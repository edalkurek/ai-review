import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { AIReviewResult } from '../src/ai/types';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name: string, ...args: unknown[]) {
  return name === 'vscode' ? {} : originalLoad.call(this, name, ...args);
};
const { renderReviewHtml } = require('../out/review/resultPanel');
Module._load = originalLoad;

const review: AIReviewResult = {
  summary: 'Özet', riskLevel: 'high', finalComment: 'Sonuç', testSuggestions: [],
  findings: [
    { file: 'b/src/a.ts', line: 4, side: 'new', severity: 'low', type: 'performance', message: 'Yavaş <döngü>', suggestion: 'Önbellekle' },
    { file: 'src/b.ts', line: 9, side: 'old', severity: 'high', type: 'bug', message: 'Hatalı', suggestion: 'Düzelt' },
  ],
};

test('sonuç paneli bulguları Türkçe etiketlerle önem sırasına göre gruplar ve konumu gösterir', () => {
  const html: string = renderReviewHtml('PR', review, 'abc', false);
  assert.ok(html.indexOf('Yüksek önem (1)') < html.indexOf('Düşük önem (1)'));
  assert.match(html, /Risk: Yüksek/);
  assert.match(html, /Performans/);
  assert.match(html, /src\/a\.ts:4</);
  assert.match(html, /src\/b\.ts:9 \(silinen satır\)/);
  assert.match(html, /Yavaş &lt;döngü&gt;/);
  assert.match(html, /script-src 'nonce-abc'/);
  assert.doesNotMatch(html, /class="pick"|id="publish"/);
});

test('yayımlama sunulduğunda her bulgu için seçim kutusu ve gönder butonu ekler', () => {
  const html: string = renderReviewHtml('PR', review, 'abc', true);
  assert.equal(html.match(/class="pick"/g)?.length, 2);
  assert.match(html, /id="publish"/);
});
