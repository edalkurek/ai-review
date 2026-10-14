import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBackoffDelay,
  isRetryableStatus,
  MAX_RETRY_ATTEMPTS,
  parseRetryAfterHeader,
} from '../src/util/retry';
import { OpenAICompatibleClient, FetchLike, AIClientError } from '../src/ai/openAIClient';
import { BitbucketServerClient } from '../src/bitbucket/client';
import { BitbucketHttpError } from '../src/bitbucket/types';

test('parseRetryAfterHeader parses seconds, dates and invalid inputs', () => {
  assert.equal(parseRetryAfterHeader('5'), 5000);
  assert.equal(parseRetryAfterHeader('0'), 0);
  assert.equal(parseRetryAfterHeader('   10  '), 10000);
  assert.equal(parseRetryAfterHeader(undefined), undefined);
  assert.equal(parseRetryAfterHeader(''), undefined);
  assert.equal(parseRetryAfterHeader('invalid-date-or-seconds'), undefined);

  // Future HTTP Date
  const futureDate = new Date(Date.now() + 15000).toUTCString();
  const parsedMs = parseRetryAfterHeader(futureDate);
  assert.ok(parsedMs !== undefined && parsedMs >= 14000 && parsedMs <= 16000);
});

test('calculateBackoffDelay applies exponential growth and respects Retry-After', () => {
  const retryAfterDelay = calculateBackoffDelay(0, 3000);
  assert.equal(retryAfterDelay, 3000);

  const cappedDelay = calculateBackoffDelay(0, 100000, 1000, 30000);
  assert.equal(cappedDelay, 30000);

  const attempt0 = calculateBackoffDelay(0, undefined, 1000);
  assert.ok(attempt0 >= 1000 && attempt0 <= 1200);

  const attempt1 = calculateBackoffDelay(1, undefined, 1000);
  assert.ok(attempt1 >= 2000 && attempt1 <= 2200);

  const attempt2 = calculateBackoffDelay(2, undefined, 1000);
  assert.ok(attempt2 >= 4000 && attempt2 <= 4200);
});

test('isRetryableStatus matches only 429 and 503', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(500), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
});

test('OpenAICompatibleClient retries on 429/503 with Retry-After and succeeds', async () => {
  let callCount = 0;
  const reviewJson = JSON.stringify({
    summary: 'OK',
    riskLevel: 'low',
    findings: [],
    testSuggestions: [],
    finalComment: 'OK',
  });

  const fetchImpl: FetchLike = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
        json: async () => ({ error: 'rate limited' }),
      };
    }
    if (callCount === 2) {
      return {
        ok: false,
        status: 503,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
        json: async () => ({ error: 'service unavailable' }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: reviewJson } }] }),
    };
  };

  const client = new OpenAICompatibleClient({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    fetchImpl,
  });

  const result = await client.reviewDiff('+code');
  assert.equal(callCount, 3);
  assert.equal(result.riskLevel, 'low');
});

test('OpenAICompatibleClient exhausts retries on continuous 429', async () => {
  let callCount = 0;
  const fetchImpl: FetchLike = async () => {
    callCount++;
    return {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
      json: async () => ({ error: 'rate limited' }),
    };
  };

  const client = new OpenAICompatibleClient({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    fetchImpl,
  });

  await assert.rejects(
    () => client.reviewDiff('+code'),
    (error: unknown) => error instanceof AIClientError && error.status === 429,
  );
  assert.equal(callCount, MAX_RETRY_ATTEMPTS + 1);
});

test('BitbucketServerClient retries on 503 and succeeds', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Retry-After': '0' },
      });
    }
    return new Response(JSON.stringify({ values: [], isLastPage: true, size: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new BitbucketServerClient(
    {
      baseUrl: 'https://bitbucket.example.com',
      auth: { method: 'bearer', token: 'test-token' },
    },
    fetchImpl as unknown as typeof fetch,
  );

  const prs = await client.listOpenPullRequestsForReviewer();
  assert.equal(callCount, 2);
  assert.deepEqual(prs, []);
});

test('BitbucketServerClient exhausts retries and throws BitbucketHttpError', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return new Response(JSON.stringify({ message: 'Rate Limited' }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
  };

  const client = new BitbucketServerClient(
    {
      baseUrl: 'https://bitbucket.example.com',
      auth: { method: 'bearer', token: 'test-token' },
    },
    fetchImpl as unknown as typeof fetch,
  );

  await assert.rejects(
    () => client.listOpenPullRequestsForReviewer(),
    (error: unknown) => error instanceof BitbucketHttpError && error.status === 429,
  );
  assert.equal(callCount, MAX_RETRY_ATTEMPTS + 1);
});
