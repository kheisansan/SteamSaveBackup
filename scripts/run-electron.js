'use strict';

/**
 * Electron 起動ラッパー。
 * エディタ内蔵ターミナル(Cursor/VS Code)には ELECTRON_RUN_AS_NODE=1 が入っている場合があり、
 * そのまま electron を叩くと素の Node として起動してしまうため、ここで環境変数を外す。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

const args = process.argv.slice(2).map((arg) => {
  if (!arg.startsWith('--user-data-dir=')) return arg;
  const dir = path.resolve(arg.slice('--user-data-dir='.length));
  fs.mkdirSync(dir, { recursive: true });
  return `--user-data-dir=${dir}`;
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, args.length > 0 ? args : ['.'], {
  stdio: 'inherit',
  env,
});

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
