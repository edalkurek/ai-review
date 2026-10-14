import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePullRequestUrl } from '../src/bitbucket/urlParser';

test('parses a Bitbucket Cloud pull request URL', () => {
  assert.deepEqual(
    parsePullRequestUrl('https://bitbucket.org/acme/widgets/pull-requests/42/overview?tab=commits'),
    {
      provider: 'cloud',
      baseUrl: 'https://bitbucket.org',
      workspace: 'acme',
      repositorySlug: 'widgets',
      pullRequestId: 42,
    },
  );
});

test('parses a Server/Data Center URL with a context path', () => {
  assert.deepEqual(
    parsePullRequestUrl('https://git.example.test/bitbucket/projects/APP/repos/web/pull-requests/7/diff'),
    {
      provider: 'server',
      baseUrl: 'https://git.example.test/bitbucket',
      projectKey: 'APP',
      repositorySlug: 'web',
      pullRequestId: 7,
    },
  );
});

test('decodes safe URL segments', () => {
  const ref = parsePullRequestUrl('https://bitbucket.org/acme/repo%20name/pull-requests/3');
  assert.equal(ref.repositorySlug, 'repo name');
});

test('rejects unsupported, malformed, credential-bearing, and invalid-id URLs', () => {
  for (const value of [
    'not a url',
    'ftp://bitbucket.org/acme/repo/pull-requests/1',
    'https://user:secret@bitbucket.org/acme/repo/pull-requests/1',
    'https://bitbucket.org/acme/repo/issues/1',
    'https://git.example.test/projects/APP/repos/repo/pull-requests/0',
    'https://git.example.test/projects/APP/repos/repo/pull-requests/not-a-number',
  ]) {
    assert.throws(() => parsePullRequestUrl(value));
  }
});
