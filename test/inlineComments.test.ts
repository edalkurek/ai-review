import assert from 'node:assert/strict';
import test from 'node:test';
import { changedLineLocations, diffLineLocations, findInlineLocation } from '../src/review/inlineComments';
import { publishReview, PublicationState } from '../src/review/publishReview';
import { AIReviewResult } from '../src/ai/types';
import { BitbucketClient, BitbucketHttpError, BitbucketServerClient, PullRequestRef } from '../src/bitbucket';
import { validateAIReviewResult } from '../src/ai/reviewParser';
import { reviewDiffInChunks } from '../src/ai/reviewService';
import { OpenAICompatibleClient } from '../src/ai/openAIClient';
import { annotateDiffLines } from '../src/util/diffLocations';

const diff = 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -10,2 +20,3 @@\n context\n-old\n+new\n+extra\n';
const review: AIReviewResult = {
  summary: 'Summary', riskLevel: 'high', finalComment: 'Fix', testSuggestions: [],
  findings: [21, 22, 99].map((line) => ({ file: 'new.ts', line, side: 'new', severity: 'high', type: 'bug', message: `Issue ${line}`, suggestion: 'Fix it' })),
};

test('maps changed lines, renamed paths and old/new offsets; rejects context and invented lines', () => {
  const locations = changedLineLocations(diff);
  assert.deepEqual(locations.map((x) => [x.line, x.side]), [[11, 'old'], [21, 'new'], [22, 'new']]);
  assert.equal(findInlineLocation(review.findings[0], locations)?.srcPath, 'old.ts');
  assert.equal(findInlineLocation(review.findings[2], locations), undefined);
  assert.equal(findInlineLocation({ ...review.findings[0], line: 20 }, locations), undefined);
  assert.equal(findInlineLocation({ ...review.findings[0], file: 'old.ts', side: 'old', line: 11 }, locations)?.lineType, 'REMOVED');
});

test('handles added/deleted files, multiple hunks and content resembling headers', () => {
  const input = 'diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+++ content\n'
    + 'diff --git a/b b/b\n--- a/b\n+++ /dev/null\n@@ -1 +0,0 @@\n--- content\n';
  assert.deepEqual(changedLineLocations(input).map((x) => [x.path, x.line, x.side]), [['a', 1, 'new'], ['b', 1, 'old']]);
});

test('invalid or missing model locations preserve findings for the general review', () => {
  for (const line of [null, -1, 0, 1.5, '21x', '1.5', true]) {
    const parsed = validateAIReviewResult({ ...review, findings: [{ ...review.findings[0], line }] });
    assert.equal(parsed.findings[0].line, undefined);
  }
  assert.equal(validateAIReviewResult(review).findings[0].line, 21);
});

test('accepts explicit Bitbucket FROM/TO side names without dropping valid coordinates', () => {
  for (const [side, expected] of [[' FROM ', 'old'], ['TO', 'new']]) {
    const parsed = validateAIReviewResult({ ...review, findings: [{ ...review.findings[0], side }] });
    assert.equal(parsed.findings[0].line, 21);
    assert.equal(parsed.findings[0].side, expected);
  }
  const invalid = validateAIReviewResult({ ...review, findings: [{ ...review.findings[0], side: 'unknown' }] });
  assert.equal(invalid.findings[0].line, undefined);
});

test('publishes visible context lines on both sides with CONTEXT anchors and preserves out-of-diff findings', async () => {
  const requests: { anchor?: { line: number; fileType: string; lineType: string }; text: string }[] = [];
  const client = new BitbucketServerClient({ provider: 'server', baseUrl: 'https://bitbucket.test',
    auth: { method: 'bearer', token: 'test' } }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: requests.length, text: 'saved' }), { status: 201 });
  });
  const input: AIReviewResult = { ...review, findings: [
    { ...review.findings[0], line: 20, message: 'New context issue' },
    { ...review.findings[0], file: 'old.ts', side: 'old', line: 10, message: 'Old context issue' },
    review.findings[2],
  ] };
  const saved = new Map<string, unknown>();
  const state: PublicationState = {
    get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key, value) => { saved.set(key, value); },
  };
  const ref: PullRequestRef = { provider: 'server', baseUrl: 'https://bitbucket.test', projectKey: 'TEST', repositorySlug: 'repo', pullRequestId: 1 };
  const unmatched: string[] = [];
  assert.deepEqual(await publishReview(client, ref, input, diff, 'context', state,
    (finding) => unmatched.push(finding.message)), { inlineComments: 2, generalOnlyFindings: 1, skippedExisting: 0 });
  assert.deepEqual(unmatched, ['Issue 99']);
  assert.deepEqual(requests.slice(0, 2).map(({ anchor }) => [anchor?.line, anchor?.fileType, anchor?.lineType]),
    [[20, 'TO', 'CONTEXT'], [10, 'FROM', 'CONTEXT']]);
  assert.match(requests[2].text, /Issue 99/);
  assert.doesNotMatch(requests[2].text, /New context issue|Old context issue/);
  assert.ok(annotateDiffLines(diff).includes(' [review-location {"file":"new.ts","line":20,"side":"new"}] context'));
});

test('context mapping rejects ambiguous sides and lines outside visible hunks', () => {
  const input = '--- a/a.ts\n+++ b/a.ts\n@@ -5,2 +5,2 @@\n context\n-before\n+after\n';
  const locations = diffLineLocations(input);
  const finding = { ...review.findings[0], file: 'a.ts', line: 5 };
  assert.equal(findInlineLocation({ ...finding, side: undefined }, locations), undefined);
  assert.equal(findInlineLocation({ ...finding, side: 'old' }, locations)?.lineType, 'CONTEXT');
  assert.equal(findInlineLocation({ ...finding, side: 'new' }, locations)?.lineType, 'CONTEXT');
  assert.equal(findInlineLocation({ ...finding, line: 4 }, locations), undefined);
  assert.equal(findInlineLocation({ ...finding, line: 7 }, locations), undefined);
});

test('retries emoji-rejected inline comments with readable plain labels and the same anchor', async () => {
  const sent: { text: string; line: number }[] = [];
  const saved = new Map<string, unknown>();
  const state: PublicationState = {
    get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key, value) => { saved.set(key, value); },
  };
  const client = {
    addInlineComment: async (_ref, text, location) => {
      sent.push({ text, line: location.line });
      if (sent.length === 1) throw new BitbucketHttpError(400, 'Bad Request', 'https://bitbucket.test/comments');
      return { id: 1, text };
    },
    addGeneralComment: async (_ref, text) => ({ id: 2, text }),
  } as BitbucketClient;
  const input = { ...review, findings: [review.findings[0]] };
  assert.deepEqual(await publishReview(client, {} as PullRequestRef, input, diff, 'emoji', state),
    { inlineComments: 1, generalOnlyFindings: 0, skippedExisting: 0 });
  assert.deepEqual(sent.map(({ line }) => line), [21, 21]);
  assert.match(sent[0].text, /🔴 \*\*Hata · Yüksek önem\*\*/);
  assert.match(sent[1].text, /Hata · Yüksek önem/);
  assert.match(sent[1].text, /Öneri:/);
  assert.match(sent[1].text, /Issue 21/);
  assert.match(sent[1].text, /Fix it/);
  assert.doesNotMatch(sent[1].text, /\p{Extended_Pictographic}/u);
  await publishReview(client, {} as PullRequestRef, input, diff, 'emoji', state);
  assert.equal(sent.length, 2);
});

test('publishes general plus valid inline comments and resumes partial failure without duplicates', async () => {
  const saved = new Map<string, unknown>();
  const state: PublicationState = {
    get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key, value) => { saved.set(key, value); },
  };
  let general = 0, fail = true;
  const lines: number[] = [];
  const client = {
    addGeneralComment: async (_ref, text) => {
      general++;
      assert.match(text, /Issue 22/);
      assert.doesNotMatch(text, /Issue 21/);
      return { id: 1, text: '' };
    },
    addInlineComment: async (_ref, _text, location) => {
      if (location.line === 22 && fail) throw new Error('unavailable');
      lines.push(location.line); return { id: 2, text: '' };
    },
  } as BitbucketClient;
  const ref = {} as PullRequestRef;
  await assert.rejects(publishReview(client, ref, review, diff, 'key', state), /1 satır yorumu/);
  assert.equal(general, 1);
  fail = false;
  await publishReview(client, ref, review, diff, 'key', state);
  assert.equal(general, 1);
  assert.deepEqual(lines, [21, 22]);
});

test('groups distinct issues on one line, deduplicates repeats and publishes a concise general comment last', async () => {
  const saved = new Map<string, unknown>();
  const state: PublicationState = {
    get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key, value) => { saved.set(key, value); },
  };
  const calls: { kind: string; text: string }[] = [];
  const client = {
    addGeneralComment: async (_ref, text) => { calls.push({ kind: 'general', text }); },
    addInlineComment: async (_ref, text, location) => { calls.push({ kind: `${location.side}:${location.line}`, text }); },
  } as unknown as BitbucketClient;
  const input: AIReviewResult = {
    ...review,
    findings: [review.findings[0], { ...review.findings[0] },
      { ...review.findings[0], message: 'Another issue', suggestion: 'Another fix' },
      review.findings[2],
      { ...review.findings[0], line: 11, side: 'old', file: 'old.ts', message: 'Deleted issue' }],
  };
  await publishReview(client, {} as PullRequestRef, input, diff, 'grouped', state);
  assert.deepEqual(calls.map((call) => call.kind), ['new:21', 'old:11', 'general']);
  assert.equal(calls[0].text.split('Issue 21').length - 1, 1);
  assert.match(calls[0].text, /Another issue/);
  assert.match(calls[0].text, /Another fix/);
  const general = calls[2].text;
  assert.match(general, /Summary/);
  assert.match(general, /Fix/);
  assert.match(general, /Issue 99/);
  assert.match(general, /Fix it/);
  assert.doesNotMatch(general, /Issue 21|Another issue|Another fix|Deleted issue/);
  assert.match(general, /4 bulgu ilgili satırlara yorum olarak eklendi \(4 yüksek\)/);
  await publishReview(client, {} as PullRequestRef, input, diff, 'grouped', state);
  assert.equal(calls.length, 3);
});

test('old and new sides at the same line number remain separate anchors', () => {
  const locations = changedLineLocations('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5 +5 @@\n-before\n+after\n');
  for (const side of ['old', 'new'] as const) {
    assert.equal(findInlineLocation({ ...review.findings[0], file: 'a.ts', line: 5, side }, locations)?.side, side);
  }
});

test('normalizes model coordinates and infers a missing side only for an unambiguous changed line', () => {
  const locations = changedLineLocations(diff);
  const parsed = validateAIReviewResult({ ...review, findings: [
    { ...review.findings[0], file: './b/new.ts', line: ' 21 ', side: ' NEW ' },
    { ...review.findings[0], file: 'new.ts', line: '22', side: null },
  ] });
  assert.equal(findInlineLocation(parsed.findings[0], locations)?.line, 21);
  assert.equal(findInlineLocation(parsed.findings[1], locations)?.side, 'new');
  const ambiguous = changedLineLocations('--- a/new.ts\n+++ b/new.ts\n@@ -21 +21 @@\n-old\n+new\n');
  assert.equal(findInlineLocation({ ...parsed.findings[0], side: undefined }, ambiguous), undefined);
  assert.equal(findInlineLocation({ ...parsed.findings[0], line: 999 }, locations), undefined);
  assert.equal(findInlineLocation({ ...parsed.findings[0], file: 'other/new.ts' }, locations), undefined);
});

test('accepts unprefixed and Git-quoted paths including UTF-8 octal escapes', () => {
  for (const [oldPath, newPath, expected] of [
    ['src/a.ts', 'src/a.ts', 'src/a.ts'],
    ['"a/src/my file.ts"', '"b/src/my file.ts"', 'src/my file.ts'],
    ['"a/src/\\303\\274.ts"', '"b/src/\\303\\274.ts"', 'src/ü.ts'],
  ]) {
    const locations = changedLineLocations(`--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-old\n+new\n`);
    assert.deepEqual(locations.map((location) => location.path), [expected, expected]);
  }
});

test('model request through Server publication produces two line anchors and exactly one general comment', async () => {
  const model = new OpenAICompatibleClient({ baseUrl: 'http://model.test/v1', model: 'test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.messages[1].content.includes('+[review-location {"file":"new.ts","line":21,"side":"new"}] new'));
      assert.ok(body.messages[1].content.includes('-[review-location {"file":"old.ts","line":11,"side":"old"}] old'));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        ...review, findings: [
          { ...review.findings[0], file: 'b/new.ts', line: '21', side: 'NEW' },
          { ...review.findings[0], file: 'old.ts', line: '11', side: 'old' },
          review.findings[2],
        ],
      }) } }] }) };
    },
  });
  const result = await reviewDiffInChunks(model, diff);
  const requests: { text: string; anchor?: { line: number; fileType: string; lineType: string; path: string; srcPath: string } }[] = [];
  const client = new BitbucketServerClient({ provider: 'server', baseUrl: 'https://bitbucket.test',
    auth: { method: 'bearer', token: 'test' } }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: requests.length, text: 'saved' }), { status: 201 });
  });
  const saved = new Map<string, unknown>();
  const state: PublicationState = {
    get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key, value) => { saved.set(key, value); },
  };
  const ref: PullRequestRef = { provider: 'server', baseUrl: 'https://bitbucket.test', projectKey: 'TEST', repositorySlug: 'repo', pullRequestId: 1 };
  assert.deepEqual(await publishReview(client, ref, result, diff, 'integration', state), { inlineComments: 2, generalOnlyFindings: 1, skippedExisting: 0 });
  assert.deepEqual(requests.map((request) => request.anchor?.fileType ?? 'general'), ['TO', 'FROM', 'general']);
  assert.deepEqual(requests.slice(0, 2).map((request) => [request.anchor?.line, request.anchor?.lineType, request.anchor?.path, request.anchor?.srcPath]),
    [[21, 'ADDED', 'new.ts', 'old.ts'], [11, 'REMOVED', 'new.ts', 'old.ts']]);
  assert.match(requests[2].text, /Issue 99/);
  await publishReview(client, ref, result, diff, 'integration', state);
  assert.equal(requests.length, 3);
});

test('strips Bitbucket Server src:// and dst:// diff prefixes so anchors use repository paths', () => {
  const input = 'diff --git src://lib/app.ts dst://lib/app.ts\n--- src://lib/app.ts\n+++ dst://lib/app.ts\n@@ -1,1 +1,2 @@\n keep\n+added\n';
  const locations = changedLineLocations(input);
  assert.deepEqual(locations.map((x) => [x.path, x.srcPath, x.line, x.side]), [['lib/app.ts', undefined, 2, 'new']]);
  assert.equal(findInlineLocation({ ...review.findings[0], file: 'dst://lib/app.ts', line: 2 }, locations)?.path, 'lib/app.ts');
});

test('does not repeat findings an earlier review already posted, even after lines shift', async () => {
  const posted: string[] = [];
  const state = (): PublicationState => {
    const saved = new Map<string, unknown>();
    return { get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
      update: async (key, value) => { saved.set(key, value); } };
  };
  const client = {
    addInlineComment: async (_ref, text) => { posted.push(text); return { id: 1, text }; },
    addGeneralComment: async (_ref, text) => { posted.push(text); return { id: 2, text }; },
  } as BitbucketClient;
  const input = { ...review, findings: [review.findings[0]] };
  await publishReview(client, {} as PullRequestRef, input, diff, 'first', state(), undefined,
    { reviewMarker: '<!-- bitbucket-ai-review:pr=1:commit=a:model=m -->' });
  assert.match(posted[0], /\[\/\/\]: # \(bitbucket-ai-review:line=[0-9a-f]{32}\)/);
  assert.match(posted[1], /\[\/\/\]: # \(bitbucket-ai-review:pr=1:commit=a:model=m\)/);
  // Two lines inserted above: same code, same issue, new line number.
  const shifted = diff.replace('@@ -10,2 +20,3 @@', '@@ -10,2 +22,3 @@');
  const result = await publishReview(client, {} as PullRequestRef, { ...input, findings: [{ ...input.findings[0], line: 23 }] },
    shifted, 'second', state(), undefined, { existingComments: [...posted] });
  assert.deepEqual(result, { inlineComments: 0, generalOnlyFindings: 0, skippedExisting: 1 });
  assert.equal(posted.length, 3);
  assert.match(posted[2], /1 bulgu ilgili satırlara/);
});

test('a teammate using another model does not repeat a line an earlier review commented on', async () => {
  const posted: string[] = [];
  const client = {
    addInlineComment: async (_ref, text) => { posted.push(text); return { id: posted.length, text }; },
    addGeneralComment: async (_ref, text) => { posted.push(text); return { id: posted.length, text }; },
  } as BitbucketClient;
  const memory = (): PublicationState => {
    const saved = new Map<string, unknown>();
    return { get: <T>(key: string, fallback: T): T => saved.has(key) ? saved.get(key) as T : fallback,
      update: async (key, value) => { saved.set(key, value); } };
  };
  await publishReview(client, {} as PullRequestRef, { ...review, findings: [review.findings[0]] }, diff, 'a', memory());
  // Same line, different wording and finding type.
  const other = { ...review.findings[0], type: 'security' as const, message: 'Başka ifade' };
  const result = await publishReview(client, {} as PullRequestRef, { ...review, findings: [other] }, diff, 'b', memory(),
    undefined, { existingComments: [...posted] });
  assert.equal(result.skippedExisting, 1);
  assert.equal(posted.filter((text) => /Başka ifade/.test(text) && /line=/.test(text)).length, 0);
});

test('still recognizes line comments written with the 0.3.x finding marker', async () => {
  const posted: string[] = [];
  const client = {
    addInlineComment: async (_ref, text) => { posted.push(text); return { id: 1, text }; },
    addGeneralComment: async (_ref, text) => { posted.push(text); return { id: 2, text }; },
  } as BitbucketClient;
  const state: PublicationState = { get: <T>(_key: string, fallback: T): T => fallback, update: async () => undefined };
  // sha256(JSON.stringify(['new.ts', 'new', 'bug'])) as 0.3.x computed it.
  const { createHash } = await import('node:crypto');
  const legacy = `bitbucket-ai-review:finding=${createHash('sha256').update(JSON.stringify(['new.ts', 'new', 'bug'])).digest('hex').slice(0, 32)}`;
  const result = await publishReview(client, {} as PullRequestRef, { ...review, findings: [review.findings[0]] }, diff, 'k', state,
    undefined, { existingComments: [`eski yorum\n\n[//]: # (${legacy})`] });
  assert.equal(result.skippedExisting, 1);
  assert.equal(posted.length, 1);
});

test('when a teammate published the same commit first, this review deletes its own comments', async () => {
  const key = 'bitbucket-ai-review:pr=1:commit=abc:';
  const comments: { id: number; text: string; deleted?: boolean }[] = [
    // A teammate's general comment, posted while this review was running.
    { id: 5, text: `Özet\n\n[//]: # (${key}model=other)` },
  ];
  const deleted: number[] = [];
  const client = {
    addInlineComment: async (_ref, text) => { const c = { id: comments.length + 10, text }; comments.push(c); return c; },
    addGeneralComment: async (_ref, text) => { const c = { id: comments.length + 10, text }; comments.push(c); return c; },
    listPullRequestComments: async () => comments,
    deleteComment: async (_ref, comment) => { deleted.push(comment.id); },
  } as unknown as BitbucketClient;
  const state: PublicationState = { get: <T>(_key: string, fallback: T): T => fallback, update: async () => undefined };
  const result = await publishReview(client, {} as PullRequestRef, review, diff, 'race', state, undefined,
    { reviewMarker: `<!-- ${key}model=m -->`, reviewKey: key });
  assert.equal(result.supersededBy, 5);
  assert.deepEqual(deleted.sort(), [11, 12, 13]);
});

test('the first review of a commit keeps its comments', async () => {
  const key = 'bitbucket-ai-review:pr=1:commit=abc:';
  const comments: { id: number; text: string }[] = [];
  let deletes = 0;
  const client = {
    addInlineComment: async (_ref, text) => { const c = { id: comments.length + 1, text }; comments.push(c); return c; },
    addGeneralComment: async (_ref, text) => { const c = { id: comments.length + 1, text }; comments.push(c); return c; },
    listPullRequestComments: async () => [...comments, { id: 99, text: `Sonraki inceleme [//]: # (${key}model=x)` }],
    deleteComment: async () => { deletes++; },
  } as unknown as BitbucketClient;
  const state: PublicationState = { get: <T>(_key: string, fallback: T): T => fallback, update: async () => undefined };
  const result = await publishReview(client, {} as PullRequestRef, review, diff, 'first', state, undefined,
    { reviewMarker: `<!-- ${key}model=m -->`, reviewKey: key });
  assert.equal(result.supersededBy, undefined);
  assert.equal(result.inlineComments, 2);
  assert.equal(deletes, 0);
});
