export const MAX_RETRY_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

export function parseRetryAfterHeader(headerValue: string | null | undefined): number | undefined {
  if (!headerValue || !headerValue.trim()) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }

  return undefined;
}

export function calculateBackoffDelay(
  attempt: number,
  retryAfterMs?: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * (baseDelayMs * 0.2));
  return Math.min(exponential + jitter, maxDelayMs);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

export async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error('İşlem iptal edildi.');
  }
  if (delayMs <= 0) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const abortHandler = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new Error('İşlem iptal edildi.'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler);
      resolve();
    }, delayMs);

    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}
