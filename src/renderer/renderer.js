'use strict';

/** 設定ウィンドウの表示・入力処理。ロジック本体はメインプロセス側にある。 */

// contextBridge が定義するグローバル `api` と衝突しないよう別名で受ける
const ipc = window.api;

const state = {
  settings: null,
  shortcuts: {},
  busy: false,
  recording: null,
};

/** 経路入力欄の定義（キー -> 要素IDと表示名）。 */
const PATH_FIELDS = {
  path1: { input: 'inputPath1', status: 'statusPath1', run: 'runPath1', label: '経路1' },
  path2: { input: 'inputPath2', status: 'statusPath2', run: 'runPath2', label: '経路2' },
  restorePath: {
    input: 'inputRestorePath',
    status: 'statusRestorePath',
    run: 'runRestorePath',
    label: '復元元フォルダ',
  },
};

const $ = (id) => document.getElementById(id);
const debounceTimers = new Map();

function debounce(key, ms, fn) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(fn, ms));
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-show'), 2600);
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

async function saveSettings(patch) {
  const result = await ipc.updateSettings(patch);
  state.settings = result.settings;
  state.shortcuts = result.shortcuts || state.shortcuts;
  return result;
}

// ------------------------------------------------------------------ 画面切替

function showSection(name) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.section === name);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `section-${name}`);
  });
  if (name === 'snapshots') loadSnapshots();
}

// -------------------------------------------------------------------- 反映

function renderPaths() {
  const s = state.settings;
  for (const [key, field] of Object.entries(PATH_FIELDS)) {
    $(field.run).textContent = s[key] || '未設定';
    const input = $(field.input);
    if (document.activeElement !== input) input.value = s[key];
  }
}

async function renderShortcutFields() {
  const s = state.settings;
  const [backupText, restoreText] = await Promise.all([
    ipc.formatAccelerator(s.shortcutBackup),
    ipc.formatAccelerator(s.shortcutRestore),
  ]);

  if (state.recording !== 'shortcutBackup') $('keyBackup').value = backupText;
  if (state.recording !== 'shortcutRestore') $('keyRestore').value = restoreText;
  $('btnBackupKey').textContent = backupText;
  $('btnRestoreKey').textContent = restoreText;

  const describe = (el, entry) => {
    if (!entry) return setStatus(el, '');
    if (entry.ok) return setStatus(el, '登録済み（他アプリ操作中も有効）', 'ok');
    return setStatus(el, `登録できませんでした: ${entry.error || '不明なエラー'}`, 'err');
  };
  describe($('statusKeyBackup'), state.shortcuts.backup);
  describe($('statusKeyRestore'), state.shortcuts.restore);

  const failed = Object.values(state.shortcuts).some((v) => v && !v.ok);
  $('shortcutNotice').textContent = failed
    ? '登録に失敗した組み合わせはOSや他アプリが使用中です。別のキーに変更してください。\n' +
      'macOSでは「システム設定 > プライバシーとセキュリティ > アクセシビリティ」で本アプリを許可すると安定します。'
    : 'Windowsの Win キーは Super として扱われます。macOSは Command / Option / Shift の組み合わせが使えます。';
}

function renderBehavior() {
  const s = state.settings;
  document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((el) => {
    el.checked = Boolean(s[el.dataset.setting]);
  });
  if (document.activeElement !== $('inputKeepSnapshots')) {
    $('inputKeepSnapshots').value = s.keepSnapshots;
  }
  if (document.activeElement !== $('inputConcurrency')) {
    $('inputConcurrency').value = s.concurrency;
  }
  if (document.activeElement !== $('inputExcludes')) {
    $('inputExcludes').value = s.excludePatterns.join('\n');
  }

  $('btnBackupNote').textContent = s.useTimestampFolder
    ? '経路2直下に yyyymmdd_hhMM フォルダを作って保存'
    : '経路2直下へそのまま上書きコピー';
}

function renderAll() {
  renderPaths();
  renderBehavior();
  renderShortcutFields();
  for (const key of Object.keys(PATH_FIELDS)) validatePathField(key);
}

function setBusy(busy) {
  state.busy = busy;
  $('btnBackup').disabled = busy;
  $('btnRestore').disabled = busy;
  $('btnCancel').disabled = !busy;
}

// ---------------------------------------------------------------- 経路の検証

async function validatePathField(key) {
  const value = state.settings[key];
  const el = $(PATH_FIELDS[key].status);
  if (!value) return setStatus(el, '未設定です。', 'warn');

  const result = await ipc.validatePath(value);
  if (result.exists && result.isDirectory) return setStatus(el, `OK: ${result.normalized}`, 'ok');
  if (result.exists) return setStatus(el, result.message, 'err');
  // 経路2はコピー時に自動作成されるので、未作成でも警告止まりにする
  return setStatus(
    el,
    key === 'path2' ? `${result.message}（経路2はコピー時に自動作成されます）` : result.message,
    key === 'path2' ? 'warn' : 'err'
  );
}

// ------------------------------------------------------- ショートカット録音

async function startRecording(key, input) {
  if (state.recording) return;
  state.recording = key;
  await ipc.suspendShortcuts();
  input.classList.add('is-recording');
  input.value = 'キーを押してください… (Escで取消)';
}

async function stopRecording(input) {
  if (!state.recording) return;
  state.recording = null;
  input.classList.remove('is-recording');
  await ipc.resumeShortcuts();
  const refreshed = await ipc.getSettings();
  state.settings = refreshed.settings;
  state.shortcuts = refreshed.shortcuts;
  renderShortcutFields();
}

function bindShortcutInput(key, inputId, statusId) {
  const input = $(inputId);
  const status = $(statusId);

  input.addEventListener('focus', () => startRecording(key, input));
  input.addEventListener('mousedown', (event) => {
    event.preventDefault();
    input.focus();
  });
  input.addEventListener('blur', () => stopRecording(input));

  input.addEventListener('keydown', async (event) => {
    if (state.recording !== key) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      input.blur();
      return;
    }
    // 修飾キー単体の入力は確定させない
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;

    const built = await ipc.buildAccelerator({
      code: event.code,
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });

    if (!built.ok) {
      setStatus(status, built.error, 'err');
      return;
    }

    input.value = built.display;
    await saveSettings({ [key]: built.accelerator });
    input.blur();
    toast(`ショートカットを ${built.display} に変更しました`);
  });
}

// -------------------------------------------------------------- スナップショット

async function loadSnapshots() {
  const list = $('snapshotList');
  const items = await ipc.listSnapshots();
  list.replaceChildren();

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '「yyyymmdd_hhMM」形式のフォルダはまだありません。';
    list.appendChild(li);
    return;
  }

  for (const item of items) {
    const isCurrent = state.settings.restorePath === item.fullPath;
    const li = document.createElement('li');
    if (isCurrent) li.classList.add('is-current');

    const name = document.createElement('span');
    name.className = 'snap-name';
    name.textContent = item.name;

    const label = document.createElement('span');
    label.className = 'snap-label';
    label.textContent = item.label;

    const actions = document.createElement('span');
    actions.className = 'snap-actions';

    if (isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'snap-badge';
      badge.textContent = '復元元に設定中';
      actions.appendChild(badge);
    } else {
      const pick = document.createElement('button');
      pick.className = 'link-btn';
      pick.type = 'button';
      pick.textContent = '復元元にする';
      pick.addEventListener('click', async () => {
        await saveSettings({ restorePath: item.fullPath });
        renderPaths();
        validatePathField('restorePath');
        loadSnapshots();
        toast(`復元元を ${item.name} に設定しました`);
      });
      actions.appendChild(pick);
    }

    const open = document.createElement('button');
    open.className = 'link-btn';
    open.type = 'button';
    open.textContent = '開く';
    open.addEventListener('click', () => ipc.openPath(item.fullPath));
    actions.appendChild(open);

    li.append(name, label, actions);
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------- ログ

function logRow(entry) {
  const li = document.createElement('li');
  li.className = `level-${entry.level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  const d = new Date(entry.time);
  time.textContent = Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

  const body = document.createElement('div');
  body.className = 'log-body';
  body.textContent = entry.text;
  if (entry.detail) {
    const detail = document.createElement('div');
    detail.className = 'log-detail';
    detail.textContent = entry.detail;
    body.appendChild(detail);
  }

  li.append(time, body);
  return li;
}

function renderLog(entries) {
  const list = $('logList');
  list.replaceChildren();
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'ログはまだありません。';
    list.appendChild(li);
    return;
  }
  for (const entry of entries) list.appendChild(logRow(entry));
}

// ------------------------------------------------------------------- 進捗

function renderProgress(p) {
  const bar = $('progressBar');
  if (p.phase === 'scan') {
    $('progressTitle').textContent = 'ファイルを走査中…';
    bar.classList.add('indeterminate');
    $('progressMeta').textContent = `${p.totalFiles} 件 / ${p.totalBytesText} を検出`;
    return;
  }

  bar.classList.remove('indeterminate');
  const pct = Math.round((p.ratio || 0) * 100);
  bar.style.width = `${pct}%`;
  $('progressTitle').textContent = `コピー中… ${pct}%`;
  $('progressMeta').textContent =
    `${p.doneFiles} / ${p.totalFiles} 件　${p.doneBytesText} / ${p.totalBytesText}` +
    (p.errorCount > 0 ? `　エラー ${p.errorCount} 件` : '');
}

function renderResult(result) {
  const box = $('resultBox');
  const report = result.report || {};
  const kind = result.ok ? 'ok' : report.canceled ? 'warn' : 'err';
  box.className = `result-box ${kind}`;

  const head = result.ok ? '完了' : report.canceled ? '中止' : '失敗/警告';
  $('resultTitle').textContent = `${head}: ${result.label} — ${result.summary || ''}`;

  const lines = [];
  if (result.src) lines.push(`コピー元: ${result.src}`);
  if (result.dest) lines.push(`コピー先: ${result.dest}`);
  if (report.createdDirs) lines.push(`フォルダ: ${report.createdDirs} 個`);
  if (report.symlinks) lines.push(`シンボリックリンク: ${report.symlinks} 個`);
  if (result.pruned && result.pruned.removed.length > 0) {
    lines.push(`削除した旧スナップショット: ${result.pruned.removed.join(', ')}`);
  }
  for (const err of (report.errors || []).slice(0, 8)) {
    lines.push(`⚠ ${err.path}: ${err.message}`);
  }
  if ((report.errorCount || 0) > 8) lines.push(`…他 ${report.errorCount - 8} 件のエラー`);
  $('resultDetail').textContent = lines.join('\n');
}

// -------------------------------------------------------------------- 初期化

async function init() {
  const info = await ipc.getAppInfo();
  document.body.classList.toggle('is-mac', info.platform === 'darwin');
  $('appVersion').textContent = `v${info.version} / Electron ${info.electron}`;
  $('settingsPath').textContent = info.settingsPath;
  $('logPath').textContent = info.logPath;

  const initial = await ipc.getSettings();
  state.settings = initial.settings;
  state.shortcuts = initial.shortcuts || {};
  setBusy(Boolean(initial.busy));
  renderAll();
  renderLog(await ipc.getHistory());

  // ---- ナビゲーション
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });

  // ---- 経路
  for (const [key, field] of Object.entries(PATH_FIELDS)) {
    $(field.input).addEventListener('input', (event) => {
      debounce(key, 450, async () => {
        await saveSettings({ [key]: event.target.value });
        renderPaths();
        validatePathField(key);
      });
    });
  }

  document.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.pick;
      const label = PATH_FIELDS[key].label;
      const picked = await ipc.pickFolder({
        current: state.settings[key],
        title: `${label}を選択`,
      });
      if (!picked) return;
      await saveSettings({ [key]: picked });
      renderPaths();
      validatePathField(key);
      if (key === 'path2') loadSnapshots();
      toast(`${label} を設定しました`);
    });
  });

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.open;
      const message = await ipc.openPath(state.settings[key]);
      if (message) toast(`開けませんでした: ${message}`);
    });
  });

  // ---- ショートカット
  bindShortcutInput('shortcutBackup', 'keyBackup', 'statusKeyBackup');
  bindShortcutInput('shortcutRestore', 'keyRestore', 'statusKeyRestore');

  document.querySelectorAll('[data-resetkey]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.resetkey;
      const info2 = await ipc.getAppInfo();
      await saveSettings({ [key]: info2.defaults[key] });
      renderShortcutFields();
      toast('既定のショートカットに戻しました');
    });
  });

  // ---- 動作設定
  document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((el) => {
    el.addEventListener('change', async () => {
      await saveSettings({ [el.dataset.setting]: el.checked });
      renderBehavior();
    });
  });

  for (const id of ['inputKeepSnapshots', 'inputConcurrency']) {
    $(id).addEventListener('change', async (event) => {
      const key = event.target.dataset.setting;
      await saveSettings({ [key]: event.target.value });
      renderBehavior();
    });
  }

  $('inputExcludes').addEventListener('input', (event) => {
    debounce('excludes', 600, async () => {
      await saveSettings({ excludePatterns: event.target.value });
    });
  });

  $('btnResetSettings').addEventListener('click', async () => {
    const result = await ipc.resetSettings();
    state.settings = result.settings;
    state.shortcuts = result.shortcuts;
    renderAll();
    toast('設定を初期値に戻しました');
  });

  // ---- 実行
  $('btnBackup').addEventListener('click', () => ipc.runJob('backup'));
  $('btnRestore').addEventListener('click', () => ipc.runJob('restore'));
  $('btnCancel').addEventListener('click', () => ipc.cancelJob());

  // ---- 一覧/ログ
  $('btnReloadSnapshots').addEventListener('click', loadSnapshots);
  $('btnOpenLog').addEventListener('click', () => ipc.openLog());
  $('btnClearLog').addEventListener('click', async () => {
    await ipc.clearHistory();
    renderLog([]);
  });

  // ---- メインプロセスからの通知
  ipc.on('job:start', (info) => {
    setBusy(true);
    $('progressBar').style.width = '0%';
    $('progressTitle').textContent = `${info.label} を開始…`;
    $('progressMeta').textContent = `${info.src}  →  ${info.dest}`;
  });

  ipc.on('job:progress', renderProgress);

  ipc.on('job:done', (result) => {
    setBusy(false);
    $('progressBar').classList.remove('indeterminate');
    $('progressBar').style.width = result.ok ? '100%' : $('progressBar').style.width;
    $('progressTitle').textContent = '待機中';
    renderResult(result);
    loadSnapshots();
  });

  ipc.on('log:entry', (entry) => {
    const list = $('logList');
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    list.prepend(logRow(entry));
  });

  ipc.on('settings:changed', (next) => {
    state.settings = next;
    renderPaths();
    renderBehavior();
    renderShortcutFields();
    for (const key of Object.keys(PATH_FIELDS)) validatePathField(key);
  });

  ipc.on('shortcuts:state', (next) => {
    state.shortcuts = next;
    renderShortcutFields();
  });

  ipc.on('ui:focus-section', (section) => showSection(section));
}

init().catch((err) => {
  const box = $('resultBox');
  if (box) {
    box.className = 'result-box err';
    $('resultTitle').textContent = '初期化に失敗しました';
    $('resultDetail').textContent = String(err && err.message ? err.message : err);
  }
});
