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

  await win.webContents.executeJavaScript(`window.api.resetSettings()`);
  await wait(400);

  const expected = process.platform === 'darwin' ? 'Command' : 'Super';
  details.registered = {
    backup: globalShortcut.isRegistered(`${expected}+Alt+Shift+A`),
    restore: globalShortcut.isRegistered(`${expected}+Alt+Shift+Z`),
  };
  check(!details.registered.backup, '未設定なのにバックアップ用ショートカットが登録されている');
  check(!details.registered.restore, '未設定なのに復元用ショートカットが登録されている');

  // ---- 2. 初期表示
  const dom = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    navItems: [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.section),
    excludes: document.getElementById('inputExcludes').value,
    keepSnapshots: document.getElementById('inputKeepSnapshots').value,
    concurrency: document.getElementById('inputConcurrency').value,
    version: document.getElementById('appVersion').textContent,
    runEmpty: Boolean(
      document.querySelector('#runGroups .empty-row') || document.querySelector('#runGroups .group-empty')
    ),
    groupBlocks: document.querySelectorAll('#pathsGroups .group-block').length,
    logCount: document.querySelectorAll('#logList li').length,
    hasApi: typeof window.api === 'object',
    hasShortcutTab: Boolean(document.querySelector('.nav-item[data-section="shortcuts"]'))
  }))()`);
  details.dom = dom;

  check(dom.hasApi, 'preload の window.api が公開されていない');
  check(dom.navItems.length === 5, `ナビ項目数が想定外: ${JSON.stringify(dom.navItems)}`);
  check(!dom.hasShortcutTab, 'ショートカットタブが残っている');
  check(dom.version === 'v1.2.5', `バージョン表示が想定外: ${dom.version}`);
  check(dom.runEmpty === true, 'ピン留めが無いのに実行テーブルが空でない');
  check(dom.groupBlocks === 1, `初期グループ数が想定外: ${dom.groupBlocks}`);
  check(dom.excludes.includes('.DS_Store'), '除外パターンの初期値が未反映');
  check(dom.logCount >= 1, '起動ログが表示されていない');

  // ---- 3. 設定更新 → バックアップ実行(レンダラー経由 = 実際の操作と同じ経路)
  const fixture = seedFixture();
  details.fixture = fixture;

  const backup = await win.webContents.executeJavaScript(`(async () => {
    await window.api.updateSettings({
      gameName: 'Smoke Game',
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
    gameName: backup.gameName,
    copiedFiles: backup.report && backup.report.copiedFiles,
    errorCount: backup.report && backup.report.errorCount,
    message: backup.message,
  };

  check(backup.ok === true, `バックアップが失敗: ${backup.message || JSON.stringify(backup.report)}`);
  check(backup.gameName === 'Smoke Game', `ゲーム名が結果に無い: ${backup.gameName}`);

  // 追加ボタンは下書き行を出すだけ。名前を入れて初めて保存される
  const games = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-section="paths"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.add-row-btn').click();
    await new Promise((r) => setTimeout(r, 200));
    const beforeFill = await window.api.getSettings();
    const nameInput = document.querySelector('input[data-game-id="_draft"][data-field="name"]');
    if (!nameInput) return { missingDraft: true, beforeCount: beforeFill.settings.games.length };
    nameInput.value = 'ゲーム2';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const mid = await window.api.getSettings();
    nameInput.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 500));
    const afterAdd = await window.api.getSettings();
    const names = afterAdd.settings.games.map((g) => g.name);
    return {
      beforeCount: beforeFill.settings.games.length,
      midCount: mid.settings.games.length,
      list: names,
      count: afterAdd.settings.games.length,
      pathRows: document.querySelectorAll('#pathsGroups tr[data-game-id]').length,
      runRows: document.querySelectorAll('#runGroups tr:not(.empty-row)').length,
      groups: afterAdd.settings.groups.length,
      groupPinned: afterAdd.settings.groups[0] && afterAdd.settings.groups[0].pinned
    };
  })()`);
  details.games = games;
  check(games.beforeCount === 1, `下書きだけでは保存されてしまう: ${games.beforeCount}`);
  check(games.midCount === 1, `入力途中なのに自動保存されている: ${games.midCount}`);
  check(games.count === 2, `ゲーム数が想定外: ${games.count}`);
  check(games.list.includes('Smoke Game'), '元のゲームが一覧に無い');
  check(games.list.includes('ゲーム2'), `追加ゲーム名が想定外: ${JSON.stringify(games.list)}`);
  check(games.pathRows === 2, `経路テーブルの行数が想定外: ${games.pathRows}`);
  check(games.groups === 1, `グループ数が想定外: ${games.groups}`);
  check(games.groupPinned === true, '既定グループがピン留めされていない');

  // コピー・グループ移動・削除（確認ダイアログは API 経由で回避）
  const organize = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-section="paths"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const lastGroupDelete = [...document.querySelectorAll('.group-head .btn.danger')]
      .find((b) => b.textContent === '削除');
    const hasCopyBtn = [...document.querySelectorAll('.row-actions .btn')]
      .some((b) => b.textContent === 'コピー');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const current = await window.api.getSettings();
    const source = current.settings.games.find((g) => g.name === 'Smoke Game');
    const duplicated = await window.api.duplicateGame(source.id);
    const copy = duplicated.settings.games.find((g) => g.name === 'Smoke Game のコピー');
    const addedGroup = await window.api.addGroup({ name: '移動先' });
    const destId = addedGroup.settings.groups.find((g) => g.name === '移動先').id;
    await new Promise((r) => setTimeout(r, 400));
    const moveSelects = document.querySelectorAll('.move-select').length;
    const wrap = document.querySelector('#pathsGroups .table-wrap');
    const tableOverflow = wrap
      ? { client: wrap.clientWidth, scroll: wrap.scrollWidth }
      : { missing: true };
    const moved = await window.api.moveGame(copy.id, destId, '');
    const movedGame = moved.settings.games.find((g) => g.id === copy.id);
    const removedGame = await window.api.removeGame(copy.id);
    const removedGroup = await window.api.removeGroup(destId);
    return {
      lastGroupDeleteDisabled: Boolean(lastGroupDelete && lastGroupDelete.disabled),
      hasCopyBtn,
      copyName: copy && copy.name,
      copyShortcut: copy && copy.shortcutBackup,
      moveSelects,
      movedGroupId: movedGame && movedGame.groupId,
      destId,
      leftoverNames: removedGroup.settings.games.map((g) => g.name).sort(),
      leftoverGroups: removedGroup.settings.groups.map((g) => g.name),
      afterCopyCount: duplicated.settings.games.length,
      afterRemoveGameCount: removedGame.settings.games.length,
      tableOverflow
    };
  })()`);
  details.organize = organize;
  check(organize.lastGroupDeleteDisabled === true, '最後のグループの削除が無効になっていない');
  check(organize.hasCopyBtn === true, '経路のコピーボタンが無い');
  check(organize.copyName === 'Smoke Game のコピー', `コピー名が想定外: ${organize.copyName}`);
  check(organize.copyShortcut === '', 'コピーした経路にショートカットが残っている');
  check(organize.moveSelects >= 1, 'グループ移動のセレクトが出ていない');
  check(
    organize.tableOverflow &&
      !organize.tableOverflow.missing &&
      organize.tableOverflow.scroll <= organize.tableOverflow.client + 1,
    `既定幅なのに経路テーブルが横スクロールしている: ${JSON.stringify(organize.tableOverflow)}`
  );
  check(organize.movedGroupId === organize.destId, 'グループを跨いだ移動ができていない');
  check(organize.afterCopyCount === 3, `コピー後の経路数が想定外: ${organize.afterCopyCount}`);
  check(organize.afterRemoveGameCount === 2, `経路削除後の件数が想定外: ${organize.afterRemoveGameCount}`);
  check(organize.leftoverGroups.length === 1, `グループ削除後の件数が想定外: ${JSON.stringify(organize.leftoverGroups)}`);
  check(
    JSON.stringify(organize.leftoverNames) === JSON.stringify(['Smoke Game', 'ゲーム2']),
    `削除後に残った経路が想定外: ${JSON.stringify(organize.leftoverNames)}`
  );

  await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-section="run"]').click()`);
  await wait(400);
  const runStatus = await win.webContents.executeJavaScript(`({
    runRows: [...document.querySelectorAll('#runGroups tbody tr:not(.empty-row)')].map((tr) => tr.children[0] && tr.children[0].textContent),
    path1: document.querySelector('#runGroups tbody tr:not(.empty-row) td:nth-child(2)') &&
      document.querySelector('#runGroups tbody tr:not(.empty-row) td:nth-child(2)').textContent,
    groupTitles: [...document.querySelectorAll('#runGroups .group-title')].map((el) => el.textContent)
  })`);
  details.runStatus = runStatus;
  check(runStatus.runRows.includes('Smoke Game'), `実行タブにピン留めゲームが無い: ${JSON.stringify(runStatus.runRows)}`);
  check(!runStatus.runRows.includes('ゲーム2'), 'ピン留めしていないゲームが実行タブに出ている');
  check(runStatus.path1 === fixture.path1, `実行タブのコピー元が未更新: ${runStatus.path1}`);
  check(runStatus.groupTitles.length === 1, `実行タブのグループ数が想定外: ${JSON.stringify(runStatus.groupTitles)}`);
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
    const current = await window.api.getSettings();
    const smoke = current.settings.games.find((g) => g.name === 'Smoke Game');
    if (smoke) await window.api.setActiveGame(smoke.id);
    document.querySelector('.nav-item[data-section="snapshots"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const select = document.getElementById('selectSnapshotGame');
    if (smoke) {
      select.value = smoke.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 800));
    const button = [...document.querySelectorAll('#snapshotList .link-btn')]
      .find((b) => b.textContent === '復元元にする');
    if (!button) return { found: false };
    button.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = await window.api.getSettings();
    const target = after.settings.games.find((g) => g.name === 'Smoke Game');
    return { found: true, restorePath: target && target.restorePath };
  })()`);
  details.picked = picked;

  check(picked.found === true, 'スナップショット一覧に「復元元にする」が出ていない');
  check(picked.restorePath === snapshotDir, `復元元フォルダが設定されていない: ${picked.restorePath}`);

  // ---- 5. 経路1を壊してから復元(日時フォルダを作らず強制上書き)
  fs.rmSync(path.join(fixture.path1, 'config'), { recursive: true, force: true });
  fs.writeFileSync(path.join(fixture.path1, 'save01.dat'), 'broken');
  fs.chmodSync(path.join(fixture.path1, 'save01.dat'), 0o444);

  const restore = await win.webContents.executeJavaScript(`(async () => {
    const current = await window.api.getSettings();
    const smoke = current.settings.games.find((g) => g.name === 'Smoke Game');
    return window.api.runJob('restore', smoke && smoke.id);
  })()`);
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

  // ---- 5b. 経路が無い／存在しないときは経路設定タブ＋エラー通知
  const pathError = await win.webContents.executeJavaScript(`(async () => {
    const current = await window.api.getSettings();
    const smoke = current.settings.games.find((g) => g.name === 'Smoke Game');
    document.querySelector('.nav-item[data-section="run"]').click();
    await new Promise((r) => setTimeout(r, 200));
    await window.api.updateGame(smoke.id, { path1: '' });
    const emptyRun = await window.api.runJob('backup', smoke.id);
    await new Promise((r) => setTimeout(r, 300));
    const emptyUi = {
      ok: emptyRun.ok,
      message: emptyRun.message,
      pathsActive: document.getElementById('section-paths').classList.contains('is-active'),
      toast: document.getElementById('toast').textContent,
      toastShown: document.getElementById('toast').classList.contains('is-show'),
      alert: document.getElementById('pathsAlert') && document.getElementById('pathsAlert').textContent
    };
    const missingPath = ${JSON.stringify(path.join('/tmp', 'ssb-missing-path-does-not-exist'))};
    await window.api.updateGame(smoke.id, { path1: missingPath });
    document.querySelector('.nav-item[data-section="run"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const missingRun = await window.api.runJob('backup', smoke.id);
    await new Promise((r) => setTimeout(r, 300));
    const missingUi = {
      ok: missingRun.ok,
      message: missingRun.message,
      pathsActive: document.getElementById('section-paths').classList.contains('is-active'),
      toast: document.getElementById('toast').textContent,
      toastShown: document.getElementById('toast').classList.contains('is-show'),
      alert: document.getElementById('pathsAlert') && document.getElementById('pathsAlert').textContent
    };
    await window.api.updateGame(smoke.id, { path1: ${JSON.stringify(fixture.path1)} });
    return { emptyUi, missing: missingUi };
  })()`);
  details.pathError = pathError;
  check(pathError.emptyUi.ok === false, '未設定の経路でもバックアップが通ってしまう');
  check(/コピー元を設定/.test(pathError.emptyUi.message || ''), `未設定時のメッセージが想定外: ${pathError.emptyUi.message}`);
  check(pathError.emptyUi.pathsActive === true, '未設定時に経路設定タブへ切り替わっていない');
  check(pathError.emptyUi.toastShown === true, '未設定時にエラー通知が出ていない');
  check(pathError.emptyUi.toast === pathError.emptyUi.message, '未設定時のトースト内容がメッセージと違う');
  check(pathError.emptyUi.alert === pathError.emptyUi.message, '未設定時の経路設定アラートが出ていない');
  check(pathError.missing.ok === false, '存在しない経路でもバックアップが通ってしまう');
  check(/見つかりません/.test(pathError.missing.message || ''), `不存在時のメッセージが想定外: ${pathError.missing.message}`);
  check(pathError.missing.pathsActive === true, '不存在時に経路設定タブへ切り替わっていない');
  check(pathError.missing.toastShown === true, '不存在時にエラー通知が出ていない');

  // ---- 6. ゲーム別ショートカット変更が反映されるか
  const changed = await win.webContents.executeJavaScript(`(async () => {
    const built = await window.api.buildAccelerator({
      code: 'KeyB', key: 'b', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true
    });
    const current = await window.api.getSettings();
    const target = current.settings.games.find((g) => g.name === 'Smoke Game') || current.settings.games[0];
    const restoreBuilt = await window.api.buildAccelerator({
      code: 'KeyZ', key: 'z', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true
    });
    const saved = await window.api.updateGame(target.id, {
      shortcutBackup: built.accelerator,
      shortcutRestore: restoreBuilt.accelerator
    });
    return {
      built,
      restoreBuilt,
      game: saved.settings.games.find((g) => g.id === target.id)
    };
  })()`);
  details.shortcutChange = changed;

  const newAccel = process.platform === 'darwin' ? 'Command+Alt+Shift+B' : 'Super+Alt+Shift+B';
  const restoreAccel = process.platform === 'darwin' ? 'Command+Alt+Shift+Z' : 'Super+Alt+Shift+Z';
  check(changed.built.accelerator === newAccel, `生成されたショートカットが想定外: ${changed.built.accelerator}`);
  check(changed.game && changed.game.shortcutBackup === newAccel, 'バックアップ用ショートカットが保存されていない');
  check(changed.game && changed.game.shortcutRestore === restoreAccel, '復元用ショートカットが保存されていない');
  check(globalShortcut.isRegistered(newAccel), '変更後のバックアップ用ショートカットが登録されていない');
  check(globalShortcut.isRegistered(restoreAccel), '復元用ショートカットが登録されていない');

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
