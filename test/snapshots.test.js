'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listSnapshots, pruneSnapshots } = require('../src/core/snapshots');
const { makeTmpDir, writeTree } = require('./helpers');

function seed() {
  const root = makeTmpDir();
  writeTree(path.join(root, '20250101_0100'), { 'a.dat': 'a' });
  writeTree(path.join(root, '20260909_1905'), { 'a.dat': 'a' });
  writeTree(path.join(root, '20260909_1905_2'), { 'a.dat': 'a' });
  writeTree(path.join(root, 'manual'), { 'a.dat': 'a' });
  fs.writeFileSync(path.join(root, '20260101_0000'), 'file-not-dir');
  return root;
}

test('listSnapshots は命名規則に合うフォルダのみ新しい順に返す', async () => {
  const root = seed();
  assert.deepEqual(await listSnapshots(root), [
    '20260909_1905_2',
    '20260909_1905',
    '20250101_0100',
  ]);
});

test('存在しないフォルダでは空配列を返す', async () => {
  assert.deepEqual(await listSnapshots(path.join(makeTmpDir(), 'nope')), []);
});

test('pruneSnapshots は新しい方を残して削除する', async () => {
  const root = seed();
  const result = await pruneSnapshots(root, 2);

  assert.deepEqual(result.removed, ['20250101_0100']);
  assert.deepEqual(await listSnapshots(root), ['20260909_1905_2', '20260909_1905']);
  assert.ok(fs.existsSync(path.join(root, 'manual')));
});

test('keep が 0 以下なら何も削除しない', async () => {
  const root = seed();
  assert.deepEqual((await pruneSnapshots(root, 0)).removed, []);
  assert.deepEqual((await pruneSnapshots(root, -1)).removed, []);
  assert.equal((await listSnapshots(root)).length, 3);
});
