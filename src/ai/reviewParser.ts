import {
  AIReviewResult,
  FINDING_TYPES,
  RISK_LEVELS,
  ReviewFinding,
  RiskLevel,
} from './types';

const MAX_TEXT_LENGTH = 20_000;
const MAX_FINDINGS = 200;
const MAX_TEST_SUGGESTIONS = 100;

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ReviewParseError(`${path} metin olmalıdır.`);
  }

  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw new ReviewParseError(`${path} boş olamaz.`);
  }
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new ReviewParseError(`${path} izin verilen uzunluğu aşıyor.`);
  }
  return normalized;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ReviewParseError(`${path} geçerli bir değer değil.`);
  }
  return value as T;
}

function validateFinding(value: unknown, index: number): ReviewFinding {
  if (!isRecord(value)) {
    throw new ReviewParseError(`findings[${index}] nesne olmalıdır.`);
  }

  const line = typeof value.line === 'string' && /^\d+$/.test(value.line.trim())
    ? Number(value.line.trim()) : value.line;
  const rawSide = typeof value.side === 'string' ? value.side.trim().toLowerCase() : value.side;
  // Some models use Bitbucket's fileType vocabulary for the same diff sides.
  const side = rawSide === 'from' ? 'old' : rawSide === 'to' ? 'new' : rawSide;
  return {
    file: requiredString(value.file, `findings[${index}].file`),
    ...(Number.isSafeInteger(line) && Number(line) > 0
      && (side === undefined || side === null || side === 'old' || side === 'new')
      ? { line: Number(line), ...(side === 'old' || side === 'new' ? { side } : {}) } : {}),
    severity: enumValue(value.severity, RISK_LEVELS, `findings[${index}].severity`),
    type: enumValue(value.type, FINDING_TYPES, `findings[${index}].type`),
    message: requiredString(value.message, `findings[${index}].message`),
    suggestion: requiredString(value.suggestion, `findings[${index}].suggestion`),
    // Optional and advisory: an unknown value must not discard an otherwise valid finding.
    ...(RISK_LEVELS.includes(value.confidence as RiskLevel) ? { confidence: value.confidence as RiskLevel } : {}),
  };
}

export function validateAIReviewResult(value: unknown): AIReviewResult {
  if (!isRecord(value)) {
    throw new ReviewParseError('AI review yanıtı bir JSON nesnesi olmalıdır.');
  }
  if (!Array.isArray(value.findings)) {
    throw new ReviewParseError('findings bir dizi olmalıdır.');
  }
  if (value.findings.length > MAX_FINDINGS) {
    throw new ReviewParseError('findings izin verilen öğe sayısını aşıyor.');
  }
  if (!Array.isArray(value.testSuggestions)) {
    throw new ReviewParseError('testSuggestions bir dizi olmalıdır.');
  }
  if (value.testSuggestions.length > MAX_TEST_SUGGESTIONS) {
    throw new ReviewParseError('testSuggestions izin verilen öğe sayısını aşıyor.');
  }

  return {
    summary: requiredString(value.summary, 'summary'),
    riskLevel: enumValue(value.riskLevel, RISK_LEVELS, 'riskLevel'),
    findings: value.findings.map(validateFinding),
    testSuggestions: value.testSuggestions.map((item, index) =>
      requiredString(item, `testSuggestions[${index}]`),
    ),
    finalComment: requiredString(value.finalComment, 'finalComment'),
  };
}

function extractFirstJsonObject(text: string): string {
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) {
    throw new ReviewParseError('AI yanıtında JSON nesnesi bulunamadı.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, index + 1);
      }
    }
  }

  throw new ReviewParseError('AI yanıtındaki JSON nesnesi tamamlanmamış.');
}

/** Parses a model response without ever evaluating model-controlled text. */
export function parseAIReviewResult(raw: string): AIReviewResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ReviewParseError('AI boş bir yanıt döndürdü.');
  }

  const jsonText = extractFirstJsonObject(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ReviewParseError('AI yanıtı geçerli JSON değil.');
  }

  return validateAIReviewResult(parsed);
}
