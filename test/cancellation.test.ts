import assert from 'node:assert/strict';
import test from 'node:test';
import { AIClientError, OpenAICompatibleClient, FetchLike } from '../src/ai/openAIClient';
import { reviewDiffInChunks } from '../src/ai/reviewService';
import { sleep } from '../src/util/retry';
import { AIReviewClient, AIReviewResult } from '../src/ai/types';

test('sleep aborts immediately when signal is triggered', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const sleepPromise = sleep(5000, controller.signal);
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    sleepPromise,
    (error: unknown) => error instanceof Error && error.message.includes('iptal'),
  );
  assert.ok(Date.now() - start < 1000);
});

test('OpenAICompatibleClient throws cancellation error when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const client = new OpenAICompatibleClient({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }),
  });

  await assert.rejects(
    () => client.reviewDiff('+code'),
    (error: unknown) => error instanceof AIClientError && error.message.includes('iptal'),
  );
});

test('reviewDiffInChunks aborts early when signal triggers between chunks', async () => {
  const controller = new AbortController();
  let chunkCalls = 0;

  const client: AIReviewClient = {
    async reviewDiff(): Promise<AIReviewResult> {
      chunkCalls++;
      if (chunkCalls === 1) {
        controller.abort();
      }
      return { summary: 'Chunk', riskLevel: 'low', findings: [], testSuggestions: [], finalComment: '' };
    },
  };

  const multiFileDiff =
    'diff --git a/file1.ts b/file1.ts\n--- a/file1.ts\n+++ b/file1.ts\n@@ -1 +1 @@\n+1\n' +
    'diff --git a/file2.ts b/file2.ts\n--- a/file2.ts\n+++ b/file2.ts\n@@ -1 +1 @@\n+2\n' +
    'diff --git a/file3.ts b/file3.ts\n--- a/file3.ts\n+++ b/file3.ts\n@@ -1 +1 @@\n+3\n';

  await assert.rejects(
    () => reviewDiffInChunks(client, multiFileDiff, {}, { maxChunkChars: 50, signal: controller.signal }),
  );
  // It stopped processing further chunks
  assert.equal(chunkCalls, 1);
});
