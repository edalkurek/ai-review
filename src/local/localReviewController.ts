import * as path from 'node:path';
import * as vscode from 'vscode';
import { OpenAICompatibleClient, reviewDiffInChunks, AIReviewResult } from '../ai';
import { readFile } from 'node:fs/promises';
import { readContextLines, readMinConfidence } from '../config';
import { parseRemoteUrl } from '../bitbucket/urlParser';
import { collectFileContext, formatFileContext } from '../review/fileContext';
import { InstructionSettings, resolveInstructions } from '../review/instructions';
import { SecretStore } from '../secrets';
import { ReviewDiagnosticsReporter } from '../review/diagnosticsReporter';
import { showReviewResult } from '../review/resultPanel';
import { git, localSnapshot, Snapshot } from './git';
import { uninstallHooks } from './hookInstaller';

interface Repository { rootUri: vscode.Uri }
interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
}
interface GitExtension { getAPI(version: 1): GitAPI }

export class LocalReviewController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private api?: GitAPI;
  private stopped = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: SecretStore,
    private readonly output: vscode.LogOutputChannel,
    private readonly diagnostics?: ReviewDiagnosticsReporter,
    /** Resolves instructions including the shared repository; settings-only when absent. */
    private readonly instructions?: (remoteUrls: readonly string[], settings: InstructionSettings) => Promise<string>,
  ) {}

  public async start(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.start().catch(error => this.report(error)); }));
      return;
    }
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) throw new Error('VS Code Git eklentisi bulunamadı.');
    this.api = (await extension.activate()).getAPI(1);
    this.disposables.push(this.api.onDidOpenRepository(repository => this.cleanRepository(repository)));
    await this.cleanAllRepositories();
  }

  private async cleanRepository(repository: Repository): Promise<void> {
    if (this.stopped) return;
    try {
      const root = await git(repository.rootUri.fsPath, ['rev-parse', '--show-toplevel']);
      const normalized = path.resolve(root.trim());
      await uninstallHooks(normalized);
    } catch {
      // Ignore cleanup error on repositories that cannot be parsed
    }
  }

  private async cleanAllRepositories(): Promise<void> {
    for (const repository of this.api?.repositories ?? []) {
      if (this.stopped) return;
      await this.cleanRepository(repository);
    }
  }

  public async reviewLocal(source?: { rootUri?: vscode.Uri }): Promise<void> {
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Yerel inceleme için çalışma alanına güvenilmelidir.');
      let root = source?.rootUri?.fsPath;
      const repositories = this.api?.repositories ?? [];
      if (!root && repositories.length === 1) root = repositories[0].rootUri.fsPath;
      if (!root) root = (await vscode.window.showQuickPick(repositories.map(repository => ({ label: path.basename(repository.rootUri.fsPath), description: repository.rootUri.fsPath, root: repository.rootUri.fsPath })), { title: 'İncelenecek depoyu seçin' }))?.root;
      if (!root) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Yerel değişiklikler inceleniyor…', cancellable: true }, async (_progress, token) => {
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        try {
          this.diagnostics?.clear();
          const snapshot = await localSnapshot(root);
          const review = await this.review(snapshot, root, controller.signal);
          if (!controller.signal.aborted) {
            showReviewResult(snapshot.title, review, { root });
            this.diagnostics?.reportFindings(root, review.findings);
          }
        } finally { listener.dispose(); }
      });
    } catch (error) { this.report(error); }
  }

  private async review(snapshot: Snapshot, root: string, signal: AbortSignal): Promise<AIReviewResult> {
    signal.throwIfAborted();
    if (!snapshot.diff.trim()) return { summary: 'İncelenecek kod değişikliği yok.', riskLevel: 'low', findings: [], testSuggestions: [], finalComment: 'İşlem kapsamındaki kod dışı veya boş değişiklikleri kontrol edin.' };
    const config = vscode.workspace.getConfiguration('bitbucketAiReview', vscode.Uri.file(root));
    const client = new OpenAICompatibleClient({
      baseUrl: config.get<string>('model.baseUrl', ''), model: config.get<string>('model.name', ''),
      apiKey: await this.secrets.get('modelApiKey') || config.get<string>('model.apiKey', ''), signal,
    });
    
    const settings: InstructionSettings = {
      extraInstructions: config.get<string>('review.extraInstructions', ''),
      repoInstructions: config.get<Record<string, string>>('review.repoInstructions', {}),
    };
    let remoteUrls: string[] = [];
    try {
      // `origin` first: it is the repository the change is meant for.
      remoteUrls = (await git(root, ['remote', '-v'])).split('\n')
        .map((line) => line.split(/\s+/))
        .sort(([left], [right]) => Number(right === 'origin') - Number(left === 'origin'))
        .map(([, url]) => url).filter(Boolean);
    } catch {
      // Without remotes only the general instructions apply.
    }
    const instructions = this.instructions
      ? await this.instructions(remoteUrls, settings)
      : await localInstructions(remoteUrls, settings);

    const fileContext = await collectFileContext(snapshot.diff,
      (file) => readFile(path.join(root, file), 'utf8').catch(() => undefined),
      { contextLines: readContextLines(config) });
    signal.throwIfAborted();

    return reviewDiffInChunks(
      client,
      snapshot.diff,
      { title: snapshot.title, extraInstructions: instructions },
      {
        failOnChunkError: true,
        signal,
        maxChunkChars: 60_000,
        minConfidence: readMinConfidence(config),
        fileContext: (files) => formatFileContext(fileContext, files, 15_000),
      },
    );
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Yerel inceleme başarısız.';
    this.output.error(message);
    void vscode.window.showErrorMessage(`AI Review: ${message}`);
  }

  public dispose(): void {
    this.stopped = true;
    this.disposables.forEach(item => { item.dispose(); });
  }
}

/** Settings-only instructions, matched to the repository by its git remote. */
async function localInstructions(remoteUrls: readonly string[], settings: InstructionSettings): Promise<string> {
  const remote = remoteUrls.map(parseRemoteUrl).find((parsed) => parsed !== undefined);
  return (await resolveInstructions({
    projectKey: remote?.projectKey ?? '',
    repositorySlug: remote?.repositorySlug ?? '',
    settingsKey: remote ? `${remote.host}/${remote.projectKey}/${remote.repositorySlug}`.toLowerCase() : '',
  }, settings)).text;
}
