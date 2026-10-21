import { diffLineLocations } from '../util/diffLocations';

export interface FileContextOptions {
  /** Lines shown before and after each changed region. */
  contextLines: number;
  /** Files beyond this count are skipped to bound the number of requests. */
  maxFiles?: number;
  /** Larger files (in characters) are skipped; they are usually generated or data. */
  maxFileChars?: number;
}

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_CHARS = 400_000;
const FETCH_CONCURRENCY = 4;

/** New-side line windows around every hunk, merged where they overlap. */
function changedWindows(diff: string, contextLines: number): Map<string, [number, number][]> {
  const lines = new Map<string, number[]>();
  for (const location of diffLineLocations(diff)) {
    if (location.side !== 'new') continue;
    const list = lines.get(location.path) ?? [];
    list.push(location.line);
    lines.set(location.path, list);
  }
  const windows = new Map<string, [number, number][]>();
  for (const [file, numbers] of lines) {
    const merged: [number, number][] = [];
    for (const line of [...new Set(numbers)].sort((a, b) => a - b)) {
      const start = Math.max(1, line - contextLines);
      const end = line + contextLines;
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    windows.set(file, merged);
  }
  return windows;
}

/**
 * Collects the surroundings of each change from the post-change files, so the model can judge a
 * change against the code it touches instead of guessing. Keys are repository paths.
 */
export async function collectFileContext(
  diff: string,
  readFile: (path: string) => Promise<string | undefined>,
  options: FileContextOptions,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (options.contextLines <= 0) return result;
  const windows = [...changedWindows(diff, options.contextLines)].slice(0, options.maxFiles ?? DEFAULT_MAX_FILES);
  for (let index = 0; index < windows.length; index += FETCH_CONCURRENCY) {
    await Promise.all(windows.slice(index, index + FETCH_CONCURRENCY).map(async ([file, ranges]) => {
      let content: string | undefined;
      try {
        content = await readFile(file);
      } catch {
        // Context is best effort; the diff alone is still reviewable.
        return;
      }
      if (content === undefined || content.length > (options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS) || content.includes('\0')) return;
      const lines = content.split(/\r?\n/);
      const width = String(lines.length).length;
      const sections = ranges
        .map(([start, end]) => [start, Math.min(end, lines.length)] as const)
        .filter(([start, end]) => start <= end)
        .map(([start, end]) => lines.slice(start - 1, end)
          .map((text, offset) => `${String(start + offset).padStart(width)} | ${text}`).join('\n'));
      if (sections.length) result.set(file, sections.join('\n...\n'));
    }));
  }
  return result;
}

/** Context for one chunk's files, trimmed to a character budget so the prompt stays bounded. */
export function formatFileContext(context: ReadonlyMap<string, string>, files: readonly string[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of files) {
    const text = context.get(file);
    if (!text) continue;
    const part = `### ${file}\n${text}\n`;
    if (used + part.length > maxChars) break;
    parts.push(part);
    used += part.length;
  }
  return parts.join('\n');
}
