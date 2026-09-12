'use strict';

/**
 * Apple Silicon では、未署名の .app が Gatekeeper に
 * 「ファイルが壊れている」と判定される。
 * Developer ID が無いときは ad-hoc 署名を付けてから dmg/zip 化する。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function shouldAdhocSign(electronPlatformName) {
  return electronPlatformName === 'darwin';
}

function resolveMacAppPath(appOutDir, productFilename) {
  return path.join(appOutDir, `${productFilename}.app`);
}

function adhocSignArgs(appPath) {
  return ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath];
}

function verifyArgs(appPath) {
  return ['--verify', '--deep', '--strict', appPath];
}

function runCodesign(args, runner = spawnSync) {
  const result = runner('codesign', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim();
    throw new Error(`codesign ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

async function afterPack(context, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const runner = deps.spawnSync || spawnSync;

  if (!shouldAdhocSign(context.electronPlatformName)) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = resolveMacAppPath(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`afterPack: app bundle not found: ${appPath}`);
  }

  runCodesign(adhocSignArgs(appPath), runner);
  runCodesign(verifyArgs(appPath), runner);
  console.log(`afterPack: ad-hoc signed ${appPath}`);
}

module.exports = {
  shouldAdhocSign,
  resolveMacAppPath,
  adhocSignArgs,
  verifyArgs,
  runCodesign,
  afterPack,
  default: afterPack,
};
