'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeInputPath,
  isUncPath,
  isSamePath,
  isSameOrInside,
  validateCopyPair,
} = require('../src/core/pathcheck');

test('前後の空白と引用符を除去する', () => {
  assert.equal(normalizeInputPath('  /tmp/foo  '), '/tmp/foo');
  assert.equal(normalizeInputPath('"/tmp/foo bar"'), '/tmp/foo bar');
  assert.equal(normalizeInputPath("'/tmp/foo'"), '/tmp/foo');
  assert.equal(normalizeInputPath(''), '');
  assert.equal(normalizeInputPath(null), '');
});

test('~ をホームディレクトリに展開する', () => {
  assert.equal(normalizeInputPath('~'), os.homedir());
  assert.equal(normalizeInputPath('~/Documents'), path.join(os.homedir(), 'Documents'));
});

test('file:// URL を通常のパスに戻す', () => {
  assert.equal(normalizeInputPath('file:///tmp/my%20folder'), '/tmp/my folder');
});

test('末尾の区切り文字を落とす', () => {
  assert.equal(normalizeInputPath('/tmp/foo/'), '/tmp/foo');
  assert.equal(normalizeInputPath('/'), '/');
});

test('UNCパスを判別できる', () => {
  assert.ok(isUncPath('\\\\nas\\share\\saves'));
  assert.ok(isUncPath('//nas/share/saves'));
  assert.ok(!isUncPath('/Volumes/share'));
  assert.ok(!isUncPath('C:\\data'));
});

test('同一パス判定は正規化してから比較する', () => {
  assert.ok(isSamePath('/tmp/foo', '/tmp/foo/'));
  assert.ok(isSamePath('/tmp/foo/../foo', '/tmp/foo'));
  assert.ok(!isSamePath('/tmp/foo', '/tmp/bar'));
  assert.ok(!isSamePath('', '/tmp'));
});

test('配下判定は親子関係だけを true にする', () => {
  assert.ok(isSameOrInside('/tmp/foo', '/tmp/foo/bar'));
  assert.ok(isSameOrInside('/tmp/foo', '/tmp/foo'));
  assert.ok(!isSameOrInside('/tmp/foo', '/tmp/foobar'));
  assert.ok(!isSameOrInside('/tmp/foo/bar', '/tmp/foo'));
});

test('validateCopyPair は妥当な組み合わせを許可する', () => {
  assert.deepEqual(validateCopyPair('/tmp/a', '/tmp/b'), { ok: true });
});

test('validateCopyPair は危険な組み合わせを拒否する', () => {
  assert.equal(validateCopyPair('', '/tmp/b').ok, false);
  assert.equal(validateCopyPair('/tmp/a', '').ok, false);
  assert.equal(validateCopyPair('relative', '/tmp/b').ok, false);
  assert.equal(validateCopyPair('/tmp/a', '/tmp/a').ok, false);
  assert.equal(validateCopyPair('/tmp/a', '/tmp/a/inside').ok, false);
  assert.equal(validateCopyPair('/tmp/a/inside', '/tmp/a').ok, false);
});
