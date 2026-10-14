import * as vscode from 'vscode';
import { getExtensionConfig, onConfigurationChanged } from '../config';
import { ReviewCoordinator } from './reviewCoordinator';
import { SerialTaskGate } from './serialTaskGate';

export class AutomaticReviewController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly gate = new SerialTaskGate();
  private readonly configurationSubscription: vscode.Disposable;
  private readonly statusBarItem: vscode.StatusBarItem;
  private isRunning = false;
  private lastRunTime: Date | undefined;
  private lastRunSummary: string | undefined;

  public constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'bitbucketAiReview.statusBar',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = 'YKB Auto PR Review';
    this.statusBarItem.command = 'bitbucketAiReview.showAutoReviewMenu';

    this.configurationSubscription = onConfigurationChanged(
      () => this.restart(),
      'automaticReview',
    );
    this.restart();
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    this.configurationSubscription.dispose();
    if (this.timer) clearInterval(this.timer);
  }

  public updateStatusBar(): void {
    const config = vscode.workspace.getConfiguration('bitbucketAiReview.automaticReview');
    const enabled = config.get<boolean>('enabled', false);
    const intervalMinutes = config.get<number>('intervalMinutes', 5);

    if (this.isRunning) {
      this.statusBarItem.text = '$(sync~spin) Auto PR Review';
    } else if (enabled) {
      this.statusBarItem.text = '$(robot) Auto PR Review';
    } else {
      this.statusBarItem.text = '$(circle-slash) Auto PR Review';
    }

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown('### $(robot) YKB Auto PR Review\n\n');

    if (this.isRunning) {
      md.appendMarkdown('**Durum:** Açık PR’lar taranıyor ve inceleniyor…\n\n');
    } else if (enabled) {
      md.appendMarkdown('**Durum:** $(robot) Etkin (Açık)\n\n');
      md.appendMarkdown(`- **Kontrol Aralığı:** Her ${intervalMinutes} dakikada bir\n`);
    } else {
      md.appendMarkdown('**Durum:** $(circle-slash) Devre Dışı (Kapalı)\n\n');
      md.appendMarkdown(`- **Kontrol Aralığı:** ${intervalMinutes} dakika\n`);
    }

    if (this.lastRunTime) {
      const timeStr = this.lastRunTime.toLocaleTimeString();
      md.appendMarkdown(`- **Son Kontrol:** ${timeStr}`);
      if (this.lastRunSummary) {
        md.appendMarkdown(` (${this.lastRunSummary})`);
      }
      md.appendMarkdown('\n');
    }

    md.appendMarkdown('\n---\n');
    md.appendMarkdown('[Aç/Kapat](command:bitbucketAiReview.toggleAutomaticReview) · [Şimdi Kontrol Et](command:bitbucketAiReview.runAutomaticReviewNow) · [Ayarlar](command:bitbucketAiReview.configureBitbucketConnection)\n\n');
    md.appendMarkdown('*Menüyü açmak veya yönetmek için tıklayın.*');

    this.statusBarItem.tooltip = md;
    this.statusBarItem.show();
  }

  private restart(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.updateStatusBar();

    const enabled = vscode.workspace
      .getConfiguration('bitbucketAiReview.automaticReview')
      .get<boolean>('enabled', false);
    if (!enabled) return;

    let config;
    try {
      config = getExtensionConfig();
    } catch (error) {
      this.output.error(`Otomatik review ayarı okunamadı: ${safeMessage(error)}`);
      return;
    }

    const poll = (): void => { void this.runNow(false); };
    this.timer = setInterval(poll, config.automaticReview.intervalMinutes * 60_000);
    poll();
    this.output.info(`Otomatik review ${config.automaticReview.intervalMinutes} dakikalık aralıkla etkin.`);
  }

  public async toggleEnabled(): Promise<void> {
    const config = vscode.workspace.getConfiguration('bitbucketAiReview');
    const autoReviewConfig = vscode.workspace.getConfiguration('bitbucketAiReview.automaticReview');
    const currentlyEnabled = autoReviewConfig.get<boolean>('enabled', false);
    const newEnabled = !currentlyEnabled;

    if (newEnabled) {
      const baseUrl = config.get<string>('bitbucket.baseUrl', '').trim();
      if (!baseUrl) {
        const choice = await vscode.window.showWarningMessage(
          'Auto PR Review’u etkinleştirmeden önce Bitbucket bağlantı ayarlarını yapılandırmalısınız.',
          'Ayarları Aç',
        );
        if (choice === 'Ayarları Aç') {
          await vscode.commands.executeCommand('bitbucketAiReview.configureBitbucketConnection');
        }
        return;
      }
    }

    await autoReviewConfig.update('enabled', newEnabled, vscode.ConfigurationTarget.Global);

    if (newEnabled) {
      const interval = autoReviewConfig.get<number>('intervalMinutes', 5);
      void vscode.window.showInformationMessage(
        `Auto PR Review etkinleştirildi. (${interval} dakikada bir otomatik kontrol edilecek)`,
      );
    } else {
      void vscode.window.showInformationMessage('Auto PR Review devre dışı bırakıldı.');
    }
  }

  public async showMenu(): Promise<void> {
    const config = vscode.workspace.getConfiguration('bitbucketAiReview.automaticReview');
    const enabled = config.get<boolean>('enabled', false);
    const interval = config.get<number>('intervalMinutes', 5);

    interface MenuItem extends vscode.QuickPickItem {
      action: () => Promise<void>;
    }

    const items: MenuItem[] = [
      {
        label: enabled ? '$(circle-slash) Auto PR Review’u Devre Dışı Bırak' : '$(play) Auto PR Review’u Etkinleştir',
        description: enabled ? 'Otomatik inceleme zamanlayıcısını durdur' : `Her ${interval} dakikada bir otomatik incele`,
        detail: enabled ? 'Mevcut durum: Etkin (Açık)' : 'Mevcut durum: Devre Dışı (Kapalı)',
        action: async (): Promise<void> => { await this.toggleEnabled(); },
      },
      {
        label: '$(refresh) Şimdi PR’ları Tara ve İncele',
        description: 'Zamanlayıcıyı beklemeden hemen çalıştır',
        detail: 'Reviewer olduğunuz açık PR’ları bulur ve yeni commit varsa AI incelemesi yapar',
        action: async (): Promise<void> => { await this.runNow(true); },
      },
      {
        label: '$(list-unordered) Açık PR’larımı Listele',
        description: 'Reviewer olduğunuz açık PR’ları manuel listeleyip inceleyin',
        action: async (): Promise<void> => {
          await vscode.commands.executeCommand('bitbucketAiReview.listPullRequests');
        },
      },
      {
        label: '$(gear) Bağlantı & Model Ayarlarını Yapılandır',
        description: 'Bitbucket URL, Access Token ve AI model ayar ekranını aç',
        action: async (): Promise<void> => {
          await vscode.commands.executeCommand('bitbucketAiReview.configureBitbucketConnection');
        },
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Auto PR Review',
      placeHolder: `Durum: ${enabled ? 'Etkin (Açık)' : 'Devre Dışı (Kapalı)'} · Kontrol Aralığı: ${interval} dk`,
    });

    if (selected) {
      await selected.action();
    }
  }

  public async runNow(manual = false): Promise<void> {
    const execute = async (
      progress?: vscode.Progress<{ message?: string }>,
      signal?: AbortSignal,
    ): Promise<void> => {
      this.isRunning = true;
      this.updateStatusBar();

      try {
        const summary = await this.processPullRequests(manual, progress, signal);
        this.lastRunTime = new Date();
        this.lastRunSummary = summary;
        if (manual) {
          void vscode.window.showInformationMessage(`Auto PR Review: ${summary}`);
        }
      } finally {
        this.isRunning = false;
        this.updateStatusBar();
      }
    };

    const started = await this.gate.tryRun(async () => {
      if (manual) {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Auto PR Review çalıştırılıyor…',
          cancellable: true,
        }, async (progress, token) => {
          const controller = new AbortController();
          const listener = token.onCancellationRequested(() => controller.abort());
          try {
            await execute(progress, controller.signal);
          } finally {
            listener.dispose();
          }
        });
      } else {
        await execute();
      }
    });

    if (!started) {
      const msg = 'Önceki review turu devam ettiği için işlem başlatılamadı.';
      this.output.warn(msg);
      if (manual) {
        void vscode.window.showWarningMessage(msg);
      }
    }
  }

  private async processPullRequests(
    manual: boolean,
    progress?: vscode.Progress<{ message?: string }>,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      signal?.throwIfAborted();
      const config = getExtensionConfig();
      if (!manual && !config.automaticReview.enabled) {
        return 'Otomatik review kapalı';
      }

      const pullRequests = await this.coordinator.listPullRequests();
      if (pullRequests.length === 0) {
        this.output.info('Reviewer olduğunuz açık pull request bulunamadı.');
        return 'Açık PR bulunamadı';
      }

      let reviewed = 0;
      let skipped = 0;
      let errors = 0;

      for (let i = 0; i < pullRequests.length; i++) {
        if (signal?.aborted) {
          return 'İşlem kullanıcı tarafından iptal edildi';
        }
        const pr = pullRequests[i];
        progress?.report({
          message: `PR #${pr.ref.pullRequestId} inceleniyor (${i + 1}/${pullRequests.length})…`,
        });

        try {
          if (await this.coordinator.hasReviewFor(pr)) {
            this.output.info(`PR #${pr.ref.pullRequestId}: commit daha önce incelenmiş, atlandı.`);
            skipped += 1;
            continue;
          }
          await this.coordinator.review(pr.ref, { pullRequest: pr, publish: true, showResult: false, signal });
          this.output.info(`PR #${pr.ref.pullRequestId}: otomatik review yayınlandı.`);
          reviewed += 1;
        } catch (error) {
          errors += 1;
          this.output.error(`PR #${pr.ref.pullRequestId} otomatik review hatası: ${safeMessage(error)}`);
        }
      }

      const parts: string[] = [];
      if (reviewed > 0) parts.push(`${reviewed} PR incelendi`);
      if (skipped > 0) parts.push(`${skipped} atlandı`);
      if (errors > 0) parts.push(`${errors} hata`);
      return parts.length > 0 ? parts.join(', ') : 'İncelenecek yeni PR bulunamadı';
    } catch (error) {
      const msg = safeMessage(error);
      this.output.error(`Otomatik review turu başarısız: ${msg}`);
      return `Hata: ${msg}`;
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Bilinmeyen hata';
}
