'use strict';

/**
 * Electron 起動〜コピー実行までの統合スモークテスト。
 * 本体(src/main/main.js)には手を入れず、外側から状態を検査して自動終了する。
 *   npx electron test/smoke/entry.js --user-data-dir=<tmp> --hidden
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { app, BrowserWindow, globalShortcut } = require('electron');

const problems = [];
const rendererLogs = [];
const details = {};

// main.js がウィンドウを作る前に購読しておく(初期化時のエラーを取りこぼさないため)
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    rendererLogs.push(`${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  contents.on('preload-error', (_e, preloadPath, error) => {
    problems.push(`preload エラー: ${preloadPath} ${error.message}`);
  });
  contents.on('did-fail-load', (_e, code, desc) => {
    problems.push(`読み込み失敗: ${code} ${desc}`);
  });
});

require('../../src/main/main.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) problems.push(message);
}

function finish() {
  const ok = problems.length === 0 && rendererLogs.every((l) => !l.startsWith('error'));
  process.stdout.write(
    `SMOKE_RESULT:${JSON.stringify({ ok, details, rendererLogs, problems })}\n`
  );
  app.exit(ok ? 0 : 1);
}

/** 経路1/経路2用の一時フォルダを用意する。 */
function seedFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-smoke-'));
  const path1 = path.join(base, 'live');
  const path2 = path.join(base, 'backup');
  fs.mkdirSync(path.join(path1, 'config', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(path1, 'save01.dat'), 'slot1');
  fs.writeFileSync(path.join(path1, 'config', 'settings.ini'), 'volume=5');
  fs.writeFileSync(path.join(path1, 'config', 'profiles', 'p1.json'), '{"n":1}');
  fs.writeFileSync(path.join(path1, '.DS_Store'), 'junk');
  fs.mkdirSync(path2, { recursive: true });
  return { base, path1, path2 };
}

async function run() {
  await wait(1200);

  // ---- 1. 起動状態
  const windows = BrowserWindow.getAllWindows();
  check(windows.length === 1, `ウィンドウ数が想定外: ${windows.length}`);
  const win = windows[0];
  if (!win) return finish();

  if (win.webContents.isLoading()) {
    await Promise.race([
      new Promise((resolve) => win.webContents.once('did-finish-load', resolve)),
      wait(8000),
    ]);
  }
  await wait(1200);

  const expected = process.platform === 'darwin' ? 'Command' : 'Super';
  details.registered = {
    backup: globalShortcut.isRegistered(`${expected}+Alt+Shift+A`),
    restore: globalShortcut.isRegistered(`${expected}+Alt+Shift+Z`),
  };
  check(details.registered.backup, 'バックアップ用グローバルショートカットが未登録');
  check(details.registered.restore, '復元用グローバルショートカットが未登録');

  // ---- 2. 初期表示
  const dom = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    navItems: document.querySelectorAll('.nav-item').length,
    backupKey: document.getElementById('btnBackupKey').textContent,
    restoreKey: document.getElementById('btnRestoreKey').textContent,
    excludes: document.getElementById('inputExcludes').value,
    keepSnapshots: document.getElementById('inputKeepSnapshots').value,
    concurrency: document.getElementById('inputConcurrency').value,
    version: document.getElementById('appVersion').textContent,
    backupStatus: document.getElementById('statusKeyBackup').textContent,
    logCount: document.querySelectorAll('#logList li').length,
    hasApi: typeof window.api === 'object'
  }))()`);
  details.dom = dom;

  check(dom.hasApi, 'preload の window.api が公開されていない');
  check(dom.navItems === 6, `ナビ項目数が想定外: ${dom.navItems}`);
  check(dom.backupKey.length > 1, 'ショートカット表示が未反映');
  check(dom.excludes.includes('.DS_Store'), '除外パターンの初期値が未反映');
  check(dom.logCount >= 1, '起動ログが表示されていない');

  // ---- 3. 設定更新 → バックアップ実行(レンダラー経由 = 実際の操作と同じ経路)
  const fixture = seedFixture();
  details.fixture = fixture;

  const backup = await win.webContents.executeJavaScript(`(async () => {
    await window.api.updateSettings({
      path1: ${JSON.stringify(fixture.path1)},
      path2: ${JSON.stringify(fixture.path2)},
      notifications: false,
      confirmRestore: false
    });
    return window.api.runJob('backup');
  })()`);
  details.backup = {
    ok: backup.ok,
    snapshotName: backup.snapshotName,
    copiedFiles: backup.report && backup.report.copiedFiles,
    errorCount: backup.report && backup.report.errorCount,
    message: backup.message,
  };

  check(backup.ok === true, `バックアップが失敗: ${backup.message || JSON.stringify(backup.report)}`);

  // 設定変更後に経路の状態表示が追従しているか
  const pathStatus = await win.webContents.executeJavaScript(`({
    path1: document.getElementById('statusPath1').textContent,
    path2: document.getElementById('statusPath2').textContent,
    runPath1: document.getElementById('runPath1').textContent
  })`);
  details.pathStatus = pathStatus;
  check(pathStatus.path1.startsWith('OK:'), `経路1の状態表示が未更新: ${pathStatus.path1}`);
  check(pathStatus.path2.startsWith('OK:'), `経路2の状態表示が未更新: ${pathStatus.path2}`);
  check(pathStatus.runPath1 === fixture.path1, '実行タブの経路表示が未更新');
  check(
    /^\d{8}_\d{4}$/.test(backup.snapshotName || ''),
    `スナップショット名が仕様と違う: ${backup.snapshotName}`
  );

  const snapshotDir = path.join(fixture.path2, backup.snapshotName || 'missing');
  check(fs.existsSync(path.join(snapshotDir, 'save01.dat')), 'ファイルがコピーされていない');
  check(
    fs.existsSync(path.join(snapshotDir, 'config', 'profiles', 'p1.json')),
    'サブディレクトリがコピーされていない'
  );
  check(!fs.existsSync(path.join(snapshotDir, '.DS_Store')), '除外パターンが効いていない');

  // ---- 4. スナップショット一覧の「復元元にする」で復元元を設定
  const picked = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-section="snapshots"]').click();
    await new Promise((r) => setTimeout(r, 800));
    const button = [...document.querySelectorAll('#snapshotList .link-btn')]
      .find((b) => b.textContent === '復元元にする');
    if (!button) return { found: false };
    button.click();
    await new Promise((r) => setTimeout(r, 800));
    const current = await window.api.getSettings();
    return { found: true, restorePath: current.settings.restorePath };
  })()`);
  details.picked = picked;

  check(picked.found === true, 'スナップショット一覧に「復元元にする」が出ていない');
  check(picked.restorePath === snapshotDir, `復元元フォルダが設定されていない: ${picked.restorePath}`);

  // ---- 5. 経路1を壊してから復元(日時フォルダを作らず強制上書き)
  fs.rmSync(path.join(fixture.path1, 'config'), { recursive: true, force: true });
  fs.writeFileSync(path.join(fixture.path1, 'save01.dat'), 'broken');
  fs.chmodSync(path.join(fixture.path1, 'save01.dat'), 0o444);

  const restore = await win.webContents.executeJavaScript(`window.api.runJob('restore')`);
  details.restore = {
    ok: restore.ok,
    snapshotName: restore.snapshotName,
    src: restore.src,
    dest: restore.dest,
    copiedFiles: restore.report && restore.report.copiedFiles,
    skippedFiles: restore.report && restore.report.skippedFiles,
    message: restore.message,
  };

  check(restore.ok === true, `復元が失敗: ${restore.message}`);
  check(restore.snapshotName === null, '復元で日時フォルダが使われている');
  check(restore.src === snapshotDir, '復元元フォルダから復元していない');
  check(restore.dest === fixture.path1, '復元先が経路1になっていない');
  check(restore.report.skippedFiles === 0, '復元が強制上書きになっていない(スキップが発生)');
  check(
    fs.readFileSync(path.join(fixture.path1, 'save01.dat'), 'utf8') === 'slot1',
    '読み取り専用ファイルを上書きできていない'
  );
  check(
    fs.existsSync(path.join(fixture.path1, 'config', 'profiles', 'p1.json')),
    '復元でサブディレクトリが戻っていない'
  );
  check(
    !fs.readdirSync(fixture.path1).some((name) => /^\d{8}_\d{4}/.test(name)),
    '経路1に日時フォルダが作られてしまっている'
  );

  // ---- 6. ショートカット変更が反映されるか
  const changed = await win.webContents.executeJavaScript(`(async () => {
    const built = await window.api.buildAccelerator({
      code: 'KeyB', key: 'b', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true
    });
    const saved = await window.api.updateSettings({ shortcutBackup: built.accelerator });
    return { built, shortcuts: saved.shortcuts };
  })()`);
  details.shortcutChange = changed;

  const newAccel = process.platform === 'darwin' ? 'Command+Alt+Shift+B' : 'Super+Alt+Shift+B';
  check(changed.built.accelerator === newAccel, `生成されたショートカットが想定外: ${changed.built.accelerator}`);
  check(globalShortcut.isRegistered(newAccel), '変更後のショートカットが登録されていない');
  check(
    !globalShortcut.isRegistered(`${expected}+Alt+Shift+A`),
    '変更前のショートカットが解除されていない'
  );

  // ---- 7. スナップショット一覧
  const snapshots = await win.webContents.executeJavaScript(`window.api.listSnapshots()`);
  details.snapshots = snapshots;
  check(snapshots.length === 1, `スナップショット一覧が想定外: ${snapshots.length}`);

  // ---- 8. ウィンドウを閉じても常駐し続ける
  win.close();
  await wait(500);
  details.afterClose = {
    windowExists: !win.isDestroyed(),
    visible: win.isDestroyed() ? null : win.isVisible(),
    shortcutStillRegistered: globalShortcut.isRegistered(newAccel),
  };
  check(details.afterClose.windowExists, 'ウィンドウが破棄された(常駐できていない)');
  check(details.afterClose.visible === false, 'ウィンドウが隠れていない');
  check(details.afterClose.shortcutStillRegistered, '閉じたらショートカットが失われた');

  fs.rmSync(fixture.base, { recursive: true, force: true });
  finish();
}

app.whenReady().then(() =>
  run().catch((err) => {
    problems.push(`スモークテスト自体が例外: ${err.stack || err.message}`);
    finish();
  })
);

setTimeout(() => {
  problems.push('タイムアウト');
  finish();
}, 60000);
