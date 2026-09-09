'use strict';

/** 表示用の整形ヘルパー。 */

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total} ms`;
  const sec = Math.floor(total / 1000);
  if (sec < 60) return `${sec}.${Math.floor((total % 1000) / 100)} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return `${min}分${String(rest).padStart(2, '0')}秒`;
  return `${Math.floor(min / 60)}時間${String(min % 60).padStart(2, '0')}分`;
}

function formatClock(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ジョブ結果を1〜2行のサマリ文にする(通知/ログ用)。 */
function summarizeResult(result) {
  if (!result) return '';
  if (result.message && !result.report) return result.message;

  const r = result.report || {};
  if (r.canceled) {
    return `中止しました(コピー済み ${r.copiedFiles} 件 / ${formatBytes(r.copiedBytes)})`;
  }
  if (r.fatal) return `失敗: ${r.fatal}`;

  const parts = [`${r.copiedFiles} 件 / ${formatBytes(r.copiedBytes)}`];
  if (r.skippedFiles > 0) parts.push(`変更なし ${r.skippedFiles} 件`);
  if (r.errorCount > 0) parts.push(`エラー ${r.errorCount} 件`);
  parts.push(formatDuration(r.durationMs));
  return parts.join(' / ');
}

function progressRatio(progress) {
  if (!progress) return 0;
  if (progress.totalFiles > 0) {
    return Math.min(1, progress.doneFiles / progress.totalFiles);
  }
  return 0;
}

module.exports = { formatBytes, formatDuration, formatClock, summarizeResult, progressRatio };
