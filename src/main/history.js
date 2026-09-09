'use strict';

/** 実行履歴をメモリに保持しつつテキストログへ追記する。 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 200;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

class History {
  constructor(logPath, { maxEntries = MAX_ENTRIES } = {}) {
    this.logPath = logPath;
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  /**
   * 1件追加する。
   * @param {{level:'info'|'warn'|'error',text:string,detail?:string}} entry
   */
  add(entry) {
    const record = {
      time: new Date().toISOString(),
      level: entry.level || 'info',
      text: entry.text || '',
      detail: entry.detail || '',
    };
    this.entries.unshift(record);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    this.appendToFile(record);
    return record;
  }

  list() {
    return this.entries.slice();
  }

  clear() {
    this.entries = [];
  }

  appendToFile(record) {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      const detail = record.detail ? `\t${record.detail.replace(/\n/g, ' / ')}` : '';
      fs.appendFileSync(
        this.logPath,
        `${record.time}\t${record.level.toUpperCase()}\t${record.text}${detail}\n`,
        'utf8'
      );
    } catch {
      /* ログ書き込み失敗でアプリを止める必要は無い */
    }
  }

  rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      }
    } catch {
      /* まだファイルが無い場合は何もしない */
    }
  }
}

module.exports = { History };
