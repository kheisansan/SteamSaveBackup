'use strict';

/** 設定の既定値・検証・JSON保存(原子的書き込み)。 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultAccelerators, validateAccelerator } = require('./accelerator');
const { normalizeInputPath } = require('./pathcheck');
const { parsePatternText } = require('./patterns');

const DEFAULT_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

function defaultSettings(platform = process.platform) {
  const acc = defaultAccelerators(platform);
  return {
    path1: '',
    path2: '',
    restorePath: '',
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

/** 不正値を既定値へ丸めた設定オブジェクトを返す。 */
function sanitizeSettings(raw, platform = process.platform) {
  const defaults = defaultSettings(platform);
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };

  out.path1 = normalizeInputPath(input.path1);
  out.path2 = normalizeInputPath(input.path2);
  out.restorePath = normalizeInputPath(input.restorePath);

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
      // 初回起動 / 壊れたJSON の場合は既定値で始める
      this.values = defaultSettings(this.platform);
      // 初回だけ実体を作る(壊れたJSONは上書きせず残す)
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
    return { ...this.values, excludePatterns: [...this.values.excludePatterns] };
  }

  /** 差分を反映して保存し、反映後の設定を返す。 */
  update(patch) {
    this.values = sanitizeSettings({ ...this.values, ...(patch || {}) }, this.platform);
    this.save();
    return this.get();
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { SettingsStore, defaultSettings, sanitizeSettings, DEFAULT_EXCLUDES };
