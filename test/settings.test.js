'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SettingsStore, defaultSettings, sanitizeSettings } = require('../src/core/settings');
const { makeTmpDir } = require('./helpers');

test('既定設定はプラットフォームごとのショートカットを持つ', () => {
  assert.equal(defaultSettings('darwin').shortcutBackup, 'Command+Alt+Shift+A');
  assert.equal(defaultSettings('win32').shortcutRestore, 'Super+Alt+Shift+Z');
  assert.equal(defaultSettings('darwin').useTimestampFolder, true);
  assert.equal(defaultSettings('darwin').restorePath, '');
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

test('経路は正規化されて保存される', () => {
  const s = sanitizeSettings(
    { path1: '  "/tmp/live/"  ', restorePath: '/tmp/backup/20260909_1905/' },
    'darwin'
  );
  assert.equal(s.path1, '/tmp/live');
  assert.equal(s.restorePath, '/tmp/backup/20260909_1905');
});

test('保存と読み込みが往復する', () => {
  const file = path.join(makeTmpDir(), 'nested', 'settings.json');
  const store = new SettingsStore(file, 'darwin');
  store.load();
  store.update({ path1: '/tmp/live', keepSnapshots: 5, launchAtLogin: true });

  const reloaded = new SettingsStore(file, 'darwin');
  const values = reloaded.load();

  assert.equal(values.path1, '/tmp/live');
  assert.equal(values.keepSnapshots, 5);
  assert.equal(values.launchAtLogin, true);
});

test('壊れたJSONは既定値で復帰する', () => {
  const file = path.join(makeTmpDir(), 'settings.json');
  fs.writeFileSync(file, '{ broken', 'utf8');

  const store = new SettingsStore(file, 'darwin');
  const values = store.load();

  assert.equal(values.shortcutBackup, 'Command+Alt+Shift+A');
});

test('get() は内部状態のコピーを返す', () => {
  const store = new SettingsStore(path.join(makeTmpDir(), 'settings.json'), 'darwin');
  store.load();
  const copy = store.get();
  copy.excludePatterns.push('mutated');
  assert.ok(!store.get().excludePatterns.includes('mutated'));
});
