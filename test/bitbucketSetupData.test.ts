import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBitbucketSetupInput } from '../src/setup/bitbucketSetupData';

const valid = {
  action: 'save',
  baseUrl: 'https://bitbucket.example.com/bitbucket',
  extraInstructions: 'Transaction sınırlarını kontrol et.',
  modelName: 'openai/gpt-oss-120b',
  modelBaseUrl: 'https://model.example.com/v1',
  bitbucketToken: 'not-a-real-token',
  modelApiKey: 'not-a-real-model-key',
  automaticReviewEnabled: false,
  automaticReviewIntervalMinutes: 5,
};

test('sade kurulum formunu normalize eder', () => {
  const result = parseBitbucketSetupInput(valid);
  assert.equal(result.baseUrl, 'https://bitbucket.example.com/bitbucket');
  assert.equal(result.modelName, 'openai/gpt-oss-120b');
  assert.equal(result.extraInstructions, 'Transaction sınırlarını kontrol et.');
});

test('otomatik review aralığını doğrular', () => {
  assert.throws(() => parseBitbucketSetupInput({
    ...valid,
    automaticReviewIntervalMinutes: 0,
  }), /1–1440/);
});

test('Bitbucket ve model URL içinde gömülü kimlik bilgisini reddeder', () => {
  assert.throws(() => parseBitbucketSetupInput({
    ...valid,
    baseUrl: 'https://user:secret@bitbucket.example.com',
  }), /kimlik bilgisi/);
  assert.throws(() => parseBitbucketSetupInput({
    ...valid,
    modelBaseUrl: 'https://user:secret@model.example.com/v1',
  }), /kimlik bilgisi/);
});

test('Bitbucket Cloud adresini reddeder', () => {
  assert.throws(() => parseBitbucketSetupInput({
    ...valid,
    baseUrl: 'https://api.bitbucket.org/2.0',
  }), /Server\/Data Center/);
});

test('Model servisi URL ve Qwen custom model girdisini normalize eder', () => {
  const result = parseBitbucketSetupInput({
    ...valid,
    modelName: 'cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit',
    modelBaseUrl: 'https://bifrost-proxy-server-dsp-ddi.apps.lan-dev-dc1-ocp.yapikredi.com.tr/v1/',
  });
  assert.equal(result.modelName, 'cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit');
  assert.equal(
    result.modelBaseUrl,
    'https://bifrost-proxy-server-dsp-ddi.apps.lan-dev-dc1-ocp.yapikredi.com.tr/v1',
  );
});
