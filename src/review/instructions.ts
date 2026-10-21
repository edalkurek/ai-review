/** Upper bound for all instructions in one prompt; keeps the diff budget intact. */
export const MAX_INSTRUCTION_CHARS = 12_000;
const CACHE_TTL_MS = 10 * 60_000;

export interface InstructionTarget {
  projectKey: string;
  repositorySlug: string;
  /** `host/project/repo` (lower case); the key used by the `review.repoInstructions` setting. */
  settingsKey: string;
}

export interface InstructionSettings {
  extraInstructions: string;
  repoInstructions: Record<string, string>;
}

/** Reads a file of the shared repository; undefined when it does not exist. */
export type SharedFileReader = (path: string) => Promise<string | undefined>;

export interface ResolvedInstructions {
  text: string;
  /** Where each included part came from, for the output log. */
  sources: string[];
  truncated: boolean;
  /** Shared files that could not be read (network, permission); the review continues without them. */
  failed: string[];
}

interface Part {
  title: string;
  source: string;
  text: string;
}

/** Tries the project folder as written in Bitbucket first, then in lower case. */
function projectFolders(projectKey: string): string[] {
  return [...new Set([projectKey, projectKey.toLowerCase()])].map((key) => `projects/${key}`);
}

/**
 * Collects instructions from the general level to the most specific one; later parts win on conflict:
 * shared general → shared project → shared repository → settings general → settings repository.
 */
export async function resolveInstructions(
  target: InstructionTarget,
  settings: InstructionSettings,
  readShared?: SharedFileReader,
): Promise<ResolvedInstructions> {
  const parts: Part[] = [];
  const failed: string[] = [];
  const readFirst = async (paths: string[]): Promise<{ path: string; text: string } | undefined> => {
    for (const path of paths) {
      try {
        const text = (await readShared!(path))?.trim();
        if (text) return { path, text };
      } catch {
        failed.push(path);
        return undefined;
      }
    }
    return undefined;
  };

  if (readShared) {
    const folders = projectFolders(target.projectKey);
    const slugs = [...new Set([target.repositorySlug, target.repositorySlug.toLowerCase()])];
    const shared: [string, string[]][] = [
      ['Ortak talimatlar · Genel', ['general.md']],
      [`Ortak talimatlar · ${target.projectKey} projesi`, folders.map((folder) => `${folder}/general.md`)],
      [`Ortak talimatlar · ${target.repositorySlug} reposu`, folders.flatMap((folder) => slugs.map((slug) => `${folder}/repos/${slug}.md`))],
    ];
    for (const [title, paths] of shared) {
      const found = await readFirst(paths);
      if (found) parts.push({ title, source: found.path, text: found.text });
    }
  }
  const general = settings.extraInstructions.trim();
  if (general) parts.push({ title: 'Kişisel ayarlar · Genel', source: 'ayarlar: review.extraInstructions', text: general });
  const repository = Object.entries(settings.repoInstructions)
    .find(([key]) => key.trim().toLowerCase() === target.settingsKey)?.[1]?.trim();
  if (repository) parts.push({ title: 'Kişisel ayarlar · Repo', source: `ayarlar: review.repoInstructions[${target.settingsKey}]`, text: repository });

  return { ...fitToLimit(parts), failed };
}

/** Drops the most general parts first: the specific ones are the reason a repository has instructions. */
function fitToLimit(parts: Part[]): Omit<ResolvedInstructions, 'failed'> {
  const render = (part: Part): string => `## ${part.title}\n${part.text}`;
  const kept = [...parts];
  let truncated = false;
  while (kept.length > 1 && kept.map(render).join('\n\n').length > MAX_INSTRUCTION_CHARS) {
    kept.shift();
    truncated = true;
  }
  let text = kept.map(render).join('\n\n');
  if (text.length > MAX_INSTRUCTION_CHARS) {
    text = `${text.slice(0, MAX_INSTRUCTION_CHARS - 1)}…`;
    truncated = true;
  }
  return { text, sources: kept.map((part) => part.source), truncated };
}

/**
 * Caches shared files across reviews (automatic review checks many pull requests every few minutes).
 * A failed read reuses the last known content, so a brief outage does not change review behavior.
 */
export class SharedInstructionsCache {
  private readonly entries = new Map<string, { value: string | undefined; expires: number }>();

  public constructor(private readonly now: () => number = Date.now, private readonly ttlMs = CACHE_TTL_MS) {}

  public reader(scope: string, read: SharedFileReader): SharedFileReader {
    return async (path) => {
      const key = `${scope}\0${path}`;
      const cached = this.entries.get(key);
      if (cached && cached.expires > this.now()) return cached.value;
      try {
        const value = await read(path);
        this.entries.set(key, { value, expires: this.now() + this.ttlMs });
        return value;
      } catch (error) {
        if (cached) return cached.value;
        throw error;
      }
    };
  }
}
