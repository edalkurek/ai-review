import { createHash } from 'node:crypto';
import { AIReviewResult, ReviewFinding } from '../ai/types';
import { BitbucketClient, BitbucketHttpError, InlineCommentLocation, PullRequestComment, PullRequestRef } from '../bitbucket';
import { formatInlineComment, formatReviewComment, hiddenMarker, sanitizeCommentForServer } from './commentFormatter';
import { diffLineLocations, findInlineLocation } from './inlineComments';

export interface PublicationState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PublicationOptions {
  /** Open line comments with a high-severity finding as Bitbucket tasks. */
  highSeverityAsTask?: boolean;
  /** Texts of comments already on the pull request; lines an earlier review commented on are not repeated. */
  existingComments?: readonly string[];
  /** Hidden key appended to the general comment so other machines can detect this review. */
  reviewMarker?: string;
  /**
   * Model-independent key of this commit's review (`bitbucket-ai-review:pr=…:commit=…:`). When another
   * teammate's review of the same commit was posted first, this review removes its own comments.
   */
  reviewKey?: string;
}

export interface PublicationResult {
  inlineComments: number;
  generalOnlyFindings: number;
  /** Findings on lines an earlier review already commented on. */
  skippedExisting: number;
  /** Set when a concurrent review of the same commit was posted first and this one withdrew its comments. */
  supersededBy?: number;
}

function hash(value: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * Identifies the commented code line across commits, models and team members: keyed by code content rather
 * than line number, so it survives lines shifting. The IntelliJ plugin computes the same key.
 */
export function lineCommentKey(location: InlineCommentLocation): string {
  return `bitbucket-ai-review:line=${hash([location.path, location.content?.trim() ?? location.line])}`;
}

/** Key written by 0.3.x, which also depended on the finding type the model chose. */
function legacyFindingKey(location: InlineCommentLocation, finding: ReviewFinding): string {
  return `bitbucket-ai-review:finding=${hash([location.path, location.content?.trim() ?? location.line, finding.type])}`;
}

export async function publishReview(
  client: BitbucketClient, ref: PullRequestRef, review: AIReviewResult, diff: string,
  key: string, state: PublicationState,
  onUnmatchedFinding?: (finding: ReviewFinding) => void,
  options: PublicationOptions = {},
): Promise<PublicationResult> {
  /** Sends once per publication key; returns the created comment, or undefined when an earlier attempt sent it. */
  async function once(id: string, text: string, send: (body: string) => Promise<PullRequestComment>): Promise<PullRequestComment | undefined> {
    const itemKey = `${key}:${id}`;
    if (state.get(itemKey, false)) return undefined;
    let comment: PullRequestComment;
    try {
      comment = await send(text);
    } catch (error) {
      if (!(error instanceof BitbucketHttpError) || error.status !== 400) throw error;
      const safe = sanitizeCommentForServer(text);
      if (safe === text) throw error;
      comment = await send(safe);
    }
    await state.update(itemKey, true);
    return comment;
  }

  const locations = diffLineLocations(diff);
  review = { ...review, findings: review.findings.map((finding) => {
    const location = findInlineLocation(finding, locations);
    return location ? { ...finding, file: location.side === 'old' ? location.srcPath ?? location.path : location.path,
      line: location.line, side: location.side } : finding;
  }) };
  const inlineFindings = new Set<ReviewFinding>();
  let skippedExisting = 0;
  const groups = new Map<string, { location: InlineCommentLocation; comments: Set<string>; findings: ReviewFinding[] }>();
  for (const finding of review.findings) {
    const location = findInlineLocation(finding, locations);
    if (!location) {
      onUnmatchedFinding?.(finding);
      continue;
    }
    const keys = [lineCommentKey(location), legacyFindingKey(location, finding)];
    if (options.existingComments?.some((text) => keys.some((existing) => text.includes(existing)))) {
      inlineFindings.add(finding);
      skippedExisting++;
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
  // Best effort: the anchor still works without hashes on most Bitbucket Server versions.
  const hashes = groups.size && client.getEffectiveDiffHashes
    ? await client.getEffectiveDiffHashes(ref).catch(() => undefined) : undefined;
  const failures: unknown[] = [];
  const posted: PullRequestComment[] = [];
  for (const [id, { location, comments, findings }] of groups) {
    const text = `${[...comments].join('\n\n---\n\n')}\n\n${hiddenMarker(lineCommentKey(location))}`;
    try {
      const blocker = Boolean(options.highSeverityAsTask) && findings.some((finding) => finding.severity === 'high');
      const comment = await once(id, text, (body) => client.addInlineComment(ref, body, location, { blocker, hashes }));
      if (comment) posted.push(comment);
      for (const finding of findings) inlineFindings.add(finding);
    } catch (error) {
      failures.push(error);
    }
  }
  const general = formatReviewComment(review, inlineFindings);
  const generalComment = await once('general', options.reviewMarker ? `${general}\n\n${hiddenMarker(options.reviewMarker)}` : general,
    (text) => client.addGeneralComment(ref, text));
  const supersededBy = generalComment && options.reviewKey
    ? await earlierReview(client, ref, options.reviewKey, generalComment) : undefined;
  if (supersededBy !== undefined) {
    // Bitbucket comment ids only grow, so every concurrent publisher agrees on which review came first.
    await Promise.all([...posted, generalComment!].map((comment) => client.deleteComment?.(ref, comment).catch(() => undefined)));
    return { inlineComments: 0, generalOnlyFindings: 0, skippedExisting, supersededBy };
  }
  if (failures.length) {
    throw new Error(`${failures.length} satır yorumu gönderilemedi. Genel yorum yayımlandı; gönderilemeyen bulgular genel yorumda korundu. Yeniden denemede başarılı yorumlar atlanır. ${failures[0] instanceof Error ? failures[0].message : ''}`);
  }
  return { inlineComments: groups.size, generalOnlyFindings: review.findings.length - inlineFindings.size, skippedExisting };
}

/** Id of a review of the same commit posted before `own`, if any. */
async function earlierReview(
  client: BitbucketClient, ref: PullRequestRef, reviewKey: string, own: PullRequestComment,
): Promise<number | undefined> {
  try {
    return (await client.listPullRequestComments(ref))
      .find((comment) => !comment.deleted && comment.id < own.id && comment.text.includes(reviewKey))?.id;
  } catch {
    // Keep the review rather than risk removing the only copy.
    return undefined;
  }
}
