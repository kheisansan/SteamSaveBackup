'use strict';

/**
 * コピー処理の実行管理。
 * Electron に依存しないので単体テストで直接叩ける。
 * direction:
 *   'backup'  = 経路1 -> 経路2/yyyymmdd_hhMM
 *   'restore' = 復元元フォルダ -> 経路1（日時フォルダを作らず強制上書き）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { copyTree } = require('./copier');
const { createExcluder } = require('./patterns');
const { validateCopyPair } = require('./pathcheck');
const { formatStamp, uniqueSnapshotName } = require('./timestamp');
const { pruneSnapshots } = require('./snapshots');

const DIRECTION_LABEL = {
  backup: '経路1 → 経路2',
  restore: '復元元 → 経路1',
};

class JobError extends Error {}

async function assertDirectory(target, label) {
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new JobError(`${label}が見つかりません: ${target}`);
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new JobError(`${label}へのアクセスが拒否されました: ${target}`);
    }
    throw new JobError(`${label}を確認できません(${err.code || err.message}): ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new JobError(`${label}がフォルダではありません: ${target}`);
  }
}

/**
 * 実行対象のコピー元/先を決める。
 * @returns {Promise<{src:string,dest:string,snapshotName:string|null}>}
 */
async function resolveEndpoints(direction, settings) {
  const { path1, path2, restorePath, useTimestampFolder } = settings;

  if (direction === 'backup') {
    const pair = validateCopyPair(path1, path2);
    if (!pair.ok) throw new JobError(pair.error);

    await assertDirectory(path1, 'コピー元(経路1)');
    await fsp.mkdir(path2, { recursive: true });
    if (!useTimestampFolder) return { src: path1, dest: path2, snapshotName: null };
    const name = uniqueSnapshotName(formatStamp(), (candidate) =>
      fs.existsSync(path.join(path2, candidate))
    );
    return { src: path1, dest: path.join(path2, name), snapshotName: name };
  }

  if (direction === 'restore') {
    if (!restorePath) throw new JobError('復元元フォルダが未設定です。');
    const pair = validateCopyPair(restorePath, path1);
    if (!pair.ok) throw new JobError(pair.error);

    await assertDirectory(restorePath, 'コピー元(復元元フォルダ)');
    await fsp.mkdir(path1, { recursive: true });
    // 復元では日時フォルダを作らず、復元元の中身をそのまま経路1へ展開する
    return { src: restorePath, dest: path1, snapshotName: null };
  }

  throw new JobError(`不明な方向指定です: ${direction}`);
}

class JobRunner extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.current = null;
    this.controller = null;
  }

  get busy() {
    return this.current !== null;
  }

  cancel() {
    if (this.controller) this.controller.abort();
  }

  /**
   * コピーを実行する。多重起動は拒否する。
   * @param {'backup'|'restore'} direction
   */
  async run(direction, { trigger = 'manual' } = {}) {
    if (this.busy) {
      const busyResult = {
        ok: false,
        direction,
        message: `実行中です(${DIRECTION_LABEL[this.current] || this.current})。完了までお待ちください。`,
      };
      this.emit('rejected', busyResult);
      return busyResult;
    }

    const settings = this.getSettings();
    this.current = direction;
    this.controller = new AbortController();

    const startedAt = new Date();
    const gameName = settings.gameName || '';
    const label = gameName
      ? `${DIRECTION_LABEL[direction]} [${gameName}]`
      : DIRECTION_LABEL[direction];
    let endpoints = null;
    try {
      endpoints = await resolveEndpoints(direction, settings);

      this.emit('start', {
        direction,
        label,
        gameName,
        gameId: settings.gameId || '',
        src: endpoints.src,
        dest: endpoints.dest,
        snapshotName: endpoints.snapshotName,
        trigger,
        startedAt: startedAt.toISOString(),
      });

      const report = await copyTree(endpoints.src, endpoints.dest, {
        exclude: createExcluder(settings.excludePatterns),
        // 復元は必ず強制上書き(「変更なしスキップ」設定に関わらず全ファイルを書き戻す)
        skipUnchanged: direction === 'restore' ? false : settings.skipUnchanged,
        concurrency: settings.concurrency,
        signal: this.controller.signal,
        onProgress: (p) => this.emit('progress', { direction, ...p }),
      });

      let pruned = null;
      if (
        direction === 'backup' &&
        settings.useTimestampFolder &&
        settings.keepSnapshots > 0 &&
        !report.canceled &&
        !report.fatal
      ) {
        pruned = await pruneSnapshots(settings.path2, settings.keepSnapshots);
      }

      const result = {
        ok: !report.canceled && !report.fatal && report.errorCount === 0,
        direction,
        label,
        gameName,
        gameId: settings.gameId || '',
        src: endpoints.src,
        dest: endpoints.dest,
        snapshotName: endpoints.snapshotName,
        trigger,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        report,
        pruned,
      };
      this.emit('done', result);
      return result;
    } catch (err) {
      const result = {
        ok: false,
        direction,
        label,
        gameName,
        gameId: settings.gameId || '',
        src: endpoints ? endpoints.src : direction === 'restore' ? settings.restorePath : settings.path1,
        dest: endpoints ? endpoints.dest : direction === 'restore' ? settings.path1 : settings.path2,
        trigger,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        message: err.message,
      };
      this.emit('failed', result);
      return result;
    } finally {
      this.current = null;
      this.controller = null;
    }
  }
}

module.exports = { JobRunner, JobError, resolveEndpoints, DIRECTION_LABEL };
