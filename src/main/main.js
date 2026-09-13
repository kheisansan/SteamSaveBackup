'use strict';

/**
 * SteamSaveBackup メインプロセス。
 * - トレイ常駐(ウィンドウを閉じても終了しない)
 * - グローバルショートカットで経路1<->経路2をコピー
 * - 環境設定はレンダラー(設定ウィンドウ)から IPC で更新
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
} = require('electron');

const { SettingsStore, defaultSettings, settingsForGame, listPinnedGames, listPinnedGroups } = require('../core/settings');
const { JobRunner, DIRECTION_LABEL, inspectJobSetup } = require('../core/jobs');
const {
  acceleratorFromKeyEvent,
  formatAccelerator,
  validateAccelerator,
} = require('../core/accelerator');
const { summarizeResult, formatBytes, progressRatio } = require('../core/format');
const { listSnapshots, describeSnapshot } = require('../core/snapshots');
const { normalizeInputPath } = require('../core/pathcheck');
const { History } = require('./history');

const ROOT_DIR = path.join(__dirname, '..', '..');
const APP_PACKAGE = require(path.join(ROOT_DIR, 'package.json'));
const HIDDEN_FLAG = '--hidden';

let store = null;
let history = null;
let runner = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let shortcutState = { byGameId: {} };

// ------------------------------------------------------------------ utilities

function settings() {
  return store.get();
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function isWindowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function revealWindow(section) {
  if (section) {
    showWindow(section);
    return;
  }
  if (!isWindowVisible()) showWindow();
}

/** アプリ内トースト＋OS通知。section があればそのタブへ切り替える。 */
function noticeUi(message, { title = 'SteamSaveBackup', section = '', kind = 'error', logLevel } = {}) {
  const level = logLevel || (kind === 'error' ? 'error' : 'warn');
  logEntry(level, message);
  notify(title, message);
  revealWindow(section);
  sendToWindow('ui:notice', { kind, message, section });
}

function logEntry(level, text, detail = '') {
  const record = history.add({ level, text, detail });
  sendToWindow('log:entry', record);
  return record;
}

function notify(title, body) {
  if (!settings().notifications) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: false }).show();
  } catch {
    /* 通知が使えない環境でも処理は続行する */
  }
}

function trayImage() {
  const file =
    process.platform === 'darwin'
      ? path.join(ROOT_DIR, 'build', 'trayTemplate.png')
      : path.join(ROOT_DIR, 'build', 'tray.png');
  const image = nativeImage.createFromPath(file);
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function windowIcon() {
  const file = path.join(ROOT_DIR, 'build', 'icon.png');
  return fs.existsSync(file) ? nativeImage.createFromPath(file) : undefined;
}

// -------------------------------------------------------------------- window

function createWindow({ show }) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'SteamSaveBackup',
    icon: windowIcon(),
    backgroundColor: '#12141a',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow.show();
  });

  // 「閉じる」では終了せず隠すだけ(バックグラウンド常駐)
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'darwin' && settings().hideDockIcon && app.dock) app.dock.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function showWindow(section = null) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow({ show: true });
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (section) sendToWindow('ui:focus-section', section);
}

// ---------------------------------------------------------------- job trigger

async function confirmRestore(s) {
  if (process.platform === 'darwin') app.focus({ steal: true });

  const gameLine = s.gameName ? `ゲーム: ${s.gameName}\n` : '';
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['復元する', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    title: '復元の確認',
    message: '復元元フォルダ → コピー元 へコピーします。よろしいですか?',
    detail:
      `${gameLine}コピー元: ${s.restorePath}\nコピー先: ${s.path1}\n\n` +
      '日時フォルダは作らず、コピー元の同名ファイルを強制的に上書きします。',
    noLink: true,
  });
  return response === 0;
}

function resolveJobSettings(gameId) {
  const all = settings();
  if (!gameId) return all;
  const found = (all.games || []).some((g) => g.id === gameId);
  if (!found) return null;
  return settingsForGame(all, gameId);
}

function reportSetupError(message, { direction, gameName } = {}) {
  logEntry('error', message);
  notify('経路を確認してください', message);
  showWindow('paths');
  sendToWindow('ui:notice', { kind: 'error', message, section: 'paths' });
  sendToWindow('job:done', {
    ok: false,
    direction: direction || '',
    label: DIRECTION_LABEL[direction] || '実行',
    gameName: gameName || '',
    message,
    summary: message,
    report: {},
  });
  return { ok: false, message, setupError: true };
}

async function trigger(direction, source = 'manual', gameId = null) {
  const s = resolveJobSettings(gameId);
  if (!s || (gameId && !(s.games || []).some((g) => g.id === gameId))) {
    const message = '指定されたゲームが見つかりません。';
    noticeUi(message, { title: '実行できません' });
    return { ok: false, message };
  }
  const setupError = inspectJobSetup(direction, s);
  if (setupError) return reportSetupError(setupError, { direction, gameName: s.gameName });

  if (runner.busy) {
    const message = `実行中です(${DIRECTION_LABEL[runner.current]})。完了までお待ちください。`;
    noticeUi(message, { title: '実行中です', section: 'run', kind: 'error', logLevel: 'warn' });
    return { ok: false, message };
  }

  if (direction === 'restore' && s.confirmRestore) {
    const approved = await confirmRestore(s);
    if (!approved) {
      logEntry('info', '復元をキャンセルしました。');
      return { ok: false, canceled: true, message: '復元をキャンセルしました。' };
    }
  }

  if (gameId && gameId !== settings().activeGameId) {
    try {
      store.setActiveGame(gameId);
      sendToWindow('settings:changed', settings());
      updateTray();
    } catch {
      /* 実行は渡した設定で進める */
    }
  }

  return runner.run(direction, { trigger: source, settings: s });
}

// ------------------------------------------------------------------ shortcuts

function registerOneShortcut(game, direction, accelerator, seen) {
  if (!accelerator) {
    return { ok: true, accelerator: '', skipped: true };
  }
  const check = validateAccelerator(accelerator);
  if (!check.ok) return { ok: false, accelerator, error: check.error };
  const dupKey = accelerator.toLowerCase();
  if (seen.has(dupKey)) {
    return { ok: false, accelerator, error: '同じショートカットが重複しています。' };
  }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      trigger(direction, 'shortcut', game.id);
    });
    if (ok) seen.set(dupKey, `${game.id}:${direction}`);
    return ok
      ? { ok: true, accelerator }
      : { ok: false, accelerator, error: 'OSまたは他アプリに使用されているため登録できません。' };
  } catch (err) {
    return { ok: false, accelerator, error: err.message };
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = settings();
  const byGameId = {};
  const seen = new Map();

  for (const game of s.games || []) {
    const backup = registerOneShortcut(game, 'backup', game.shortcutBackup || '', seen);
    const restore = registerOneShortcut(game, 'restore', game.shortcutRestore || '', seen);
    byGameId[game.id] = { backup, restore };
  }

  shortcutState = { byGameId };
  for (const [gameId, value] of Object.entries(byGameId)) {
    const game = (s.games || []).find((g) => g.id === gameId);
    const name = game ? game.name || '(無題)' : gameId;
    for (const [kind, entry] of [
      ['バックアップ', value.backup],
      ['復元', value.restore],
    ]) {
      if (!entry || entry.skipped || entry.ok) continue;
      logEntry(
        'error',
        `ショートカット登録に失敗: ${name} / ${kind} (${formatAccelerator(entry.accelerator)})`,
        entry.error
      );
    }
  }
  sendToWindow('shortcuts:state', shortcutState);
  updateTray();
  return shortcutState;
}

// ----------------------------------------------------------------- login item

function applyLoginItem({ force = false } = {}) {
  const s = settings();
  try {
    // 既に一致しているなら触らない(未署名の開発実行で余計なエラーが出るのを避ける)
    if (!force && !s.launchAtLogin && !app.getLoginItemSettings().openAtLogin) return;

    const options = {
      openAtLogin: s.launchAtLogin,
      args: s.startHidden ? [HIDDEN_FLAG] : [],
    };
    if (process.platform === 'darwin') options.openAsHidden = s.startHidden;
    if (process.platform === 'win32') options.path = process.execPath;
    app.setLoginItemSettings(options);
  } catch (err) {
    logEntry('error', 'ログイン時起動の設定に失敗しました。', err.message);
    sendToWindow('ui:notice', {
      kind: 'error',
      message: `ログイン時起動の設定に失敗しました。${err.message}`,
    });
  }
}

function applyDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const s = settings();
  if (s.hideDockIcon && mainWindow && !mainWindow.isVisible()) app.dock.hide();
  else app.dock.show();
}

// ----------------------------------------------------------------------- tray

function updateTray() {
  if (!tray) return;
  const s = settings();
  const busy = runner.busy;
  const pinnedGroups = listPinnedGroups(s);
  const listed = listPinnedGames(s);
  const gameLabel = listed.length === 1 ? listed[0].name || '未設定' : `${listed.length} 件`;

  const gameMenus = [];
  for (const group of pinnedGroups) {
    const items = (s.games || []).filter((g) => g.pinned && g.groupId === group.id);
    for (const game of items) {
      const backupSc = game.shortcutBackup ? `   ${formatAccelerator(game.shortcutBackup)}` : '';
      const restoreSc = game.shortcutRestore ? `   ${formatAccelerator(game.shortcutRestore)}` : '';
      const prefix = group.name ? `${group.name} / ` : '';
      gameMenus.push({
        label: `${prefix}${game.name || '(無題)'}`,
        submenu: [
          {
            label: `バックアップ${backupSc}`,
            enabled: !busy,
            click: () => trigger('backup', 'tray', game.id),
          },
          {
            label: `復元${restoreSc}`,
            enabled: !busy,
            click: () => trigger('restore', 'tray', game.id),
          },
        ],
      });
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: listed.length > 0 ? `ピン留め: ${gameLabel}` : 'ピン留めされた経路はありません', enabled: false },
    ...(gameMenus.length > 0 ? gameMenus : []),
    { type: 'separator' },
    { label: '実行中の処理を中止', enabled: busy, click: () => runner.cancel() },
    { type: 'separator' },
    { label: '環境設定を開く…', click: () => showWindow('paths') },
    { label: 'SteamSaveBackup を終了', click: () => quitApp() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(
    busy
      ? `SteamSaveBackup: ${DIRECTION_LABEL[runner.current]} 実行中`
      : 'SteamSaveBackup'
  );
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setIgnoreDoubleClickEvents?.(true);
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else showWindow();
    });
  }
  updateTray();
}

// ----------------------------------------------------------------- app menu

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const runMenu = {
    label: '実行',
    submenu: [
      {
        label: 'コピー元 → バックアップ先にコピー',
        accelerator: 'CmdOrCtrl+1',
        click: () => trigger('backup', 'menu'),
      },
      {
        label: '復元元 → コピー元にコピー',
        accelerator: 'CmdOrCtrl+2',
        click: () => trigger('restore', 'menu'),
      },
      { type: 'separator' },
      { label: '中止', accelerator: 'CmdOrCtrl+.', click: () => runner.cancel() },
    ],
  };

  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'SteamSaveBackup について' },
        { type: 'separator' },
        { label: '環境設定…', accelerator: 'Cmd+,', click: () => showWindow('paths') },
        { type: 'separator' },
        { role: 'hide', label: '隠す' },
        { role: 'unhide', label: 'すべて表示' },
        { type: 'separator' },
        { label: '終了', accelerator: 'Cmd+Q', click: () => quitApp() },
      ],
    });
  } else {
    template.push({
      label: 'ファイル',
      submenu: [
        { label: '環境設定…', accelerator: 'Ctrl+,', click: () => showWindow('paths') },
        { type: 'separator' },
        { label: 'ウィンドウを閉じる(常駐は継続)', accelerator: 'Ctrl+W', role: 'close' },
        { label: '終了', accelerator: 'Alt+F4', click: () => quitApp() },
      ],
    });
  }

  template.push({
    label: '編集',
    submenu: [
      { role: 'undo', label: '取り消す' },
      { role: 'redo', label: 'やり直す' },
      { type: 'separator' },
      { role: 'cut', label: 'カット' },
      { role: 'copy', label: 'コピー' },
      { role: 'paste', label: 'ペースト' },
      { role: 'selectAll', label: 'すべて選択' },
    ],
  });
  template.push(runMenu);
  template.push({
    label: '表示',
    submenu: [
      { role: 'reload', label: '再読み込み' },
      { role: 'toggleDevTools', label: '開発者ツール' },
      { type: 'separator' },
      { role: 'resetZoom', label: '実際のサイズ' },
      { role: 'zoomIn', label: '拡大' },
      { role: 'zoomOut', label: '縮小' },
    ],
  });
  template.push({
    label: 'ヘルプ',
    submenu: [
      {
        label: '設定ファイルの場所を開く',
        click: () => shell.showItemInFolder(store.filePath),
      },
      { label: 'ログを開く', click: () => shell.openPath(history.logPath) },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function gamesShortcutFingerprint(s) {
  return (s.games || []).map((g) => `${g.id}:${g.shortcutBackup || ''}:${g.shortcutRestore || ''}`).join('|');
}

// ------------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: APP_PACKAGE.version,
    electron: process.versions.electron,
    platform: process.platform,
    settingsPath: store.filePath,
    logPath: history.logPath,
    defaults: defaultSettings(process.platform),
  }));

  ipcMain.handle('settings:get', () => ({
    settings: settings(),
    shortcuts: shortcutState,
    busy: runner.busy,
    current: runner.current,
  }));

  ipcMain.handle('settings:update', (_event, patch) => {
    try {
      const before = settings();
      const after = store.update(patch || {});

      if (gamesShortcutFingerprint(before) !== gamesShortcutFingerprint(after)) {
        registerShortcuts();
      }
      if (
        before.launchAtLogin !== after.launchAtLogin ||
        before.startHidden !== after.startHidden
      ) {
        applyLoginItem({ force: true });
      }
      if (before.hideDockIcon !== after.hideDockIcon) applyDockVisibility();

      updateTray();
      sendToWindow('settings:changed', after);
      return { settings: after, shortcuts: shortcutState };
    } catch (err) {
      logEntry('error', '設定の保存に失敗しました。', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: `設定の保存に失敗しました。${err.message}` });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('settings:reset', () => {
    const next = store.update(defaultSettings(process.platform));
    registerShortcuts();
    applyLoginItem();
    updateTray();
    sendToWindow('settings:changed', next);
    logEntry('info', '設定を初期値に戻しました。');
    return { settings: next, shortcuts: shortcutState };
  });

  const publishSettings = (after, message) => {
    registerShortcuts();
    updateTray();
    sendToWindow('settings:changed', after);
    if (message) logEntry('info', message);
    return { settings: after, shortcuts: shortcutState };
  };

  ipcMain.handle('game:add', (_event, partial) => {
    try {
      const after = store.addGame(partial || {});
      return publishSettings(after, after.gameName ? `ゲームを追加しました: ${after.gameName}` : '');
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:update', (_event, { id, patch } = {}) => {
    try {
      if (!id) throw new Error('ゲームIDが指定されていません。');
      const after = store.updateGame(id, patch || {});
      return publishSettings(after);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:remove', (_event, gameId) => {
    try {
      const before = settings();
      const target = (before.games || []).find((g) => g.id === gameId);
      const after = store.removeGame(gameId);
      return publishSettings(after, target ? `ゲームを削除しました: ${target.name}` : 'ゲームを削除しました。');
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:setActive', (_event, gameId) => {
    try {
      const after = store.setActiveGame(gameId);
      return publishSettings(after, `ゲームを切り替えました: ${after.gameName}`);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:reorder', (_event, payload) => {
    try {
      const orderedIds = Array.isArray(payload) ? payload : (payload && payload.orderedIds) || [];
      const groupId = Array.isArray(payload) ? undefined : payload && payload.groupId;
      const after = store.reorderGames(orderedIds, groupId);
      return publishSettings(after);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:duplicate', (_event, gameId) => {
    try {
      const after = store.duplicateGame(gameId);
      return publishSettings(after, after.gameName ? `経路をコピーしました: ${after.gameName}` : '経路をコピーしました。');
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('game:move', (_event, { gameId, groupId, beforeId } = {}) => {
    try {
      if (!gameId) throw new Error('ゲームIDが指定されていません。');
      const after = store.moveGame(gameId, groupId, beforeId || '');
      return publishSettings(after);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('group:add', (_event, partial) => {
    try {
      const after = store.addGroup(partial || {});
      return publishSettings(after, `グループを追加しました: ${after.groups[after.groups.length - 1].name}`);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('group:update', (_event, { id, patch } = {}) => {
    try {
      if (!id) throw new Error('グループIDが指定されていません。');
      const after = store.updateGroup(id, patch || {});
      return publishSettings(after);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('group:remove', (_event, groupId) => {
    try {
      const before = settings();
      const target = (before.groups || []).find((g) => g.id === groupId);
      const after = store.removeGroup(groupId);
      return publishSettings(after, target ? `グループを削除しました: ${target.name}` : 'グループを削除しました。');
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('group:reorder', (_event, orderedIds) => {
    try {
      const after = store.reorderGroups(orderedIds || []);
      return publishSettings(after);
    } catch (err) {
      logEntry('error', err.message);
      sendToWindow('ui:notice', { kind: 'error', message: err.message });
      return { ok: false, error: err.message, settings: settings(), shortcuts: shortcutState };
    }
  });

  ipcMain.handle('dialog:pickFolder', async (_event, { current, title } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'フォルダを選択',
      defaultPath: current && fs.existsSync(current) ? current : undefined,
      properties: ['openDirectory', 'createDirectory', 'treatPackageAsDirectory'],
      buttonLabel: '選択',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('path:validate', async (_event, target) => {
    const normalized = normalizeInputPath(target);
    if (!normalized) return { normalized: '', exists: false, isDirectory: false, message: '' };
    try {
      const stat = await fsp.stat(normalized);
      return {
        normalized,
        exists: true,
        isDirectory: stat.isDirectory(),
        message: stat.isDirectory() ? '' : 'フォルダではありません。',
      };
    } catch (err) {
      return {
        normalized,
        exists: false,
        isDirectory: false,
        message:
          err.code === 'ENOENT'
            ? '現在アクセスできません(未マウント/未作成の可能性)。'
            : `確認できません: ${err.code || err.message}`,
      };
    }
  });

  ipcMain.handle('job:run', (_event, payload) => {
    if (payload && typeof payload === 'object') {
      return trigger(payload.direction, 'ui', payload.gameId || null);
    }
    return trigger(payload, 'ui');
  });
  ipcMain.handle('job:cancel', () => {
    runner.cancel();
    return true;
  });
  ipcMain.handle('job:status', () => ({ busy: runner.busy, current: runner.current }));

  ipcMain.handle('snapshots:list', async (_event, gameId) => {
    const s = gameId ? resolveJobSettings(gameId) : settings();
    if (!s || !s.path2) return [];
    const names = await listSnapshots(s.path2);
    return names.slice(0, 50).map((name) => ({
      name,
      label: describeSnapshot(name),
      fullPath: path.join(s.path2, name),
    }));
  });

  // ショートカット文字列の生成/整形はコア側に集約(レンダラーは表示のみ)
  ipcMain.handle('accelerator:build', (_event, keyEvent) => {
    const accelerator = acceleratorFromKeyEvent(keyEvent || {}, process.platform);
    if (!accelerator) {
      return { ok: false, error: '修飾キー(Cmd/Ctrl/Alt/Shift/Win)＋通常キーで入力してください。' };
    }
    const check = validateAccelerator(accelerator);
    return {
      ok: check.ok,
      error: check.error || '',
      accelerator,
      display: formatAccelerator(accelerator, process.platform),
    };
  });

  ipcMain.handle('accelerator:format', (_event, accelerator) =>
    formatAccelerator(accelerator, process.platform)
  );

  // 録音中に既存のショートカットが発火してコピーが走るのを防ぐ
  ipcMain.handle('shortcuts:suspend', () => {
    globalShortcut.unregisterAll();
    return true;
  });

  ipcMain.handle('shortcuts:resume', () => registerShortcuts());

  ipcMain.handle('history:get', () => history.list());
  ipcMain.handle('history:clear', () => {
    history.clear();
    return true;
  });

  ipcMain.handle('shell:open', async (_event, target) => {
    const normalized = normalizeInputPath(target);
    if (!normalized) return 'パスが未設定です。';
    try {
      return (await shell.openPath(normalized)) || '';
    } catch (err) {
      return err.message || 'フォルダを開けませんでした。';
    }
  });

  ipcMain.handle('shell:openLog', async () => {
    try {
      return (await shell.openPath(history.logPath)) || '';
    } catch (err) {
      return err.message || 'ログファイルを開けませんでした。';
    }
  });
}

// -------------------------------------------------------------- job listeners

function bindRunnerEvents() {
  runner.on('start', (info) => {
    updateTray();
    sendToWindow('job:start', info);
    const label = info.snapshotName ? ` [${info.snapshotName}]` : '';
    logEntry('info', `開始: ${info.label}${label}`, `${info.src}  →  ${info.dest}`);
  });

  runner.on('progress', (p) => {
    const ratio = progressRatio(p);
    sendToWindow('job:progress', {
      ...p,
      ratio,
      doneBytesText: formatBytes(p.doneBytes),
      totalBytesText: formatBytes(p.totalBytes),
    });
    if (tray) {
      const pct = Math.round(ratio * 100);
      tray.setToolTip(
        p.phase === 'scan'
          ? `SteamSaveBackup: 走査中 ${p.totalFiles} 件`
          : `SteamSaveBackup: ${pct}% (${p.doneFiles}/${p.totalFiles} 件 ${formatBytes(p.doneBytes)})`
      );
    }
  });

  runner.on('done', (result) => {
    updateTray();
    const summary = summarizeResult(result);
    sendToWindow('job:done', { ...result, summary });
    const level = result.ok ? 'info' : result.report.canceled ? 'warn' : 'error';
    const detail = (result.report.errors || [])
      .slice(0, 5)
      .map((e) => `${e.path}: ${e.message}`)
      .join('\n');
    logEntry(level, `完了: ${result.label} — ${summary}`, detail);
    if (result.pruned && result.pruned.removed.length > 0) {
      logEntry('info', `古いスナップショットを削除: ${result.pruned.removed.join(', ')}`);
    }
    notify(
      result.ok ? `完了: ${result.label}` : `注意: ${result.label}`,
      `${summary}\n${result.dest}`
    );
    if (!result.ok && !(result.report && result.report.canceled)) {
      revealWindow();
      sendToWindow('ui:notice', { kind: 'error', message: summary, section: '' });
    }
  });

  runner.on('failed', (result) => {
    updateTray();
    sendToWindow('job:done', { ...result, summary: result.message });
    logEntry('error', `失敗: ${result.label}`, result.message);
    notify(`失敗: ${result.label}`, result.message);
    if (result.setupError) {
      showWindow('paths');
      sendToWindow('ui:notice', { kind: 'error', message: result.message, section: 'paths' });
    } else {
      revealWindow('run');
      sendToWindow('ui:notice', { kind: 'error', message: result.message, section: 'run' });
    }
  });

  runner.on('rejected', (result) => {
    noticeUi(result.message || '実行中です。完了までお待ちください。', {
      title: '実行中です',
      section: 'run',
      kind: 'error',
      logLevel: 'warn',
    });
  });
}

// ------------------------------------------------------------------- bootstrap

function shouldStartHidden() {
  const s = settings();
  if (!s.startHidden) return false;
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  try {
    return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch {
    return false;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    store = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    store.load();
    history = new History(path.join(app.getPath('userData'), 'activity.log'));
    runner = new JobRunner(() => settings());

    bindRunnerEvents();
    registerIpc();
    buildAppMenu();
    createTray();

    const hidden = shouldStartHidden();
    createWindow({ show: !hidden });
    if (hidden && process.platform === 'darwin' && settings().hideDockIcon && app.dock) {
      app.dock.hide();
    }

    registerShortcuts();
    applyLoginItem();

    if (store.loadError) {
      logEntry('warn', '設定ファイルが壊れていたため初期値で起動しました。', store.loadError);
    }
    logEntry('info', `起動しました (v${APP_PACKAGE.version} / ${process.platform})`);

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // トレイ常駐のため終了しない
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
