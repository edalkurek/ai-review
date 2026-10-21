import assert from 'node:assert/strict';
import test from 'node:test';
import { AIClientError, FetchLike, OpenAICompatibleClient } from '../src/ai/openAIClient';

const reviewJson = JSON.stringify({
  summary: 'Özet',
  riskLevel: 'low',
  findings: [],
  testSuggestions: [],
  finalComment: 'Uygun.',
});

test('OpenAI-compatible chat completions isteğini ve yanıtını işler', async () => {
  let requestedUrl = '';
  let authorization = '';
  const fetchImpl: FetchLike = async (url, init) => {
    requestedUrl = url;
    authorization = init.headers.Authorization ?? '';
    const body = JSON.parse(init.body) as { model: string; messages: unknown[] };
    assert.equal(body.model, 'local-model');
    assert.equal(body.messages.length, 2);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: reviewJson } }] }),
    };
  };

  const client = new OpenAICompatibleClient({
    baseUrl: 'http://127.0.0.1:1234/v1/',
    model: 'local-model',
    apiKey: 'secret',
    fetchImpl,
  });
  const result = await client.reviewDiff('+const value = 1;');

  assert.equal(requestedUrl, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(authorization, 'Bearer secret');
  assert.equal(result.riskLevel, 'low');
});

test('HTTP hata gövdesini veya API anahtarını hata mesajına sızdırmaz', async () => {
  const client = new OpenAICompatibleClient({
    baseUrl: 'http://localhost/v1',
    model: 'model',
    apiKey: 'sk-secret',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'sk-secret' }),
    }),
  });

  await assert.rejects(
    () => client.reviewDiff('+change'),
    (error: unknown) =>
      error instanceof AIClientError
      && error.status === 500
      && !error.message.includes('sk-secret'),
  );
});

test('review isteğinde JSON modunu ister, desteklenmiyorsa bir kez onsuz tekrar dener', async () => {
  const formats: unknown[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { response_format?: unknown };
    formats.push(body.response_format);
    if (body.response_format) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reviewJson } }] }) };
  };
  const client = new OpenAICompatibleClient({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', fetchImpl });
  await client.reviewDiff('+x');
  await client.reviewDiff('+y');
  await client.chat([{ role: 'user', content: 'kısalt' }]);
  assert.deepEqual(formats, [{ type: 'json_object' }, undefined, undefined, undefined]);
});
