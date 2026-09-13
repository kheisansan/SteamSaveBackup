'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SettingsStore,
  defaultSettings,
  sanitizeSettings,
  getActiveGame,
  createGame,
  isGameFilled,
  listPinnedGames,
  listPinnedGroups,
  createGroup,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  nextCopyName,
  settingsForGame,
} = require('../src/core/settings');
const { makeTmpDir } = require('./helpers');

test('既定設定はゲーム0件で、全体ショートカットは空', () => {
  const s = defaultSettings('darwin');
  assert.equal(s.shortcutBackup, '');
  assert.equal(defaultSettings('win32').shortcutRestore, '');
  assert.equal(s.useTimestampFolder, true);
  assert.equal(s.games.length, 0);
  assert.equal(s.activeGameId, '');
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].id, DEFAULT_GROUP_ID);
  assert.equal(s.groups[0].name, DEFAULT_GROUP_NAME);
  assert.equal(s.groups[0].pinned, true);
});

test('空のショートカットは未設定として残し、不正値は捨てる', () => {
  const empty = sanitizeSettings({ shortcutBackup: '', shortcutRestore: '' }, 'darwin');
  assert.equal(empty.shortcutBackup, '');
  const s = sanitizeSettings({ shortcutBackup: 'A', shortcutRestore: 'Ctrl+Alt+Delete' }, 'darwin');
  assert.equal(s.shortcutBackup, '');
  assert.equal(s.shortcutRestore, '');
});

test('数値は範囲内に丸められる', () => {
  assert.equal(sanitizeSettings({ concurrency: 999 }, 'darwin').concurrency, 16);
  assert.equal(sanitizeSettings({ concurrency: 0 }, 'darwin').concurrency, 1);
  assert.equal(sanitizeSettings({ concurrency: 'abc' }, 'darwin').concurrency, 4);
  assert.equal(sanitizeSettings({ keepSnapshots: -5 }, 'darwin').keepSnapshots, 0);
});

test('除外パターンは文字列でも配列でも受け付ける', () => {
  assert.deepEqual(sanitizeSettings({ excludePatterns: '*.tmp, .DS_Store' }, 'darwin').excludePatterns, [
    '*.tmp',
    '.DS_Store',
  ]);
  assert.deepEqual(sanitizeSettings({ excludePatterns: [' a ', ''] }, 'darwin').excludePatterns, ['a']);
});

test('v1.0のフラット経路はゲーム1件へ移行する', () => {
  const s = sanitizeSettings(
    { path1: '  "/tmp/live/"  ', path2: '/tmp/backup/', restorePath: '/tmp/backup/20260909_1905/' },
    'darwin'
  );
  assert.equal(s.games.length, 1);
  assert.equal(s.games[0].path1, '/tmp/live');
  assert.equal(s.games[0].path2, '/tmp/backup');
  assert.equal(s.games[0].restorePath, '/tmp/backup/20260909_1905');
  assert.equal(s.games[0].pinned, true);
  assert.equal(s.activeGameId, s.games[0].id);
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].pinned, true);
  assert.equal(s.games[0].groupId, s.groups[0].id);
});

test('games配列がある場合はフラット経路より優先する', () => {
  const game = createGame({ name: 'Elden Ring', path1: '/tmp/elden', path2: '/tmp/bak' });
  const s = sanitizeSettings(
    { path1: '/tmp/ignored', games: [game], activeGameId: game.id },
    'darwin'
  );
  assert.equal(s.games.length, 1);
  assert.equal(s.games[0].name, 'Elden Ring');
  assert.equal(s.games[0].path1, '/tmp/elden');
});

test('v1.1のゲームはピン留めされ、全体ショートカットは先頭へ移る', () => {
  const gameA = { id: 'ga', name: 'A', path1: '/a', path2: '/ab', restorePath: '' };
  const gameB = { id: 'gb', name: 'B', path1: '/b', path2: '/bb', restorePath: '' };
  const s = sanitizeSettings(
    {
      games: [gameA, gameB],
      activeGameId: 'gb',
      shortcutBackup: 'Command+Alt+Shift+A',
      shortcutRestore: 'Command+Alt+Shift+Z',
    },
    'darwin'
  );
  assert.equal(s.games[0].pinned, true);
  assert.equal(s.games[1].pinned, true);
  assert.equal(s.games[0].shortcutBackup, 'Command+Alt+Shift+A');
  assert.equal(s.games[0].shortcutRestore, 'Command+Alt+Shift+Z');
  assert.equal(s.games[1].shortcutBackup, '');
  assert.equal(s.games[1].shortcutRestore, '');
  assert.equal(s.shortcutBackup, '');
  assert.equal(s.shortcutRestore, '');
});

test('ゲーム別ショートカットが既にある場合は全体ショートカットを移さない', () => {
  const game = createGame({
    name: 'Pinned',
    pinned: false,
    shortcutBackup: 'Control+Alt+Shift+S',
  });
  const s = sanitizeSettings(
    {
      games: [game],
      shortcutBackup: 'Command+Alt+Shift+A',
      shortcutRestore: 'Command+Alt+Shift+Z',
    },
    'darwin'
  );
  assert.equal(s.games[0].shortcutBackup, 'Control+Alt+Shift+S');
  assert.equal(s.games[0].shortcutRestore, 'Command+Alt+Shift+Z');
  assert.equal(s.games[0].pinned, false);
});

test('保存と読み込みが往復する', () => {
  const file = path.join(makeTmpDir(), 'nested', 'settings.json');
  const store = new SettingsStore(file, 'darwin');
  store.load();
  store.update({ path1: '/tmp/live', keepSnapshots: 5, launchAtLogin: true, gameName: 'Test Game' });

  const reloaded = new SettingsStore(file, 'darwin');
  reloaded.load();
  const values = reloaded.get();

  assert.equal(values.path1, '/tmp/live');
  assert.equal(values.gameName, 'Test Game');
  assert.equal(values.keepSnapshots, 5);
  assert.equal(values.launchAtLogin, true);
  assert.equal(values.games.length, 1);
  assert.equal(values.games[0].pinned, true);
});

test('壊れたJSONは既定値で復帰する', () => {
  const file = path.join(makeTmpDir(), 'settings.json');
  fs.writeFileSync(file, '{ broken', 'utf8');

  const store = new SettingsStore(file, 'darwin');
  const values = store.load();

  assert.equal(values.shortcutBackup, '');
  assert.equal(values.games.length, 0);
  assert.ok(store.loadError);
});

test('get() は内部状態のコピーを返し、アクティブ経路を展開する', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  store.update({ gameName: 'A', path1: '/tmp/a' });
  store.addGame({ name: 'B', path1: '/tmp/b' });
  store.setActiveGame(store.get().games.find((g) => g.name === 'B').id);

  const copy = store.get();
  assert.equal(copy.path1, '/tmp/b');
  assert.equal(copy.gameName, 'B');
  copy.excludePatterns.push('mutated');
  copy.games.find((g) => g.name === 'A').name = 'mutated';
  assert.ok(!store.get().excludePatterns.includes('mutated'));
  assert.equal(store.get().games.find((g) => g.path1 === '/tmp/a').name, 'A');
});

test('ゲームの追加・切替・更新・削除ができる', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();

  store.update({ gameName: 'Game A', path1: '/tmp/a', path2: '/tmp/a-bak' });
  const firstId = store.get().activeGameId;
  const withB = store.addGame({ name: 'Game B', path1: '/tmp/b', path2: '/tmp/b-bak' });
  assert.equal(withB.gameName, 'Game B');
  assert.equal(withB.path1, '/tmp/b');
  assert.equal(withB.games.length, 2);

  const backToA = store.setActiveGame(firstId);
  assert.equal(backToA.gameName, 'Game A');
  assert.equal(backToA.path1, '/tmp/a');

  store.updateGame(firstId, { restorePath: '/tmp/a-bak/20260909_1200' });
  assert.equal(store.get().restorePath, '/tmp/a-bak/20260909_1200');

  const afterRemove = store.removeGame(withB.activeGameId);
  assert.equal(afterRemove.games.length, 1);
  assert.equal(afterRemove.gameName, 'Game A');

  assert.throws(() => store.updateGame('missing', { name: 'Nope' }), /見つかりません/);
});

test('空のゲームは追加せず、最後の1件も削除できる', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  const before = store.addGame({ name: '', path1: '', path2: '' });
  assert.equal(before.games.length, 0);

  store.addGame({ name: 'Only' });
  const after = store.removeGame(store.get().activeGameId);
  assert.equal(after.games.length, 0);
  assert.equal(after.activeGameId, '');
});

test('getActiveGame は見つからなければ先頭を返す', () => {
  const g1 = createGame({ name: 'One', path1: '/1' });
  const g2 = createGame({ name: 'Two', path1: '/2' });
  assert.equal(getActiveGame({ games: [g1, g2], activeGameId: g2.id }).name, 'Two');
  assert.equal(getActiveGame({ games: [g1, g2], activeGameId: 'missing' }).name, 'One');
});

test('isGameFilled は何か入ったときだけ true', () => {
  assert.equal(isGameFilled(createGame()), false);
  assert.equal(isGameFilled(createGame({ name: 'Elden' })), true);
  assert.equal(isGameFilled(createGame({ path1: '/tmp/a' })), true);
  assert.equal(isGameFilled(createGame({ pinned: true })), true);
  assert.equal(isGameFilled(createGame({ shortcutBackup: 'Control+Alt+A' })), true);
  assert.equal(isGameFilled(createGame({ shortcutRestore: 'Control+Alt+Z' })), true);
});

test('listPinnedGames は配列順を保ったままピン留めだけ返す', () => {
  const a = createGame({ name: 'A', pinned: true });
  const b = createGame({ name: 'B', pinned: false });
  const c = createGame({ name: 'C', pinned: true });
  const pinned = listPinnedGames({ games: [a, b, c] });
  assert.deepEqual(pinned.map((g) => g.name), ['A', 'C']);
});

test('reorderGames で表示順を変えられる', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  store.addGame({ name: 'A' });
  store.addGame({ name: 'B' });
  store.addGame({ name: 'C' });
  const ids = store.get().games.map((g) => g.id);
  store.reorderGames([ids[2], ids[0], ids[1]]);
  assert.deepEqual(store.get().games.map((g) => g.name), ['C', 'A', 'B']);
});

test('settingsForGame は指定ゲームの経路を展開する', () => {
  const a = createGame({ name: 'A', path1: '/a' });
  const b = createGame({ name: 'B', path1: '/b' });
  const s = { games: [a, b], activeGameId: a.id };
  assert.equal(settingsForGame(s, b.id).path1, '/b');
  assert.equal(settingsForGame(s, b.id).gameName, 'B');
});

test('v1.2のゲームは既定グループへ入り、グループもピン留めされる', () => {
  const game = createGame({ name: 'Elden', pinned: true });
  const s = sanitizeSettings({ games: [game] }, 'darwin');
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].pinned, true);
  assert.equal(s.games[0].groupId, s.groups[0].id);
});

test('グループと経路の両方がピンのときだけ実行対象になる', () => {
  const groupA = createGroup({ id: 'ga', name: 'A', pinned: true });
  const groupB = createGroup({ id: 'gb', name: 'B', pinned: false });
  const a = createGame({ name: 'A1', pinned: true, groupId: 'ga' });
  const b = createGame({ name: 'A2', pinned: false, groupId: 'ga' });
  const c = createGame({ name: 'B1', pinned: true, groupId: 'gb' });
  const pinned = listPinnedGames({ groups: [groupA, groupB], games: [a, b, c] });
  assert.deepEqual(pinned.map((g) => g.name), ['A1']);
  assert.deepEqual(listPinnedGroups({ groups: [groupA, groupB] }).map((g) => g.name), ['A']);
});

test('グループの追加・改名・削除とグループ内並び替えができる', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  const firstId = store.get().groups[0].id;
  store.addGame({ name: 'A', groupId: firstId });
  store.addGame({ name: 'B', groupId: firstId });
  const extra = store.addGroup({ name: '別グループ' });
  assert.equal(extra.groups.length, 2);
  assert.equal(extra.groups[1].name, '別グループ');
  assert.equal(extra.groups[1].pinned, false);

  store.updateGroup(extra.groups[1].id, { pinned: true, name: '作業用' });
  assert.equal(store.get().groups[1].name, '作業用');
  assert.equal(store.get().groups[1].pinned, true);

  const ids = store.get().games.map((g) => g.id);
  store.reorderGames([ids[1], ids[0]], firstId);
  assert.deepEqual(store.get().games.map((g) => g.name), ['B', 'A']);

  store.removeGroup(store.get().groups[1].id);
  assert.equal(store.get().groups.length, 1);
  assert.equal(store.get().games.length, 2);

  store.addGroup({ name: '捨てる' });
  store.removeGroup(store.get().groups[0].id);
  assert.equal(store.get().groups.length, 1);
  assert.equal(store.get().groups[0].name, '捨てる');
  assert.equal(store.get().games.length, 0);
  assert.throws(() => store.removeGroup(store.get().groups[0].id), /最後のグループ/);
});

test('経路のコピーとグループ移動ができる', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  const firstId = store.get().groups[0].id;
  store.addGame({
    name: 'Elden',
    path1: '/tmp/a',
    path2: '/tmp/b',
    groupId: firstId,
    shortcutBackup: 'Control+Alt+Shift+A',
  });
  const sourceId = store.get().games[0].id;
  store.addGroup({ name: '移動先' });
  const destId = store.get().groups[1].id;

  store.duplicateGame(sourceId);
  assert.equal(store.get().games.length, 2);
  assert.equal(store.get().games[1].name, 'Elden のコピー');
  assert.equal(store.get().games[1].path1, '/tmp/a');
  assert.equal(store.get().games[1].shortcutBackup, '');
  assert.equal(nextCopyName('Elden', ['Elden', 'Elden のコピー']), 'Elden のコピー 2');

  store.moveGame(store.get().games[1].id, destId);
  assert.equal(store.get().games.filter((g) => g.groupId === destId).length, 1);
  assert.equal(store.get().games.filter((g) => g.groupId === firstId).length, 1);
  assert.equal(store.get().games.find((g) => g.groupId === destId).name, 'Elden のコピー');

  store.addGame({ name: 'First', groupId: destId });
  store.addGame({ name: 'Second', groupId: destId });
  const copyId = store.get().games.find((g) => g.name === 'Elden のコピー').id;
  const secondId = store.get().games.find((g) => g.name === 'Second').id;
  store.moveGame(copyId, destId, secondId);
  assert.deepEqual(
    store.get().games.filter((g) => g.groupId === destId).map((g) => g.name),
    ['First', 'Elden のコピー', 'Second']
  );
});
