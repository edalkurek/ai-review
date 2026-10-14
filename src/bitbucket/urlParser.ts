import { PullRequestRef } from './types';

const CLOUD_HOST = 'bitbucket.org';

function decodeSegment(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/')) {
      throw new Error();
    }
    return decoded;
  } catch {
    throw new Error(`Invalid ${label} in Bitbucket pull request URL`);
  }
}

function parseId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('Invalid pull request id in Bitbucket URL');
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Invalid pull request id in Bitbucket URL');
  }
  return id;
}

/**
 * Parses browser URLs produced by Bitbucket Cloud and Bitbucket Server/Data Center.
 * Additional path components after the PR id (for example `/overview`) are ignored.
 */
export function parsePullRequestUrl(value: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Bitbucket pull request URL');
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('Invalid Bitbucket pull request URL');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase() === CLOUD_HOST) {
    if (segments.length < 4 || segments[2] !== 'pull-requests') {
      throw new Error('Unsupported Bitbucket Cloud pull request URL');
    }

    return {
      provider: 'cloud',
      baseUrl: `${url.protocol}//${url.host}`,
      workspace: decodeSegment(segments[0], 'workspace'),
      repositorySlug: decodeSegment(segments[1], 'repository'),
      pullRequestId: parseId(segments[3]),
    };
  }

  const projectsIndex = segments.findIndex((part) => part.toLowerCase() === 'projects');
  if (
    projectsIndex < 0 ||
    segments[projectsIndex + 2]?.toLowerCase() !== 'repos' ||
    segments[projectsIndex + 4]?.toLowerCase() !== 'pull-requests' ||
    !segments[projectsIndex + 5]
  ) {
    throw new Error('Unsupported Bitbucket Server/Data Center pull request URL');
  }

  const contextPath = segments.slice(0, projectsIndex).join('/');
  return {
    provider: 'server',
    baseUrl: `${url.protocol}//${url.host}${contextPath ? `/${contextPath}` : ''}`,
    projectKey: decodeSegment(segments[projectsIndex + 1], 'project'),
    repositorySlug: decodeSegment(segments[projectsIndex + 3], 'repository'),
    pullRequestId: parseId(segments[projectsIndex + 5]),
  };
}

export const parseBitbucketPullRequestUrl = parsePullRequestUrl;
