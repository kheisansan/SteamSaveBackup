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
} = require('../src/core/settings');
const { makeTmpDir } = require('./helpers');

test('既定設定はゲーム1件とプラットフォームごとのショートカットを持つ', () => {
  const s = defaultSettings('darwin');
  assert.equal(s.shortcutBackup, 'Command+Alt+Shift+A');
  assert.equal(defaultSettings('win32').shortcutRestore, 'Super+Alt+Shift+Z');
  assert.equal(s.useTimestampFolder, true);
  assert.equal(s.games.length, 1);
  assert.equal(s.games[0].name, 'ゲーム1');
  assert.equal(s.games[0].path1, '');
  assert.equal(s.activeGameId, s.games[0].id);
});

test('不正なショートカットは既定値へ戻す', () => {
  const s = sanitizeSettings({ shortcutBackup: 'A', shortcutRestore: 'Ctrl+Alt+Delete' }, 'darwin');
  assert.equal(s.shortcutBackup, 'Command+Alt+Shift+A');
  assert.equal(s.shortcutRestore, 'Ctrl+Alt+Delete');
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
  assert.equal(s.activeGameId, s.games[0].id);
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
});

test('壊れたJSONは既定値で復帰する', () => {
  const file = path.join(makeTmpDir(), 'settings.json');
  fs.writeFileSync(file, '{ broken', 'utf8');

  const store = new SettingsStore(file, 'darwin');
  const values = store.load();

  assert.equal(values.shortcutBackup, 'Command+Alt+Shift+A');
  assert.equal(values.games.length, 1);
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
  const firstId = store.get().activeGameId;

  store.update({ gameName: 'Game A', path1: '/tmp/a', path2: '/tmp/a-bak' });
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
});

test('最後のゲームは削除できない', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  assert.throws(() => store.removeGame(store.get().activeGameId), /最後のゲーム/);
});

test('getActiveGame は見つからなければ先頭を返す', () => {
  const g1 = createGame({ name: 'One', path1: '/1' });
  const g2 = createGame({ name: 'Two', path1: '/2' });
  assert.equal(getActiveGame({ games: [g1, g2], activeGameId: g2.id }).name, 'Two');
  assert.equal(getActiveGame({ games: [g1, g2], activeGameId: 'missing' }).name, 'One');
});
