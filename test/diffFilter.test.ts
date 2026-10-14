import assert from 'node:assert/strict';
import test from 'node:test';
import { filterDiff, isBinaryDiffSection } from '../src/ai/diffFilter';
import { chunkDiff } from '../src/ai/diffChunker';
import { reviewDiffInChunks } from '../src/ai/reviewService';
import { AIReviewClient, AIReviewResult } from '../src/ai/types';

const fileDiff = (name: string, body: string): string =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;

test('isBinaryDiffSection detects git binary indicators', () => {
  assert.equal(isBinaryDiffSection('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n'), true);
  assert.equal(isBinaryDiffSection('diff --git a/bin b/bin\nGIT binary patch\nliteral 1234\n'), true);
  assert.equal(isBinaryDiffSection('diff --git a/code.ts b/code.ts\n+const x = 1;\n'), false);
});

test('filterDiff preserves all source and lock files, excluding only binary diffs', () => {
  const codeDiff = fileDiff('src/app.ts', '+console.log("hello");');
  const lockDiff = fileDiff('package-lock.json', '+"version": "1.2.3"');
  const minDiff = fileDiff('public/vendor.min.js', '+function a(){return 1;}');
  const binaryDiff = 'diff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\n';

  const fullDiff = codeDiff + lockDiff + minDiff + binaryDiff;
  const result = filterDiff(fullDiff);

  // Kod, lock ve minified dosyalar artık hariç tutulmaz, korunur
  assert.ok(result.filteredDiff.includes('src/app.ts'));
  assert.ok(result.filteredDiff.includes('package-lock.json'));
  assert.ok(result.filteredDiff.includes('vendor.min.js'));
  // Sadece ikili (binary) diff elenir
  assert.ok(!result.filteredDiff.includes('icon.png'));
  assert.equal(result.excludedFiles.length, 1);
  assert.ok(result.excludedFiles.includes('icon.png'));
});

test('chunkDiff includes all text files regardless of extension', () => {
  const codeDiff = fileDiff('src/feature.ts', '+export const feature = true;');
  const snapDiff = fileDiff('test/__snapshots__/feature.test.ts.snap', '+exports[`snapshot`] = 1;');
  const chunks = chunkDiff(codeDiff + snapDiff, 10000);

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].files, ['src/feature.ts', 'test/__snapshots__/feature.test.ts.snap']);
});

test('reviewDiffInChunks returns low-risk review when only binary diff files are present', async () => {
  let modelCalled = false;
  const client: AIReviewClient = {
    async reviewDiff(): Promise<AIReviewResult> {
      modelCalled = true;
      return { summary: '', riskLevel: 'high', findings: [], testSuggestions: [], finalComment: '' };
    },
  };

  const binaryOnlyDiff = 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
  const result = await reviewDiffInChunks(client, binaryOnlyDiff);

  assert.equal(modelCalled, false);
  assert.equal(result.riskLevel, 'low');
  assert.ok(result.summary.includes('ikili (binary) dosyalar'));
});
