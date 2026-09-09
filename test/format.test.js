'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatBytes, formatDuration, summarizeResult, progressRatio } = require('../src/core/format');

test('formatBytes は単位を切り替える', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
});

test('formatDuration は読みやすい時間表記にする', () => {
  assert.equal(formatDuration(250), '250 ms');
  assert.equal(formatDuration(4300), '4.3 秒');
  assert.equal(formatDuration(65000), '1分05秒');
  assert.equal(formatDuration(3_900_000), '1時間05分');
});

test('summarizeResult は成功/中止/失敗を書き分ける', () => {
  assert.match(
    summarizeResult({
      report: { copiedFiles: 3, copiedBytes: 2048, skippedFiles: 1, errorCount: 0, durationMs: 1200 },
    }),
    /3 件 \/ 2\.0 KB \/ 変更なし 1 件/
  );
  assert.match(
    summarizeResult({ report: { canceled: true, copiedFiles: 2, copiedBytes: 1024 } }),
    /中止しました/
  );
  assert.match(summarizeResult({ report: { fatal: 'ENOENT' } }), /失敗: ENOENT/);
  assert.equal(summarizeResult({ message: '経路が未設定です。' }), '経路が未設定です。');
  assert.equal(summarizeResult(null), '');
});

test('progressRatio は0〜1に収まる', () => {
  assert.equal(progressRatio({ totalFiles: 10, doneFiles: 5 }), 0.5);
  assert.equal(progressRatio({ totalFiles: 0, doneFiles: 0 }), 0);
  assert.equal(progressRatio({ totalFiles: 10, doneFiles: 20 }), 1);
});
