import assert from 'node:assert/strict';
import test from 'node:test';
import { AIReviewResult } from '../src/ai/types';
import { createReviewCommentMarker, formatReviewComment, sanitizeCommentForServer } from '../src/review/commentFormatter';

const review: AIReviewResult = {
  summary: 'Kısa özet',
  riskLevel: 'medium',
  findings: [{
    file: 'src/a.ts', severity: 'medium', type: 'bug', message: 'Null riski var.', suggestion: 'Guard ekleyin.',
  }],
  testSuggestions: ['Null girdiyi test edin.'],
  finalComment: 'Düzeltme gerekli.',
};

test('yorum metadata içermez ve emojili başlıklar içerir', () => {
  const comment = formatReviewComment(review);
  assert.doesNotMatch(comment, /bitbucket-ai-review:/);
  assert.match(comment, /AI PR Review/);
  assert.match(comment, /Risk seviyesi:\*\* 🟡 Orta/);
  assert.match(comment, /### 🔎 Öne çıkan bulgular/);
  assert.match(comment, /### 🧪 Test önerileri/);
});

test('marker girdisinin HTML yorumunu erken kapatmasına izin vermez', () => {
  const marker = createReviewCommentMarker({ prId: 1, commitHash: 'abc-->injected', modelName: 'm' });
  assert.equal((marker.match(/-->/g) ?? []).length, 1);
  assert.match(marker, /abc--%3Einjected/);
});

test('bulgu yoksa bunu açıkça belirtir', () => {
  const comment = formatReviewComment(
    { ...review, riskLevel: 'low', findings: [], testSuggestions: [] },
  );
  assert.match(comment, /aksiyon gerektiren bir bulgu tespit edilmedi/);
});

test('tüm bulguları korurken her bir açıklamayı kısa tutar', () => {
  const findings = Array.from({ length: 6 }, (_, index) => ({
    ...review.findings[0],
    file: `src/${index}.ts`,
    message: `Bulgu ${index} ${'uzun '.repeat(80)}`,
  }));
  const comment = formatReviewComment({
    ...review,
    findings,
    testSuggestions: Array.from({ length: 5 }, (_, index) => `Test ${index}`),
    finalComment: 'sonuç '.repeat(100),
  });

  assert.match(comment, /src\/5\.ts/);
  assert.match(comment, /Test 4/);
  assert.match(comment, /…/);
});

test('kurumsal uyumluluk için HTML yorumunu ve 4-byte emojileri güvenli markdowna dönüştürür', () => {
  const original = formatReviewComment(review);
  const sanitized = sanitizeCommentForServer(original);

  assert.doesNotMatch(sanitized, /<!--/);
  assert.doesNotMatch(sanitized, /-->/);
  assert.doesNotMatch(sanitized, /bitbucket-ai-review:/);
  assert.doesNotMatch(sanitized, /[🤖🟢🟡🔴🔎🧪📝]/);
  assert.match(sanitized, /AI PR Review/);
  assert.match(sanitized, /Risk seviyesi:\*\* \[Orta\] Orta/);
});
