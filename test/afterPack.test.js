'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  shouldAdhocSign,
  resolveMacAppPath,
  adhocSignArgs,
  verifyArgs,
  runCodesign,
  afterPack,
} = require('../scripts/afterPack');

describe('afterPack ad-hoc sign', () => {
  it('macOS だけ署名対象にする', () => {
    assert.equal(shouldAdhocSign('darwin'), true);
    assert.equal(shouldAdhocSign('win32'), false);
    assert.equal(shouldAdhocSign('linux'), false);
  });

  it('アプリ束のパスを productFilename.app で組み立てる', () => {
    assert.equal(
      resolveMacAppPath('/tmp/out', 'SteamSaveBackup'),
      path.join('/tmp/out', 'SteamSaveBackup.app'),
    );
  });

  it('ad-hoc 署名と検証の codesign 引数を組む', () => {
    const app = '/tmp/SteamSaveBackup.app';
    assert.deepEqual(adhocSignArgs(app), [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--timestamp=none',
      app,
    ]);
    assert.deepEqual(verifyArgs(app), ['--verify', '--deep', '--strict', app]);
  });

  it('codesign が失敗したら例外にする', () => {
    assert.throws(
      () => runCodesign(['--verify', 'x'], () => ({ status: 1, stderr: 'boom', stdout: '' })),
      /codesign .* failed: boom/,
    );
  });

  it('darwin では署名→検証の順で codesign を叩く', async () => {
    const calls = [];
    await afterPack(
      {
        electronPlatformName: 'darwin',
        appOutDir: '/tmp/out',
        packager: { appInfo: { productFilename: 'SteamSaveBackup' } },
      },
      {
        existsSync: () => true,
        spawnSync: (cmd, args) => {
          calls.push([cmd, ...args]);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'codesign');
    assert.deepEqual(calls[0].slice(1), adhocSignArgs(path.join('/tmp/out', 'SteamSaveBackup.app')));
    assert.deepEqual(calls[1].slice(1), verifyArgs(path.join('/tmp/out', 'SteamSaveBackup.app')));
  });

  it('darwin 以外では何もしない', async () => {
    let called = false;
    await afterPack(
      { electronPlatformName: 'win32', appOutDir: '/tmp/out', packager: { appInfo: { productFilename: 'X' } } },
      { existsSync: () => true, spawnSync: () => { called = true; return { status: 0 }; } },
    );
    assert.equal(called, false);
  });

  it('app が無いときは失敗する', async () => {
    await assert.rejects(
      () => afterPack(
        {
          electronPlatformName: 'darwin',
          appOutDir: '/tmp/missing',
          packager: { appInfo: { productFilename: 'SteamSaveBackup' } },
        },
        { existsSync: () => false, spawnSync: () => ({ status: 0 }) },
      ),
      /app bundle not found/,
    );
  });
});
