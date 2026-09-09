'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultAccelerators,
  validateAccelerator,
  acceleratorFromKeyEvent,
  formatAccelerator,
} = require('../src/core/accelerator');

test('既定ショートカットは仕様どおり', () => {
  assert.deepEqual(defaultAccelerators('darwin'), {
    backup: 'Command+Alt+Shift+A',
    restore: 'Command+Alt+Shift+Z',
  });
  assert.deepEqual(defaultAccelerators('win32'), {
    backup: 'Super+Alt+Shift+A',
    restore: 'Super+Alt+Shift+Z',
  });
});

test('妥当なアクセラレータを受け付ける', () => {
  for (const acc of [
    'Command+Alt+Shift+A',
    'Super+Alt+Shift+S',
    'CommandOrControl+Shift+F5',
    'Ctrl+Alt+num1',
    'Alt+Shift+Up',
  ]) {
    assert.equal(validateAccelerator(acc).ok, true, acc);
  }
});

test('修飾キー無しや不正なキーは拒否する', () => {
  assert.equal(validateAccelerator('A').ok, false);
  assert.equal(validateAccelerator('').ok, false);
  assert.equal(validateAccelerator('Command+Shift').ok, false);
  assert.equal(validateAccelerator('Command+A+B').ok, false);
  assert.equal(validateAccelerator('Command+F25').ok, false);
});

test('キーイベントからアクセラレータを組み立てる', () => {
  const base = { metaKey: true, altKey: true, shiftKey: true, ctrlKey: false };
  assert.equal(
    acceleratorFromKeyEvent({ ...base, code: 'KeyA', key: 'å' }, 'darwin'),
    'Command+Alt+Shift+A'
  );
  assert.equal(
    acceleratorFromKeyEvent({ ...base, code: 'KeyS', key: 'ß' }, 'win32'),
    'Super+Alt+Shift+S'
  );
  assert.equal(
    acceleratorFromKeyEvent(
      { code: 'Digit1', key: '1', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      'win32'
    ),
    'Control+1'
  );
  assert.equal(
    acceleratorFromKeyEvent(
      { code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
      'win32'
    ),
    'Control+Alt+Up'
  );
});

test('修飾キーが無い場合や未対応キーは null', () => {
  assert.equal(
    acceleratorFromKeyEvent({ code: 'KeyA', key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    null
  );
  assert.equal(
    acceleratorFromKeyEvent({ code: 'MediaTrackNext', key: 'MediaTrackNext', ctrlKey: true }),
    null
  );
});

test('表示用の整形はプラットフォームごとに変わる', () => {
  assert.equal(formatAccelerator('Command+Alt+Shift+A', 'darwin'), '⌘⌥⇧A');
  assert.equal(formatAccelerator('Super+Alt+Shift+A', 'win32'), 'Win+Alt+Shift+A');
  assert.equal(formatAccelerator('', 'win32'), '(未設定)');
});
