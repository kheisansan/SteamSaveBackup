'use strict';

/** 経路文字列の正規化と、コピー元/先の安全性チェック。 */

const path = require('node:path');
const os = require('node:os');

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** UNCパス(\\\\server\\share もしくは //server/share)かどうか。 */
function isUncPath(input) {
  return /^(\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+/.test(String(input));
}

/**
 * ユーザー入力の経路を正規化する。
 * - 前後の空白/引用符を除去
 * - 先頭の `~` をホームに展開
 * - file:// URL を解除
 * - Windowsでは区切りを `\` に統一(UNCの先頭 `\\` は保持)
 */
function normalizeInputPath(input) {
  let value = String(input == null ? '' : input).trim();
  if (!value) return '';

  value = value.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim();
  if (!value) return '';

  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\//i, ''));
      if (process.platform === 'win32' && /^\/[a-z]:/i.test(value)) value = value.slice(1);
    } catch {
      /* デコードできない場合は元の文字列のまま扱う */
    }
  }

  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }

  if (process.platform === 'win32') {
    const unc = isUncPath(value);
    value = value.replace(/\//g, '\\');
    if (unc) value = `\\\\${value.replace(/^\\+/, '')}`;
  }

  // 末尾区切りを落とす(ルート直下やUNCのサーバ/共有名までは保持)
  const isRoot = value === path.sep || /^[a-z]:[\\/]?$/i.test(value);
  if (!isRoot && value.length > 1) {
    const trimmed = value.replace(/[\\/]+$/, '');
    if (trimmed && !(isUncPath(value) && !isUncPath(trimmed))) value = trimmed;
  }

  return value;
}

function comparable(p) {
  const resolved = path.resolve(p);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function isSamePath(a, b) {
  if (!a || !b) return false;
  return comparable(a) === comparable(b);
}

/** child が parent と同じ、または parent の配下かどうか。 */
function isSameOrInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(comparable(parent), comparable(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * コピー元/先の組み合わせを検証する。
 * 無限再帰や自己上書きになる組み合わせを弾く。
 */
function validateCopyPair(src, dest) {
  if (!src) return { ok: false, error: 'コピー元の経路が未設定です。' };
  if (!dest) return { ok: false, error: 'コピー先の経路が未設定です。' };
  if (!path.isAbsolute(src) && !isUncPath(src)) {
    return { ok: false, error: `コピー元は絶対パスで指定してください: ${src}` };
  }
  if (!path.isAbsolute(dest) && !isUncPath(dest)) {
    return { ok: false, error: `コピー先は絶対パスで指定してください: ${dest}` };
  }
  if (isSamePath(src, dest)) {
    return { ok: false, error: 'コピー元とコピー先が同じ経路です。' };
  }
  if (isSameOrInside(src, dest)) {
    return { ok: false, error: 'コピー先がコピー元の配下にあります(無限にコピーされるため中止)。' };
  }
  if (isSameOrInside(dest, src)) {
    return { ok: false, error: 'コピー元がコピー先の配下にあります(上書き事故を防ぐため中止)。' };
  }
  return { ok: true };
}

module.exports = {
  isUncPath,
  normalizeInputPath,
  isSamePath,
  isSameOrInside,
  validateCopyPair,
};
