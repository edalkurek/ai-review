import * as vscode from 'vscode';
import { AIReviewResult, ReviewFinding } from '../ai';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findingHtml(finding: ReviewFinding): string {
  return `<li class="finding ${finding.severity}">
    <div><strong>${escapeHtml(finding.severity.toUpperCase())}</strong> · ${escapeHtml(finding.type)} · <code>${escapeHtml(finding.file)}</code></div>
    <p>${escapeHtml(finding.message)}</p>
    <p><strong>Öneri:</strong> ${escapeHtml(finding.suggestion)}</p>
  </li>`;
}

export function showReviewResult(title: string, review: AIReviewResult): void {
  const panel = vscode.window.createWebviewPanel(
    'bitbucketAiReview.result',
    `AI Review: ${title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );
  panel.webview.html = reviewHtml(title, review);
}

function reviewHtml(title: string, review: AIReviewResult): string {
  const findings = review.findings.length
    ? review.findings.map(findingHtml).join('')
    : '<li>Ciddi veya doğrudan aksiyon gerektiren bir bulgu tespit edilmedi.</li>';
  const tests = review.testSuggestions.length
    ? review.testSuggestions.map((test) => `<li>${escapeHtml(test)}</li>`).join('')
    : '<li>Ek test önerisi bulunmuyor.</li>';

  return `<!doctype html><html lang="tr"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>
      body{font-family:var(--vscode-font-family);padding:20px;line-height:1.5;color:var(--vscode-foreground)}
      .risk{display:inline-block;padding:3px 9px;border:1px solid var(--vscode-panel-border);border-radius:12px;text-transform:uppercase}
      code{color:var(--vscode-textPreformat-foreground);background:var(--vscode-textCodeBlock-background);padding:2px 4px}
      li{margin:12px 0}.finding p{margin:4px 0}.high strong{color:var(--vscode-errorForeground)}
      h1{white-space:pre-wrap;font-size:20px;overflow-wrap:anywhere}
    </style></head><body>
    <h1>${escapeHtml(title)}</h1><p class="risk">Risk: ${escapeHtml(review.riskLevel)}</p>
    <h2>Özet</h2><p>${escapeHtml(review.summary)}</p>
    <h2>Bulgular</h2><ul>${findings}</ul>
    <h2>Test önerileri</h2><ul>${tests}</ul>
    <h2>Genel değerlendirme</h2><p>${escapeHtml(review.finalComment)}</p>
    </body></html>`;
}
