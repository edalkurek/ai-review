import {
  calculateBackoffDelay,
  isRetryableStatus,
  MAX_RETRY_ATTEMPTS,
  parseRetryAfterHeader,
  sleep,
} from '../util/retry';
import {
  BitbucketAuth,
  BitbucketClient,
  BitbucketCloudConfig,
  BitbucketConfig,
  BitbucketHttpError,
  BitbucketServerConfig,
  DiffHashes,
  FetchLike,
  InlineCommentLocation,
  InlineCommentOptions,
  PullRequest,
  PullRequestAuthor,
  PullRequestComment,
  PullRequestRef,
  Repository,
  RepositoryRef,
} from './types';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function safeBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return trimTrailingSlash(parsed.toString());
}

function normalizePath(value: string): string {
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function authHeader(auth: BitbucketAuth): string {
  return `Bearer ${auth.token}`;
}

function requireRef(ref: RepositoryRef, provider: 'cloud' | 'server'): void {
  if (ref.provider !== provider) {
    throw new Error(`Cannot use a ${ref.provider} pull request with the ${provider} client`);
  }
  if (provider === 'cloud' && !ref.workspace) {
    throw new Error('Bitbucket Cloud pull request reference requires a workspace');
  }
  if (provider === 'server' && !ref.projectKey) {
    throw new Error('Bitbucket Server/Data Center pull request reference requires a project key');
  }
}

function matchesMarker(text: string, marker: string): boolean {
  if (text.includes(marker)) return true;
  // The key spans pr/commit/model; stopping at ':' would match every review of the same PR.
  const rawKeyMatch = marker.match(/bitbucket-ai-review:[a-zA-Z0-9_=%&.:!*'~-]+/);
  return rawKeyMatch ? text.includes(rawKeyMatch[0]) : false;
}

abstract class BaseClient {
  protected allowedOrigin = '';

  protected constructor(
    protected readonly auth: BitbucketAuth,
    protected readonly fetchImpl: FetchLike,
  ) {
    if (!auth.token) {
      throw new Error('Bitbucket access token cannot be empty');
    }
  }

  protected async request(url: string, init: RequestInit = {}): Promise<Response> {
    let requestUrl: URL;
    try {
      requestUrl = new URL(url);
    } catch {
      throw new Error('Bitbucket API returned an invalid request URL');
    }
    if (!this.allowedOrigin || requestUrl.origin !== this.allowedOrigin) {
      throw new Error('Refusing to send Bitbucket credentials to an unexpected origin');
    }
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    headers.set('Authorization', authHeader(this.auth));
    if (!headers.has('X-Atlassian-Token')) headers.set('X-Atlassian-Token', 'no-check');

    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(url, { ...init, headers });
      if (response.ok) {
        return response;
      }

      if (isRetryableStatus(response.status) && attempt < MAX_RETRY_ATTEMPTS) {
        const retryAfterHeader = typeof response.headers?.get === 'function'
          ? response.headers.get('Retry-After')
          : undefined;
        const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
        const delayMs = calculateBackoffDelay(attempt, retryAfterMs);
        attempt++;
        await sleep(delayMs, init.signal as AbortSignal | undefined);
        continue;
      }

      let serverMessage: string | undefined;
      try {
        const bodyText = await response.text();
        try {
          const parsed = record(JSON.parse(bodyText));
          const parsedErrors = values(parsed.errors);
          if (parsedErrors.length > 0) {
            serverMessage = parsedErrors
              .map((e) => string(record(e).message))
              .filter(Boolean)
              .join('; ');
          } else if (typeof parsed.message === 'string') {
            serverMessage = parsed.message;
          }
        } catch {
          const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            serverMessage = titleMatch[1].trim();
          } else if (bodyText.length > 0 && bodyText.length < 200 && !bodyText.includes('<')) {
            serverMessage = bodyText.trim();
          }
        }
      } catch {
        // Deliberately ignore response body read errors
      }
      if (serverMessage) {
        serverMessage = serverMessage.replace(/([a-zA-Z0-9_-]{24,})/g, '[REDACTED]');
      }
      throw new BitbucketHttpError(response.status, response.statusText, url, serverMessage);
    }
  }

  protected async text(url: string): Promise<string | undefined> {
    try {
      return await (await this.request(url, { headers: { Accept: 'text/plain' } })).text();
    } catch (error) {
      if (error instanceof BitbucketHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  protected async json(url: string, init?: RequestInit): Promise<UnknownRecord> {
    return record(await (await this.request(url, init)).json());
  }

  protected async postJson(url: string, body: unknown): Promise<UnknownRecord> {
    return this.json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

export class BitbucketCloudClient extends BaseClient implements BitbucketClient {
  private readonly apiBaseUrl: string;

  public constructor(
    private readonly config: BitbucketCloudConfig,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    super(config.auth, fetchImpl);
    this.apiBaseUrl = safeBaseUrl(
      config.apiBaseUrl ?? 'https://api.bitbucket.org/2.0',
      'Bitbucket Cloud API base URL',
    );
    this.allowedOrigin = new URL(this.apiBaseUrl).origin;
  }

  public async listRepositories(): Promise<Repository[]> {
    const result: Repository[] = [];
    if (this.config.workspace) {
      const workspace = encodePath(this.config.workspace);
      let repositoriesUrl: string | undefined = `${this.apiBaseUrl}/repositories/${workspace}?pagelen=100`;
      while (repositoriesUrl) {
        const repositoriesPage = await this.json(repositoriesUrl);
        for (const repositoryValue of values(repositoriesPage.values)) {
          const rec = record(repositoryValue);
          const slug = string(rec.slug);
          if (slug) {
            result.push({
              provider: 'cloud',
              baseUrl: 'https://bitbucket.org',
              workspace: this.config.workspace,
              slug,
              name: string(rec.name) || slug,
            });
          }
        }
        repositoriesUrl = string(repositoriesPage.next) || undefined;
      }
    }
    return result;
  }

  public async listOpenPullRequestsForReviewer(): Promise<PullRequest[]> {
    const result: PullRequest[] = [];

    if (this.config.workspace) {
      const workspace = encodePath(this.config.workspace);
      let repositoriesUrl: string | undefined = `${this.apiBaseUrl}/repositories/${workspace}?pagelen=100`;
      while (repositoriesUrl) {
        const repositoriesPage = await this.json(repositoriesUrl);
        for (const repositoryValue of values(repositoriesPage.values)) {
          const repositorySlug = string(record(repositoryValue).slug);
          if (repositorySlug) {
            await this.appendReviewerPullRequests(
              `${this.apiBaseUrl}/repositories/${workspace}/${encodePath(repositorySlug)}/pullrequests?state=OPEN&pagelen=50`,
              result,
            );
          }
        }
        repositoriesUrl = string(repositoriesPage.next) || undefined;
      }
      return result;
    }

    // Kept for installations that still expose Bitbucket Cloud's legacy cross-workspace route.
    const reviewer = encodePath(this.config.reviewer);
    const query = encodeURIComponent('state="OPEN"');
    await this.appendReviewerPullRequests(
      `${this.apiBaseUrl}/pullrequests/${reviewer}?q=${query}&pagelen=50`,
      result,
    );
    return result;
  }

  private async appendReviewerPullRequests(firstPage: string, result: PullRequest[]): Promise<void> {
    let next: string | undefined = firstPage;
    while (next) {
      const page = await this.json(next);
      for (const item of values(page.values)) {
        const pr = this.toPullRequest(record(item));
        // The selected_user endpoint also includes authored/participant PRs. Keep only reviewer PRs.
        if (this.isReviewer(record(item))) result.push(pr);
      }
      next = string(page.next) || undefined;
    }
  }

  public async getPullRequestDiff(ref: PullRequestRef): Promise<string> {
    requireRef(ref, 'cloud');
    const response = await this.request(`${this.pullRequestUrl(ref)}/diff`, {
      headers: { Accept: 'text/plain' },
    });
    return response.text();
  }

  public async getLatestCommitHash(ref: PullRequestRef): Promise<string> {
    requireRef(ref, 'cloud');
    const item = await this.json(this.pullRequestUrl(ref));
    return string(record(record(item.source).commit).hash);
  }

  public async listPullRequestComments(ref: PullRequestRef): Promise<PullRequestComment[]> {
    const comments: PullRequestComment[] = [];
    await this.visitComments(ref, (comment) => {
      comments.push(comment);
      return false;
    });
    return comments;
  }

  public async addGeneralComment(ref: PullRequestRef, text: string): Promise<PullRequestComment> {
    if (!text.trim()) throw new Error('Comment text cannot be empty');
    const item = await this.postJson(`${this.pullRequestUrl(ref)}/comments`, { content: { raw: text } });
    return this.toComment(item);
  }

  public async addInlineComment(ref: PullRequestRef, text: string, location: InlineCommentLocation): Promise<PullRequestComment> {
    if (!text.trim()) throw new Error('Comment text cannot be empty');
    return this.toComment(await this.postJson(`${this.pullRequestUrl(ref)}/comments`, {
      content: { raw: text },
      inline: { path: location.path, [location.side === 'old' ? 'from' : 'to']: location.line },
    }));
  }

  public async hasCommentMarker(ref: PullRequestRef, marker: string): Promise<boolean> {
    if (!marker) return false;
    return this.visitComments(ref, (comment) => !comment.deleted && matchesMarker(comment.text, marker));
  }

  public async deleteComment(ref: PullRequestRef, comment: PullRequestComment): Promise<void> {
    await this.request(`${this.pullRequestUrl(ref)}/comments/${comment.id}`, { method: 'DELETE' });
  }

  public async getFileContent(ref: RepositoryRef, path: string, at?: string): Promise<string | undefined> {
    requireRef(ref, 'cloud');
    const repositoryUrl = `${this.apiBaseUrl}/repositories/${encodePath(ref.workspace!)}/${encodePath(ref.repositorySlug)}`;
    // Cloud's src endpoint needs a revision; fall back to the repository's main branch.
    const revision = at?.replace(/^refs\/heads\//, '') || string(record((await this.json(repositoryUrl)).mainbranch).name);
    return this.text(`${repositoryUrl}/src/${encodePath(revision)}/${encodeFilePath(path)}`);
  }

  private pullRequestUrl(ref: PullRequestRef): string {
    requireRef(ref, 'cloud');
    return `${this.apiBaseUrl}/repositories/${encodePath(ref.workspace!)}/${encodePath(ref.repositorySlug)}/pullrequests/${ref.pullRequestId}`;
  }

  private async visitComments(
    ref: PullRequestRef,
    visitor: (comment: PullRequestComment) => boolean,
  ): Promise<boolean> {
    let next: string | undefined = `${this.pullRequestUrl(ref)}/comments?pagelen=100`;
    while (next) {
      const page = await this.json(next);
      for (const value of values(page.values)) {
        if (visitor(this.toComment(record(value)))) return true;
      }
      next = string(page.next) || undefined;
    }
    return false;
  }

  private isReviewer(item: UnknownRecord): boolean {
    const expected = this.config.reviewer.toLowerCase().replace(/[{}]/g, '');
    return values(item.reviewers).some((candidate) => {
      const reviewer = record(candidate);
      return [reviewer.uuid, reviewer.username, reviewer.nickname, reviewer.account_id]
        .map((value) => string(value).toLowerCase().replace(/[{}]/g, ''))
        .includes(expected);
    });
  }

  private toPullRequest(item: UnknownRecord): PullRequest {
    const repository = record(record(item.destination).repository);
    const workspace = record(repository.workspace);
    const source = record(item.source);
    const destination = record(item.destination);
    const author = record(item.author);
    const links = record(item.links);
    const html = record(links.html);
    return {
      ref: {
        provider: 'cloud',
        baseUrl: 'https://bitbucket.org',
        workspace: string(workspace.slug) || string(workspace.uuid).replace(/[{}]/g, ''),
        repositorySlug: string(repository.slug),
        pullRequestId: number(item.id),
      },
      title: string(item.title),
      state: string(item.state),
      url: string(html.href),
      author: this.toAuthor(author),
      sourceBranch: string(record(source.branch).name),
      destinationBranch: string(record(destination.branch).name),
      latestCommitHash: string(record(source.commit).hash),
      updatedAt: string(item.updated_on) || undefined,
    };
  }

  private toComment(item: UnknownRecord): PullRequestComment {
    return {
      id: number(item.id),
      text: string(record(item.content).raw),
      author: Object.keys(record(item.user)).length ? this.toAuthor(record(item.user)) : undefined,
      createdAt: string(item.created_on) || undefined,
      updatedAt: string(item.updated_on) || undefined,
      deleted: Boolean(item.deleted),
    };
  }

  private toAuthor(user: UnknownRecord): PullRequestAuthor {
    return {
      id: string(user.account_id) || string(user.uuid) || undefined,
      displayName: string(user.display_name) || string(user.nickname) || 'Unknown',
    };
  }
}

export class BitbucketServerClient extends BaseClient implements BitbucketClient {
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;

  public constructor(
    config: BitbucketServerConfig,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    super(config.auth, fetchImpl);
    const baseUrl = safeBaseUrl(config.baseUrl, 'Bitbucket Server/Data Center base URL');
    this.webBaseUrl = baseUrl.replace(/\/rest\/api\/(?:latest|\d+(?:\.\d+)*)$/i, '');
    this.apiBaseUrl = config.apiPath
      ? `${baseUrl}${normalizePath(config.apiPath)}`
      : /\/rest\/api\/(?:latest|\d+(?:\.\d+)*)$/i.test(baseUrl)
        ? baseUrl
        : `${baseUrl}/rest/api/1.0`;
    this.allowedOrigin = new URL(this.apiBaseUrl).origin;
  }

  public async listRepositories(): Promise<Repository[]> {
    let start = 0;
    const result: Repository[] = [];
    do {
      const url = `${this.apiBaseUrl}/repos?limit=100&start=${start}`;
      const page = await this.json(url);
      for (const item of values(page.values)) {
        const rec = record(item);
        const project = record(rec.project);
        result.push({
          provider: 'server',
          baseUrl: this.webBaseUrl,
          projectKey: string(project.key),
          slug: string(rec.slug),
          name: string(rec.name) || string(rec.slug),
        });
      }
      if (Boolean(page.isLastPage)) break;
      const next = number(page.nextPageStart);
      if (!Number.isFinite(next) || next <= start) break;
      start = next;
    } while (true);
    return result;
  }

  public async listOpenPullRequestsForReviewer(): Promise<PullRequest[]> {
    let start = 0;
    const result: PullRequest[] = [];
    do {
      const url = `${this.apiBaseUrl}/dashboard/pull-requests?role=REVIEWER&state=OPEN&limit=100&start=${start}`;
      const page = await this.json(url);
      for (const item of values(page.values)) result.push(this.toPullRequest(record(item)));
      if (Boolean(page.isLastPage)) break;
      const next = number(page.nextPageStart);
      if (!Number.isFinite(next) || next <= start) break;
      start = next;
    } while (true);
    return result;
  }

  public async getPullRequestDiff(ref: PullRequestRef): Promise<string> {
    const response = await this.request(`${this.pullRequestUrl(ref)}.diff`, {
      headers: { Accept: 'text/plain' },
    });
    return response.text();
  }

  public async getLatestCommitHash(ref: PullRequestRef): Promise<string> {
    const item = await this.json(this.pullRequestUrl(ref));
    return string(record(item.fromRef).latestCommit);
  }

  public async listPullRequestComments(ref: PullRequestRef): Promise<PullRequestComment[]> {
    const comments: PullRequestComment[] = [];
    await this.visitComments(ref, (comment) => {
      comments.push(comment);
      return false;
    });
    return comments;
  }

  public async addGeneralComment(ref: PullRequestRef, text: string): Promise<PullRequestComment> {
    if (!text.trim()) throw new Error('Comment text cannot be empty');
    return this.toComment(await this.postJson(`${this.pullRequestUrl(ref)}/comments`, { text }));
  }

  public async addInlineComment(
    ref: PullRequestRef, text: string, location: InlineCommentLocation, options: InlineCommentOptions = {},
  ): Promise<PullRequestComment> {
    if (!text.trim()) throw new Error('Comment text cannot be empty');
    return this.toComment(await this.postJson(`${this.pullRequestUrl(ref)}/comments`, {
      text,
      ...(options.blocker ? { severity: 'BLOCKER' } : {}),
      anchor: {
        diffType: 'EFFECTIVE',
        ...(options.hashes ? { fromHash: options.hashes.fromHash, toHash: options.hashes.toHash } : {}),
        path: location.path,
        // Only for renames: a source path that does not exist (e.g. for a new file) breaks the anchor.
        ...(location.srcPath ? { srcPath: location.srcPath } : {}),
        line: location.line, lineType: location.lineType,
        fileType: location.side === 'old' ? 'FROM' : 'TO',
      },
    }));
  }

  public async deleteComment(ref: PullRequestRef, comment: PullRequestComment): Promise<void> {
    await this.request(`${this.pullRequestUrl(ref)}/comments/${comment.id}?version=${comment.version ?? 0}`, { method: 'DELETE' });
  }

  public async getEffectiveDiffHashes(ref: PullRequestRef): Promise<DiffHashes | undefined> {
    const page = await this.json(`${this.pullRequestUrl(ref)}/changes?limit=1`);
    const fromHash = string(page.fromHash);
    const toHash = string(page.toHash);
    return fromHash && toHash ? { fromHash, toHash } : undefined;
  }

  public async hasCommentMarker(ref: PullRequestRef, marker: string): Promise<boolean> {
    if (!marker) return false;
    return this.visitComments(ref, (comment) => !comment.deleted && matchesMarker(comment.text, marker));
  }

  public async getFileContent(ref: RepositoryRef, path: string, at?: string): Promise<string | undefined> {
    requireRef(ref, 'server');
    // Without `at`, Server serves the repository's default branch.
    return this.text(`${this.apiBaseUrl}/projects/${encodePath(ref.projectKey!)}/repos/${encodePath(ref.repositorySlug)}/raw/${encodeFilePath(path)}${at ? `?at=${encodePath(at)}` : ''}`);
  }

  private pullRequestUrl(ref: PullRequestRef): string {
    requireRef(ref, 'server');
    return `${this.apiBaseUrl}/projects/${encodePath(ref.projectKey!)}/repos/${encodePath(ref.repositorySlug)}/pull-requests/${ref.pullRequestId}`;
  }

  private async visitComments(
    ref: PullRequestRef,
    visitor: (comment: PullRequestComment) => boolean,
  ): Promise<boolean> {
    const seen = new Set<number>();
    const visitThread = (item: UnknownRecord): boolean => {
      const comment = this.toComment(item);
      if (!seen.has(comment.id)) {
        seen.add(comment.id);
        if (visitor(comment)) return true;
      }
      return values(item.comments).some((reply) => visitThread(record(reply)));
    };
    let start = 0;
    do {
      // Server's GET /comments requires a file path; PR-wide comments live in activities.
      const page = await this.json(`${this.pullRequestUrl(ref)}/activities?limit=100&start=${start}`);
      for (const value of values(page.values)) {
        const comment = record(record(value).comment);
        if (Object.keys(comment).length && visitThread(comment)) return true;
      }
      if (Boolean(page.isLastPage)) break;
      const next = number(page.nextPageStart);
      if (!Number.isFinite(next) || next <= start) break;
      start = next;
    } while (true);
    return false;
  }

  private toPullRequest(item: UnknownRecord): PullRequest {
    const fromRef = record(item.fromRef);
    const toRef = record(item.toRef);
    const repository = record(toRef.repository);
    const project = record(repository.project);
    const author = record(record(item.author).user);
    const links = record(item.links);
    const self = values(links.self).map(record)[0] ?? {};
    return {
      ref: {
        provider: 'server',
        baseUrl: this.webBaseUrl,
        projectKey: string(project.key),
        repositorySlug: string(repository.slug),
        pullRequestId: number(item.id),
      },
      title: string(item.title),
      state: string(item.state),
      url: string(self.href),
      author: this.toAuthor(author),
      sourceBranch: string(fromRef.displayId) || string(fromRef.id),
      destinationBranch: string(toRef.displayId) || string(toRef.id),
      latestCommitHash: string(fromRef.latestCommit),
      updatedAt: typeof item.updatedDate === 'number' ? new Date(item.updatedDate).toISOString() : undefined,
    };
  }

  private toComment(item: UnknownRecord): PullRequestComment {
    return {
      id: number(item.id),
      text: string(item.text),
      author: Object.keys(record(item.author)).length ? this.toAuthor(record(item.author)) : undefined,
      createdAt: typeof item.createdDate === 'number' ? new Date(item.createdDate).toISOString() : undefined,
      updatedAt: typeof item.updatedDate === 'number' ? new Date(item.updatedDate).toISOString() : undefined,
      deleted: Boolean(item.deleted),
      version: number(item.version),
    };
  }

  private toAuthor(user: UnknownRecord): PullRequestAuthor {
    return {
      id: string(user.slug) || string(user.name) || undefined,
      displayName: string(user.displayName) || string(user.name) || 'Unknown',
    };
  }
}

export function createBitbucketClient(config: BitbucketConfig, fetchImpl?: FetchLike): BitbucketClient {
  return config.provider === 'cloud'
    ? new BitbucketCloudClient(config, fetchImpl)
    : new BitbucketServerClient(config, fetchImpl);
}
