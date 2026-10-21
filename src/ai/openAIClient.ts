import {
  calculateBackoffDelay,
  isRetryableStatus,
  MAX_RETRY_ATTEMPTS,
  parseRetryAfterHeader,
  sleep,
} from '../util/retry';
import { buildReviewMessages } from './reviewPrompt';
import { parseAIReviewResult } from './reviewParser';
import { AIReviewClient, AIReviewResult, ChatMessage, ReviewContext } from './types';

interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface OpenAIClientOptions {
  signal?: AbortSignal;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: FetchLike;
}

export class AIClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AIClientError';
  }
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new AIClientError('Model API adresi yapılandırılmamış.');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AIClientError('Model API adresi geçerli bir URL değil.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AIClientError('Model API adresi HTTP veya HTTPS kullanmalıdır.');
  }
  if (parsed.username || parsed.password) {
    throw new AIClientError('Model API adresinde kullanıcı bilgisi bulunmamalıdır.');
  }
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function responseContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new AIClientError('Model API geçersiz bir yanıt döndürdü.');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AIClientError('Model API yanıtında choices bulunamadı.');
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) {
    throw new AIClientError('Model API yanıtındaki choice geçersiz.');
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw new AIClientError('Model API yanıtında message bulunamadı.');
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AIClientError('Model API boş içerik döndürdü.');
  }
  return content;
}

export function configureCorporateTls(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

configureCorporateTls();

function defaultFetch(): FetchLike {
  const candidate = globalThis.fetch;
  if (typeof candidate !== 'function') {
    throw new AIClientError('Bu çalışma ortamında fetch desteği bulunmuyor.');
  }
  return async (input, init) => candidate(input, init);
}

export class OpenAICompatibleClient implements AIReviewClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  /** Set once the gateway rejects response_format, so later requests skip it. */
  private jsonModeUnsupported = false;

  constructor(private readonly options: OpenAIClientOptions) {
    this.endpoint = endpointFor(options.baseUrl);
    if (!options.model.trim()) {
      throw new AIClientError('Model adı yapılandırılmamış.');
    }
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AIClientError('Model zaman aşımı pozitif bir sayı olmalıdır.');
    }
    if (
      options.temperature !== undefined
      && (!Number.isFinite(options.temperature) || options.temperature < 0)
    ) {
      throw new AIClientError('Model temperature değeri negatif olmayan bir sayı olmalıdır.');
    }
    if (
      options.maxTokens !== undefined
      && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)
    ) {
      throw new AIClientError('Model maxTokens değeri pozitif bir tam sayı olmalıdır.');
    }
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
  }

  async reviewDiff(diff: string, context: ReviewContext = {}): Promise<AIReviewResult> {
    const messages = buildReviewMessages(diff, context);
    const content = await this.chat(messages, { json: true });
    return parseAIReviewResult(content);
  }

  async chat(messages: ChatMessage[], options: { json?: boolean } = {}): Promise<string> {
    if (messages.length === 0) {
      throw new AIClientError('Model mesaj listesi boş olamaz.');
    }
    const controller = new AbortController();
    const cancel = (): void => { controller.abort(); };
    this.options.signal?.addEventListener('abort', cancel, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey?.trim()) {
      headers.Authorization = `Bearer ${this.options.apiKey.trim()}`;
    }

    try {
      let attempt = 0;
      while (true) {
        if (this.options.signal?.aborted) {
          throw new AIClientError('Model API isteği iptal edildi.');
        }

        try {
          const response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: this.options.model,
              messages,
              temperature: this.options.temperature ?? 0.1,
              ...(options.json && !this.jsonModeUnsupported ? { response_format: { type: 'json_object' } } : {}),
              ...(this.options.maxTokens === undefined
                ? {}
                : { max_tokens: this.options.maxTokens }),
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            // Not every OpenAI-compatible gateway supports JSON mode; fall back to the prompt contract.
            if (response.status === 400 && options.json && !this.jsonModeUnsupported) {
              this.jsonModeUnsupported = true;
              continue;
            }
            if (isRetryableStatus(response.status) && attempt < MAX_RETRY_ATTEMPTS) {
              const retryAfterHeader = typeof response.headers?.get === 'function'
                ? response.headers.get('Retry-After')
                : undefined;
              const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
              const delayMs = calculateBackoffDelay(attempt, retryAfterMs);
              attempt++;
              await sleep(delayMs, controller.signal);
              continue;
            }
            // Do not include response bodies: local gateways may echo credentials/prompts.
            throw new AIClientError(`Model API isteği başarısız oldu (HTTP ${response.status}).`, response.status);
          }

          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new AIClientError('Model API yanıtı geçerli JSON değil.');
          }
          return responseContent(payload);
        } catch (error) {
          if (this.options.signal?.aborted) {
            throw new AIClientError('Model API isteği iptal edildi.');
          }
          if (error instanceof AIClientError) {
            throw error;
          }
          if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('iptal'))) {
            if (this.options.signal?.aborted) {
              throw new AIClientError('Model API isteği iptal edildi.');
            }
            throw new AIClientError('Model API isteği zaman aşımına uğradı.');
          }
          throw new AIClientError('Model API isteği tamamlanamadı.');
        }
      }
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener('abort', cancel);
    }
  }
}
