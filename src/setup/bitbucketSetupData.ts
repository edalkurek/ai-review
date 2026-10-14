export interface BitbucketSetupInput {
  action: 'save' | 'test';
  baseUrl: string;
  extraInstructions: string;
  modelName: string;
  modelBaseUrl: string;
  bitbucketToken: string;
  modelApiKey: string;
  automaticReviewEnabled: boolean;
  automaticReviewIntervalMinutes: number;
  repoInstructions: Record<string, string>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {};
}

function stringField(value: UnknownRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error('Kurulum formu geçersiz.');
  return field.trim();
}

function booleanField(value: UnknownRecord, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') throw new Error('Kurulum formu geçersiz.');
  return field;
}

function intervalField(value: UnknownRecord): number {
  const interval = Number(value.automaticReviewIntervalMinutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    throw new Error('Otomatik review aralığı 1–1440 dakika arasında olmalıdır.');
  }
  return interval;
}

function safeUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} geçerli bir URL olmalıdır.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} HTTP(S) kullanmalı ve kimlik bilgisi içermemelidir.`);
  }
  return url.toString().replace(/\/$/, '');
}

export function parseBitbucketSetupInput(value: unknown): BitbucketSetupInput {
  const message = asRecord(value);
  const action = stringField(message, 'action');
  if (action !== 'save' && action !== 'test') throw new Error('Bilinmeyen kurulum işlemi.');
  const baseUrl = safeUrl(stringField(message, 'baseUrl'), 'Bitbucket Base URL');
  const bitbucketHost = new URL(baseUrl).hostname.toLowerCase();
  if (bitbucketHost === 'bitbucket.org' || bitbucketHost === 'api.bitbucket.org') {
    throw new Error('Yalnızca Bitbucket Server/Data Center Base URL desteklenir.');
  }

  return {
    action,
    baseUrl,
    extraInstructions: stringField(message, 'extraInstructions'),
    modelName: stringField(message, 'modelName'),
    modelBaseUrl: safeUrl(stringField(message, 'modelBaseUrl'), 'AI Model Base URL'),
    bitbucketToken: stringField(message, 'bitbucketToken'),
    modelApiKey: stringField(message, 'modelApiKey'),
    automaticReviewEnabled: booleanField(message, 'automaticReviewEnabled'),
    automaticReviewIntervalMinutes: intervalField(message),
    repoInstructions: asRecord(message.repoInstructions) as Record<string, string>,
  };
}
