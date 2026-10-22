export type BitbucketProvider = 'cloud' | 'server';

export interface BitbucketAuth {
  method: 'bearer';
  /** Access token supplied by the caller (normally from VS Code SecretStorage). */
  token: string;
}

export interface BitbucketCloudConfig {
  provider: 'cloud';
  auth: BitbucketAuth;
  /** Workspace whose assigned pull requests should be queried (recommended for current Cloud API). */
  workspace?: string;
  /** UUID (preferred), username, or nickname accepted by Bitbucket's selected_user route. */
  reviewer: string;
  apiBaseUrl?: string;
}

export interface BitbucketServerConfig {
  provider: 'server';
  auth: BitbucketAuth;
  /** Server/context root or REST root, e.g. https://example.com/bitbucket/rest/api/1.0. */
  baseUrl: string;
  /** Override only when the instance exposes the REST API at a non-standard path. */
  apiPath?: string;
}

export type BitbucketConfig = BitbucketCloudConfig | BitbucketServerConfig;

export interface RepositoryRef {
  provider: BitbucketProvider;
  baseUrl: string;
  repositorySlug: string;
  workspace?: string;
  projectKey?: string;
}

export interface PullRequestRef extends RepositoryRef {
  pullRequestId: number;
}

export interface PullRequestAuthor {
  id?: string;
  displayName: string;
}

export interface Repository {
  provider: BitbucketProvider;
  baseUrl: string;
  projectKey?: string;
  workspace?: string;
  slug: string;
  name: string;
}

export interface PullRequest {
  ref: PullRequestRef;
  title: string;
  state: string;
  url: string;
  author: PullRequestAuthor;
  sourceBranch: string;
  destinationBranch: string;
  latestCommitHash: string;
  updatedAt?: string;
}

export interface PullRequestComment {
  id: number;
  text: string;
  author?: PullRequestAuthor;
  createdAt?: string;
  updatedAt?: string;
  deleted?: boolean;
}

export interface InlineCommentLocation {
  path: string;
  srcPath?: string;
  line: number;
  side: 'old' | 'new';
  lineType: 'ADDED' | 'REMOVED' | 'CONTEXT';
  /** The line's code (without the diff marker); used locally, never sent to Bitbucket. */
  content?: string;
}

/** Commits of the pull request's effective diff; Bitbucket Server anchors line comments to this diff. */
export interface DiffHashes {
  fromHash: string;
  toHash: string;
}

export interface InlineCommentOptions {
  blocker?: boolean;
  /** Without them Bitbucket Server may not find the line and attach the comment to the file instead. */
  hashes?: DiffHashes;
}

export interface BitbucketClient {
  listRepositories(): Promise<Repository[]>;
  listOpenPullRequestsForReviewer(): Promise<PullRequest[]>;
  getPullRequestDiff(ref: PullRequestRef): Promise<string>;
  getLatestCommitHash(ref: PullRequestRef): Promise<string>;
  /** File text at a commit or ref (default branch when omitted); undefined when the file does not exist there. */
  getFileContent(ref: RepositoryRef, path: string, at?: string): Promise<string | undefined>;
  listPullRequestComments(ref: PullRequestRef): Promise<PullRequestComment[]>;
  addGeneralComment(ref: PullRequestRef, text: string): Promise<PullRequestComment>;
  /** `blocker` opens the comment as a task that must be resolved (Bitbucket Server only). */
  addInlineComment(ref: PullRequestRef, text: string, location: InlineCommentLocation, options?: InlineCommentOptions): Promise<PullRequestComment>;
  /** Bitbucket Server only; undefined when the hashes are unavailable. */
  getEffectiveDiffHashes?(ref: PullRequestRef): Promise<DiffHashes | undefined>;
  hasCommentMarker(ref: PullRequestRef, marker: string): Promise<boolean>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class BitbucketHttpError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly serverMessage?: string;

  public constructor(status: number, statusText: string, url: string, serverMessage?: string) {
    const safeUrl = sanitizeErrorUrl(url);
    const detail = serverMessage ? ` [${serverMessage}]` : '';
    super(`Bitbucket request failed (${status}${statusText ? ` ${statusText}` : ''})${detail}: ${safeUrl}`);
    this.name = 'BitbucketHttpError';
    this.status = status;
    this.url = safeUrl;
    this.serverMessage = serverMessage;
  }
}

function sanitizeErrorUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}
