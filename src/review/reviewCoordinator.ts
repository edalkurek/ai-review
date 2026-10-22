import * as vscode from 'vscode';
import { OpenAICompatibleClient, reviewDiffInChunks, AIReviewResult, ReviewFinding, RiskLevel, RISK_LEVELS } from '../ai';
import { BitbucketAuth, BitbucketClient, PullRequest, PullRequestRef, Repository, createBitbucketClient, parseRemoteUrl } from '../bitbucket';
import { ConfigurationError, ExtensionConfig, getExtensionConfig, getRepoKey } from '../config';
import { SecretStore } from '../secrets';
import { createReviewCommentMarker, reviewCommentKey } from './commentFormatter';
import { showReviewResult } from './resultPanel';
import { publishReview } from './publishReview';

import { ReviewDiagnosticsReporter } from './diagnosticsReporter';
import { PRDiffProvider } from './diffProvider';
import { collectFileContext, formatFileContext } from './fileContext';
import { InstructionSettings, InstructionTarget, SharedInstructionsCache, resolveInstructions } from './instructions';

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
  private readonly sharedInstructions = new SharedInstructionsCache();

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
    const { bitbucket } = await this.createBitbucket();
    // Any model, IDE or teammate counts: one review per commit for the whole team.
    const key = reviewCommentKey(pullRequest.ref.pullRequestId, pullRequest.latestCommitHash);
    return this.state.get<boolean>(this.reviewKey(pullRequest.ref, key), false)
      || bitbucket.hasCommentMarker(pullRequest.ref, key);
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
    const key = reviewCommentKey(ref.pullRequestId, commitHash);

    options.signal?.throwIfAborted();
    const diff = await bitbucket.getPullRequestDiff(ref);
    if (!diff.trim()) {
      throw new Error('Pull request diff içeriği boş.');
    }
    const pr = options.pullRequest;
    
    const instructions = await this.loadInstructions(bitbucket, config, {
      projectKey: ref.projectKey ?? ref.workspace ?? '',
      repositorySlug: ref.repositorySlug,
      settingsKey: getRepoKey(ref),
    }, config.review, `PR #${ref.pullRequestId}`);
    options.signal?.throwIfAborted();

    const fileContext = await collectFileContext(diff, (file) => bitbucket.getFileContent(ref, file, commitHash),
      { contextLines: config.review.contextLines });
    options.signal?.throwIfAborted();

    const review = await reviewDiffInChunks(model, diff, {
      title: pr?.title,
      sourceBranch: pr?.sourceBranch,
      targetBranch: pr?.destinationBranch,
      extraInstructions: instructions,
    }, {
      maxChunkChars: config.review.maxDiffCharacters,
      minConfidence: config.review.minConfidence,
      fileContext: (files) => formatFileContext(fileContext, files, Math.floor(config.review.maxDiffCharacters / 4)),
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

    const publishFindings = async (findings: readonly ReviewFinding[]): Promise<'published' | 'duplicate'> => {
      if (this.state.get<boolean>(this.reviewKey(ref, key), false) || await bitbucket.hasCommentMarker(ref, key)) {
        this.output.info(`PR #${ref.pullRequestId}: bu commit için yorum zaten mevcut.`);
        return 'duplicate';
      }
      if (await bitbucket.getLatestCommitHash(ref) !== commitHash) {
        throw new Error('PR inceleme sırasında değişti. Güncel commit için yeniden inceleme başlatın.');
      }
      const existingComments = (await bitbucket.listPullRequestComments(ref))
        .filter((comment) => !comment.deleted).map((comment) => comment.text);
      // Risk follows the published findings; the prompt defines it as their highest severity.
      const riskLevel = findings.reduce<RiskLevel>((highest, finding) =>
        RISK_LEVELS.indexOf(finding.severity) > RISK_LEVELS.indexOf(highest) ? finding.severity : highest, 'low');
      const selected = findings.length === review.findings.length ? review : { ...review, findings: [...findings], riskLevel };
      const publication = await publishReview(bitbucket, ref, selected, diff, this.reviewKey(ref, key), this.state, (finding) => {
        const reason = finding.line === undefined
          ? 'Model geçerli satır konumu döndürmedi.'
          : finding.side === undefined
            ? 'Taraf bilgisi eksik; konum diff üzerinde tek bir satırla eşleştirilemedi.'
            : 'Dosya, satır ve taraf bilgisi diff üzerinde bulunamadı.';
        this.output.warn(`PR #${ref.pullRequestId}: satır yorumu genel yoruma alındı (${JSON.stringify({ file: finding.file, line: finding.line, side: finding.side })}). ${reason}`);
      }, { highSeverityAsTask: config.publish.highSeverityAsTask, existingComments, reviewMarker: marker, reviewKey: key });
      if (publication.supersededBy !== undefined) {
        await this.state.update(this.reviewKey(ref, key), true);
        this.output.info(`PR #${ref.pullRequestId}: bir ekip arkadaşının aynı commit için incelemesi daha önce yayımlandı (yorum #${publication.supersededBy}); bu incelemenin yorumları geri alındı.`);
        return 'duplicate';
      }
      this.output.info(`PR #${ref.pullRequestId}: ${publication.inlineComments} satır yorumu ve 1 genel yorum yayımlandı.`);
      if (publication.generalOnlyFindings > 0) {
        this.output.warn(`PR #${ref.pullRequestId}: ${publication.generalOnlyFindings} bulgu için diff üzerinde kesin satır konumu bulunamadı; bu bulgular genel yorumda yer alıyor.`);
      }
      if (publication.skippedExisting > 0) {
        this.output.info(`PR #${ref.pullRequestId}: ${publication.skippedExisting} bulgu önceki bir incelemede zaten satır yorumu olarak eklendiği için tekrar yazılmadı.`);
      }
      await this.state.update(this.reviewKey(ref, key), true);
      return 'published';
    };

    if (options.showResult) {
      if (this.diffProvider) {
        const diffId = `PR-${ref.pullRequestId}.diff`;
        this.diffProvider.setDiff(diffId, diff);
        const diffUri = vscode.Uri.parse(`${PRDiffProvider.scheme}:/${diffId}`);
        const doc = await vscode.workspace.openTextDocument(diffUri);
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
      }
      showReviewResult(pr?.title ?? `PR #${ref.pullRequestId}`, review, {
        root: workspaceRoot,
        // Reviewing without publishing lets the user pick which findings reach the pull request.
        onPublish: options.publish ? undefined : async (findings): Promise<string> => await publishFindings(findings) === 'duplicate'
          ? 'Bu commit için yorum zaten mevcut; tekrar yayınlanmadı.'
          : `${findings.length} bulgu Bitbucket'a gönderildi.`,
      });
    }
    if (!options.publish) {
      return { review, published: false, skippedDuplicate: false };
    }
    const outcome = await publishFindings(review.findings);
    return { review, published: outcome === 'published', skippedDuplicate: outcome === 'duplicate' };
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

/**
   * Instructions for a local repository, identified by its git remotes. The shared repository is read
   * only when Bitbucket is configured; otherwise the given settings alone are used.
   */
  public async instructionsForRemotes(remoteUrls: readonly string[], settings: InstructionSettings): Promise<string> {
    let clients: { bitbucket: BitbucketClient; config: ExtensionConfig } | undefined;
    try {
      clients = await this.createBitbucket();
    } catch (error) {
      this.output.warn(`Yerel inceleme: ortak talimatlar okunamadı, yalnızca ayarlardaki talimatlar kullanılıyor (${safeMessage(error)}).`);
    }
    const remote = remoteUrls.map(parseRemoteUrl).find((parsed) => parsed !== undefined);
    if (!remote) {
      return (await resolveInstructions({ projectKey: '', repositorySlug: '', settingsKey: '' }, settings)).text;
    }
    // Settings keys use the configured server's host (with port); SSH remotes report the bare hostname.
    const serverHost = clients ? new URL(clients.config.bitbucket.baseUrl) : undefined;
    const host = serverHost && serverHost.hostname.toLowerCase() === remote.host ? serverHost.host : remote.host;
    const target: InstructionTarget = {
      projectKey: remote.projectKey,
      repositorySlug: remote.repositorySlug,
      settingsKey: `${host}/${remote.projectKey}/${remote.repositorySlug}`.toLowerCase(),
    };
    return this.loadInstructions(clients?.bitbucket, clients?.config, target, settings, 'Yerel inceleme');
  }

  private async loadInstructions(
    bitbucket: BitbucketClient | undefined,
    config: ExtensionConfig | undefined,
    target: InstructionTarget,
    settings: InstructionSettings,
    label: string,
  ): Promise<string> {
    const shared = config?.review.sharedInstructions;
    const reader = bitbucket && shared
      ? this.sharedInstructions.reader(
        JSON.stringify([shared.repository.projectKey, shared.repository.repositorySlug, shared.branch]),
        (path) => bitbucket.getFileContent(shared.repository, path, shared.branch ? `refs/heads/${shared.branch}` : undefined),
      )
      : undefined;
    const resolved = await resolveInstructions(target, settings, reader);
    if (resolved.failed.length) {
      this.output.warn(`${label}: ortak talimat dosyaları okunamadı (${resolved.failed.join(', ')}); inceleme bunlar olmadan sürüyor.`);
    }
    if (resolved.sources.length) this.output.info(`${label}: talimatlar → ${resolved.sources.join(', ')}`);
    if (resolved.truncated) {
      this.output.warn(`${label}: talimatlar uzunluk sınırını aştı; en genel bölümler çıkarıldı.`);
    }
    return resolved.text;
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
