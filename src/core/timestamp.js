'use strict';

/** 「yyyymmdd_hhMM」形式のスナップショットフォルダ名を扱う。 */

const SNAPSHOT_RE = /^(\d{8})_(\d{4})(?:_(\d+))?$/;

function pad(value, len) {
  return String(value).padStart(len, '0');
}

/** ローカル時刻から「yyyymmdd_hhMM」を作る。 */
function formatStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
    `_${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}`
  );
}

function isSnapshotName(name) {
  return SNAPSHOT_RE.test(name);
}

/**
 * 同じ分に複数回実行された場合でも衝突しない名前を返す。
 * exists は同期的に存在判定する関数(名前 -> boolean)。
 */
function uniqueSnapshotName(stamp, exists) {
  if (!exists(stamp)) return stamp;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stamp}_${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`スナップショット名が枯渇しました: ${stamp}`);
}

/** スナップショット名を新しい順に並べる。 */
function sortSnapshotsDesc(names) {
  return names
    .filter(isSnapshotName)
    .sort((a, b) => {
      const ma = SNAPSHOT_RE.exec(a);
      const mb = SNAPSHOT_RE.exec(b);
      const keyA = `${ma[1]}${ma[2]}`;
      const keyB = `${mb[1]}${mb[2]}`;
      if (keyA !== keyB) return keyA < keyB ? 1 : -1;
      const seqA = Number(ma[3] || 1);
      const seqB = Number(mb[3] || 1);
      return seqB - seqA;
    });
}

/** 「yyyymmdd_hhMM」を表示用の「yyyy/mm/dd hh:MM」に変換する。 */
function describeSnapshot(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return name;
  const [, ymd, hm, seq] = m;
  const base = `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)} ${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
  return seq ? `${base} (${seq})` : base;
}

module.exports = {
  SNAPSHOT_RE,
  formatStamp,
  isSnapshotName,
  uniqueSnapshotName,
  sortSnapshotsDesc,
  describeSnapshot,
};
