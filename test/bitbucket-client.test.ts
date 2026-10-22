import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BitbucketCloudClient,
  BitbucketHttpError,
  BitbucketServerClient,
  FetchLike,
  PullRequestRef,
} from '../src/bitbucket';

interface SeenRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(
  handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>,
): { fetch: FetchLike; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = String(input);
    seen.push({ url, init });
    return handler(url, init, seen.length);
  };
  return { fetch, seen };
}

const cloudRef: PullRequestRef = {
  provider: 'cloud',
  baseUrl: 'https://bitbucket.org',
  workspace: 'acme',
  repositorySlug: 'widgets',
  pullRequestId: 42,
};

const serverRef: PullRequestRef = {
  provider: 'server',
  baseUrl: 'https://git.example.test/bitbucket',
  projectKey: 'APP',
  repositorySlug: 'widgets',
  pullRequestId: 7,
};

test('Server and Cloud post inline anchors on the correct diff side', async () => {
  const mock = mockFetch(() => jsonResponse({ id: 1, text: 'review' }));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  const cloud = new BitbucketCloudClient({ provider: 'cloud', reviewer: 'me', auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  await server.addInlineComment(serverRef, 'review', { path: 'new.ts', srcPath: 'old.ts', line: 12, side: 'old', lineType: 'REMOVED' });
  assert.deepEqual(JSON.parse(String(mock.seen[0].init.body)).anchor, { diffType: 'EFFECTIVE', path: 'new.ts', srcPath: 'old.ts', line: 12, lineType: 'REMOVED', fileType: 'FROM' });
  await server.addInlineComment(serverRef, 'review', { path: 'new.ts', line: 15, side: 'new', lineType: 'ADDED' });
  assert.deepEqual(JSON.parse(String(mock.seen[1].init.body)).anchor, { diffType: 'EFFECTIVE', path: 'new.ts', line: 15, lineType: 'ADDED', fileType: 'TO' });
  for (const side of ['old', 'new'] as const) {
    await cloud.addInlineComment(cloudRef, 'review', { path: 'a.ts', line: 4, side, lineType: side === 'old' ? 'REMOVED' : 'ADDED' });
  }
  assert.deepEqual(JSON.parse(String(mock.seen[2].init.body)).inline, { path: 'a.ts', from: 4 });
  assert.deepEqual(JSON.parse(String(mock.seen[3].init.body)).inline, { path: 'a.ts', to: 4 });
});

test('Cloud lists only reviewer open PRs and follows next-page URLs', async () => {
  const matching = {
    id: 42,
    title: 'Improve parser',
    state: 'OPEN',
    author: { account_id: 'author-id', display_name: 'Ada' },
    reviewers: [{ uuid: '{reviewer-id}', display_name: 'Reviewer' }],
    source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
    destination: {
      branch: { name: 'main' },
      repository: { slug: 'widgets', workspace: { slug: 'acme' } },
    },
    links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/42' } },
    updated_on: '2026-01-02T03:04:05Z',
  };
  const notReviewer = { ...matching, id: 43, reviewers: [{ uuid: '{someone-else}' }] };
  const mock = mockFetch((url) => {
    if (url.includes('/repositories/acme?')) {
      return jsonResponse({ values: [{ slug: 'widgets' }], next: null });
    }
    return jsonResponse(url === 'https://api.test/page/2'
      ? { values: [{ ...matching, id: 44 }], next: null }
      : { values: [matching, notReviewer], next: 'https://api.test/page/2' });
  });
  const client = new BitbucketCloudClient({
    provider: 'cloud',
    workspace: 'acme',
    reviewer: '{reviewer-id}',
    apiBaseUrl: 'https://api.test/2.0/',
    auth: { method: 'bearer', token: 'cloud-secret' },
  }, mock.fetch);

  const result = await client.listOpenPullRequestsForReviewer();

  assert.deepEqual(result.map((pr) => pr.ref.pullRequestId), [42, 44]);
  assert.equal(result[0].latestCommitHash, 'abc123');
  assert.match(mock.seen[0].url, /\/repositories\/acme\?pagelen=100$/);
  assert.equal(new Headers(mock.seen[0].init.headers).get('Authorization'), 'Bearer cloud-secret');
  assert.match(mock.seen[1].url, /\/repositories\/acme\/widgets\/pullrequests\?state=OPEN/);
  assert.equal(mock.seen[2].url, 'https://api.test/page/2');
});

test('Cloud gets diff and latest commit, posts comments, and searches all comment pages', async () => {
  const mock = mockFetch((url, init) => {
    if (url.endsWith('/diff')) return new Response('diff --git a/a b/a');
    if (url.endsWith('/pullrequests/42')) {
      return jsonResponse({ source: { commit: { hash: 'deadbeef' } } });
    }
    if (init.method === 'POST') {
      return jsonResponse({ id: 9, content: { raw: JSON.parse(String(init.body)).content.raw } });
    }
    if (url === 'https://api.test/comment-page-2') {
      return jsonResponse({ values: [{ id: 2, content: { raw: '<!-- marker --> review' } }] });
    }
    return jsonResponse({ values: [{ id: 1, content: { raw: 'ordinary' } }], next: 'https://api.test/comment-page-2' });
  });
  const client = new BitbucketCloudClient({
    provider: 'cloud', reviewer: 'me', apiBaseUrl: 'https://api.test/2.0',
    auth: { method: 'bearer', token: 'cloud-access-token' },
  }, mock.fetch);

  assert.equal(await client.getPullRequestDiff(cloudRef), 'diff --git a/a b/a');
  assert.equal(new Headers(mock.seen[0].init.headers).get('Accept'), 'text/plain');
  assert.equal(await client.getLatestCommitHash(cloudRef), 'deadbeef');
  const posted = await client.addGeneralComment(cloudRef, 'AI review');
  assert.equal(posted.text, 'AI review');
  assert.equal(await client.hasCommentMarker(cloudRef, '<!-- marker -->'), true);
  assert.equal(mock.seen.length, 5);
});

test('Server uses dashboard pagination and normalizes pull requests', async () => {
  const item = {
    id: 7,
    title: 'Server PR',
    state: 'OPEN',
    author: { user: { slug: 'ada', displayName: 'Ada' } },
    fromRef: { displayId: 'feature', latestCommit: 'cafe' },
    toRef: {
      displayId: 'main',
      repository: { slug: 'widgets', project: { key: 'APP' } },
    },
    links: { self: [{ href: 'https://git.example.test/bitbucket/projects/APP/repos/widgets/pull-requests/7' }] },
  };
  const mock = mockFetch((_url, _init, call) => jsonResponse(call === 1
    ? { values: [item], isLastPage: false, nextPageStart: 100 }
    : { values: [{ ...item, id: 8 }], isLastPage: true }),
  );
  const client = new BitbucketServerClient({
    provider: 'server',
    baseUrl: 'https://git.example.test/bitbucket/rest/api/1.0',
    auth: { method: 'bearer', token: 'server-secret' },
  }, mock.fetch);

  const result = await client.listOpenPullRequestsForReviewer();

  assert.deepEqual(result.map((pr) => pr.ref.pullRequestId), [7, 8]);
  assert.equal(result[0].ref.projectKey, 'APP');
  assert.match(mock.seen[0].url, /\/rest\/api\/1\.0\/dashboard\/pull-requests\?/);
  assert.doesNotMatch(mock.seen[0].url, /rest\/api\/1\.0\/rest\/api/);
  assert.match(mock.seen[1].url, /start=100$/);
});

test('Server gets PR data, posts a general comment, and finds duplicate markers', async () => {
  const mock = mockFetch((url, init) => {
    if (url.endsWith('.diff')) return new Response('server diff');
    if (url.endsWith('/pull-requests/7')) return jsonResponse({ fromRef: { latestCommit: 'feedface' } });
    if (init.method === 'POST') return jsonResponse({ id: 3, text: JSON.parse(String(init.body)).text });
    assert.match(url, /\/activities\?limit=100&start=0$/);
    return jsonResponse({ values: [{ action: 'COMMENTED', comment: { id: 4, text: '<!-- duplicate -->' } }], isLastPage: true });
  });
  const client = new BitbucketServerClient({
    provider: 'server', baseUrl: 'https://git.example.test/bitbucket',
    auth: { method: 'bearer', token: 'server-access-token' },
  }, mock.fetch);

  assert.equal(await client.getPullRequestDiff(serverRef), 'server diff');
  assert.equal(await client.getLatestCommitHash(serverRef), 'feedface');
  assert.equal((await client.addGeneralComment(serverRef, 'review')).text, 'review');
  assert.equal(await client.hasCommentMarker(serverRef, '<!-- duplicate -->'), true);
  assert.match(mock.seen[0].url, /\/rest\/api\/1\.0\/projects\/APP\/repos\/widgets/);
});

test('Server reads paginated activity threads, deduplicates replies and ignores deleted markers', async () => {
  const reply = { id: 12, text: '<!-- reply-marker -->' };
  const mock = mockFetch((url) => {
    const parsed = new URL(url);
    assert.ok(parsed.pathname.endsWith('/activities'));
    if (parsed.searchParams.get('start') === '0') {
      return jsonResponse({
        values: [
          { action: 'OPENED' },
          { action: 'COMMENTED', comment: { id: 10, text: '<!-- deleted-marker -->', deleted: true } },
        ],
        isLastPage: false, nextPageStart: 37,
      });
    }
    assert.equal(parsed.searchParams.get('start'), '37');
    return jsonResponse({
      values: [
        { action: 'COMMENTED', comment: { id: 11, text: 'review', comments: [reply] } },
        { action: 'COMMENTED', comment: reply },
      ],
      isLastPage: true,
    });
  });
  const client = new BitbucketServerClient({
    provider: 'server', baseUrl: serverRef.baseUrl,
    auth: { method: 'bearer', token: 'test-token' },
  }, mock.fetch);

  assert.deepEqual((await client.listPullRequestComments(serverRef)).map((comment) => comment.id), [10, 11, 12]);
  assert.equal(await client.hasCommentMarker(serverRef, '<!-- reply-marker -->'), true);
  assert.equal(await client.hasCommentMarker(serverRef, '<!-- deleted-marker -->'), false);
  assert.equal(await client.hasCommentMarker(serverRef, '<!-- absent -->'), false);
});

test('HTTP failures are typed and never include response bodies or credentials', async () => {
  const mock = mockFetch(() => jsonResponse({ error: 'token=very-secret' }, 401));
  const client = new BitbucketCloudClient({
    provider: 'cloud', reviewer: 'me', apiBaseUrl: 'https://api.test/2.0',
    auth: { method: 'bearer', token: 'very-secret' },
  }, mock.fetch);

  await assert.rejects(
    client.getLatestCommitHash(cloudRef),
    (error: unknown) => {
      assert.ok(error instanceof BitbucketHttpError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /very-secret/);
      return true;
    },
  );
});

test('does not forward credentials to a cross-origin Cloud pagination URL', async () => {
  const mock = mockFetch((_url, _init, call) => jsonResponse(call === 1
    ? { values: [], next: 'https://attacker.example.test/steal' }
    : { values: [] }),
  );
  const client = new BitbucketCloudClient({
    provider: 'cloud', reviewer: 'me', apiBaseUrl: 'https://api.test/2.0',
    auth: { method: 'bearer', token: 'very-secret' },
  }, mock.fetch);

  await assert.rejects(
    client.listOpenPullRequestsForReviewer(),
    /unexpected origin/,
  );
  assert.equal(mock.seen.length, 1);
});

test('rejects API base URLs containing embedded credentials', () => {
  assert.throws(() => new BitbucketCloudClient({
    provider: 'cloud', reviewer: 'me', apiBaseUrl: 'https://user:secret@api.test/2.0',
    auth: { method: 'bearer', token: 'token' },
  }));
});

test('Server client sets X-Atlassian-Token header and surfaces Bitbucket error messages', async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({
    errors: [{ message: 'The comment text is invalid' }],
  }), {
    status: 400,
    statusText: 'Bad Request',
    headers: { 'Content-Type': 'application/json' },
  }));

  const client = new BitbucketServerClient({
    provider: 'server', baseUrl: 'https://git.example.test/bitbucket',
    auth: { method: 'bearer', token: 'server-token' },
  }, mock.fetch);

  await assert.rejects(
    client.addGeneralComment(serverRef, 'test comment'),
    (error: unknown) => {
      assert.ok(error instanceof BitbucketHttpError);
      assert.equal(error.status, 400);
      assert.match(error.message, /The comment text is invalid/);
      assert.equal(error.serverMessage, 'The comment text is invalid');
      return true;
    },
  );

  assert.equal(new Headers(mock.seen[0].init.headers).get('X-Atlassian-Token'), 'no-check');
});

test('Server opens blocker line comments as tasks only when requested', async () => {
  const mock = mockFetch(() => jsonResponse({ id: 1, text: 'review' }));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  const location = { path: 'a.ts', line: 3, side: 'new', lineType: 'ADDED' } as const;
  await server.addInlineComment(serverRef, 'review', location, { blocker: true });
  await server.addInlineComment(serverRef, 'review', location);
  assert.equal(JSON.parse(String(mock.seen[0].init.body)).severity, 'BLOCKER');
  assert.equal(JSON.parse(String(mock.seen[1].init.body)).severity, undefined);
});

test('Server reads raw file content at a commit and treats a missing file as undefined', async () => {
  const mock = mockFetch((url) => url.includes('gone.ts') ? new Response('', { status: 404, statusText: 'Not Found' }) : new Response('line 1\nline 2'));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  assert.equal(await server.getFileContent(serverRef, 'src/my file.ts', 'abc123'), 'line 1\nline 2');
  assert.equal(mock.seen[0].url, 'https://git.example.test/bitbucket/rest/api/1.0/projects/APP/repos/widgets/raw/src/my%20file.ts?at=abc123');
  assert.equal(await server.getFileContent(serverRef, 'gone.ts', 'abc123'), undefined);
});

test('Server reads shared files from a branch or, without one, from the default branch', async () => {
  const mock = mockFetch(() => new Response('kural'));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  const rules = { provider: 'server' as const, baseUrl: serverRef.baseUrl, projectKey: 'AI', repositorySlug: 'rules' };
  await server.getFileContent(rules, 'projects/PAY/general.md', 'refs/heads/main');
  await server.getFileContent(rules, 'general.md');
  assert.equal(mock.seen[0].url, 'https://git.example.test/bitbucket/rest/api/1.0/projects/AI/repos/rules/raw/projects/PAY/general.md?at=refs%2Fheads%2Fmain');
  assert.equal(mock.seen[1].url, 'https://git.example.test/bitbucket/rest/api/1.0/projects/AI/repos/rules/raw/general.md');
  await server.getFileContent({ ...rules, projectKey: '~t0101505' }, 'general.md');
  assert.equal(mock.seen[2].url, 'https://git.example.test/bitbucket/rest/api/1.0/projects/~t0101505/repos/rules/raw/general.md');
});

test('Server anchors line comments to the effective diff commits', async () => {
  const mock = mockFetch((url) => url.includes('/changes')
    ? jsonResponse({ fromHash: 'src-tip', toHash: 'merge-base', values: [] })
    : jsonResponse({ id: 1, text: 'review' }));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  const hashes = await server.getEffectiveDiffHashes(serverRef);
  assert.deepEqual(hashes, { fromHash: 'src-tip', toHash: 'merge-base' });
  await server.addInlineComment(serverRef, 'review', { path: 'dml/a.sql', line: 3, side: 'new', lineType: 'ADDED' }, { hashes });
  const anchor = JSON.parse(String(mock.seen[1].init.body)).anchor;
  assert.equal(anchor.fromHash, 'src-tip');
  assert.equal(anchor.toHash, 'merge-base');
  assert.equal(anchor.srcPath, undefined);
});

test('Server deletes a comment with its version', async () => {
  const mock = mockFetch(() => new Response(null, { status: 204 }));
  const server = new BitbucketServerClient({ provider: 'server', baseUrl: serverRef.baseUrl, auth: { method: 'bearer', token: 'test' } }, mock.fetch);
  await server.deleteComment(serverRef, { id: 42, text: '', version: 3 });
  assert.equal(mock.seen[0].url, 'https://git.example.test/bitbucket/rest/api/1.0/projects/APP/repos/widgets/pull-requests/7/comments/42?version=3');
  assert.equal(mock.seen[0].init.method, 'DELETE');
});
