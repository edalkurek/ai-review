import * as vscode from 'vscode';
import { PullRequestRef, Repository } from './bitbucket/types';

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
  };
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

export function getRepoInstructionsFor(config: ExtensionConfig, ref: PullRequestRef): string | undefined {
  const key = getRepoKey(ref);
  return config.review.repoInstructions[key];
}
