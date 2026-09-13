'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JobRunner, inspectJobSetup } = require('../src/core/jobs');
const { defaultSettings } = require('../src/core/settings');
const { listSnapshots } = require('../src/core/snapshots');
const { makeTmpDir, writeTree, readTree, listDirs } = require('./helpers');

function makeCase(overrides = {}, tree = { 'save.dat': 'v1', sub: { 'a.txt': 'a' } }) {
  const base = makeTmpDir();
  const path1 = writeTree(path.join(base, 'live'), tree);
  const path2 = path.join(base, 'backup');
  fs.mkdirSync(path2, { recursive: true });

  const settings = {
    ...defaultSettings('darwin'),
    path1,
    path2,
    ...overrides,
  };
  return { base, path1, path2, settings, runner: new JobRunner(() => settings) };
}

test('backup は経路2直下に yyyymmdd_hhMM フォルダを作ってコピーする', async () => {
  const { path1, path2, runner } = makeCase();

  const result = await runner.run('backup');

  assert.equal(result.ok, true, JSON.stringify(result));
  const dirs = listDirs(path2);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /^\d{8}_\d{4}$/);
  assert.equal(result.snapshotName, dirs[0]);
  assert.deepEqual(readTree(path.join(path2, dirs[0])), readTree(path1));
});

test('useTimestampFolder が false なら経路2直下に直接コピーする', async () => {
  const { path1, path2, runner } = makeCase({ useTimestampFolder: false });

  const result = await runner.run('backup');

  assert.equal(result.ok, true);
  assert.equal(result.snapshotName, null);
  assert.deepEqual(readTree(path2), readTree(path1));
});

test('同じ分に2回実行しても別フォルダになる', async () => {
  const { path2, runner } = makeCase();

  await runner.run('backup');
  await runner.run('backup');

  const dirs = listDirs(path2);
  assert.equal(dirs.length, 2);
  assert.ok(dirs.some((d) => /^\d{8}_\d{4}_2$/.test(d)));
});

test('restore は復元元フォルダの中身を経路1へ戻す(日時フォルダを作らない)', async () => {
  const { base, path1, runner, settings } = makeCase();
  settings.restorePath = writeTree(path.join(base, 'src-20260909_1905'), {
    'save.dat': 'restored',
    extra: { 'e.txt': 'e' },
  });

  const result = await runner.run('restore');

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.snapshotName, null);
  assert.equal(result.src, settings.restorePath);
  assert.equal(result.dest, path1);
  assert.equal(fs.readFileSync(path.join(path1, 'save.dat'), 'utf8'), 'restored');
  assert.equal(fs.readFileSync(path.join(path1, 'extra', 'e.txt'), 'utf8'), 'e');
  // 経路1直下に yyyymmdd_hhMM が作られていないこと
  assert.ok(!listDirs(path1).some((d) => /^\d{8}_\d{4}/.test(d)));
});

test('restore は skipUnchanged 設定に関わらず強制上書きする', async () => {
  const { base, path1, runner, settings } = makeCase({ skipUnchanged: true }, {});
  settings.restorePath = writeTree(path.join(base, 'restore-src'), {
    'save.dat': 'from-backup',
    sub: { 'a.txt': 'a' },
  });

  // 1回目で経路1をそろえる → 通常なら2回目は「変更なし」でスキップされる状態
  const first = await runner.run('restore');
  assert.equal(first.ok, true);
  assert.equal(first.report.copiedFiles, 2);

  const second = await runner.run('restore');

  assert.equal(second.ok, true);
  assert.equal(second.report.skippedFiles, 0, 'スキップされてはいけない');
  assert.equal(second.report.copiedFiles, 2);
});

test('restore は経路1の読み取り専用ファイルも上書きする', async () => {
  const { base, path1, runner, settings } = makeCase({}, { 'save.dat': 'locked' });
  settings.restorePath = writeTree(path.join(base, 'restore-src'), { 'save.dat': 'from-backup' });
  fs.chmodSync(path.join(path1, 'save.dat'), 0o444);

  const result = await runner.run('restore');

  assert.equal(result.ok, true, JSON.stringify(result.report.errors));
  assert.equal(fs.readFileSync(path.join(path1, 'save.dat'), 'utf8'), 'from-backup');
});

test('復元元フォルダが未設定なら失敗する', async () => {
  const { runner } = makeCase();

  const result = await runner.run('restore');

  assert.equal(result.ok, false);
  assert.match(result.message, /復元元フォルダが未設定/);
});

test('復元元フォルダが存在しないと失敗する', async () => {
  const { runner, settings } = makeCase();
  settings.restorePath = path.join(makeTmpDir(), 'missing');

  const result = await runner.run('restore');

  assert.equal(result.ok, false);
  assert.match(result.message, /見つかりません/);
});

test('復元元フォルダが経路1と同じ/配下だと拒否する', async () => {
  const { path1, runner, settings } = makeCase();

  settings.restorePath = path1;
  assert.match((await runner.run('restore')).message, /同じ経路/);

  settings.restorePath = path.join(path1, 'sub');
  assert.match((await runner.run('restore')).message, /配下/);
});

test('restore ではスナップショットの世代削除が走らない', async () => {
  const { base, path2, runner, settings } = makeCase({ keepSnapshots: 1 });
  settings.restorePath = writeTree(path.join(base, 'restore-src'), { 'save.dat': 'v' });
  writeTree(path.join(path2, '20250101_0100'), { 'a.dat': 'a' });
  writeTree(path.join(path2, '20250102_0100'), { 'a.dat': 'a' });

  const result = await runner.run('restore');

  assert.equal(result.ok, true);
  assert.equal(result.pruned, null);
  assert.equal((await listSnapshots(path2)).length, 2);
});

test('経路が未設定なら失敗する', async () => {
  const { runner } = makeCase({ path2: '' });

  const result = await runner.run('backup');

  assert.equal(result.ok, false);
  assert.equal(result.setupError, true);
  assert.match(result.message, /コピー先の経路が未設定/);
});

test('経路1が存在しないと失敗する', async () => {
  const { base, runner } = makeCase({ path1: path.join(makeTmpDir(), 'missing') });
  assert.ok(base);

  const result = await runner.run('backup');

  assert.equal(result.ok, false);
  assert.equal(result.setupError, true);
  assert.match(result.message, /見つかりません/);
});

test('経路2が経路1の配下だと拒否する', async () => {
  const { path1, runner } = makeCase();
  const nested = path.join(path1, 'inside');
  const { runner: nestedRunner } = (() => {
    const settings = { ...defaultSettings('darwin'), path1, path2: nested };
    return { runner: new JobRunner(() => settings) };
  })();
  assert.ok(runner);

  const result = await nestedRunner.run('backup');

  assert.equal(result.ok, false);
  assert.match(result.message, /配下/);
});

test('inspectJobSetup は未設定と存在しない経路を説明する', () => {
  assert.equal(inspectJobSetup('backup', { path1: '', path2: '/tmp/b' }), 'コピー元を設定してください。');
  assert.equal(inspectJobSetup('backup', { path1: '/tmp/a', path2: '' }), 'バックアップ先を設定してください。');
  assert.equal(inspectJobSetup('restore', { path1: '/tmp/a', restorePath: '' }), '復元元フォルダを設定してください。');

  const missing = path.join(makeTmpDir(), 'nope');
  const backupMissing = inspectJobSetup('backup', { path1: missing, path2: makeTmpDir() });
  assert.match(backupMissing, /コピー元が見つかりません/);

  const { path1, path2 } = makeCase();
  assert.equal(inspectJobSetup('backup', { path1, path2 }), null);

  const restoreMissing = inspectJobSetup('restore', { path1, restorePath: missing });
  assert.match(restoreMissing, /見つかりません/);
});

test('実行中の多重起動は拒否される', async () => {
  const spec = {};
  for (let i = 0; i < 300; i += 1) spec[`f${i}.dat`] = 'x'.repeat(4096);
  const { runner } = makeCase({}, spec);

  const first = runner.run('backup');
  const second = await runner.run('backup');

  assert.equal(second.ok, false);
  assert.match(second.message, /実行中/);
  await first;
});

test('keepSnapshots で古い世代が削除される', async () => {
  const { path2, runner } = makeCase({ keepSnapshots: 2 });
  writeTree(path.join(path2, '20250101_0100'), { 'a.dat': 'a' });
  writeTree(path.join(path2, '20250102_0100'), { 'a.dat': 'a' });
  writeTree(path.join(path2, 'not-a-snapshot'), { 'a.dat': 'a' });

  const result = await runner.run('backup');

  assert.equal(result.ok, true);
  const remaining = await listSnapshots(path2);
  assert.equal(remaining.length, 2);
  assert.deepEqual(result.pruned.removed, ['20250101_0100']);
  assert.ok(fs.existsSync(path.join(path2, 'not-a-snapshot')), '規則外フォルダは消さない');
});

test('除外パターンが backup にも適用される', async () => {
  const { path2, runner } = makeCase({ excludePatterns: ['*.tmp'] }, {
    'save.dat': 'v',
    'cache.tmp': 'x',
  });

  const result = await runner.run('backup');

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(readTree(path.join(path2, result.snapshotName))), ['save.dat']);
});

test('イベントが start -> progress -> done の順で発火する', async () => {
  const { runner } = makeCase();
  const seen = [];
  runner.on('start', () => seen.push('start'));
  runner.on('progress', () => {
    if (!seen.includes('progress')) seen.push('progress');
  });
  runner.on('done', () => seen.push('done'));

  await runner.run('backup');

  assert.deepEqual(seen, ['start', 'progress', 'done']);
});

test('不明な direction は失敗する', async () => {
  const { runner } = makeCase();
  const result = await runner.run('sideways');
  assert.equal(result.ok, false);
  assert.match(result.message, /不明な方向指定/);
});

test('run に渡した settings を getSettings より優先する', async () => {
  const { path1, path2, runner } = makeCase();
  const other = writeTree(path.join(makeTmpDir(), 'other'), { 'other.dat': 'x' });
  const result = await runner.run('backup', {
    settings: {
      ...defaultSettings('darwin'),
      path1: other,
      path2,
      gameName: 'Override',
      useTimestampFolder: true,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.gameName, 'Override');
  assert.equal(fs.readFileSync(path.join(path2, result.snapshotName, 'other.dat'), 'utf8'), 'x');
  assert.ok(!fs.existsSync(path.join(path2, result.snapshotName, 'save.dat')));
  assert.equal(path1.includes('live'), true);
});
