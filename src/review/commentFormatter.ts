import { AIReviewResult, FindingType, ReviewFinding, RiskLevel, TEXT_LIMITS } from '../ai/types';

export interface ReviewCommentMetadata {
  prId: string | number;
  commitHash: string;
  modelName: string;
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
};

export const RISK_ICONS: Record<RiskLevel, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

export const FINDING_LABELS: Record<FindingType, string> = {
  bug: 'Hata',
  security: 'Güvenlik',
  performance: 'Performans',
  readability: 'Okunabilirlik',
  test: 'Test',
  architecture: 'Mimari',
};

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

function markerPart(value: string | number): string {
  return encodeURIComponent(String(value).trim());
}

export function createReviewCommentMarker(metadata: ReviewCommentMetadata): string {
  return `<!-- bitbucket-ai-review:pr=${markerPart(metadata.prId)}:commit=${markerPart(metadata.commitHash)}:model=${markerPart(metadata.modelName)} -->`;
}

function inlineCode(value: string): string {
  return `\`${compactText(value, 120).replace(/`/g, '\\`')}\``;
}

function formatFinding(finding: ReviewFinding): string {
  const severity = RISK_LABELS[finding.severity];
  return `- **${severity} · ${FINDING_LABELS[finding.type]} · ${inlineCode(finding.file)}:** ${compactText(finding.message, 240)} Öneri: ${compactText(finding.suggestion, 200)}`;
}

export function formatInlineComment(finding: ReviewFinding): string {
  // Kept compact so it reads like a reviewer's line comment, not a report.
  return `${RISK_ICONS[finding.severity]} **${FINDING_LABELS[finding.type]} · ${RISK_LABELS[finding.severity]} önem**

${finding.message}

💡 **Öneri:** ${finding.suggestion}`;
}

function inlineSummary(findings: readonly ReviewFinding[]): string {
  const counts = (['high', 'medium', 'low'] as const)
    .map((severity) => [RISK_LABELS[severity], findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label.toLocaleLowerCase('tr-TR')}`);
  return `- ${findings.length} bulgu ilgili satırlara yorum olarak eklendi (${counts.join(', ')}).`;
}

export function formatReviewComment(
  review: AIReviewResult,
  inlineFindings: ReadonlySet<ReviewFinding> = new Set(),
): string {
  // Line comments already carry their details; only unanchored findings are listed here.
  const inline = review.findings.filter((finding) => inlineFindings.has(finding));
  const general = review.findings.filter((finding) => !inlineFindings.has(finding));
  const findings = review.findings.length > 0
    ? [...(inline.length ? [inlineSummary(inline)] : []), ...new Set(general.map(formatFinding))].join('\n')
    : '- Ciddi veya doğrudan aksiyon gerektiren bir bulgu tespit edilmedi.';
  const tests = review.testSuggestions.length > 0
    ? review.testSuggestions.map((suggestion) => `- ${compactText(suggestion, 200)}`).join('\n')
    : '- Ek bir test önerisi bulunmuyor.';

  return `## 🤖 AI PR Review

**Risk seviyesi:** ${RISK_ICONS[review.riskLevel]} ${RISK_LABELS[review.riskLevel]}

### PR özeti
${compactText(review.summary, TEXT_LIMITS.PR_SUMMARY)}

### 🔎 Öne çıkan bulgular
${findings}

### 🧪 Test önerileri
${tests}

### 📝 Genel değerlendirme
${compactText(review.finalComment || review.summary, TEXT_LIMITS.FINAL_COMMENT)}`;
}

/** A markdown link reference definition: CommonMark keeps it in the source but does not render it. */
export function hiddenMarker(key: string): string {
  const raw = /<!--\s*([^>]+?)\s*-->/.exec(key)?.[1] ?? key;
  return `[//]: # (${raw.replace(/[()]/g, '')})`;
}

export function sanitizeCommentForServer(text: string): string {
  return text
    .replace(/<!--\s*(bitbucket-ai-review:[^>]+?)\s*-->/g, '[//]: # ($1)')
    .replace(/🤖/g, '[AI]')
    .replace(/🟢/g, '[Düşük]')
    .replace(/🟡/g, '[Orta]')
    .replace(/🔴/g, '[Yüksek]')
    .replace(/🔎/g, '•')
    .replace(/🧪/g, '•')
    .replace(/📝/g, '•')
    .replace(/💡/g, '•')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
}
