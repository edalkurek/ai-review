import { normalizeDiffPath } from '../util/diffLocations';
import { AIReviewResult, ReviewFinding, RiskLevel } from './types';

const RISK_SCORE: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase('tr-TR');
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findingKey(finding: ReviewFinding): string {
  // Wording differences (punctuation, spacing, case) must not publish the same issue twice;
  // distinct messages on one line stay separate findings.
  const message = finding.message.toLocaleLowerCase('tr-TR').replace(/[\p{P}\s]+/gu, ' ').trim();
  return [normalizeDiffPath(finding.file), finding.side, finding.line, finding.type, message]
    .join('\u0000');
}

export function mergeReviewResults(results: readonly AIReviewResult[]): AIReviewResult {
  if (results.length === 0) {
    throw new Error('Birleştirilecek AI review sonucu bulunamadı.');
  }

  const findingMap = new Map<string, ReviewFinding>();
  for (const result of results) {
    for (const finding of result.findings) {
      const key = findingKey(finding);
      const existing = findingMap.get(key);
      if (!existing || RISK_SCORE[finding.severity] > RISK_SCORE[existing.severity]) {
        findingMap.set(key, finding);
      }
    }
  }
  const findings = [...findingMap.values()].sort(
    (left, right) => RISK_SCORE[right.severity] - RISK_SCORE[left.severity],
  );
  const summaries = uniqueNonEmpty(results.map((result) => result.summary));
  const finalComments = uniqueNonEmpty(results.map((result) => result.finalComment));
  const declaredRisk = results.reduce<RiskLevel>(
    (highest, result) =>
      RISK_SCORE[result.riskLevel] > RISK_SCORE[highest] ? result.riskLevel : highest,
    'low',
  );
  const findingRisk = findings.reduce<RiskLevel>(
    (highest, finding) =>
      RISK_SCORE[finding.severity] > RISK_SCORE[highest] ? finding.severity : highest,
    'low',
  );

  return {
    summary: summaries.join(' '),
    riskLevel: RISK_SCORE[findingRisk] > RISK_SCORE[declaredRisk] ? findingRisk : declaredRisk,
    findings,
    testSuggestions: uniqueNonEmpty(results.flatMap((result) => result.testSuggestions)),
    finalComment: finalComments.join(' '),
  };
}
