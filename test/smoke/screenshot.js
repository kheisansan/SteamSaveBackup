'use strict';

/**
 * 実画面のスクリーンショットを撮る開発用スクリプト。
 *   npm run screenshot -- <出力先ディレクトリ>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { app, BrowserWindow } = require('electron');

require('../../src/main/main.js');

const outDir = process.argv.find((a) => a.startsWith('--out='))
  ? path.resolve(process.argv.find((a) => a.startsWith('--out=')).slice('--out='.length))
  : path.join(os.tmpdir(), 'ssb-shots');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(win, name) {
  const image = await win.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  process.stdout.write(`SHOT:${file}\n`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await wait(1500);

  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  await wait(1200);

  // 表示用のダミー経路とスナップショットを用意
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-shot-'));
  const path1 = path.join(base, 'Steam', 'userdata', '12345678', '·remote');
  const path2 = path.join(base, 'NAS', 'SteamSaves');
  fs.mkdirSync(path.join(path1, 'config'), { recursive: true });
  fs.writeFileSync(path.join(path1, 'save01.dat'), 'slot1');
  fs.writeFileSync(path.join(path1, 'config', 'settings.ini'), 'volume=5');
  fs.mkdirSync(path2, { recursive: true });

  await win.webContents.executeJavaScript(`(async () => {
    await window.api.resetSettings();
    await window.api.updateSettings({
      gameName: 'Smoke Game',
      path1: ${JSON.stringify(path1)},
      path2: ${JSON.stringify(path2)},
      notifications: false,
      confirmRestore: false
    });
    const current = await window.api.getSettings();
    const game = current.settings.games[0];
    if (game) {
      await window.api.updateGame(game.id, {
        shortcutBackup: 'Command+Alt+Shift+B',
        shortcutRestore: 'Command+Alt+Shift+Z',
      });
      await window.api.duplicateGame(game.id);
    }
    await window.api.addGroup({ name: 'アーカイブ' });
    await window.api.runJob('backup');
  })()`);
  await wait(600);

  for (const section of ['run', 'paths', 'behavior', 'snapshots', 'log']) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.nav-item[data-section="${section}"]').click()`
    );
    await wait(500);
    await capture(win, section);
  }

  fs.rmSync(base, { recursive: true, force: true });
  app.exit(0);
});
