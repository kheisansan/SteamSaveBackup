'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createExcluder, parsePatternText } = require('../src/core/patterns');

test('名前だけのパターンはどの階層でも一致する', () => {
  const exclude = createExcluder(['.DS_Store', 'Thumbs.db']);
  assert.ok(exclude('.DS_Store', false));
  assert.ok(exclude(path.join('a', 'b', '.DS_Store'), false));
  assert.ok(!exclude(path.join('a', 'save.dat'), false));
});

test('* と ? のワイルドカードが使える', () => {
  const exclude = createExcluder(['*.tmp', 'log?.txt']);
  assert.ok(exclude('cache.tmp', false));
  assert.ok(exclude(path.join('deep', 'dir', 'cache.tmp'), false));
  assert.ok(exclude('log1.txt', false));
  assert.ok(!exclude('log10.txt', false));
});

test('/ を含むパターンは相対パス全体に一致する', () => {
  const exclude = createExcluder(['cache/temp', 'a/*/skip.dat']);
  assert.ok(exclude(path.join('cache', 'temp'), true));
  assert.ok(!exclude(path.join('deep', 'cache', 'temp'), true));
  assert.ok(exclude(path.join('a', 'b', 'skip.dat'), false));
});

test('末尾スラッシュのパターンはディレクトリのみ対象', () => {
  const exclude = createExcluder(['cache/']);
  assert.ok(exclude('cache', true));
  assert.ok(!exclude('cache', false));
});

test('パターンが空なら常に false', () => {
  assert.ok(!createExcluder([])('anything', false));
  assert.ok(!createExcluder(['', '  '])('anything', false));
});

test('大文字小文字は既定で無視する', () => {
  const exclude = createExcluder(['thumbs.db']);
  assert.ok(exclude('Thumbs.db', false));
  assert.ok(!createExcluder(['thumbs.db'], { caseSensitive: true })('Thumbs.db', false));
});

test('parsePatternText は改行/カンマを分割する', () => {
  assert.deepEqual(parsePatternText('.DS_Store\n*.tmp, Thumbs.db\n\n'), [
    '.DS_Store',
    '*.tmp',
    'Thumbs.db',
  ]);
  assert.deepEqual(parsePatternText(''), []);
  assert.deepEqual(parsePatternText(null), []);
});
