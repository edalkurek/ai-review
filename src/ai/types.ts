export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const FINDING_TYPES = [
  'bug',
  'security',
  'performance',
  'readability',
  'test',
  'architecture',
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type FindingType = (typeof FINDING_TYPES)[number];

export interface ReviewFinding {
  file: string;
  line?: number;
  side?: 'old' | 'new';
  severity: RiskLevel;
  type: FindingType;
  message: string;
  suggestion: string;
  /** How directly the visible diff proves the issue; absent when the model did not say. */
  confidence?: RiskLevel;
}

export interface AIReviewResult {
  summary: string;
  riskLevel: RiskLevel;
  findings: ReviewFinding[];
  testSuggestions: string[];
  finalComment: string;
}

export interface ReviewContext {
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  chunkLabel?: string;
  files?: readonly string[];
  extraInstructions?: string;
  /** Numbered post-change lines around the chunk's changes. */
  fileContext?: string;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AIReviewClient {
  reviewDiff(diff: string, context?: ReviewContext): Promise<AIReviewResult>;
  chat?(messages: ChatMessage[]): Promise<string>;
}

export const TEXT_LIMITS = {
  PR_SUMMARY: 1000,
  FINAL_COMMENT: 1000,
};
