'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { copyTree, scanTree } = require('../src/core/copier');
const { createExcluder } = require('../src/core/patterns');
const { makeTmpDir, writeTree, readTree } = require('./helpers');

const SAMPLE = {
  'save01.dat': 'slot1',
  'save02.dat': 'slot2',
  '.DS_Store': 'junk',
  config: {
    'settings.ini': 'volume=5',
    profiles: {
      'p1.json': '{"name":"kei"}',
      'p2.json': '{"name":"sub"}',
    },
  },
  cache: {
    'a.tmp': 'temp',
  },
};

test('サブディレクトリを含めて丸ごとコピーする', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), SAMPLE);
  const dest = path.join(makeTmpDir(), 'dest');

  const report = await copyTree(src, dest);

  assert.equal(report.errorCount, 0, JSON.stringify(report.errors));
  assert.equal(report.canceled, false);
  assert.equal(report.copiedFiles, 7);
  assert.deepEqual(readTree(dest), readTree(src));
});

test('存在しないコピー先は自動で作られ、空フォルダも再現する', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), { keep: { 'x.txt': 'x' } });
  fs.mkdirSync(path.join(src, 'empty', 'nested'), { recursive: true });
  const dest = path.join(makeTmpDir(), 'deep', 'dest');

  const report = await copyTree(src, dest);

  assert.equal(report.errorCount, 0);
  assert.ok(fs.statSync(path.join(dest, 'empty', 'nested')).isDirectory());
});

test('除外パターンでファイルとフォルダを飛ばす', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), SAMPLE);
  const dest = path.join(makeTmpDir(), 'dest');

  const report = await copyTree(src, dest, {
    exclude: createExcluder(['.DS_Store', 'cache/', '*.tmp']),
  });

  assert.equal(report.errorCount, 0);
  const copied = Object.keys(readTree(dest)).sort();
  assert.deepEqual(copied, [
    'config/profiles/p1.json',
    'config/profiles/p2.json',
    'config/settings.ini',
    'save01.dat',
    'save02.dat',
  ]);
  assert.ok(!fs.existsSync(path.join(dest, 'cache')));
});

test('変更が無いファイルは2回目にスキップされる', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), SAMPLE);
  const dest = path.join(makeTmpDir(), 'dest');

  const first = await copyTree(src, dest, { skipUnchanged: true });
  assert.equal(first.copiedFiles, 7);
  assert.equal(first.skippedFiles, 0);

  fs.writeFileSync(path.join(src, 'save01.dat'), 'slot1-updated', 'utf8');
  const second = await copyTree(src, dest, { skipUnchanged: true });

  assert.equal(second.errorCount, 0);
  assert.equal(second.copiedFiles, 1);
  assert.equal(second.skippedFiles, 6);
  assert.equal(fs.readFileSync(path.join(dest, 'save01.dat'), 'utf8'), 'slot1-updated');
});

test('skipUnchanged が false なら毎回コピーする', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), { 'a.txt': 'a' });
  const dest = path.join(makeTmpDir(), 'dest');

  await copyTree(src, dest, { skipUnchanged: false });
  const second = await copyTree(src, dest, { skipUnchanged: false });

  assert.equal(second.copiedFiles, 1);
  assert.equal(second.skippedFiles, 0);
});

test('読み取り専用ファイルがあっても上書きできる', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), { 'a.txt': 'new' });
  const dest = writeTree(path.join(makeTmpDir(), 'dest'), { 'a.txt': 'old' });
  fs.chmodSync(path.join(dest, 'a.txt'), 0o444);

  const report = await copyTree(src, dest, { skipUnchanged: false });

  assert.equal(report.errorCount, 0, JSON.stringify(report.errors));
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'new');
});

test('シンボリックリンクは辿らずリンクとして再作成する', async (t) => {
  if (process.platform === 'win32') return t.skip('Windowsでは権限が必要なためスキップ');

  const base = makeTmpDir();
  const src = writeTree(path.join(base, 'src'), { real: { 'f.txt': 'f' } });
  fs.symlinkSync(path.join(src, 'real'), path.join(src, 'loop'), 'dir');
  const dest = path.join(base, 'dest');

  const report = await copyTree(src, dest);

  assert.equal(report.symlinks, 1);
  assert.ok(fs.lstatSync(path.join(dest, 'loop')).isSymbolicLink());
});

test('AbortSignal でキャンセルできる', async () => {
  const spec = {};
  for (let i = 0; i < 400; i += 1) spec[`f${i}.dat`] = 'x'.repeat(2048);
  const src = writeTree(path.join(makeTmpDir(), 'src'), spec);
  const dest = path.join(makeTmpDir(), 'dest');

  const controller = new AbortController();
  const promise = copyTree(src, dest, {
    signal: controller.signal,
    onProgress: (p) => {
      if (p.phase === 'copy') controller.abort();
    },
  });
  controller.abort();
  const report = await promise;

  assert.equal(report.canceled, true);
  assert.ok(report.copiedFiles < 400);
});

test('コピー元がフォルダでない場合は致命的エラーを返す', async () => {
  const base = makeTmpDir();
  const file = path.join(base, 'a.txt');
  fs.writeFileSync(file, 'a');

  const report = await copyTree(file, path.join(base, 'dest'));

  assert.match(report.fatal, /フォルダではありません/);
});

test('コピー元が存在しない場合も例外を投げずにレポートで返す', async () => {
  const report = await copyTree(path.join(makeTmpDir(), 'nope'), path.join(makeTmpDir(), 'dest'));
  assert.ok(report.fatal);
  assert.equal(report.copiedFiles, 0);
});

test('進捗コールバックは走査とコピーの両フェーズを通知する', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), SAMPLE);
  const dest = path.join(makeTmpDir(), 'dest');
  const phases = new Set();

  await copyTree(src, dest, { onProgress: (p) => phases.add(p.phase) });

  assert.ok(phases.has('scan'));
  assert.ok(phases.has('done'));
});

test('scanTree は総ファイル数と総バイト数を数える', async () => {
  const src = writeTree(path.join(makeTmpDir(), 'src'), {
    'a.txt': '12345',
    sub: { 'b.txt': '123' },
  });

  const scan = await scanTree(src);

  assert.equal(scan.files.length, 2);
  assert.equal(scan.totalBytes, 8);
  assert.deepEqual(scan.dirs, ['sub']);
});
