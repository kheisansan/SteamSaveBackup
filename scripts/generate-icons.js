'use strict';

/**
 * 依存パッケージ無しでアプリ/トレイ用のPNGを生成する。
 * ビルド前に build/ 配下へ出力するだけの補助スクリプト。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BUILD_DIR = path.join(__dirname, '..', 'build');

// ---------------------------------------------------------------- PNG encoder

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  return crcTable;
}

function crc32(buf) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA画素配列(Uint8Array)をPNGバッファに変換する。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[(stride + 1) * y] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      (stride + 1) * y + 1
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- raster

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  /** アルファ合成で1ピクセル塗る。coverageは0..1のアンチエイリアス係数。 */
  blend(x, y, [r, g, b, a], coverage = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const srcA = (a / 255) * coverage;
    if (srcA <= 0) return;
    const i = (y * this.size + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c += 1) {
      const src = [r, g, b][c];
      const dst = this.data[i + c];
      this.data[i + c] = Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  /** 形状関数(内側判定)を4x4スーパーサンプリングで塗る。 */
  fillShape(inside, colorAt) {
    const samples = 4;
    const step = 1 / samples;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        let hit = 0;
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            if (inside(x + (sx + 0.5) * step, y + (sy + 0.5) * step)) hit += 1;
          }
        }
        if (hit === 0) continue;
        this.blend(x, y, colorAt(x, y), hit / (samples * samples));
      }
    }
  }
}

function roundRect(x0, y0, x1, y1, radius) {
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

function triangle(ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  return (px, py) => {
    const d1 = sign(px, py, ax, ay, bx, by);
    const d2 = sign(px, py, bx, by, cx, cy);
    const d3 = sign(px, py, cx, cy, ax, ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
}

function union(...shapes) {
  return (px, py) => shapes.some((s) => s(px, py));
}

/**
 * 「箱に下向き矢印が入る」= バックアップを表すグリフ。
 * size を基準にした相対座標で描くのでどの解像度でも同じ形になる。
 */
function arrowIntoBoxShape(size) {
  const u = size / 32;
  const stem = roundRect(13.5 * u, 5 * u, 18.5 * u, 17 * u, 1.6 * u);
  const head = triangle(9.5 * u, 15 * u, 22.5 * u, 15 * u, 16 * u, 24 * u);
  const base = roundRect(7 * u, 25.5 * u, 25 * u, 28.5 * u, 1.5 * u);
  return union(stem, head, base);
}

function writeAppIcon(size, file) {
  const canvas = new Canvas(size);
  const bg = roundRect(0, 0, size - 1, size - 1, size * 0.22);
  canvas.fillShape(bg, (_x, y) => {
    const t = y / (size - 1);
    return [
      Math.round(58 + (18 - 58) * t),
      Math.round(134 + (70 - 134) * t),
      Math.round(255 + (168 - 255) * t),
      255,
    ];
  });
  canvas.fillShape(arrowIntoBoxShape(size), () => [255, 255, 255, 255]);
  fs.writeFileSync(file, encodePng(size, size, canvas.data));
}

function writeGlyphIcon(size, file, color) {
  const canvas = new Canvas(size);
  canvas.fillShape(arrowIntoBoxShape(size), () => color);
  fs.writeFileSync(file, encodePng(size, size, canvas.data));
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  writeAppIcon(512, path.join(BUILD_DIR, 'icon.png'));
  // macOS: テンプレート画像(黒+アルファ)にするとライト/ダーク両対応になる
  writeGlyphIcon(16, path.join(BUILD_DIR, 'trayTemplate.png'), [0, 0, 0, 255]);
  writeGlyphIcon(32, path.join(BUILD_DIR, 'trayTemplate@2x.png'), [0, 0, 0, 255]);
  // Windows/Linux: 暗いタスクバーでも見える白グリフ
  writeGlyphIcon(32, path.join(BUILD_DIR, 'tray.png'), [255, 255, 255, 255]);
  process.stdout.write(`icons generated in ${BUILD_DIR}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { encodePng, Canvas, arrowIntoBoxShape };
