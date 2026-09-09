'use strict';

/** グローバルショートカット文字列(Electronアクセラレータ)の既定値・検証・表示整形。 */

const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];

const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete',
  'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp',
  'PageDown', 'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack',
  'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];

const PUNCTUATION_KEYS = ['~', '`', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '[', ']', '{', '}', '\\', '|', ';', ':', "'", '"', ',', '<', '.', '>', '/', '?'];

const CODE_TO_KEY = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** プラットフォーム別の既定ショートカット。 */
function defaultAccelerators(platform = process.platform) {
  if (platform === 'darwin') {
    return { backup: 'Command+Alt+Shift+A', restore: 'Command+Alt+Shift+Z' };
  }
  // Windows/Linux は Win(Super)キー起点
  return { backup: 'Super+Alt+Shift+A', restore: 'Super+Alt+Shift+Z' };
}

function splitAccelerator(accelerator) {
  return String(accelerator || '')
    .split('+')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isModifierToken(token) {
  return MODIFIERS.some((m) => m.toLowerCase() === token.toLowerCase());
}

function isKeyToken(token) {
  if (/^[0-9A-Za-z]$/.test(token)) return true;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(token)) return true;
  if (NAMED_KEYS.some((k) => k.toLowerCase() === token.toLowerCase())) return true;
  return PUNCTUATION_KEYS.includes(token);
}

/**
 * アクセラレータとして妥当か検証する。
 * 修飾キー無しは他アプリの入力を奪ってしまうため不許可。
 */
function validateAccelerator(accelerator) {
  const parts = splitAccelerator(accelerator);
  if (parts.length === 0) return { ok: false, error: 'ショートカットが空です。' };

  const keys = parts.filter((p) => !isModifierToken(p));
  const mods = parts.filter((p) => isModifierToken(p));
  if (keys.length !== 1) {
    return { ok: false, error: '通常キーを1つだけ含めてください。' };
  }
  if (!isKeyToken(keys[0])) {
    return { ok: false, error: `使用できないキーです: ${keys[0]}` };
  }
  if (mods.length === 0) {
    return { ok: false, error: '修飾キー(Cmd/Ctrl/Alt/Shift/Win)を1つ以上含めてください。' };
  }
  return { ok: true };
}

/**
 * レンダラーのキーイベント情報からアクセラレータ文字列を作る。
 * @param {{code:string,key:string,metaKey:boolean,ctrlKey:boolean,altKey:boolean,shiftKey:boolean}} event
 */
function acceleratorFromKeyEvent(event, platform = process.platform) {
  const { code = '', key = '' } = event;
  let main = null;

  if (/^Key[A-Z]$/.test(code)) main = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) main = `num${code.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) main = code;
  else if (CODE_TO_KEY[code]) main = CODE_TO_KEY[code];
  else if (/^[0-9A-Za-z]$/.test(key)) main = key.toUpperCase();

  if (!main) return null;

  const mods = [];
  if (event.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super');
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (mods.length === 0) return null;

  return [...mods, main].join('+');
}

/** 見た目用の表記(macは記号、Windowsは英語表記)。 */
function formatAccelerator(accelerator, platform = process.platform) {
  const parts = splitAccelerator(accelerator);
  if (parts.length === 0) return '(未設定)';

  const macSymbols = {
    command: '⌘', cmd: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘', meta: '⌘', super: '⌘',
    control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
  };
  const winNames = {
    command: 'Ctrl', cmd: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
    meta: 'Win', super: 'Win', control: 'Ctrl', ctrl: 'Ctrl',
    alt: 'Alt', option: 'Alt', shift: 'Shift',
  };

  if (platform === 'darwin') {
    return parts
      .map((p) => macSymbols[p.toLowerCase()] || p.toUpperCase())
      .join('');
  }
  return parts.map((p) => winNames[p.toLowerCase()] || p.toUpperCase()).join('+');
}

module.exports = {
  defaultAccelerators,
  validateAccelerator,
  acceleratorFromKeyEvent,
  formatAccelerator,
  splitAccelerator,
};
