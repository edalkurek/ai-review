import { AIReviewResult, FindingType, ReviewFinding, RiskLevel, TEXT_LIMITS } from '../ai/types';

export interface ReviewCommentMetadata {
  prId: string | number;
  commitHash: string;
  modelName: string;
}

const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
};

const RISK_ICONS: Record<RiskLevel, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

const FINDING_LABELS: Record<FindingType, string> = {
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
  return `- **${severity} · ${finding.type} · ${inlineCode(finding.file)}:** ${compactText(finding.message, 240)} Öneri: ${compactText(finding.suggestion, 200)}`;
}

export function formatInlineComment(finding: ReviewFinding): string {
  return `### ${RISK_ICONS[finding.severity]} ${FINDING_LABELS[finding.type]} · ${RISK_LABELS[finding.severity]} önem

**🔎 Sorun**

${finding.message}

**💡 Düzeltme önerisi**

${finding.suggestion}`;
}

export function formatReviewComment(
  review: AIReviewResult,
  inlineFindings: ReadonlySet<ReviewFinding> = new Set(),
): string {
  const findings = review.findings.length > 0
    ? [...new Set(review.findings.map((finding) => inlineFindings.has(finding)
      ? `- **${RISK_LABELS[finding.severity]} · ${finding.type} · ${inlineCode(finding.file)}:${finding.line} (${finding.side === 'old' ? 'eski' : 'yeni'}):** Sorun ve düzeltme önerisi satır içi yorumda.`
      : formatFinding(finding)))].join('\n')
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
