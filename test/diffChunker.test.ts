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

test('reads file names from Bitbucket Server src:// and dst:// diff headers', () => {
  const server = 'diff --git src://lib/a.ts dst://lib/a.ts\n--- src://lib/a.ts\n+++ dst://lib/a.ts\n@@ -1 +1 @@\n-x\n+y\n'
    + 'diff --git src://gone.ts dst://gone.ts\n--- src://gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n';
  assert.deepEqual(chunkDiff(server)[0].files, ['lib/a.ts', 'gone.ts']);
});

test('merges findings whose messages differ only in punctuation, spacing or case', () => {
  const base: AIReviewResult = { summary: 'S', riskLevel: 'low', testSuggestions: [], finalComment: 'F', findings: [] };
  const finding = { file: 'a.ts', line: 3, side: 'new' as const, type: 'bug' as const, suggestion: 'Fix' };
  const merged = mergeReviewResults([
    { ...base, findings: [{ ...finding, severity: 'medium', message: 'Toplam yanlış hesaplanıyor.' }] },
    { ...base, findings: [{ ...finding, file: 'b/a.ts', severity: 'high', message: 'toplam  yanlış hesaplanıyor' },
      { ...finding, severity: 'low', message: 'Başka bir sorun' }] },
  ]);
  assert.deepEqual(merged.findings.map((x) => [x.severity, x.message]),
    [['high', 'toplam  yanlış hesaplanıyor'], ['low', 'Başka bir sorun']]);
});

test('drops findings below the minimum confidence, keeps unrated ones and lowers risk accordingly', async () => {
  const finding = { file: 'a.ts', line: 1, side: 'new' as const, type: 'bug' as const, message: 'M', suggestion: 'S' };
  const client: AIReviewClient = {
    reviewDiff: async () => ({ summary: 'S', riskLevel: 'high', testSuggestions: [], finalComment: 'F', findings: [
      { ...finding, severity: 'high', confidence: 'low', message: 'Guess' },
      { ...finding, severity: 'medium', confidence: 'high', message: 'Proven' },
      { ...finding, severity: 'low', message: 'Unrated' },
    ] }),
  };
  const result = await reviewDiffInChunks(client, fileDiff('a.ts', '+x\n'), {}, { minConfidence: 'medium' });
  assert.deepEqual(result.findings.map((x) => x.message), ['Proven', 'Unrated']);
  assert.equal(result.riskLevel, 'medium');
});

test('multi-chunk reviews get one synthesized summary; a broken synthesis keeps the joined summaries', async () => {
  const result = (summary: string): AIReviewResult => ({ summary, riskLevel: 'low', findings: [], testSuggestions: [], finalComment: `${summary} sonuç` });
  const diff = fileDiff('a.ts', `+${'a'.repeat(50)}\n`) + fileDiff('b.ts', `+${'b'.repeat(50)}\n`);
  let calls = 0;
  const reviewDiff = async (content: string): Promise<AIReviewResult> => result(content.includes('a.ts') ? 'A' : 'B');
  const synthesized = await reviewDiffInChunks({ reviewDiff, chat: async (messages) => {
    calls++;
    assert.match(messages[0].content, /<untrusted_review_data>[\s\S]*"A"[\s\S]*"B"/);
    return 'Yanıt: {"summary": "Tek özet", "finalComment": "Tek sonuç"}';
  } }, diff, {}, { maxChunkChars: 120 });
  assert.equal(calls, 1);
  assert.deepEqual([synthesized.summary, synthesized.finalComment], ['Tek özet', 'Tek sonuç']);
  const fallback = await reviewDiffInChunks({ reviewDiff, chat: async () => 'geçersiz' }, diff, {}, { maxChunkChars: 120 });
  assert.equal(fallback.summary, 'A B');
});
