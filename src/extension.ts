import * as vscode from 'vscode';
import { PullRequest, parsePullRequestUrl } from './bitbucket';
import { ConfigurationError } from './config';
import { AutomaticReviewController } from './review/automaticReview';
import { ReviewCoordinator } from './review/reviewCoordinator';
import { promptAndStoreSecret, SecretStore } from './secrets';
import { openBitbucketSetup } from './setup/bitbucketSetupPanel';
import { ReviewDiagnosticsReporter } from './review/diagnosticsReporter';
import { LocalReviewController } from './local/localReviewController';
import { PRDiffProvider } from './review/diffProvider';

const COMMANDS = {
  listPullRequests: 'bitbucketAiReview.listPullRequests',
  reviewPullRequestUrl: 'bitbucketAiReview.reviewPullRequestUrl',
  configureBitbucketConnection: 'bitbucketAiReview.configureBitbucketConnection',
  configureBitbucketCredentials: 'bitbucketAiReview.configureBitbucketCredentials',
  configureModelApiKey: 'bitbucketAiReview.configureModelApiKey',
  clearStoredCredentials: 'bitbucketAiReview.clearStoredCredentials',
  showAutoReviewMenu: 'bitbucketAiReview.showAutoReviewMenu',
  toggleAutomaticReview: 'bitbucketAiReview.toggleAutomaticReview',
  runAutomaticReviewNow: 'bitbucketAiReview.runAutomaticReviewNow',
  clearDiagnostics: 'bitbucketAiReview.clearDiagnostics',
} as const;

function configureCorporateTls(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureCorporateTls();
  const secrets = new SecretStore(context.secrets);
  const output = vscode.window.createOutputChannel('YKB AI Review', { log: true });
  const diagnostics = new ReviewDiagnosticsReporter();
  const diffProvider = new PRDiffProvider();
  
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PRDiffProvider.scheme, diffProvider)
  );
  
  const coordinator = new ReviewCoordinator(secrets, output, context.globalState, diagnostics, diffProvider);
  const automaticReview = new AutomaticReviewController(coordinator, output);
  const localReview = new LocalReviewController(context, secrets, output, diagnostics);

  context.subscriptions.push(
    output,
    diagnostics,
    automaticReview,
    localReview,
    vscode.commands.registerCommand('bitbucketAiReview.clearDiagnostics', () => diagnostics.clear()),
    vscode.commands.registerCommand('bitbucketAiReview.reviewLocalChanges', (source?: { rootUri?: vscode.Uri }) => localReview.reviewLocal(source)),
    vscode.commands.registerCommand(COMMANDS.showAutoReviewMenu, async () => {
      await automaticReview.showMenu();
    }),
    vscode.commands.registerCommand(COMMANDS.toggleAutomaticReview, async () => {
      await automaticReview.toggleEnabled();
    }),
    vscode.commands.registerCommand(COMMANDS.runAutomaticReviewNow, async () => {
      await automaticReview.runNow(true);
    }),
    vscode.commands.registerCommand(COMMANDS.configureBitbucketConnection, async () => {
      await openBitbucketSetup(secrets, coordinator, output);
    }),
    vscode.commands.registerCommand(COMMANDS.listPullRequests, async () => {
      await runSafely(output, async () => {
        const pullRequests = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Reviewer olduğunuz açık PR’lar alınıyor…',
        }, async () => coordinator.listPullRequests());
        if (pullRequests.length === 0) {
          await vscode.window.showInformationMessage('Reviewer olduğunuz açık pull request bulunamadı.');
          return;
        }
        const selected = await pickPullRequest(pullRequests);
        if (!selected) return;
        const publish = await choosePublication();
        if (publish === undefined) return;
        await runReview(coordinator, selected.ref, selected, publish);
      });
    }),
    vscode.commands.registerCommand(COMMANDS.reviewPullRequestUrl, async () => {
      await runSafely(output, async () => {
        const value = await vscode.window.showInputBox({
          prompt: 'Bitbucket pull request bağlantısını girin',
          placeHolder: 'https://sdlc.yapikredi.com.tr/bitbucket/projects/PROJECT/repos/repo/pull-requests/123',
          ignoreFocusOut: true,
          validateInput: validatePullRequestUrl,
        });
        if (value === undefined) return;
        const ref = parsePullRequestUrl(value);
        if (ref.provider !== 'server') {
          throw new ConfigurationError(
            'Bu eklenti yalnızca Bitbucket Server/Data Center PR bağlantılarını destekler.',
          );
        }
        const publish = await choosePublication();
        if (publish === undefined) return;
        await runReview(coordinator, ref, undefined, publish);
      });
    }),
    vscode.commands.registerCommand(COMMANDS.configureBitbucketCredentials, async () => {
      if (await promptAndStoreSecret(
        secrets,
        'bitbucketToken',
        'Bitbucket access token girin',
        'VS Code güvenli depolamasında saklanır',
      )) {
        await vscode.window.showInformationMessage('Bitbucket kimlik bilgisi güvenle saklandı.');
      }
    }),
    vscode.commands.registerCommand(COMMANDS.configureModelApiKey, async () => {
      if (await promptAndStoreSecret(
        secrets,
        'modelApiKey',
        'Model API anahtarını girin',
        'VS Code güvenli depolamasında saklanır',
      )) {
        await vscode.window.showInformationMessage('Model API anahtarı güvenle saklandı.');
      }
    }),
    vscode.commands.registerCommand(COMMANDS.clearStoredCredentials, async () => {
      const selection = await vscode.window.showWarningMessage(
        'YKB AI Review tarafından saklanan tüm kimlik bilgileri silinsin mi?',
        { modal: true },
        'Sil',
      );
      if (selection === 'Sil') {
        await secrets.clearAll();
        await vscode.window.showInformationMessage('Saklanan kimlik bilgileri silindi.');
      }
    }),
  );

  output.info('Eklenti etkinleştirildi. Gizli değerler hiçbir zaman loglanmaz.');
  await runSafely(output, () => localReview.start());
}

export function deactivate(): void {
  // Resources registered in context.subscriptions are disposed by VS Code.
}

async function pickPullRequest(pullRequests: PullRequest[]): Promise<PullRequest | undefined> {
  const items = pullRequests.map((pullRequest) => ({
    label: `#${pullRequest.ref.pullRequestId} ${pullRequest.title}`,
    description: `${pullRequest.sourceBranch} → ${pullRequest.destinationBranch}`,
    detail: `${pullRequest.author.displayName} · ${pullRequest.latestCommitHash.slice(0, 12)}`,
    pullRequest,
  }));
  return (await vscode.window.showQuickPick(items, {
    title: 'İncelenecek pull request’i seçin',
    matchOnDescription: true,
    matchOnDetail: true,
  }))?.pullRequest;
}

async function choosePublication(): Promise<boolean | undefined> {
  const selection = await vscode.window.showQuickPick([
    { label: 'Yalnızca VS Code’da göster', value: false },
    { label: 'Bitbucket’a yorum yaz', value: true },
  ], { title: 'Review sonucu nasıl işlensin?' });
  return selection?.value;
}

async function runReview(
  coordinator: ReviewCoordinator,
  ref: PullRequest['ref'],
  pullRequest: PullRequest | undefined,
  publish: boolean,
): Promise<void> {
  const outcome = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `PR #${ref.pullRequestId} AI tarafından inceleniyor…`,
    cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => controller.abort());
    try {
      return await coordinator.review(ref, {
        pullRequest,
        publish,
        showResult: !publish,
        signal: controller.signal,
      });
    } finally {
      listener.dispose();
    }
  });
  if (outcome.skippedDuplicate) {
    await vscode.window.showInformationMessage('Bu commit/model için yorum zaten mevcut; tekrar yayınlanmadı.');
  } else if (outcome.published) {
    await vscode.window.showInformationMessage('AI review tamamlandı ve Bitbucket yorumuna yazıldı.');
  } else {
    await vscode.window.showInformationMessage('AI review tamamlandı.');
  }
}

function validatePullRequestUrl(value: string): string | undefined {
  try {
    parsePullRequestUrl(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Geçerli bir Bitbucket PR bağlantısı girin.';
  }
}

async function runSafely(
  output: vscode.LogOutputChannel,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Beklenmeyen bir hata oluştu.';
    output.error(message);
    const actions: string[] = [];
    if (error instanceof ConfigurationError) {
      if (/bitbucket/i.test(message)) actions.push('Bitbucket Bağlantısını Yapılandır');
      actions.push('Ayarları Aç');
    }
    const selection = await vscode.window.showErrorMessage(
      message,
      ...actions,
    );
    if (selection === 'Bitbucket Bağlantısını Yapılandır') {
      await vscode.commands.executeCommand(COMMANDS.configureBitbucketConnection);
    } else if (selection === 'Ayarları Aç') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:ykb.bitbucket-ai-review',
      );
    }
  }
}
