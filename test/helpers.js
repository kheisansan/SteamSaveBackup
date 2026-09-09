'use strict';

/** テスト用の一時ディレクトリ操作。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeTmpDir(prefix = 'ssb-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * オブジェクトからファイルツリーを作る。
 * 値が文字列ならファイル、オブジェクトならディレクトリ。
 */
function writeTree(root, spec) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of Object.entries(spec)) {
    const target = path.join(root, name);
    if (typeof value === 'string') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value, 'utf8');
    } else {
      writeTree(target, value);
    }
  }
  return root;
}

/** ツリーを「相対パス -> 内容」の平坦なオブジェクトとして読み出す。 */
function readTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out[childRel] = `@symlink:${fs.readlinkSync(abs)}`;
      else if (entry.isDirectory()) walk(abs, childRel);
      else out[childRel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

function listDirs(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

module.exports = { makeTmpDir, writeTree, readTree, listDirs };
