import * as vscode from 'vscode';
import { OpenAICompatibleClient, reviewDiffInChunks, AIReviewResult } from '../ai';
import { BitbucketAuth, BitbucketClient, PullRequest, PullRequestRef, Repository, createBitbucketClient } from '../bitbucket';
import { ConfigurationError, ExtensionConfig, getExtensionConfig, getRepoInstructionsFor } from '../config';
import { SecretStore } from '../secrets';
import { createReviewCommentMarker } from './commentFormatter';
import { showReviewResult } from './resultPanel';
import { publishReview } from './publishReview';

import { ReviewDiagnosticsReporter } from './diagnosticsReporter';
import { PRDiffProvider } from './diffProvider';

export interface ReviewOutcome {
  review?: AIReviewResult;
  published: boolean;
  skippedDuplicate: boolean;
}

export interface ReviewCoordinatorOptions {
  pullRequest?: PullRequest;
  publish: boolean;
  showResult: boolean;
  signal?: AbortSignal;
}

export class ReviewCoordinator {
  public constructor(
    private readonly secrets: SecretStore,
    private readonly output: vscode.LogOutputChannel,
    private readonly state: vscode.Memento,
    private readonly diagnostics?: ReviewDiagnosticsReporter,
    private readonly diffProvider?: PRDiffProvider,
  ) {}

  public async listPullRequests(): Promise<PullRequest[]> {
    const { bitbucket } = await this.createBitbucket();
    return bitbucket.listOpenPullRequestsForReviewer();
  }

  public async listRepositories(): Promise<Repository[]> {
    const { bitbucket } = await this.createBitbucket();
    return bitbucket.listRepositories();
  }

  public async hasReviewFor(pullRequest: PullRequest): Promise<boolean> {
    const { bitbucket, config } = await this.createBitbucket();
    const marker = createReviewCommentMarker({
      prId: pullRequest.ref.pullRequestId,
      commitHash: pullRequest.latestCommitHash,
      modelName: requireModelName(config),
    });
    return this.state.get<boolean>(this.reviewKey(pullRequest.ref, marker), false)
      || bitbucket.hasCommentMarker(pullRequest.ref, marker);
  }

  public async review(
    ref: PullRequestRef,
    options: ReviewCoordinatorOptions,
  ): Promise<ReviewOutcome> {
    options.signal?.throwIfAborted();
    this.diagnostics?.clear();

    const { bitbucket, model, config } = await this.createClients(options.signal);
    const commitHash = options.pullRequest?.latestCommitHash
      || await bitbucket.getLatestCommitHash(ref);
    if (!commitHash) {
      throw new Error('Pull request son commit bilgisi alınamadı.');
    }
    const marker = createReviewCommentMarker({
      prId: ref.pullRequestId,
      commitHash,
      modelName: requireModelName(config),
    });

    options.signal?.throwIfAborted();
    const diff = await bitbucket.getPullRequestDiff(ref);
    if (!diff.trim()) {
      throw new Error('Pull request diff içeriği boş.');
    }
    const pr = options.pullRequest;
    
    let instructions = config.review.extraInstructions;
    const repoInstructions = getRepoInstructionsFor(config, ref);
    if (repoInstructions) {
      instructions = instructions ? `${instructions}\n\nRepo özel talimatları:\n${repoInstructions}` : repoInstructions;
    }

    const review = await reviewDiffInChunks(model, diff, {
      title: pr?.title,
      sourceBranch: pr?.sourceBranch,
      targetBranch: pr?.destinationBranch,
      extraInstructions: instructions,
    }, {
      maxChunkChars: config.review.maxDiffCharacters,
      signal: options.signal,
      onChunkError: (error, index, total) => {
        this.output.error(`AI review parçası ${index + 1}/${total} başarısız: ${safeMessage(error)}`);
      },
    });

    options.signal?.throwIfAborted();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      this.diagnostics?.reportFindings(workspaceRoot, review.findings);
    }

    if (options.showResult) {
      if (this.diffProvider) {
        const diffId = `PR-${ref.pullRequestId}.diff`;
        this.diffProvider.setDiff(diffId, diff);
        const diffUri = vscode.Uri.parse(`${PRDiffProvider.scheme}:/${diffId}`);
        const doc = await vscode.workspace.openTextDocument(diffUri);
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
      }
      showReviewResult(pr?.title ?? `PR #${ref.pullRequestId}`, review);
    }
    if (options.publish && (this.state.get<boolean>(this.reviewKey(ref, marker), false)
      || await bitbucket.hasCommentMarker(ref, marker))) {
      this.output.info(`PR #${ref.pullRequestId}: aynı commit/model için yorum zaten mevcut.`);
      return { review, published: false, skippedDuplicate: true };
    }
    if (options.publish) {
      if (await bitbucket.getLatestCommitHash(ref) !== commitHash) {
        throw new Error('PR inceleme sırasında değişti. Güncel commit için yeniden inceleme başlatın.');
      }
      const publication = await publishReview(bitbucket, ref, review, diff, this.reviewKey(ref, marker), this.state, (finding) => {
        const reason = finding.line === undefined
          ? 'Model geçerli satır konumu döndürmedi.'
          : finding.side === undefined
            ? 'Taraf bilgisi eksik; konum diff üzerinde tek bir satırla eşleştirilemedi.'
            : 'Dosya, satır ve taraf bilgisi diff üzerinde bulunamadı.';
        this.output.warn(`PR #${ref.pullRequestId}: satır yorumu genel yoruma alındı (${JSON.stringify({ file: finding.file, line: finding.line, side: finding.side })}). ${reason}`);
      });
      this.output.info(`PR #${ref.pullRequestId}: ${publication.inlineComments} satır yorumu ve 1 genel yorum yayımlandı.`);
      if (publication.generalOnlyFindings > 0) {
        this.output.warn(`PR #${ref.pullRequestId}: ${publication.generalOnlyFindings} bulgu için diff üzerinde kesin satır konumu bulunamadı; bu bulgular genel yorumda yer alıyor.`);
      }
    }
    if (options.publish) {
      await this.state.update(this.reviewKey(ref, marker), true);
    }
    return { review, published: options.publish, skippedDuplicate: false };
  }

  private reviewKey(ref: PullRequestRef, marker: string): string {
    return `publishedReview:${JSON.stringify([ref.provider, ref.baseUrl, ref.projectKey,
      ref.workspace, ref.repositorySlug, ref.pullRequestId, marker])}`;
  }

  private async createClients(signal?: AbortSignal): Promise<{
    bitbucket: BitbucketClient;
    model: OpenAICompatibleClient;
    config: ExtensionConfig;
  }> {
    const { bitbucket, config } = await this.createBitbucket();
    const apiKey = (await this.secrets.get('modelApiKey')) || config.model.apiKey;
    const model = new OpenAICompatibleClient({
      baseUrl: config.model.baseUrl,
      model: requireModelName(config),
      apiKey,
      signal,
    });
    return { bitbucket, model, config };
  }

  private async createBitbucket(): Promise<{
    bitbucket: BitbucketClient;
    config: ExtensionConfig;
  }> {
    const config = getExtensionConfig();
    const token = (await this.secrets.get('bitbucketToken')) || config.bitbucket.token;
    if (!token) {
      throw new ConfigurationError('Bitbucket kimlik bilgisi ayarlanmamış.');
    }
    const auth: BitbucketAuth = { method: 'bearer', token };
    const bitbucket = createBitbucketClient({
      provider: 'server',
      auth,
      baseUrl: config.bitbucket.baseUrl,
    });
    return { bitbucket, config };
  }
}

function requireModelName(config: ExtensionConfig): string {
  if (!config.model.name) {
    throw new ConfigurationError('Yerel model adı ayarlanmamış.');
  }
  return config.model.name;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Bilinmeyen hata';
}
