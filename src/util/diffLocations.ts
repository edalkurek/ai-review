import type { InlineCommentLocation } from '../bitbucket';

interface DiffLineLocation {
  index: number;
  location: InlineCommentLocation;
}

/** Only lines actually present in a diff hunk are eligible for inline comments. */
function scanDiffLines(diff: string): DiffLineLocation[] {
  const result: DiffLineLocation[] = [];
  let oldPath = '', newPath = '';
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  let inHunk = false;
  for (const [index, text] of diff.split(/\r?\n/).entries()) {
    if (text.startsWith('diff --git ')) {
      oldPath = newPath = '';
      inHunk = false;
    } else if (!inHunk && text.startsWith('--- ')) {
      oldPath = headerPath(text.slice(4), ['a/', 'src://']);
      newPath = '';
    } else if (!inHunk && text.startsWith('+++ ')) {
      newPath = headerPath(text.slice(4), ['b/', 'dst://']);
    } else if (text.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      inHunk = Boolean(match);
      if (match) {
        oldLine = Number(match[1]); newLine = Number(match[3]);
        oldRemaining = Number(match[2] ?? 1); newRemaining = Number(match[4] ?? 1);
      }
    } else if (inHunk) {
      const path = newPath || oldPath;
      const srcPath = oldPath && newPath && oldPath !== newPath ? oldPath : undefined;
      if (text.startsWith('+') && newRemaining > 0) {
        if (path) result.push({ index, location: { path, srcPath, line: newLine, side: 'new', lineType: 'ADDED', content: text.slice(1) } });
        newLine++; newRemaining--;
      } else if (text.startsWith('-') && oldRemaining > 0) {
        if (path) result.push({ index, location: { path, srcPath, line: oldLine, side: 'old', lineType: 'REMOVED', content: text.slice(1) } });
        oldLine++; oldRemaining--;
      } else if (text.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        if (path) {
          result.push({ index, location: { path, srcPath, line: oldLine, side: 'old', lineType: 'CONTEXT', content: text.slice(1) } });
          result.push({ index, location: { path, srcPath, line: newLine, side: 'new', lineType: 'CONTEXT', content: text.slice(1) } });
        }
        oldLine++; newLine++; oldRemaining--; newRemaining--;
      } else if (!text.startsWith('\\')) {
        inHunk = false;
      }
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
    }
  }
  return result;
}

function headerPath(value: string, prefixes: string[]): string {
  let path = value.split('\t')[0];
  if (path.startsWith('"')) {
    if (!path.endsWith('"')) return '';
    // Git quotes UTF-8 bytes using C-style octal escapes.
    const decoded = path.slice(1, -1).replace(/\\([0-7]{1,3}|[\\"abfnrtv])/g, (_match, escape: string) => {
      if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
      const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
      return escapes[escape] ?? escape;
    });
    path = /\\[0-7]{1,3}/.test(path) ? Buffer.from(decoded, 'latin1').toString('utf8') : decoded;
    if (path.includes('\uFFFD')) return '';
  }
  if (path === '/dev/null') return '';
  // Git uses a/ and b/; Bitbucket Server's raw pull request diff uses src:// and dst://.
  const prefix = prefixes.find((candidate) => path.startsWith(candidate));
  return prefix ? path.slice(prefix.length) : path;
}

/** Removes the a/, b/ (git) or src://, dst:// (Bitbucket Server) prefix a diff path may carry. */
export function normalizeDiffPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^(?:[ab]\/|src:\/\/|dst:\/\/)/, '');
}

/** The repository path a single-file diff section changes (the new path; the old one for deletions). */
export function diffSectionFiles(section: string): string[] {
  let oldPath = '', newPath = '';
  for (const text of section.split(/\r?\n/)) {
    if (text.startsWith('@@ ')) break;
    if (text.startsWith('--- ')) oldPath = headerPath(text.slice(4), ['a/', 'src://']);
    else if (text.startsWith('+++ ')) newPath = headerPath(text.slice(4), ['b/', 'dst://']);
  }
  if (newPath || oldPath) return [newPath || oldPath];
  // Binary or mode-only sections have no ---/+++ lines.
  const match = /^diff --git (?:a\/|src:\/\/)(.+?) (?:b\/|dst:\/\/)(.+)$/m.exec(section);
  return match ? [match[2]] : [];
}

export function changedLineLocations(diff: string): InlineCommentLocation[] {
  return diffLineLocations(diff).filter((location) => location.lineType !== 'CONTEXT');
}

export function diffLineLocations(diff: string): InlineCommentLocation[] {
  return scanDiffLines(diff).map(({ location }) => location);
}

/** Attach original file coordinates before chunking can remove a hunk header. */
export function annotateDiffLines(diff: string): string {
  const lines = diff.split(/\r?\n/);
  for (const { index, location } of scanDiffLines(diff)) {
    // Show one authoritative coordinate per line; context uses the current file.
    if (location.lineType === 'CONTEXT' && location.side === 'old') continue;
    const file = location.side === 'old' ? location.srcPath ?? location.path : location.path;
    const coordinates = JSON.stringify({ file, line: location.line, side: location.side });
    lines[index] = `${lines[index][0]}[review-location ${coordinates}] ${lines[index].slice(1)}`;
  }
  return lines.join('\n');
}
