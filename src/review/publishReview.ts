import { createHash } from 'node:crypto';
import { AIReviewResult, ReviewFinding } from '../ai/types';
import { BitbucketClient, BitbucketHttpError, InlineCommentLocation, PullRequestRef } from '../bitbucket';
import { formatInlineComment, formatReviewComment, sanitizeCommentForServer } from './commentFormatter';
import { diffLineLocations, findInlineLocation } from './inlineComments';

export interface PublicationState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PublicationResult {
  inlineComments: number;
  generalOnlyFindings: number;
}

export async function publishReview(
  client: BitbucketClient, ref: PullRequestRef, review: AIReviewResult, diff: string,
  key: string, state: PublicationState,
  onUnmatchedFinding?: (finding: ReviewFinding) => void,
): Promise<PublicationResult> {
  async function once(id: string, text: string, send: (body: string) => Promise<unknown>): Promise<void> {
    const itemKey = `${key}:${id}`;
    if (state.get(itemKey, false)) return;
    try {
      await send(text);
    } catch (error) {
      if (!(error instanceof BitbucketHttpError) || error.status !== 400) throw error;
      const safe = sanitizeCommentForServer(text);
      if (safe === text) throw error;
      await send(safe);
    }
    await state.update(itemKey, true);
  }

  const locations = diffLineLocations(diff);
  review = { ...review, findings: review.findings.map((finding) => {
    const location = findInlineLocation(finding, locations);
    return location ? { ...finding, file: location.side === 'old' ? location.srcPath ?? location.path : location.path,
      line: location.line, side: location.side } : finding;
  }) };
  const inlineFindings = new Set<ReviewFinding>();
  const groups = new Map<string, { location: InlineCommentLocation; comments: Set<string>; findings: ReviewFinding[] }>();
  for (const finding of review.findings) {
    const location = findInlineLocation(finding, locations);
    if (!location) {
      onUnmatchedFinding?.(finding);
      continue;
    }
    const id = createHash('sha256').update(JSON.stringify([location.path, location.side, location.line])).digest('hex');
    let group = groups.get(id);
    if (!group) {
      group = { location, comments: new Set(), findings: [] };
      groups.set(id, group);
    }
    group.comments.add(formatInlineComment(finding));
    group.findings.push(finding);
  }
  const failures: unknown[] = [];
  for (const [id, { location, comments, findings }] of groups) {
    const text = [...comments].join('\n\n---\n\n');
    try {
      await once(id, text, (body) => client.addInlineComment(ref, body, location));
      for (const finding of findings) inlineFindings.add(finding);
    } catch (error) {
      failures.push(error);
    }
  }
  await once('general', formatReviewComment(review, inlineFindings), (text) => client.addGeneralComment(ref, text));
  if (failures.length) {
    throw new Error(`${failures.length} satır yorumu gönderilemedi. Genel yorum yayımlandı; gönderilemeyen bulgular genel yorumda korundu. Yeniden denemede başarılı yorumlar atlanır. ${failures[0] instanceof Error ? failures[0].message : ''}`);
  }
  return { inlineComments: groups.size, generalOnlyFindings: review.findings.length - inlineFindings.size };
}
