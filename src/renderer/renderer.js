'use strict';

/** 設定ウィンドウの表示・入力処理。ロジック本体はメインプロセス側にある。 */

const ipc = window.api;
const DRAFT_ID = '_draft';

const PATH_KEYS = [
  { key: 'path1', label: 'コピー元' },
  { key: 'path2', label: 'バックアップ先' },
  { key: 'restorePath', label: '復元元' },
];

const state = {
  settings: null,
  shortcuts: { byGameId: {} },
  busy: false,
  recording: null,
  draft: null,
  draftResolvedId: '',
  shortcutText: {},
  committing: false,
  pathsAlert: '',
};

const $ = (id) => document.getElementById(id);
const debounceTimers = new Map();

function debounce(key, ms, fn) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(fn, ms));
}

function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.add('is-show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('is-show'), kind === 'error' ? 5200 : 2600);
}

function setPathsAlert(message) {
  state.pathsAlert = message || '';
  const el = $('pathsAlert');
  if (!el) return;
  el.hidden = !state.pathsAlert;
  el.textContent = state.pathsAlert;
}

async function openPathWithFeedback(opener) {
  try {
    const err = await opener();
    if (err) toast(String(err), 'error');
  } catch (err) {
    toast(err && err.message ? err.message : '開けませんでした', 'error');
  }
}

function isFilled(game) {
  if (!game) return false;
  if (String(game.name || '').trim()) return true;
  if (game.path1 || game.path2 || game.restorePath) return true;
  if (game.shortcutBackup) return true;
  if (game.shortcutRestore) return true;
  if (game.pinned) return true;
  return false;
}

function emptyDraft(groupId = '') {
  return {
    name: '',
    path1: '',
    path2: '',
    restorePath: '',
    pinned: false,
    shortcutBackup: '',
    shortcutRestore: '',
    groupId,
  };
}

function games() {
  return (state.settings && state.settings.games) || [];
}

function groups() {
  return (state.settings && state.settings.groups) || [];
}

function gamesIn(groupId) {
  return games().filter((g) => g.groupId === groupId);
}

function gameById(id) {
  if (id === DRAFT_ID) return state.draft;
  return games().find((g) => g.id === id) || null;
}

async function saveSettings(patch) {
  const result = await ipc.updateSettings(patch);
  if (result && result.ok === false) return result;
  state.settings = result.settings;
  state.shortcuts = result.shortcuts || state.shortcuts;
  return result;
}

async function persistGame(id, patch) {
  if (id === DRAFT_ID) {
    if (!state.draft) {
      if (state.draftResolvedId) return persistGame(state.draftResolvedId, patch);
      return null;
    }
    state.draft = { ...state.draft, ...patch };
    if (!isFilled(state.draft)) return null;
    const result = await ipc.addGame(state.draft);
    if (result && result.ok === false) return result;
    state.settings = result.settings;
    state.shortcuts = result.shortcuts || state.shortcuts;
    state.draftResolvedId = state.settings.activeGameId || '';
    state.draft = null;
    if (patch.path1 !== undefined || patch.path2 !== undefined || patch.restorePath !== undefined) {
      setPathsAlert('');
    }
    return result;
  }
  const result = await ipc.updateGame(id, patch);
  if (result && result.ok === false) return result;
  if (result && result.settings) {
    state.settings = result.settings;
    state.shortcuts = result.shortcuts || state.shortcuts;
  }
  if (result && (patch.path1 !== undefined || patch.path2 !== undefined || patch.restorePath !== undefined)) {
    setPathsAlert('');
  }
  return result;
}

function applySettings(result) {
  if (!result || result.ok === false) return false;
  if (result.settings) {
    state.settings = result.settings;
    state.shortcuts = result.shortcuts || state.shortcuts;
  }
  return true;
}

function isEditingPathField() {
  const active = document.activeElement;
  return Boolean(
    active &&
      active.matches &&
      active.matches('.paths-groups input[type="text"]')
  );
}

function showSection(name) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.section === name);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `section-${name}`);
  });
  if (name === 'snapshots') loadSnapshots();
}

function displayName(game) {
  const name = String(game && game.name ? game.name : '').trim();
  return name || '(無題)';
}

function displayPath(value) {
  return value || '未設定';
}

function shortcutEntry(gameId, field) {
  const map = (state.shortcuts && state.shortcuts.byGameId) || {};
  const row = map[gameId];
  if (!row) return null;
  if (field === 'shortcutRestore') return row.restore || null;
  return row.backup || null;
}

function shortcutTextKey(gameId, field) {
  return `${gameId}:${field}`;
}

async function refreshShortcutTexts() {
  const next = {};
  const targets = [...games()];
  if (state.draft) targets.push({ id: DRAFT_ID, ...state.draft });
  await Promise.all(
    targets.flatMap((game) =>
      ['shortcutBackup', 'shortcutRestore'].map(async (field) => {
        next[shortcutTextKey(game.id, field)] = await ipc.formatAccelerator(game[field] || '');
      })
    )
  );
  state.shortcutText = next;
}

function isRecording(gameId, field) {
  return Boolean(state.recording && state.recording.gameId === gameId && state.recording.field === field);
}

function shortcutLabel(gameId, field, accelerator) {
  if (isRecording(gameId, field)) return 'キーを押してください… (Escで取消)';
  const entry = shortcutEntry(gameId, field);
  if (entry && !entry.ok && !entry.skipped) return entry.error || '登録失敗';
  if (!accelerator) return 'なし';
  return state.shortcutText[shortcutTextKey(gameId, field)] || accelerator;
}

function ellipsisPath(value) {
  const text = displayPath(value);
  const span = document.createElement('span');
  span.className = `path-text${value ? '' : ' is-empty'}`;
  span.textContent = text;
  span.title = text;
  return span;
}

// ------------------------------------------------------------------ 実行 / 経路グループ

function tableHead(editable) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  if (editable) {
    const handle = document.createElement('th');
    handle.className = 'col-handle';
    tr.appendChild(handle);
  }
  for (const label of ['ゲーム名', 'コピー元', 'バックアップ先', '復元元', 'ショートカット']) {
    const th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
  }
  if (editable) {
    const actions = document.createElement('th');
    actions.className = 'col-row-actions';
    actions.textContent = '操作';
    tr.appendChild(actions);
  } else {
    const actions = document.createElement('th');
    actions.className = 'col-actions';
    actions.textContent = '実行';
    tr.appendChild(actions);
  }
  thead.appendChild(tr);
  return thead;
}

function appendRunGameRow(body, game) {
  const tr = document.createElement('tr');
  const name = document.createElement('td');
  name.textContent = displayName(game);
  const cells = PATH_KEYS.map(({ key }) => {
    const td = document.createElement('td');
    td.appendChild(ellipsisPath(game[key]));
    return td;
  });
  const shortcut = document.createElement('td');
  shortcut.className = 'col-shortcut';
  shortcut.appendChild(shortcutStack(game, { editable: false }));
  const actions = document.createElement('td');
  actions.className = 'col-actions';
  const wrap = document.createElement('div');
  wrap.className = 'run-actions';
  const backup = document.createElement('button');
  backup.className = 'btn compact';
  backup.type = 'button';
  backup.textContent = 'バックアップ';
  backup.disabled = state.busy;
  backup.addEventListener('click', () => ipc.runJob('backup', game.id));
  const restore = document.createElement('button');
  restore.className = 'btn compact';
  restore.type = 'button';
  restore.textContent = '復元';
  restore.disabled = state.busy;
  restore.addEventListener('click', () => ipc.runJob('restore', game.id));
  wrap.append(backup, restore);
  actions.appendChild(wrap);
  tr.append(name, ...cells, shortcut, actions);
  body.appendChild(tr);
}

function renderRunTable() {
  const root = $('runGroups');
  root.replaceChildren();
  const pinnedGroups = groups().filter((g) => g.pinned);
  if (pinnedGroups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty';
    empty.textContent = 'ピン留めしたグループがありません。経路設定タブでグループにピンを付けてください。';
    root.appendChild(empty);
    return;
  }

  for (const group of pinnedGroups) {
    const pinnedGames = gamesIn(group.id).filter((g) => g.pinned);
    root.appendChild(buildGroupBlock(group, pinnedGames, { editable: false }));
  }
}

async function persistGroup(id, patch) {
  const result = await ipc.updateGroup(id, patch);
  if (result && result.ok === false) return result;
  if (result && result.settings) {
    state.settings = result.settings;
    state.shortcuts = result.shortcuts || state.shortcuts;
  }
  return result;
}

function bindGroupNameInput(input, groupId) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    input.blur();
  });
  input.addEventListener('blur', async () => {
    if (state.committing) return;
    const current = groups().find((g) => g.id === groupId);
    if (current && String(current.name || '') === String(input.value || '').trim()) return;
    state.committing = true;
    try {
      await persistGroup(groupId, { name: input.value });
    } finally {
      state.committing = false;
    }
  });
}

function buildGroupBlock(group, list, { editable }) {
  const block = document.createElement('section');
  block.className = `group-block${group.collapsed ? ' is-collapsed' : ''}`;
  block.dataset.groupId = group.id;

  const head = document.createElement('header');
  head.className = 'group-head';

  const toggle = document.createElement('button');
  toggle.className = 'group-toggle';
  toggle.type = 'button';
  toggle.title = group.collapsed ? 'グループを開く' : 'グループを閉じる';
  toggle.textContent = group.collapsed ? '▸' : '▾';
  toggle.addEventListener('click', async () => {
    await persistGroup(group.id, { collapsed: !group.collapsed });
    if (editable) renderPathsTable();
    else renderRunTable();
  });

  head.appendChild(toggle);

  if (editable) {
    const pin = document.createElement('input');
    pin.type = 'checkbox';
    pin.className = 'pin-check';
    pin.checked = Boolean(group.pinned);
    pin.title = '実行タブにこのグループを表示する';
    pin.addEventListener('change', async (event) => {
      await persistGroup(group.id, { pinned: event.target.checked });
      await renderAll();
    });
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'group-name-input';
    nameInput.spellcheck = false;
    nameInput.placeholder = 'グループ名';
    nameInput.value = group.name || '';
    nameInput.dataset.groupId = group.id;
    bindGroupNameInput(nameInput, group.id);
    const remove = document.createElement('button');
    remove.className = 'btn compact danger';
    remove.type = 'button';
    remove.textContent = '削除';
    remove.disabled = groups().length <= 1;
    remove.title =
      groups().length <= 1 ? '最後のグループは削除できません' : 'このグループと中の経路を削除';
    remove.addEventListener('click', async () => {
      const count = gamesIn(group.id).length;
      const label = group.name || '(無題)';
      const message =
        count > 0
          ? `「${label}」と中の経路 ${count} 件を削除します。よろしいですか?`
          : `「${label}」を削除します。よろしいですか?`;
      if (!window.confirm(message)) return;
      const result = await ipc.removeGroup(group.id);
      if (!applySettings(result)) return;
      if (state.draft && state.draft.groupId === group.id) {
        state.draft = null;
        state.draftResolvedId = '';
      }
      await renderAll();
      toast('グループを削除しました');
    });
    head.append(pin, nameInput, remove);
    bindDropTarget(head, group.id, '');
  } else {
    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = group.name || '(無題)';
    head.appendChild(title);
  }

  const body = document.createElement('div');
  body.className = 'group-body';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = `data-table${editable ? ' paths-table' : ''}`;
  table.appendChild(tableHead(editable));
  const tbody = document.createElement('tbody');
  if (!editable && list.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'このグループでピン留めした経路はありません。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  if (editable) {
    for (const game of list) appendGameRow(tbody, game, { groupId: group.id });
    if (state.draft && state.draft.groupId === group.id) {
      appendGameRow(tbody, { id: DRAFT_ID, ...state.draft }, { draft: true, groupId: group.id });
    }
    appendAddRow(tbody, group.id);
  } else {
    for (const game of list) appendRunGameRow(tbody, game);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);
  block.append(head, body);
  return block;
}

// ------------------------------------------------------------------ 経路テーブル

function pathPicker(gameId, key, label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'path-cell';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = value || '';
  input.placeholder = '未設定';
  input.dataset.gameId = gameId;
  input.dataset.field = key;
  const btn = document.createElement('button');
  btn.className = 'btn compact';
  btn.type = 'button';
  btn.textContent = '選択';
  btn.title = `${label}をファインダー / エクスプローラから選ぶ`;
  btn.addEventListener('click', async () => {
    const current = gameById(gameId);
    const picked = await ipc.pickFolder({
      current: current ? current[key] : '',
      title: `${label}を選択`,
    });
    if (!picked) return;
    const saved = await persistGame(gameId, { [key]: picked });
    if (!saved || saved.ok === false) return;
    await renderAll();
    toast(`${label} を設定しました`);
  });
  wrap.append(input, btn);
  return wrap;
}

function bindFieldInput(input, gameId, field) {
  input.addEventListener('input', (event) => {
    if (gameId === DRAFT_ID && state.draft) state.draft[field] = event.target.value;
  });
  input.addEventListener('keydown', (event) => {
    // IME確定のEnterでは保存せず、確定後のEnterかフォーカス外れまで待つ
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    input.blur();
  });
  input.addEventListener('blur', async () => {
    if (state.committing) return;
    if (gameId !== DRAFT_ID) {
      const current = gameById(gameId);
      if (current && String(current[field] || '') === String(input.value || '')) return;
    }
    state.committing = true;
    try {
      await persistGame(gameId, { [field]: input.value });
    } finally {
      state.committing = false;
    }
  });
}

function shortcutStack(game, { editable }) {
  const stack = document.createElement('div');
  stack.className = 'shortcut-stack';
  const rows = [
    { field: 'shortcutBackup', kind: 'バックアップ' },
    { field: 'shortcutRestore', kind: '復元' },
  ];
  for (const { field, kind } of rows) {
    const row = document.createElement('div');
    row.className = 'shortcut-cell';
    const kindEl = document.createElement('span');
    kindEl.className = 'shortcut-kind';
    kindEl.textContent = kind;
    const scLabel = document.createElement('span');
    const entry = shortcutEntry(game.id, field);
    scLabel.className = `shortcut-label${game[field] ? '' : ' is-empty'}`;
    if (isRecording(game.id, field)) scLabel.classList.add('is-recording');
    if (entry && !entry.ok && !entry.skipped) scLabel.classList.add('is-err');
    scLabel.textContent = shortcutLabel(game.id, field, game[field]);
    row.append(kindEl, scLabel);
    if (editable) {
      const change = document.createElement('button');
      change.className = 'btn compact';
      change.type = 'button';
      change.textContent = '変更';
      change.addEventListener('click', () => startRecording(game.id, field));
      row.appendChild(change);
    }
    stack.appendChild(row);
  }
  return stack;
}

async function dropGameOnGroup(event, groupId, beforeId = '') {
  event.preventDefault();
  const fromId = event.dataTransfer.getData('text/plain');
  if (!fromId) return;
  const fromGame = gameById(fromId);
  if (!fromGame || fromGame.id === DRAFT_ID) return;
  if (fromGame.groupId === groupId) {
    if (fromId === beforeId) return;
    const rest = gamesIn(groupId).filter((g) => g.id !== fromId).map((g) => g.id);
    if (beforeId) {
      const to = rest.indexOf(beforeId);
      if (to < 0) rest.push(fromId);
      else rest.splice(to, 0, fromId);
    } else {
      rest.push(fromId);
    }
    const result = await ipc.reorderGames(rest, groupId);
    if (!applySettings(result)) return;
  } else {
    const result = await ipc.moveGame(fromId, groupId, beforeId || '');
    if (!applySettings(result)) return;
    toast('グループを移動しました');
  }
  await renderAll();
}

function bindDropTarget(el, groupId, beforeId) {
  el.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.classList.add('is-drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
  el.addEventListener('drop', async (event) => {
    event.stopPropagation();
    el.classList.remove('is-drop-target');
    await dropGameOnGroup(event, groupId, beforeId);
  });
}

function appendGameRow(body, game, { draft = false, groupId = '' } = {}) {
  const gid = groupId || game.groupId;
  const tr = document.createElement('tr');
  tr.dataset.gameId = game.id;
  if (!draft) {
    const enableDrag = () => {
      tr.draggable = true;
    };
    const disableDrag = () => {
      tr.draggable = false;
    };
    tr.addEventListener('dragstart', (event) => {
      if (!tr.draggable) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData('text/plain', game.id);
      event.dataTransfer.effectAllowed = 'move';
      tr.classList.add('is-dragging');
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('is-dragging');
      disableDrag();
    });
    bindDropTarget(tr, gid, game.id);
    tr._enableDrag = enableDrag;
    tr._disableDrag = disableDrag;
  }

  const handle = document.createElement('td');
  handle.className = 'col-handle';
  if (!draft) {
    const grip = document.createElement('span');
    grip.className = 'drag-handle';
    grip.textContent = '⋮⋮';
    grip.title = '同じグループ内は並び替え、別グループへ落とすと移動';
    grip.addEventListener('mousedown', () => {
      if (tr._enableDrag) tr._enableDrag();
    });
    handle.appendChild(grip);
  }

  const pin = document.createElement('input');
  pin.type = 'checkbox';
  pin.className = 'pin-check';
  pin.checked = Boolean(game.pinned);
  pin.title = 'グループがピン留めされていれば実行タブに出す';
  pin.addEventListener('change', async (event) => {
    await persistGame(game.id, { pinned: event.target.checked });
    await renderAll();
  });

  const nameTd = document.createElement('td');
  nameTd.className = 'cell-name';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'path-cell';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.spellcheck = false;
  nameInput.placeholder = 'ゲーム名';
  nameInput.value = game.name || '';
  nameInput.dataset.gameId = game.id;
  nameInput.dataset.field = 'name';
  bindFieldInput(nameInput, game.id, 'name');
  nameWrap.append(pin, nameInput);
  nameTd.appendChild(nameWrap);

  const pathCells = PATH_KEYS.map(({ key, label }) => {
    const td = document.createElement('td');
    td.className = 'cell-path';
    const picker = pathPicker(game.id, key, label, game[key]);
    bindFieldInput(picker.querySelector('input'), game.id, key);
    td.appendChild(picker);
    return td;
  });

  const shortcutTd = document.createElement('td');
  shortcutTd.className = 'col-shortcut';
  shortcutTd.appendChild(shortcutStack(game, { editable: true }));

  const actionsTd = document.createElement('td');
  actionsTd.className = 'col-row-actions';
  if (!draft) {
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';

    const copy = document.createElement('button');
    copy.className = 'btn compact';
    copy.type = 'button';
    copy.textContent = 'コピー';
    copy.title = 'この経路を複製する（ショートカットは空のまま）';
    copy.addEventListener('click', async () => {
      const hadShortcut = Boolean(game.shortcutBackup || game.shortcutRestore);
      const result = await ipc.duplicateGame(game.id);
      if (!applySettings(result)) return;
      await renderAll();
      toast(hadShortcut ? 'ショートカットは未設定のままコピーしました' : '経路をコピーしました');
    });
    wrap.appendChild(copy);

    const otherGroups = groups().filter((g) => g.id !== gid);
    if (otherGroups.length > 0) {
      const selectWrap = document.createElement('div');
      selectWrap.className = 'move-select-wrap';
      const select = document.createElement('select');
      select.className = 'move-select';
      select.title = '別のグループへ移動';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '移動…';
      select.appendChild(placeholder);
      for (const g of otherGroups) {
        const option = document.createElement('option');
        option.value = g.id;
        option.textContent = g.name || '(無題)';
        select.appendChild(option);
      }
      select.addEventListener('change', async () => {
        const target = select.value;
        if (!target) return;
        const result = await ipc.moveGame(game.id, target, '');
        if (!applySettings(result)) {
          select.value = '';
          return;
        }
        await renderAll();
        toast('グループを移動しました');
      });
      selectWrap.appendChild(select);
      wrap.appendChild(selectWrap);
    }

    const del = document.createElement('button');
    del.className = 'btn compact danger';
    del.type = 'button';
    del.textContent = '削除';
    del.title = 'この経路を削除';
    del.addEventListener('click', async () => {
      const label = displayName(game);
      if (!window.confirm(`「${label}」を削除します。よろしいですか?`)) return;
      const result = await ipc.removeGame(game.id);
      if (!applySettings(result)) return;
      await renderAll();
      toast('経路を削除しました');
    });
    wrap.appendChild(del);
    actionsTd.appendChild(wrap);
  }

  tr.append(handle, nameTd, ...pathCells, shortcutTd, actionsTd);
  body.appendChild(tr);
}

function appendAddRow(body, groupId) {
  const tr = document.createElement('tr');
  tr.className = 'add-row';
  const td = document.createElement('td');
  td.colSpan = 7;
  const btn = document.createElement('button');
  btn.className = 'add-row-btn';
  btn.type = 'button';
  btn.textContent = '＋新しい経路を追加';
  btn.addEventListener('click', () => {
    state.draft = emptyDraft(groupId);
    state.draftResolvedId = '';
    renderPathsTable();
    const input = document.querySelector(`input[data-game-id="${DRAFT_ID}"][data-field="name"]`);
    if (input) {
      input.focus();
      input.select();
    }
  });
  td.appendChild(btn);
  tr.appendChild(td);
  bindDropTarget(tr, groupId, '');
  body.appendChild(tr);
}

function renderPathsTable() {
  const root = $('pathsGroups');
  root.replaceChildren();
  for (const group of groups()) {
    root.appendChild(buildGroupBlock(group, gamesIn(group.id), { editable: true }));
  }

  const failed = Object.values((state.shortcuts && state.shortcuts.byGameId) || {}).some((row) =>
    ['backup', 'restore'].some((kind) => {
      const entry = row && row[kind];
      return entry && !entry.ok && !entry.skipped;
    })
  );
  $('shortcutNotice').textContent = failed
    ? '登録に失敗したショートカットは OS や他アプリが使用中です。別のキーに変更してください。\n' +
      'macOSでは「システム設定 > プライバシーとセキュリティ > アクセシビリティ」で本アプリを許可すると安定します。'
    : 'ショートカットの既定はなしです。バックアップ／復元それぞれ「変更」を押してからキーを押してください。Escで入力を取消、Delete で解除できます。';
}

function fillSnapshotSelect() {
  const select = $('selectSnapshotGame');
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  const list = games();
  if (list.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '(経路がありません)';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = state.busy;
  for (const game of list) {
    const option = document.createElement('option');
    option.value = game.id;
    const group = groups().find((g) => g.id === game.groupId);
    option.textContent = group
      ? `${group.name || '(無題)'} / ${displayName(game)}`
      : displayName(game);
    select.appendChild(option);
  }
  const active = state.settings.activeGameId || '';
  select.value = list.some((g) => g.id === active) ? active : previous;
  if (!select.value && list[0]) select.value = list[0].id;
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
}

async function renderAll() {
  if (isEditingPathField()) return;
  await refreshShortcutTexts();
  renderRunTable();
  renderPathsTable();
  renderBehavior();
  fillSnapshotSelect();
}

function setBusy(busy) {
  state.busy = busy;
  $('btnCancel').disabled = !busy;
  renderRunTable();
}

// ------------------------------------------------------- ショートカット録音

async function startRecording(gameId, field) {
  if (state.recording) return;
  state.recording = { gameId, field };
  await ipc.suspendShortcuts();
  renderPathsTable();
}

async function stopRecording() {
  if (!state.recording) return;
  state.recording = null;
  await ipc.resumeShortcuts();
  const refreshed = await ipc.getSettings();
  state.settings = refreshed.settings;
  state.shortcuts = refreshed.shortcuts || state.shortcuts;
  await renderAll();
  toast('ショートカットの入力を取り消しました');
}

async function applyRecordedAccelerator(built) {
  const rec = state.recording;
  if (!rec) return;
  const saved = await persistGame(rec.gameId, { [rec.field]: built.accelerator });
  state.recording = null;
  await ipc.resumeShortcuts();
  const latest = await ipc.getSettings();
  if (latest) {
    state.settings = latest.settings;
    state.shortcuts = latest.shortcuts || state.shortcuts;
  }
  await renderAll();
  if (saved && saved.ok === false) return;
  const gameId = rec.gameId === DRAFT_ID ? state.draftResolvedId || rec.gameId : rec.gameId;
  const entry = shortcutEntry(gameId, rec.field);
  if (entry && !entry.ok && !entry.skipped) {
    toast(entry.error || 'ショートカットを登録できませんでした', 'error');
    return;
  }
  toast(`ショートカットを ${built.display} に変更しました`);
}

async function clearShortcut() {
  const rec = state.recording;
  if (!rec) return;
  await persistGame(rec.gameId, { [rec.field]: '' });
  state.recording = null;
  await ipc.resumeShortcuts();
  await renderAll();
  toast('ショートカットを解除しました');
}

// -------------------------------------------------------------- スナップショット

async function loadSnapshots() {
  const list = $('snapshotList');
  const gameId = $('selectSnapshotGame').value;
  const items = gameId ? await ipc.listSnapshots(gameId) : [];
  list.replaceChildren();

  if (!gameId) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '先に経路設定でゲームを追加してください。';
    list.appendChild(li);
    return;
  }

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '「yyyymmdd_hhMM」形式のフォルダはまだありません。';
    list.appendChild(li);
    return;
  }

  const currentGame = gameById(gameId);
  const currentRestore = currentGame ? currentGame.restorePath : '';

  for (const item of items) {
    const isCurrent = currentRestore === item.fullPath;
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
        const saved = await ipc.updateGame(gameId, { restorePath: item.fullPath });
        if (saved && saved.ok === false) return;
        const latest = await ipc.getSettings();
        state.settings = latest.settings;
        await renderAll();
        loadSnapshots();
        toast(`復元元を ${item.name} に設定しました`);
      });
      actions.appendChild(pick);
    }

    const open = document.createElement('button');
    open.className = 'link-btn';
    open.type = 'button';
    open.textContent = '開く';
    open.addEventListener('click', () => openPathWithFeedback(() => ipc.openPath(item.fullPath)));
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
  $('appVersion').textContent = `v${info.version}`;
  $('settingsPath').textContent = info.settingsPath;
  $('logPath').textContent = info.logPath;

  const initial = await ipc.getSettings();
  state.settings = initial.settings;
  state.shortcuts = initial.shortcuts || { byGameId: {} };
  setBusy(Boolean(initial.busy));
  await renderAll();
  renderLog(await ipc.getHistory());

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });

  $('btnAddGroup').addEventListener('click', async () => {
    const result = await ipc.addGroup({});
    if (result && result.ok === false) return;
    if (result && result.settings) {
      state.settings = result.settings;
      state.shortcuts = result.shortcuts || state.shortcuts;
    }
    await renderAll();
    const created = groups()[groups().length - 1];
    const input = created && document.querySelector(`input.group-name-input[data-group-id="${created.id}"]`);
    if (input) {
      input.focus();
      input.select();
    }
    toast('グループを追加しました');
  });

  document.addEventListener('keydown', async (event) => {
    if (!state.recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape' || event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      await stopRecording();
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      await clearShortcut();
      return;
    }
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
      toast(built.error);
      return;
    }
    await applyRecordedAccelerator(built);
  });

  $('selectSnapshotGame').addEventListener('change', async (event) => {
    const gameId = event.target.value;
    if (gameId) await ipc.setActiveGame(gameId);
    loadSnapshots();
  });

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
    state.draft = null;
    state.draftResolvedId = '';
    await renderAll();
    toast('設定を初期値に戻しました');
  });

  $('btnCancel').addEventListener('click', () => ipc.cancelJob());
  $('btnReloadSnapshots').addEventListener('click', loadSnapshots);
  $('btnOpenLog').addEventListener('click', () => openPathWithFeedback(() => ipc.openLog()));
  $('btnClearLog').addEventListener('click', async () => {
    await ipc.clearHistory();
    renderLog([]);
  });

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

  ipc.on('settings:changed', async (next) => {
    state.settings = next;
    if (state.recording) return;
    if (isEditingPathField()) {
      renderRunTable();
      fillSnapshotSelect();
      return;
    }
    const active = document.activeElement;
    if (active && active.closest && active.closest('.paths-groups')) return;
    await renderAll();
  });

  ipc.on('shortcuts:state', async (next) => {
    state.shortcuts = next;
    if (state.recording || isEditingPathField()) return;
    await renderAll();
  });

  ipc.on('ui:focus-section', (section) => showSection(section));
  ipc.on('ui:notice', (payload) => {
    const notice = payload || {};
    if (notice.section) showSection(notice.section);
    if (notice.message) {
      toast(notice.message, notice.kind || 'error');
      if (notice.section === 'paths') setPathsAlert(notice.message);
    }
  });
}

init().catch((err) => {
  const box = $('resultBox');
  if (box) {
    box.className = 'result-box err';
    $('resultTitle').textContent = '初期化に失敗しました';
    $('resultDetail').textContent = String(err && err.message ? err.message : err);
  }
});
