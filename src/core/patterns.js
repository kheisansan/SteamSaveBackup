'use strict';

/** 除外パターン(簡易グロブ)の判定。`*` と `?` のみ対応。 */

const path = require('node:path');

function escapeRegExp(str) {
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * パターン文字列を判定関数に変換する。
 * - `/` を含むパターンは相対パス全体に対して照合
 * - 含まないパターンはファイル/フォルダ名に対して照合
 * - 末尾が `/` のパターンはディレクトリのみ対象
 */
function compilePattern(pattern, { caseSensitive = false } = {}) {
  let raw = String(pattern).trim();
  if (!raw) return null;

  const dirOnly = raw.endsWith('/');
  if (dirOnly) raw = raw.slice(0, -1);
  const matchFullPath = raw.includes('/');

  const source = `^${escapeRegExp(raw).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`;
  const re = new RegExp(source, caseSensitive ? '' : 'i');

  return (relPath, isDirectory) => {
    if (dirOnly && !isDirectory) return false;
    const target = matchFullPath ? relPath.split(path.sep).join('/') : path.basename(relPath);
    return re.test(target);
  };
}

/** パターン配列から「除外する?」を返す関数を作る。 */
function createExcluder(patterns, options) {
  const matchers = (patterns || [])
    .map((p) => compilePattern(p, options))
    .filter(Boolean);
  if (matchers.length === 0) return () => false;
  return (relPath, isDirectory = false) => matchers.some((m) => m(relPath, isDirectory));
}

/** 改行/カンマ区切りのテキストをパターン配列にする。 */
function parsePatternText(text) {
  return String(text || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

module.exports = { compilePattern, createExcluder, parsePatternText };
