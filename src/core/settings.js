'use strict';

/** 設定の既定値・検証・JSON保存(原子的書き込み)。ゲーム別の経路を管理する。 */

const fs = require('node:fs');
const path = require('node:path');
const { validateAccelerator } = require('./accelerator');
const { normalizeInputPath } = require('./pathcheck');
const { parsePatternText } = require('./patterns');

const DEFAULT_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const DEFAULT_GAME_NAME = 'ゲーム1';
const DEFAULT_GROUP_NAME = 'グループ1';
const DEFAULT_GROUP_ID = 'grp_default';
const DRAFT_ID = '_draft';

function createGameId() {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createGroupId() {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** ゲーム別ショートカット。空は「未設定」として許可する。 */
function sanitizeGameShortcut(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return validateAccelerator(text).ok ? text : '';
}

/** 1ゲーム分の経路設定を作る。 */
function createGame(partial = {}) {
  const name = String(partial.name == null ? '' : partial.name).trim();
  const hasPinned = Object.prototype.hasOwnProperty.call(partial, 'pinned');
  return {
    id: typeof partial.id === 'string' && partial.id.trim() ? partial.id.trim() : createGameId(),
    name,
    path1: normalizeInputPath(partial.path1),
    path2: normalizeInputPath(partial.path2),
    restorePath: normalizeInputPath(partial.restorePath),
    pinned: hasPinned ? toBool(partial.pinned, false) : false,
    shortcutBackup: sanitizeGameShortcut(partial.shortcutBackup),
    shortcutRestore: sanitizeGameShortcut(partial.shortcutRestore),
    groupId: typeof partial.groupId === 'string' && partial.groupId.trim() ? partial.groupId.trim() : '',
  };
}

function createGroup(partial = {}) {
  const hasPinned = Object.prototype.hasOwnProperty.call(partial, 'pinned');
  const hasCollapsed = Object.prototype.hasOwnProperty.call(partial, 'collapsed');
  const name = String(partial.name == null ? '' : partial.name).trim();
  return {
    id: typeof partial.id === 'string' && partial.id.trim() ? partial.id.trim() : createGroupId(),
    name,
    pinned: hasPinned ? toBool(partial.pinned, false) : false,
    collapsed: hasCollapsed ? toBool(partial.collapsed, false) : false,
  };
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return createGroup();
  return createGroup(raw);
}

function nextGroupName(groups) {
  const names = new Set((groups || []).map((g) => g.name));
  let n = 1;
  while (names.has(`グループ${n}`)) n += 1;
  return `グループ${n}`;
}

function nextCopyName(name, existingNames) {
  const base = String(name || '').trim() || '(無題)';
  const names = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  const first = `${base} のコピー`;
  if (!names.has(first)) return first;
  let n = 2;
  while (names.has(`${first} ${n}`)) n += 1;
  return `${first} ${n}`;
}

function sanitizeGame(raw) {
  if (!raw || typeof raw !== 'object') return createGame();
  const game = createGame(raw);
  // v1.1 以前のゲームは pinned が無いので、実行タブから消えないようピン留めする
  if (!Object.prototype.hasOwnProperty.call(raw, 'pinned')) game.pinned = true;
  return game;
}

/** 空の下書き行は保存対象にしない。何か入ったときだけ永続化する。 */
function isGameFilled(game) {
  if (!game || typeof game !== 'object') return false;
  if (String(game.name || '').trim()) return true;
  if (normalizeInputPath(game.path1)) return true;
  if (normalizeInputPath(game.path2)) return true;
  if (normalizeInputPath(game.restorePath)) return true;
  if (sanitizeGameShortcut(game.shortcutBackup)) return true;
  if (sanitizeGameShortcut(game.shortcutRestore)) return true;
  if (toBool(game.pinned, false) === true) return true;
  return false;
}

function listGroups(settings) {
  return settings && Array.isArray(settings.groups) ? settings.groups : [];
}

function gamesInGroup(settings, groupId) {
  const games = settings && Array.isArray(settings.games) ? settings.games : [];
  return games.filter((g) => g.groupId === groupId);
}

/** 実行タブ用。ピン留めグループの中のピン留め経路だけ。groups が無い旧データはゲームのピンだけ見る。 */
function listPinnedGames(settings) {
  const games = settings && Array.isArray(settings.games) ? settings.games : [];
  const groups = listGroups(settings);
  if (groups.length === 0) return games.filter((g) => g.pinned);
  const pinnedGroups = new Set(groups.filter((g) => g.pinned).map((g) => g.id));
  return games.filter((g) => g.pinned && pinnedGroups.has(g.groupId));
}

function listPinnedGroups(settings) {
  return listGroups(settings).filter((g) => g.pinned);
}

function flattenGamesByGroups(groups, games) {
  const list = Array.isArray(games) ? games : [];
  const grouped = new Map();
  const leftover = [];
  for (const game of list) {
    const gid = game.groupId || '';
    if (!gid) {
      leftover.push(game);
      continue;
    }
    if (!grouped.has(gid)) grouped.set(gid, []);
    grouped.get(gid).push(game);
  }
  const next = [];
  const seen = new Set();
  for (const group of groups || []) {
    seen.add(group.id);
    next.push(...(grouped.get(group.id) || []));
  }
  for (const [gid, items] of grouped) {
    if (!seen.has(gid)) next.push(...items);
  }
  next.push(...leftover);
  return next;
}

function defaultSettings(platform = process.platform) {
  return {
    games: [],
    groups: [
      {
        id: DEFAULT_GROUP_ID,
        name: DEFAULT_GROUP_NAME,
        pinned: true,
        collapsed: false,
      },
    ],
    activeGameId: '',
    shortcutBackup: '',
    shortcutRestore: '',
    launchAtLogin: false,
    startHidden: true,
    useTimestampFolder: true,
    skipUnchanged: true,
    excludePatterns: [...DEFAULT_EXCLUDES],
    notifications: true,
    confirmRestore: true,
    keepSnapshots: 0,
    concurrency: 4,
    hideDockIcon: false,
  };
}

/**
 * v1.0 のフラット経路を、ゲーム1件として取り込む。
 * 既に games 配列がある場合はそちらを優先する。
 */
function migrateLegacyGames(input) {
  if (Array.isArray(input.games) && input.games.length > 0) {
    return {
      games: input.games.map((g) => sanitizeGame(g)),
      activeGameId: typeof input.activeGameId === 'string' ? input.activeGameId : '',
    };
  }

  const hasLegacy =
    Boolean(input.path1) || Boolean(input.path2) || Boolean(input.restorePath);
  if (!hasLegacy) {
    return { games: [], activeGameId: '' };
  }

  const game = createGame({
    name: DEFAULT_GAME_NAME,
    path1: input.path1,
    path2: input.path2,
    restorePath: input.restorePath,
    pinned: true,
  });
  return {
    games: [game],
    activeGameId: game.id,
    _fromLegacy: true,
  };
}

function migrateLegacyGroups(input, games) {
  if (Array.isArray(input.groups) && input.groups.length > 0) {
    const seen = new Set();
    return input.groups.map((raw) => {
      const group = sanitizeGroup(raw);
      if (seen.has(group.id) || group.id === DRAFT_ID) {
        const fresh = createGroup({ ...group, id: createGroupId() });
        seen.add(fresh.id);
        return fresh;
      }
      seen.add(group.id);
      return group;
    });
  }
  const fallback = createGroup({
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    pinned: true,
    collapsed: false,
  });
  return games.length > 0 || !Array.isArray(input.groups) ? [fallback] : [fallback];
}

function assignGameGroups(games, groups) {
  const fallbackId = groups[0] ? groups[0].id : '';
  const known = new Set(groups.map((g) => g.id));
  return games.map((game) => {
    if (game.groupId && known.has(game.groupId)) return game;
    return { ...game, groupId: fallbackId };
  });
}

/** v1.1 の全体ショートカットを、先頭ゲームへ移す。 */
function migrateLegacyShortcuts(games, input) {
  let next = games;
  if (!next.some((g) => g.shortcutBackup)) {
    const globalBackup = sanitizeGameShortcut(input.shortcutBackup);
    if (globalBackup && next.length > 0) {
      next = next.map((g, index) => (index === 0 ? { ...g, shortcutBackup: globalBackup } : g));
    }
  }
  if (!next.some((g) => g.shortcutRestore)) {
    const globalRestore = sanitizeGameShortcut(input.shortcutRestore);
    if (globalRestore && next.length > 0) {
      next = next.map((g, index) => (index === 0 ? { ...g, shortcutRestore: globalRestore } : g));
    }
  }
  return next;
}

/** アクティブなゲームを返す。見つからなければ先頭。 */
function getActiveGame(settings) {
  const games = settings && Array.isArray(settings.games) ? settings.games : [];
  if (games.length === 0) return createGame();
  const found = games.find((g) => g.id === settings.activeGameId);
  return found || games[0];
}

/**
 * ジョブ実行用に、アクティブゲームの経路をトップレベルへ展開した設定を返す。
 * path1 / path2 / restorePath / gameName / gameId が使える。
 */
function withActivePaths(settings) {
  const game = getActiveGame(settings);
  return {
    ...settings,
    path1: game.path1,
    path2: game.path2,
    restorePath: game.restorePath,
    gameName: game.name,
    gameId: game.id,
    shortcutBackup: game.shortcutBackup || '',
    shortcutRestore: game.shortcutRestore || '',
  };
}

function settingsForGame(settings, gameId) {
  const games = settings && Array.isArray(settings.games) ? settings.games : [];
  const found = games.find((g) => g.id === gameId);
  if (!found) return withActivePaths(settings);
  return withActivePaths({ ...settings, activeGameId: found.id });
}

/** 不正値を既定値へ丸めた設定オブジェクトを返す。 */
function sanitizeSettings(raw, platform = process.platform) {
  const defaults = defaultSettings(platform);
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };

  const migrated = migrateLegacyGames(input);
  out.games = migrateLegacyShortcuts(migrated.games, input);
  // id の重複を潰す
  const seen = new Set();
  out.games = out.games.map((g) => {
    if (!seen.has(g.id) && g.id !== DRAFT_ID) {
      seen.add(g.id);
      return g;
    }
    const fresh = createGame({ ...g, id: createGameId() });
    seen.add(fresh.id);
    return fresh;
  });

  const activeExists = out.games.some((g) => g.id === migrated.activeGameId);
  out.activeGameId = activeExists ? migrated.activeGameId : out.games[0] ? out.games[0].id : '';

  out.groups = migrateLegacyGroups(input, out.games);
  out.games = assignGameGroups(out.games, out.groups);
  out.games = flattenGamesByGroups(out.groups, out.games);

  // 全体ショートカットはゲームへ移したので、トップレベルには残さない
  out.shortcutBackup = '';
  out.shortcutRestore = '';

  out.launchAtLogin = toBool(input.launchAtLogin, defaults.launchAtLogin);
  out.startHidden = toBool(input.startHidden, defaults.startHidden);
  out.useTimestampFolder = toBool(input.useTimestampFolder, defaults.useTimestampFolder);
  out.skipUnchanged = toBool(input.skipUnchanged, defaults.skipUnchanged);
  out.notifications = toBool(input.notifications, defaults.notifications);
  out.confirmRestore = toBool(input.confirmRestore, defaults.confirmRestore);
  out.hideDockIcon = toBool(input.hideDockIcon, defaults.hideDockIcon);

  out.keepSnapshots = toInt(input.keepSnapshots, defaults.keepSnapshots, 0, 9999);
  out.concurrency = toInt(input.concurrency, defaults.concurrency, 1, 16);

  if (Array.isArray(input.excludePatterns)) {
    out.excludePatterns = input.excludePatterns
      .map((p) => String(p).trim())
      .filter((p) => p.length > 0);
  } else if (typeof input.excludePatterns === 'string') {
    out.excludePatterns = parsePatternText(input.excludePatterns);
  }

  return out;
}

class SettingsStore {
  constructor(filePath, platform = process.platform) {
    this.filePath = filePath;
    this.platform = platform;
    this.values = defaultSettings(platform);
    this.loadError = '';
  }

  load() {
    this.loadError = '';
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      this.values = sanitizeSettings(JSON.parse(text), this.platform);
    } catch (err) {
      this.values = defaultSettings(this.platform);
      if (err.code === 'ENOENT') {
        try {
          this.save();
        } catch {
          /* 書き込めなくてもメモリ上の既定値で動作させる */
        }
      } else {
        this.loadError = err.message || String(err);
      }
    }
    return this.values;
  }

  get() {
    const games = this.values.games.map((g) => ({ ...g }));
    const groups = this.values.groups.map((g) => ({ ...g }));
    return withActivePaths({
      ...this.values,
      games,
      groups,
      excludePatterns: [...this.values.excludePatterns],
    });
  }

  getRaw() {
    return {
      ...this.values,
      games: this.values.games.map((g) => ({ ...g })),
      groups: this.values.groups.map((g) => ({ ...g })),
      excludePatterns: [...this.values.excludePatterns],
    };
  }

  /**
   * 差分を反映して保存する。
   * path1 / path2 / restorePath / gameName はアクティブゲームへ書き込む。
   * games / activeGameId を直接渡した場合はそちらを優先する。
   */
  update(patch) {
    const next = { ...this.values, ...(patch || {}) };

    // トップレベルの経路・名前更新はアクティブゲームへ反映
    const pathKeys = ['path1', 'path2', 'restorePath', 'gameName'];
    const touchesActive = pathKeys.some((k) => patch && Object.prototype.hasOwnProperty.call(patch, k));
    if (touchesActive && !Array.isArray(patch.games)) {
      const games = (next.games || this.values.games).map((g) => ({ ...g }));
      if (games.length === 0) {
        const created = createGame({
          name: Object.prototype.hasOwnProperty.call(patch, 'gameName') ? patch.gameName : '',
          path1: patch.path1,
          path2: patch.path2,
          restorePath: patch.restorePath,
          pinned: true,
          groupId: (next.groups && next.groups[0] && next.groups[0].id) || DEFAULT_GROUP_ID,
        });
        games.push(created);
        next.activeGameId = created.id;
      } else {
        const activeId = next.activeGameId || this.values.activeGameId;
        const index = games.findIndex((g) => g.id === activeId);
        const target = index >= 0 ? index : 0;
        if (games[target]) {
          if (Object.prototype.hasOwnProperty.call(patch, 'path1')) games[target].path1 = patch.path1;
          if (Object.prototype.hasOwnProperty.call(patch, 'path2')) games[target].path2 = patch.path2;
          if (Object.prototype.hasOwnProperty.call(patch, 'restorePath')) {
            games[target].restorePath = patch.restorePath;
          }
          if (Object.prototype.hasOwnProperty.call(patch, 'gameName')) games[target].name = patch.gameName;
        }
      }
      next.games = games;
    }

    // フラット経路は永続化しない
    delete next.path1;
    delete next.path2;
    delete next.restorePath;
    delete next.gameName;
    delete next.gameId;
    delete next.shortcutBackup;
    delete next.shortcutRestore;

    this.values = sanitizeSettings(next, this.platform);
    this.save();
    return this.get();
  }

  /** ゲームを追加してアクティブにする。空の下書きは追加しない。 */
  addGame(partial = {}) {
    const fallbackGroup = this.values.groups[0] ? this.values.groups[0].id : DEFAULT_GROUP_ID;
    const requested = typeof partial.groupId === 'string' ? partial.groupId : '';
    const groupId = this.values.groups.some((g) => g.id === requested) ? requested : fallbackGroup;
    const game = createGame({ ...partial, groupId });
    if (!isGameFilled(game)) {
      return this.get();
    }
    const games = [...this.values.games, game];
    return this.update({ games, activeGameId: game.id });
  }

  /** 既存ゲームを複製する。ショートカットは重複登録を避けるため空にする。 */
  duplicateGame(gameId) {
    const source = this.values.games.find((g) => g.id === gameId);
    if (!source) throw new Error('指定されたゲームが見つかりません。');
    const names = new Set(this.values.games.map((g) => g.name));
    const copy = createGame({
      ...source,
      id: '',
      name: nextCopyName(source.name, names),
      shortcutBackup: '',
      shortcutRestore: '',
    });
    const games = [];
    for (const game of this.values.games) {
      games.push(game);
      if (game.id === gameId) games.push(copy);
    }
    return this.update({ games, activeGameId: copy.id });
  }

  /** ゲームを別グループへ移す。beforeId があればその直前へ入れる。 */
  moveGame(gameId, targetGroupId, beforeId = '') {
    if (!this.values.groups.some((g) => g.id === targetGroupId)) {
      throw new Error('指定されたグループが見つかりません。');
    }
    const source = this.values.games.find((g) => g.id === gameId);
    if (!source) throw new Error('指定されたゲームが見つかりません。');
    const moved = createGame({ ...source, id: source.id, groupId: targetGroupId });
    const without = this.values.games.filter((g) => g.id !== gameId);
    const next = [];
    let inserted = false;
    for (const group of this.values.groups) {
      const items = without.filter((g) => g.groupId === group.id);
      if (group.id !== targetGroupId) {
        next.push(...items);
        continue;
      }
      for (const item of items) {
        if (beforeId && item.id === beforeId && !inserted) {
          next.push(moved);
          inserted = true;
        }
        next.push(item);
      }
      if (!inserted) {
        next.push(moved);
        inserted = true;
      }
    }
    if (!inserted) next.push(moved);
    return this.update({ games: next, activeGameId: moved.id });
  }

  /** 指定ゲームを更新する。 */
  updateGame(gameId, patch = {}) {
    const exists = this.values.games.some((g) => g.id === gameId);
    if (!exists) throw new Error('指定されたゲームが見つかりません。');
    const games = this.values.games.map((g) => {
      if (g.id !== gameId) return g;
      return createGame({ ...g, ...patch, id: g.id });
    });
    return this.update({ games });
  }

  /** ゲームを削除する。 */
  removeGame(gameId) {
    const games = this.values.games.filter((g) => g.id !== gameId);
    if (games.length === this.values.games.length) {
      throw new Error('指定されたゲームが見つかりません。');
    }
    const activeGameId =
      this.values.activeGameId === gameId ? (games[0] ? games[0].id : '') : this.values.activeGameId;
    return this.update({ games, activeGameId });
  }

  /** 表示順を orderedIds の順に並べ替える。groupId があればそのグループ内だけ。 */
  reorderGames(orderedIds, groupId) {
    const wanted = Array.isArray(orderedIds) ? orderedIds : [];
    if (!groupId) {
      const byId = new Map(this.values.games.map((g) => [g.id, g]));
      const next = [];
      for (const id of wanted) {
        if (!byId.has(id)) continue;
        next.push(byId.get(id));
        byId.delete(id);
      }
      for (const leftover of byId.values()) next.push(leftover);
      return this.update({ games: next });
    }
    const inGroup = this.values.games.filter((g) => g.groupId === groupId);
    const byId = new Map(inGroup.map((g) => [g.id, g]));
    const nextIn = [];
    for (const id of wanted) {
      if (!byId.has(id)) continue;
      nextIn.push(byId.get(id));
      byId.delete(id);
    }
    for (const leftover of byId.values()) nextIn.push(leftover);
    const next = [];
    for (const group of this.values.groups) {
      if (group.id === groupId) next.push(...nextIn);
      else next.push(...this.values.games.filter((g) => g.groupId === group.id));
    }
    next.push(...this.values.games.filter((g) => !this.values.groups.some((gr) => gr.id === g.groupId)));
    return this.update({ games: next });
  }

  addGroup(partial = {}) {
    const group = createGroup({
      ...partial,
      name: String(partial.name == null ? '' : partial.name).trim() || nextGroupName(this.values.groups),
    });
    return this.update({ groups: [...this.values.groups, group] });
  }

  updateGroup(groupId, patch = {}) {
    const exists = this.values.groups.some((g) => g.id === groupId);
    if (!exists) throw new Error('指定されたグループが見つかりません。');
    const groups = this.values.groups.map((g) => {
      if (g.id !== groupId) return g;
      return createGroup({ ...g, ...patch, id: g.id });
    });
    return this.update({ groups });
  }

  removeGroup(groupId) {
    if (this.values.groups.length <= 1) {
      throw new Error('最後のグループは削除できません。');
    }
    const groups = this.values.groups.filter((g) => g.id !== groupId);
    if (groups.length === this.values.groups.length) {
      throw new Error('指定されたグループが見つかりません。');
    }
    const games = this.values.games.filter((g) => g.groupId !== groupId);
    const activeStill = games.some((g) => g.id === this.values.activeGameId);
    const activeGameId = activeStill ? this.values.activeGameId : games[0] ? games[0].id : '';
    return this.update({ groups, games, activeGameId });
  }

  reorderGroups(orderedIds) {
    const wanted = Array.isArray(orderedIds) ? orderedIds : [];
    const byId = new Map(this.values.groups.map((g) => [g.id, g]));
    const next = [];
    for (const id of wanted) {
      if (!byId.has(id)) continue;
      next.push(byId.get(id));
      byId.delete(id);
    }
    for (const leftover of byId.values()) next.push(leftover);
    return this.update({ groups: next });
  }

  /** アクティブなゲームを切り替える。 */
  setActiveGame(gameId) {
    const exists = this.values.games.some((g) => g.id === gameId);
    if (!exists) throw new Error('指定されたゲームが見つかりません。');
    return this.update({ activeGameId: gameId });
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = {
  SettingsStore,
  defaultSettings,
  sanitizeSettings,
  createGame,
  createGroup,
  getActiveGame,
  withActivePaths,
  settingsForGame,
  isGameFilled,
  listPinnedGames,
  listPinnedGroups,
  listGroups,
  gamesInGroup,
  nextGroupName,
  nextCopyName,
  sanitizeGameShortcut,
  DEFAULT_EXCLUDES,
  DEFAULT_GAME_NAME,
  DEFAULT_GROUP_NAME,
  DEFAULT_GROUP_ID,
  DRAFT_ID,
};
