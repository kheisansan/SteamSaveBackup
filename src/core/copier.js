'use strict';

/**
 * サブディレクトリを含むツリー丸ごとコピー。
 * - 進捗通知つき(走査 -> コピーの2フェーズ)
 * - 1ファイル失敗しても止めずに続行し、最後にまとめて報告
 * - シンボリックリンクは辿らず、リンクとして再作成(ループ防止)
 * - SMB/UNC でのシンボリックリンク誤判定は通常ファイルとしてコピーする
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MTIME_TOLERANCE_MS = 2000;
const MAX_RECORDED_ERRORS = 200;
const DEFAULT_CONCURRENCY = 4;
const PROGRESS_INTERVAL_MS = 150;

class CanceledError extends Error {
  constructor() {
    super('処理がキャンセルされました。');
    this.name = 'CanceledError';
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new CanceledError();
}

/**
 * Dirent の種別を確定する。
 * Windows の SMB/UNC では `isSymbolicLink()` が通常ファイルに対して true になることがあり、
 * そのまま readlink すると EINVAL になる。リンク候補は lstat + readlink で再確認する。
 * @returns {Promise<{kind:'dir'|'file'|'link'|'other'|'error', size?:number, mtimeMs?:number, message?:string}>}
 */
async function resolveEntryKind(abs, entry) {
  const asFile = (stat) => ({ kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs });

  if (!entry.isSymbolicLink()) {
    if (entry.isDirectory()) return { kind: 'dir' };
    if (entry.isFile()) {
      try {
        return asFile(await fsp.lstat(abs));
      } catch (err) {
        return { kind: 'error', message: err.message };
      }
    }
    return { kind: 'other' };
  }

  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (err) {
    return { kind: 'error', message: err.message };
  }

  if (stat.isSymbolicLink()) {
    try {
      await fsp.readlink(abs);
      return { kind: 'link' };
    } catch {
      // EINVAL 等: リンクではない reparse point / SMB 誤判定 → 中身を通常コピーする
      if (stat.isDirectory()) return { kind: 'dir' };
      return asFile(stat);
    }
  }
  if (stat.isDirectory()) return { kind: 'dir' };
  if (stat.isFile()) return asFile(stat);
  return { kind: 'other' };
}

/**
 * ツリーを走査して、作るべきディレクトリ/コピーするファイル一覧を集める。
 * 返す順序は「親が先」になっているのでそのまま mkdir に使える。
 */
async function scanTree(root, { exclude, signal, onCount } = {}) {
  const dirs = [];
  const files = [];
  const links = [];
  const errors = [];
  let totalBytes = 0;

  const stack = [''];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);

    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: abs, message: err.message });
      continue;
    }

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : path.join(rel, entry.name);
      const absChild = path.join(root, childRel);
      const resolved = await resolveEntryKind(absChild, entry);
      const isDir = resolved.kind === 'dir';
      if (exclude && exclude(childRel, isDir)) continue;

      if (resolved.kind === 'error') {
        errors.push({ path: absChild, message: resolved.message });
      } else if (resolved.kind === 'link') {
        links.push({ rel: childRel });
      } else if (resolved.kind === 'dir') {
        dirs.push(childRel);
        stack.push(childRel);
      } else if (resolved.kind === 'file') {
        files.push({ rel: childRel, size: resolved.size, mtimeMs: resolved.mtimeMs });
        totalBytes += resolved.size;
      }
      // FIFO/デバイス等の特殊ファイルは対象外
    }

    if (onCount) onCount({ files: files.length, dirs: dirs.length, bytes: totalBytes });
  }

  dirs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return { dirs, files, links, errors, totalBytes };
}

/** コピー先が同一内容(サイズ+更新時刻)ならスキップ可否を判定する。 */
async function isUnchanged(destFile, srcMeta) {
  try {
    const stat = await fsp.lstat(destFile);
    if (!stat.isFile()) return false;
    if (stat.size !== srcMeta.size) return false;
    return Math.abs(stat.mtimeMs - srcMeta.mtimeMs) <= MTIME_TOLERANCE_MS;
  } catch {
    return false;
  }
}

async function copyOneFile(srcFile, destFile, srcMeta, skipUnchanged) {
  if (skipUnchanged && (await isUnchanged(destFile, srcMeta))) return 'skipped';

  try {
    await fsp.copyFile(srcFile, destFile, fs.constants.COPYFILE_FICLONE);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
      // 読み取り専用ファイルが居座っている場合は書き込み可にして消してから再試行
      try {
        await fsp.chmod(destFile, 0o666);
      } catch {
        /* 属性を変えられなくても削除できる場合がある */
      }
      await fsp.rm(destFile, { force: true });
      await fsp.copyFile(srcFile, destFile);
    } else {
      throw err;
    }
  }

  // 次回の「変更なしスキップ」判定のため更新時刻を合わせる
  try {
    await fsp.utimes(destFile, new Date(), new Date(srcMeta.mtimeMs));
  } catch {
    /* SMB共有等では失敗し得るが致命的ではない */
  }
  return 'copied';
}

/** @returns {Promise<'link'|'file'>} */
async function recreateSymlink(srcLink, destLink) {
  try {
    const target = await fsp.readlink(srcLink);
    await fsp.rm(destLink, { force: true, recursive: true });
    await fsp.symlink(target, destLink);
    return 'link';
  } catch (err) {
    // 走査時の誤判定が残った場合の保険: 通常ファイルとしてコピーする
    if (err.code === 'EINVAL' || err.code === 'UNKNOWN') {
      const stat = await fsp.lstat(srcLink);
      await fsp.copyFile(srcLink, destLink);
      try {
        await fsp.utimes(destLink, new Date(), new Date(stat.mtimeMs));
      } catch {
        /* SMB共有等では失敗し得るが致命的ではない */
      }
      return 'file';
    }
    throw err;
  }
}

/**
 * src の中身を dest 配下へコピーする。
 * @returns {Promise<object>} 件数/バイト数/エラーを含むレポート
 */
async function copyTree(src, dest, options = {}) {
  const {
    exclude,
    skipUnchanged = true,
    onProgress,
    signal,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  const startedAt = Date.now();
  const report = {
    src,
    dest,
    copiedFiles: 0,
    skippedFiles: 0,
    createdDirs: 0,
    symlinks: 0,
    copiedBytes: 0,
    totalFiles: 0,
    totalBytes: 0,
    errors: [],
    errorCount: 0,
    canceled: false,
    durationMs: 0,
  };

  const addError = (target, message) => {
    report.errorCount += 1;
    if (report.errors.length < MAX_RECORDED_ERRORS) report.errors.push({ path: target, message });
  };

  let lastEmit = 0;
  const emit = (phase, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    onProgress({
      phase,
      totalFiles: report.totalFiles,
      totalBytes: report.totalBytes,
      doneFiles: report.copiedFiles + report.skippedFiles,
      doneBytes: report.copiedBytes,
      errorCount: report.errorCount,
    });
  };

  try {
    const srcStat = await fsp.lstat(src);
    if (!srcStat.isDirectory()) {
      throw new Error(`コピー元がフォルダではありません: ${src}`);
    }

    emit('scan', true);
    const scan = await scanTree(src, {
      exclude,
      signal,
      onCount: () => emit('scan'),
    });
    report.totalFiles = scan.files.length;
    report.totalBytes = scan.totalBytes;
    for (const e of scan.errors) addError(e.path, e.message);
    emit('scan', true);

    await fsp.mkdir(dest, { recursive: true });
    for (const rel of scan.dirs) {
      throwIfAborted(signal);
      try {
        await fsp.mkdir(path.join(dest, rel), { recursive: true });
        report.createdDirs += 1;
      } catch (err) {
        addError(path.join(dest, rel), err.message);
      }
    }

    emit('copy', true);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        throwIfAborted(signal);
        const index = cursor;
        cursor += 1;
        if (index >= scan.files.length) return;
        const file = scan.files[index];
        const srcFile = path.join(src, file.rel);
        const destFile = path.join(dest, file.rel);
        try {
          const result = await copyOneFile(srcFile, destFile, file, skipUnchanged);
          if (result === 'copied') {
            report.copiedFiles += 1;
            report.copiedBytes += file.size;
          } else {
            report.skippedFiles += 1;
          }
        } catch (err) {
          addError(srcFile, err.message);
        }
        emit('copy');
      }
    };

    const workers = [];
    const poolSize = Math.max(1, Math.min(concurrency, scan.files.length || 1));
    for (let i = 0; i < poolSize; i += 1) workers.push(worker());
    await Promise.all(workers);

    for (const link of scan.links) {
      throwIfAborted(signal);
      try {
        const result = await recreateSymlink(path.join(src, link.rel), path.join(dest, link.rel));
        if (result === 'link') report.symlinks += 1;
        else report.copiedFiles += 1;
      } catch (err) {
        addError(path.join(src, link.rel), err.message);
      }
    }

    emit('done', true);
  } catch (err) {
    if (err instanceof CanceledError) {
      report.canceled = true;
    } else {
      addError(src, err.message);
      report.fatal = err.message;
    }
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}

module.exports = { copyTree, scanTree, resolveEntryKind, CanceledError, MTIME_TOLERANCE_MS };
