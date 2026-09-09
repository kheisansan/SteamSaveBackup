'use strict';

/** 経路2直下の「yyyymmdd_hhMM」フォルダの一覧取得と世代整理。 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isSnapshotName, sortSnapshotsDesc, describeSnapshot } = require('./timestamp');

/** 新しい順のスナップショット名一覧を返す。 */
async function listSnapshots(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => e.isDirectory() && isSnapshotName(e.name))
    .map((e) => e.name);
  return sortSnapshotsDesc(names);
}

/**
 * 新しいものを keep 件だけ残し、古いスナップショットを削除する。
 * keep が 0 以下なら何もしない(無制限)。命名規則に一致するフォルダのみ対象。
 */
async function pruneSnapshots(root, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return { removed: [], errors: [] };
  const names = await listSnapshots(root);
  const targets = names.slice(keep);
  const removed = [];
  const errors = [];
  for (const name of targets) {
    try {
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      errors.push({ path: path.join(root, name), message: err.message });
    }
  }
  return { removed, errors };
}

module.exports = { listSnapshots, pruneSnapshots, describeSnapshot };
