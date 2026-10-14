import { chunkDiff } from './diffChunker';
import { mergeReviewResults } from './reviewMerger';
import { AIReviewClient, AIReviewResult, ReviewContext, TEXT_LIMITS } from './types';

export interface ReviewDiffOptions {
  /** Gate reviews must never approve a partially reviewed diff. */
  failOnChunkError?: boolean;
  signal?: AbortSignal;
  maxChunkChars?: number;
  onChunkError?: (error: Error, chunkIndex: number, chunkCount: number) => void;
}

/** Reviews chunks sequentially to avoid overwhelming a local model. */
export async function reviewDiffInChunks(
  client: AIReviewClient,
  diff: string,
  context: ReviewContext = {},
  options: ReviewDiffOptions = {},
): Promise<AIReviewResult> {
  const chunks = chunkDiff(diff, options.maxChunkChars, true);
  if (chunks.length === 0) {
    if (diff.trim()) {
      return {
        summary: 'Değişikliklerin tamamı ikili (binary) dosyalar kapsamında olduğu için incelenecek kod metni bulunamadı.',
        riskLevel: 'low',
        findings: [],
        testSuggestions: [],
        finalComment: 'Yalnızca ikili (binary) dosyalar içerdiğinden AI incelemesi yapılmadı.',
      };
    }
    throw new Error('Review için diff boş olamaz.');
  }

  const successful: AIReviewResult[] = [];
  let firstError: Error | undefined;
  for (const chunk of chunks) {
    options.signal?.throwIfAborted();
    try {
      successful.push(
        await client.reviewDiff(chunk.content, {
          ...context,
          chunkLabel: `${chunk.index + 1}/${chunk.total}`,
          files: chunk.files,
        }),
      );
    } catch (error) {
      if (options.failOnChunkError || options.signal?.aborted) throw error;
      const safeError = error instanceof Error ? error : new Error('Bilinmeyen AI review hatası.');
      firstError ??= safeError;
      try {
        options.onChunkError?.(safeError, chunk.index, chunk.total);
      } catch {
        // A logging/telemetry callback must not stop the remaining review chunks.
      }
    }
  }

  options.signal?.throwIfAborted();

  if (successful.length === 0) {
    throw firstError ?? new Error('AI review tamamlanamadı.');
  }
  const merged = mergeReviewResults(successful);

  if (client.chat) {
    if (merged.summary.length > TEXT_LIMITS.PR_SUMMARY) {
      merged.summary = await shortenText(client, merged.summary, TEXT_LIMITS.PR_SUMMARY);
    }
    if (merged.finalComment.length > TEXT_LIMITS.FINAL_COMMENT) {
      merged.finalComment = await shortenText(client, merged.finalComment, TEXT_LIMITS.FINAL_COMMENT);
    }
  }

  return merged;
}

async function shortenText(client: AIReviewClient, text: string, maxLength: number): Promise<string> {
  if (!client.chat) return text;
  try {
    const prompt = `Aşağıdaki metin belirlenen karakter sınırını (${maxLength}) aşıyor. Lütfen bu metni en fazla ${maxLength} karakter olacak şekilde, anlam bütünlüğünü koruyarak ve tüm cümleleri (veya maddeleri) tamamlayarak yeniden özetle. Yarım kalan cümle veya eksik madde olmamalıdır.\n\nMetin:\n${text}`;
    const result = await client.chat([
      { role: 'user', content: prompt }
    ]);
    return result.trim() || text;
  } catch {
    return text;
  }
}
