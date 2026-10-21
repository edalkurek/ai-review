import * as vscode from 'vscode';
import { RISK_LEVELS, RiskLevel } from './ai/types';
import { RepositoryRef } from './bitbucket/types';
import { parseRepositoryUrl } from './bitbucket/urlParser';

const CONFIGURATION_SECTION = 'bitbucketAiReview';
const DEFAULT_MAX_DIFF_CHARACTERS = 60_000;

export interface ExtensionConfig {
  readonly bitbucket: {
    readonly baseUrl: string;
    readonly token?: string;
  };
  readonly model: {
    readonly baseUrl: string;
    readonly name: string;
    readonly apiKey?: string;
  };
  readonly automaticReview: {
    readonly enabled: boolean;
    readonly intervalMinutes: number;
  };
  readonly review: {
    readonly maxDiffCharacters: number;
    readonly extraInstructions: string;
    readonly repoInstructions: Record<string, string>;
    readonly minConfidence: RiskLevel;
    readonly contextLines: number;
    readonly sharedInstructions?: SharedInstructionsSettings;
  };
  readonly publish: {
    readonly highSeverityAsTask: boolean;
  };
}

export interface SharedInstructionsSettings {
  readonly repository: RepositoryRef;
  /** Branch to read; empty means the repository's default branch. */
  readonly branch: string;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readRequiredString(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): string {
  const value = configuration.get<string>(key, '').trim();
  if (!value) {
    throw new ConfigurationError(`Eksik ayar: ${CONFIGURATION_SECTION}.${key}`);
  }
  return value;
}

function readSafeHttpUrl(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): string {
  const rawValue = readRequiredString(configuration, key);
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ConfigurationError(`Geçersiz URL ayarı: ${CONFIGURATION_SECTION}.${key}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ConfigurationError(`${CONFIGURATION_SECTION}.${key} HTTP veya HTTPS kullanmalıdır.`);
  }
  if (url.username || url.password) {
    throw new ConfigurationError(`${CONFIGURATION_SECTION}.${key} kimlik bilgisi içermemelidir.`);
  }
  return url.toString().replace(/\/$/, '');
}

export function readMinConfidence(configuration: vscode.WorkspaceConfiguration): RiskLevel {
  const value = configuration.get<string>('review.minConfidence', 'medium');
  return RISK_LEVELS.includes(value as RiskLevel) ? value as RiskLevel : 'medium';
}

export function readContextLines(configuration: vscode.WorkspaceConfiguration): number {
  const value = configuration.get<number>('review.contextLines', 20);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 200) : 20;
}

/** The shared instructions repository, or undefined when none is configured. */
export function readSharedInstructions(
  configuration: vscode.WorkspaceConfiguration,
  bitbucketBaseUrl: string,
): SharedInstructionsSettings | undefined {
  const address = configuration.get<string>('review.instructionsRepository', '').trim();
  if (!address) return undefined;
  let repository: RepositoryRef;
  try {
    repository = parseRepositoryUrl(address);
  } catch (error) {
    throw new ConfigurationError(`${CONFIGURATION_SECTION}.review.instructionsRepository: ${error instanceof Error ? error.message : 'geçersiz adres'}`);
  }
  // The Bitbucket token is only ever sent to the configured server.
  if (new URL(repository.baseUrl).origin !== new URL(bitbucketBaseUrl).origin) {
    throw new ConfigurationError('Talimat reposu, yapılandırılan Bitbucket sunucusunda olmalıdır.');
  }
  return { repository: { ...repository, baseUrl: bitbucketBaseUrl }, branch: configuration.get<string>('review.instructionsBranch', '').trim() };
}

export function getExtensionConfig(): ExtensionConfig {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const intervalMinutes = configuration.get<number>('automaticReview.intervalMinutes', 5);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new ConfigurationError('Otomatik review aralığı 1–1440 dakika arasında olmalıdır.');
  }
  const bitbucketBaseUrl = readSafeHttpUrl(configuration, 'bitbucket.baseUrl');
  const bitbucketHost = new URL(bitbucketBaseUrl).hostname.toLowerCase();
  if (bitbucketHost === 'bitbucket.org' || bitbucketHost === 'api.bitbucket.org') {
    throw new ConfigurationError('Yalnızca Bitbucket Server/Data Center Base URL desteklenir.');
  }

  return {
    bitbucket: {
      baseUrl: bitbucketBaseUrl,
      token: configuration.get<string>('bitbucket.token', '').trim() || undefined,
    },
    model: {
      baseUrl: readSafeHttpUrl(configuration, 'model.baseUrl'),
      name: configuration.get<string>('model.name', '').trim(),
      apiKey: configuration.get<string>('model.apiKey', '').trim() || undefined,
    },
    automaticReview: {
      enabled: configuration.get<boolean>('automaticReview.enabled', false),
      intervalMinutes,
    },
    review: {
      maxDiffCharacters: DEFAULT_MAX_DIFF_CHARACTERS,
      extraInstructions: configuration.get<string>('review.extraInstructions', '').trim(),
      repoInstructions: configuration.get<Record<string, string>>('review.repoInstructions', {}),
      minConfidence: readMinConfidence(configuration),
      contextLines: readContextLines(configuration),
      sharedInstructions: readSharedInstructions(configuration, bitbucketBaseUrl),
    },
    publish: {
      highSeverityAsTask: configuration.get<boolean>('publish.highSeverityAsTask', true),
    },
  };
}

export function onConfigurationChanged(
  listener: () => void,
  subsection?: string,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    const section = subsection
      ? `${CONFIGURATION_SECTION}.${subsection}`
      : CONFIGURATION_SECTION;
    if (event.affectsConfiguration(section)) listener();
  });
}

export function getRepoKey(repo: { provider: string; baseUrl: string; projectKey?: string; workspace?: string; slug?: string; repositorySlug?: string }): string {
  const host = new URL(repo.baseUrl).host;
  const parent = repo.provider === 'cloud' ? repo.workspace : repo.projectKey;
  const slug = repo.slug || repo.repositorySlug;
  return `${host}/${parent}/${slug}`.toLowerCase();
}
