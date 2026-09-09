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

const { SettingsStore, defaultSettings } = require('../core/settings');
const { JobRunner, DIRECTION_LABEL } = require('../core/jobs');
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
const HIDDEN_FLAG = '--hidden';

let store = null;
let history = null;
let runner = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let shortcutState = { backup: { ok: false }, restore: { ok: false } };

// ------------------------------------------------------------------ utilities

function settings() {
  return store.get();
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
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
    width: 940,
    height: 780,
    minWidth: 720,
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

async function confirmRestore() {
  const s = settings();

  if (process.platform === 'darwin') app.focus({ steal: true });

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['復元する', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    title: '復元の確認',
    message: '復元元フォルダ → 経路1 へコピーします。よろしいですか?',
    detail:
      `コピー元: ${s.restorePath}\nコピー先: ${s.path1}\n\n` +
      '日時フォルダは作らず、経路1の同名ファイルを強制的に上書きします。',
    noLink: true,
  });
  return response === 0;
}

/** 方向ごとに必要な経路が揃っているか確認する。 */
function missingPathMessage(direction, s) {
  if (direction === 'backup') {
    if (!s.path1) return '経路1を設定してください。';
    if (!s.path2) return '経路2を設定してください。';
    return null;
  }
  if (!s.restorePath) return '復元元フォルダを設定してください。';
  if (!s.path1) return '経路1を設定してください。';
  return null;
}

async function trigger(direction, source = 'manual') {
  const s = settings();
  const missing = missingPathMessage(direction, s);
  if (missing) {
    logEntry('warn', missing);
    notify('SteamSaveBackup', missing);
    showWindow('paths');
    return { ok: false, message: missing };
  }

  if (runner.busy) {
    const message = `実行中です(${DIRECTION_LABEL[runner.current]})。完了までお待ちください。`;
    logEntry('warn', message);
    notify('SteamSaveBackup', message);
    return { ok: false, message };
  }

  if (direction === 'restore' && s.confirmRestore) {
    const approved = await confirmRestore();
    if (!approved) {
      logEntry('info', '復元をキャンセルしました。');
      return { ok: false, canceled: true, message: '復元をキャンセルしました。' };
    }
  }

  return runner.run(direction, { trigger: source });
}

// ------------------------------------------------------------------ shortcuts

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = settings();
  const state = {};
  const seen = new Map();

  const entries = [
    ['backup', s.shortcutBackup],
    ['restore', s.shortcutRestore],
  ];

  for (const [key, accelerator] of entries) {
    const check = validateAccelerator(accelerator);
    if (!check.ok) {
      state[key] = { ok: false, accelerator, error: check.error };
      continue;
    }
    const dupKey = accelerator.toLowerCase();
    if (seen.has(dupKey)) {
      state[key] = { ok: false, accelerator, error: '同じショートカットが重複しています。' };
      continue;
    }
    try {
      const ok = globalShortcut.register(accelerator, () => {
        trigger(key, 'shortcut');
      });
      state[key] = ok
        ? { ok: true, accelerator }
        : { ok: false, accelerator, error: 'OSまたは他アプリに使用されているため登録できません。' };
      if (ok) seen.set(dupKey, key);
    } catch (err) {
      state[key] = { ok: false, accelerator, error: err.message };
    }
  }

  shortcutState = state;
  for (const [key, value] of Object.entries(state)) {
    if (!value.ok) {
      logEntry(
        'error',
        `ショートカット登録に失敗: ${DIRECTION_LABEL[key]} (${formatAccelerator(value.accelerator)})`,
        value.error
      );
    }
  }
  sendToWindow('shortcuts:state', state);
  updateTray();
  return state;
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

  const menu = Menu.buildFromTemplate([
    {
      label: `経路1 → 経路2 にコピー   ${formatAccelerator(s.shortcutBackup)}`,
      enabled: !busy,
      click: () => trigger('backup', 'tray'),
    },
    {
      label: `復元元 → 経路1 にコピー   ${formatAccelerator(s.shortcutRestore)}`,
      enabled: !busy,
      click: () => trigger('restore', 'tray'),
    },
    { type: 'separator' },
    { label: '実行中の処理を中止', enabled: busy, click: () => runner.cancel() },
    { type: 'separator' },
    {
      label: '経路1をファイラで開く',
      enabled: Boolean(s.path1),
      click: () => shell.openPath(s.path1),
    },
    {
      label: '経路2をファイラで開く',
      enabled: Boolean(s.path2),
      click: () => shell.openPath(s.path2),
    },
    {
      label: '復元元フォルダをファイラで開く',
      enabled: Boolean(s.restorePath),
      click: () => shell.openPath(s.restorePath),
    },
    { type: 'separator' },
    { label: '環境設定を開く…', click: () => showWindow('paths') },
    { label: 'SteamSaveBackup を終了', click: () => quitApp() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(
    busy ? `SteamSaveBackup: ${DIRECTION_LABEL[runner.current]} 実行中` : 'SteamSaveBackup'
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
        label: '経路1 → 経路2 にコピー',
        accelerator: 'CmdOrCtrl+1',
        click: () => trigger('backup', 'menu'),
      },
      {
        label: '復元元 → 経路1 にコピー',
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

// ------------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
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
    const before = settings();
    const after = store.update(patch || {});

    if (
      before.shortcutBackup !== after.shortcutBackup ||
      before.shortcutRestore !== after.shortcutRestore
    ) {
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

  ipcMain.handle('job:run', (_event, direction) => trigger(direction, 'ui'));
  ipcMain.handle('job:cancel', () => {
    runner.cancel();
    return true;
  });
  ipcMain.handle('job:status', () => ({ busy: runner.busy, current: runner.current }));

  ipcMain.handle('snapshots:list', async () => {
    const s = settings();
    if (!s.path2) return [];
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
    return shell.openPath(normalized);
  });

  ipcMain.handle('shell:openLog', () => shell.openPath(history.logPath));
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
  });

  runner.on('failed', (result) => {
    updateTray();
    sendToWindow('job:done', { ...result, summary: result.message });
    logEntry('error', `失敗: ${result.label}`, result.message);
    notify(`失敗: ${result.label}`, result.message);
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

    logEntry('info', `起動しました (v${app.getVersion()} / ${process.platform})`);

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
