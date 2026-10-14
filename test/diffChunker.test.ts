import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDiff } from '../src/ai/diffChunker';
import { mergeReviewResults } from '../src/ai/reviewMerger';
import { AIReviewClient, AIReviewResult } from '../src/ai/types';
import { reviewDiffInChunks } from '../src/ai/reviewService';

const fileDiff = (name: string, body: string): string =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;

test('küçük dosyaları mümkün olduğunda dosya sınırlarında gruplar', () => {
  const first = fileDiff('a.ts', '-a\n+b');
  const second = fileDiff('b.ts', '-c\n+d');
  const chunks = chunkDiff(first + second, first.length + 1);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.files), [['a.ts'], ['b.ts']]);
  assert.equal(chunks[0]?.total, 2);
});

test('tek büyük dosyayı karakter sınırını aşmayan parçalara böler', () => {
  const chunks = chunkDiff(fileDiff('large.ts', `+${'x'.repeat(300)}`), 80);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 80));
});

test('chunk sonuçlarını tekrarları ayıklayarak ve en yüksek riski koruyarak birleştirir', () => {
  const first: AIReviewResult = {
    summary: 'Özet', riskLevel: 'low', findings: [], testSuggestions: ['Test A'], finalComment: 'İyi.',
  };
  const second: AIReviewResult = {
    summary: 'İkinci özet', riskLevel: 'high',
    findings: [{ file: 'a.ts', severity: 'high', type: 'security', message: 'Secret var.', suggestion: 'Kaldırın.' }],
    testSuggestions: ['test a'], finalComment: 'Risk var.',
  };
  const merged = mergeReviewResults([first, second]);

  assert.equal(merged.riskLevel, 'high');
  assert.equal(merged.testSuggestions.length, 1);
  assert.equal(merged.findings.length, 1);
});

test('bir chunk hata verse de başarılı chunk sonuçlarını döndürür', async () => {
  let calls = 0;
  let errors = 0;
  const client: AIReviewClient = {
    async reviewDiff(): Promise<AIReviewResult> {
      calls += 1;
      if (calls === 1) throw new Error('geçici hata');
      return { summary: 'Özet', riskLevel: 'low', findings: [], testSuggestions: [], finalComment: 'Tamam.' };
    },
  };
  const result = await reviewDiffInChunks(
    client,
    fileDiff('a.ts', `+${'a'.repeat(100)}`),
    {},
    { maxChunkChars: 60, onChunkError: () => { errors += 1; } },
  );
  assert.equal(result.riskLevel, 'low');
  assert.equal(errors, 1);
});

test('large-file chunks retain original coordinates even after the hunk header is split away', async () => {
  const input = 'diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -80,1 +90,12 @@\n context\n'
    + Array.from({ length: 11 }, (_, index) => `+change${index}\n`).join('');
  const seen: number[] = [];
  let continuation = false;
  await reviewDiffInChunks({ reviewDiff: async (content) => {
    const matches = [...content.matchAll(/\[review-location (\{[^\n]+?\})\] (change\d+)/g)];
    if (matches.length && !content.includes('@@')) continuation = true;
    for (const match of matches) {
      const coordinates = JSON.parse(match[1]);
      assert.equal(coordinates.file, 'large.ts');
      assert.equal(coordinates.side, 'new');
      assert.equal(coordinates.line, 91 + Number(match[2].slice('change'.length)));
      seen.push(coordinates.line);
    }
    return { summary: 'Summary', riskLevel: 'low', findings: [], testSuggestions: [], finalComment: 'Done' };
  } }, input, {}, { maxChunkChars: 220 });
  assert.equal(continuation, true);
  assert.deepEqual(seen, Array.from({ length: 11 }, (_, index) => 91 + index));
});
