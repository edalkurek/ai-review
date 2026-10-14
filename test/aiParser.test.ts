import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAIReviewResult, ReviewParseError } from '../src/ai/reviewParser';

const validReview = {
  summary: 'Validation iyileştirildi.',
  riskLevel: 'medium',
  findings: [
    {
      file: 'src/user.ts',
      severity: 'medium',
      type: 'bug',
      message: 'Boş kullanıcı adı kabul ediliyor.',
      suggestion: 'Trim sonrası boşluk kontrolü ekleyin.',
    },
  ],
  testSuggestions: ['Boş kullanıcı adı için test ekleyin.'],
  finalComment: 'Validation düzeltilmeden birleştirilmemeli.',
};

test('markdown kod bloğu içindeki geçerli review JSON yanıtını ayrıştırır', () => {
  const result = parseAIReviewResult(`\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\``);
  assert.equal(result.riskLevel, 'medium');
  assert.equal(result.findings[0]?.file, 'src/user.ts');
});

test('şemaya uymayan enum değerini güvenli biçimde reddeder', () => {
  assert.throws(
    () => parseAIReviewResult(JSON.stringify({ ...validReview, riskLevel: 'critical' })),
    ReviewParseError,
  );
});

test('eksik veya bozuk JSON için model metnini hata mesajına taşımaz', () => {
  const secret = 'sk-super-secret';
  assert.throws(
    () => parseAIReviewResult(`{ "summary": "${secret}"`),
    (error: unknown) => error instanceof ReviewParseError && !error.message.includes(secret),
  );
});
