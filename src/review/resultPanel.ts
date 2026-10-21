import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AIReviewResult, ReviewFinding, RiskLevel } from '../ai';
import { normalizeDiffPath } from '../util/diffLocations';
import { FINDING_LABELS, RISK_LABELS } from './commentFormatter';

export interface ReviewResultOptions {
  /** Folder that finding paths are relative to; defaults to the first workspace folder. */
  root?: string;
  /** Offered as "send selected" when set; resolves to a status line shown in the panel. */
  onPublish?: (findings: ReviewFinding[]) => Promise<string>;
}

const SEVERITY_ORDER: readonly RiskLevel[] = ['high', 'medium', 'low'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function locationLabel(finding: ReviewFinding): string {
  const file = normalizeDiffPath(finding.file);
  if (finding.line === undefined) return file;
  return finding.side === 'old' ? `${file}:${finding.line} (silinen satır)` : `${file}:${finding.line}`;
}

function findingHtml(finding: ReviewFinding, index: number, selectable: boolean): string {
  return `<li class="finding ${finding.severity}">
    <div class="head">
      ${selectable ? `<input type="checkbox" class="pick" data-index="${index}" checked aria-label="Bitbucket'a gönder">` : ''}
      <span class="badge ${finding.severity}">${escapeHtml(RISK_LABELS[finding.severity])}</span>
      <span class="type">${escapeHtml(FINDING_LABELS[finding.type])}</span>
      <a href="#" class="open" data-index="${index}"><code>${escapeHtml(locationLabel(finding))}</code></a>
    </div>
    <p>${escapeHtml(finding.message)}</p>
    <p class="suggestion"><strong>Öneri:</strong> ${escapeHtml(finding.suggestion)}</p>
  </li>`;
}

export function showReviewResult(title: string, review: AIReviewResult, options: ReviewResultOptions = {}): void {
  const panel = vscode.window.createWebviewPanel(
    'bitbucketAiReview.result',
    `AI Review: ${title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  const nonce = randomBytes(16).toString('base64');
  panel.webview.html = renderReviewHtml(title, review, nonce, Boolean(options.onPublish));

  const finding = (value: unknown): ReviewFinding | undefined =>
    Number.isInteger(value) ? review.findings[value as number] : undefined;
  let publishing = false;
  panel.webview.onDidReceiveMessage(async (message: { command?: string; index?: unknown; indexes?: unknown }) => {
    if (message.command === 'open') {
      const target = finding(message.index);
      if (target) await openFinding(target, options.root);
    } else if (message.command === 'publish' && options.onPublish && !publishing && Array.isArray(message.indexes)) {
      const selected = [...new Set(message.indexes)].map(finding).filter((item): item is ReviewFinding => Boolean(item));
      publishing = true;
      let status: string;
      let done = false;
      try {
        status = await options.onPublish(selected);
        done = true;
      } catch (error) {
        status = error instanceof Error ? error.message : 'Yorumlar gönderilemedi.';
      } finally {
        publishing = false;
      }
      await panel.webview.postMessage({ command: 'published', status, done });
    }
  });
}

async function openFinding(finding: ReviewFinding, root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath): Promise<void> {
  const file = normalizeDiffPath(finding.file);
  if (!root && !path.isAbsolute(file)) {
    await vscode.window.showInformationMessage('Dosyayı açmak için bir çalışma alanı klasörü açın.');
    return;
  }
  const uri = vscode.Uri.file(path.isAbsolute(file) ? file : path.resolve(root!, file));
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    // Old-side lines belong to removed code, so they do not exist in the working copy.
    const line = finding.side !== 'old' && finding.line !== undefined
      ? Math.min(Math.max(finding.line - 1, 0), document.lineCount - 1)
      : 0;
    const range = new vscode.Range(line, 0, line, 0);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection: range });
  } catch {
    await vscode.window.showInformationMessage(`${file} çalışma alanında bulunamadı.`);
  }
}

export function renderReviewHtml(title: string, review: AIReviewResult, nonce: string, selectable: boolean): string {
  const indexed = review.findings.map((finding, index) => ({ finding, index }));
  const findings = review.findings.length
    ? SEVERITY_ORDER.map((severity) => {
      const items = indexed.filter(({ finding }) => finding.severity === severity);
      return items.length
        ? `<h3>${escapeHtml(RISK_LABELS[severity])} önem (${items.length})</h3><ul>${items.map(({ finding, index }) => findingHtml(finding, index, selectable)).join('')}</ul>`
        : '';
    }).join('')
    : '<p>Ciddi veya doğrudan aksiyon gerektiren bir bulgu tespit edilmedi.</p>';
  const tests = review.testSuggestions.length
    ? review.testSuggestions.map((test) => `<li>${escapeHtml(test)}</li>`).join('')
    : '<li>Ek test önerisi bulunmuyor.</li>';
  const publishBar = selectable
    ? `<div class="bar"><button id="publish">Seçilenleri Bitbucket'a gönder</button><span id="status" role="status"></span></div>`
    : '';

  return `<!doctype html><html lang="tr"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      body{font-family:var(--vscode-font-family);padding:20px;line-height:1.5;color:var(--vscode-foreground)}
      h1{white-space:pre-wrap;font-size:20px;overflow-wrap:anywhere}
      h3{margin:18px 0 4px}
      ul{padding-left:0;list-style:none}
      code{color:var(--vscode-textPreformat-foreground);background:var(--vscode-textCodeBlock-background);padding:2px 4px}
      .finding{margin:10px 0;padding:10px 12px;border:1px solid var(--vscode-panel-border);border-left-width:4px;border-radius:4px}
      .finding.high{border-left-color:var(--vscode-errorForeground)}
      .finding.medium{border-left-color:var(--vscode-editorWarning-foreground)}
      .finding.low{border-left-color:var(--vscode-editorInfo-foreground)}
      .finding p{margin:6px 0 0}
      .head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .badge{padding:1px 8px;border-radius:10px;font-size:12px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}
      .badge.high{color:var(--vscode-editor-background);background:var(--vscode-errorForeground)}
      .type{font-weight:600}
      .open{color:var(--vscode-textLink-foreground);text-decoration:none;overflow-wrap:anywhere}
      .open:hover{text-decoration:underline}
      .suggestion{color:var(--vscode-descriptionForeground)}
      .bar{position:sticky;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px 0;background:var(--vscode-editor-background)}
      button{padding:6px 14px;border:0;border-radius:2px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
      button:hover{background:var(--vscode-button-hoverBackground)}
      button:disabled{opacity:.6;cursor:default}
      .risk{display:inline-block;padding:3px 9px;border:1px solid var(--vscode-panel-border);border-radius:12px}
    </style></head><body>
    <h1>${escapeHtml(title)}</h1><p class="risk">Risk: ${escapeHtml(RISK_LABELS[review.riskLevel])}</p>
    ${publishBar}
    <h2>Özet</h2><p>${escapeHtml(review.summary)}</p>
    <h2>Bulgular</h2>${findings}
    <h2>Test önerileri</h2><ul>${tests}</ul>
    <h2>Genel değerlendirme</h2><p>${escapeHtml(review.finalComment)}</p>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('.open').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        vscode.postMessage({ command: 'open', index: Number(link.dataset.index) });
      }));
      const button = document.getElementById('publish');
      const status = document.getElementById('status');
      button?.addEventListener('click', () => {
        const indexes = [...document.querySelectorAll('.pick:checked')].map((box) => Number(box.dataset.index));
        button.disabled = true;
        status.textContent = 'Gönderiliyor…';
        vscode.postMessage({ command: 'publish', indexes });
      });
      window.addEventListener('message', ({ data }) => {
        if (data.command !== 'published') return;
        status.textContent = data.status;
        // A successful publish is final; on failure the user may retry.
        button.disabled = data.done;
        if (data.done) document.querySelectorAll('.pick').forEach((box) => { box.disabled = true; });
      });
    </script>
    </body></html>`;
}
