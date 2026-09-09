'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatStamp,
  isSnapshotName,
  uniqueSnapshotName,
  sortSnapshotsDesc,
  describeSnapshot,
} = require('../src/core/timestamp');

test('formatStamp は yyyymmdd_hhMM 形式を返す', () => {
  assert.equal(formatStamp(new Date(2026, 8, 9, 19, 5)), '20260909_1905');
  assert.equal(formatStamp(new Date(2026, 0, 1, 0, 0)), '20260101_0000');
  assert.equal(formatStamp(new Date(2026, 11, 31, 23, 59)), '20261231_2359');
});

test('formatStamp は引数なしでも形式を満たす', () => {
  assert.match(formatStamp(), /^\d{8}_\d{4}$/);
});

test('isSnapshotName は命名規則を判定する', () => {
  assert.ok(isSnapshotName('20260909_1905'));
  assert.ok(isSnapshotName('20260909_1905_2'));
  assert.ok(!isSnapshotName('2026099_1905'));
  assert.ok(!isSnapshotName('20260909-1905'));
  assert.ok(!isSnapshotName('backup'));
});

test('uniqueSnapshotName は同一分の衝突を避ける', () => {
  const existing = new Set(['20260909_1905', '20260909_1905_2']);
  assert.equal(uniqueSnapshotName('20260909_1905', (n) => existing.has(n)), '20260909_1905_3');
  assert.equal(uniqueSnapshotName('20260909_1906', (n) => existing.has(n)), '20260909_1906');
});

test('sortSnapshotsDesc は新しい順に並べ、非対象を除外する', () => {
  const input = ['20260901_0900', 'readme.txt', '20260909_1905', '20260909_1905_2', '20260909_1804'];
  assert.deepEqual(sortSnapshotsDesc(input), [
    '20260909_1905_2',
    '20260909_1905',
    '20260909_1804',
    '20260901_0900',
  ]);
});

test('describeSnapshot は読みやすい表記にする', () => {
  assert.equal(describeSnapshot('20260909_1905'), '2026/09/09 19:05');
  assert.equal(describeSnapshot('20260909_1905_3'), '2026/09/09 19:05 (3)');
  assert.equal(describeSnapshot('other'), 'other');
});
