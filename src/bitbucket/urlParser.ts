import { PullRequestRef, RepositoryRef } from './types';

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

/**
 * Parses a Server/Data Center repository browser URL: `…/projects/P/repos/r[/browse…]`, or a personal
 * repository `…/users/u/repos/r[/browse…]`, which the REST API addresses as project `~u`.
 */
export function parseRepositoryUrl(value: string): RepositoryRef {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Geçersiz Bitbucket repo adresi');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('Geçersiz Bitbucket repo adresi');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const ownerIndex = segments.findIndex((part, index) => ['projects', 'users'].includes(part.toLowerCase())
    && segments[index + 2]?.toLowerCase() === 'repos' && Boolean(segments[index + 3]));
  if (ownerIndex < 0) {
    throw new Error('Bitbucket repo adresi …/projects/<PROJE>/repos/<repo> veya …/users/<kullanıcı>/repos/<repo> biçiminde olmalıdır');
  }
  const contextPath = segments.slice(0, ownerIndex).join('/');
  const owner = decodeSegment(segments[ownerIndex + 1], 'project');
  return {
    provider: 'server',
    baseUrl: `${url.protocol}//${url.host}${contextPath ? `/${contextPath}` : ''}`,
    projectKey: segments[ownerIndex].toLowerCase() === 'users' ? `~${owner}` : owner,
    repositorySlug: decodeSegment(segments[ownerIndex + 3], 'repository'),
  };
}

export interface RemoteRepository {
  host: string;
  projectKey: string;
  repositorySlug: string;
}

/**
 * Reads project and repository from a Bitbucket Server git remote:
 * `https://host[/ctx]/scm/P/r.git`, `ssh://git@host[:port]/p/r.git` or `git@host:p/r.git`.
 */
export function parseRemoteUrl(value: string): RemoteRepository | undefined {
  const remote = value.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(remote);
  let host: string;
  let pathname: string;
  if (scp) {
    [, host, pathname] = scp;
  } else {
    try {
      const url = new URL(remote);
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return undefined;
    }
  }
  const segments = pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  const scmIndex = segments.findIndex((part) => part.toLowerCase() === 'scm');
  // HTTP remotes carry /scm/; SSH remotes are just /project/repo.
  const [projectKey, repositorySlug] = scmIndex >= 0 ? segments.slice(scmIndex + 1) : segments.slice(-2);
  if (!projectKey || !repositorySlug || (scmIndex >= 0 && segments.length !== scmIndex + 3)) return undefined;
  try {
    return { host: host.toLowerCase(), projectKey: decodeURIComponent(projectKey), repositorySlug: decodeURIComponent(repositorySlug) };
  } catch {
    return undefined;
  }
}
