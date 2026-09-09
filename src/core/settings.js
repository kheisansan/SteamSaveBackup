'use strict';

/** 設定の既定値・検証・JSON保存(原子的書き込み)。ゲーム別の経路を管理する。 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultAccelerators, validateAccelerator } = require('./accelerator');
const { normalizeInputPath } = require('./pathcheck');
const { parsePatternText } = require('./patterns');

const DEFAULT_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const DEFAULT_GAME_NAME = 'ゲーム1';

function createGameId() {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 1ゲーム分の経路設定を作る。 */
function createGame(partial = {}) {
  const name = String(partial.name == null ? DEFAULT_GAME_NAME : partial.name).trim() || DEFAULT_GAME_NAME;
  return {
    id: typeof partial.id === 'string' && partial.id.trim() ? partial.id.trim() : createGameId(),
    name,
    path1: normalizeInputPath(partial.path1),
    path2: normalizeInputPath(partial.path2),
    restorePath: normalizeInputPath(partial.restorePath),
  };
}

function sanitizeGame(raw) {
  if (!raw || typeof raw !== 'object') return createGame();
  return createGame(raw);
}

function defaultSettings(platform = process.platform) {
  const acc = defaultAccelerators(platform);
  const game = createGame({ name: DEFAULT_GAME_NAME });
  return {
    games: [game],
    activeGameId: game.id,
    shortcutBackup: acc.backup,
    shortcutRestore: acc.restore,
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
  const game = createGame({
    name: DEFAULT_GAME_NAME,
    path1: input.path1,
    path2: input.path2,
    restorePath: input.restorePath,
  });
  return {
    games: [game],
    activeGameId: game.id,
    // レガシー経路が空でも1件は必ず持たせる(初回起動と同じ)
    _fromLegacy: hasLegacy,
  };
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
  };
}

/** 不正値を既定値へ丸めた設定オブジェクトを返す。 */
function sanitizeSettings(raw, platform = process.platform) {
  const defaults = defaultSettings(platform);
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };

  const migrated = migrateLegacyGames(input);
  out.games = migrated.games;
  // id の重複を潰す
  const seen = new Set();
  out.games = out.games.map((g) => {
    if (!seen.has(g.id)) {
      seen.add(g.id);
      return g;
    }
    const fresh = createGame({ ...g, id: createGameId() });
    seen.add(fresh.id);
    return fresh;
  });
  if (out.games.length === 0) out.games = [createGame({ name: DEFAULT_GAME_NAME })];

  const activeExists = out.games.some((g) => g.id === migrated.activeGameId);
  out.activeGameId = activeExists ? migrated.activeGameId : out.games[0].id;

  for (const key of ['shortcutBackup', 'shortcutRestore']) {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    out[key] = validateAccelerator(value).ok ? value : defaults[key];
  }

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
  }

  load() {
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
      }
    }
    return this.values;
  }

  get() {
    const games = this.values.games.map((g) => ({ ...g }));
    return withActivePaths({
      ...this.values,
      games,
      excludePatterns: [...this.values.excludePatterns],
    });
  }

  getRaw() {
    return {
      ...this.values,
      games: this.values.games.map((g) => ({ ...g })),
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
      next.games = games;
    }

    // フラット経路は永続化しない
    delete next.path1;
    delete next.path2;
    delete next.restorePath;
    delete next.gameName;
    delete next.gameId;

    this.values = sanitizeSettings(next, this.platform);
    this.save();
    return this.get();
  }

  /** ゲームを追加してアクティブにする。 */
  addGame(partial = {}) {
    const game = createGame(partial);
    const games = [...this.values.games, game];
    return this.update({ games, activeGameId: game.id });
  }

  /** 指定ゲームを更新する。 */
  updateGame(gameId, patch = {}) {
    const games = this.values.games.map((g) => {
      if (g.id !== gameId) return g;
      return createGame({ ...g, ...patch, id: g.id });
    });
    return this.update({ games });
  }

  /** ゲームを削除する。最後の1件は削除できない。 */
  removeGame(gameId) {
    if (this.values.games.length <= 1) {
      throw new Error('最後のゲームは削除できません。');
    }
    const games = this.values.games.filter((g) => g.id !== gameId);
    if (games.length === this.values.games.length) {
      throw new Error('指定されたゲームが見つかりません。');
    }
    const activeGameId =
      this.values.activeGameId === gameId ? games[0].id : this.values.activeGameId;
    return this.update({ games, activeGameId });
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
  getActiveGame,
  withActivePaths,
  DEFAULT_EXCLUDES,
  DEFAULT_GAME_NAME,
};
