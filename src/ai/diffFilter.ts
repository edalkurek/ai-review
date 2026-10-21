import { diffSectionFiles } from '../util/diffLocations';

export function isBinaryDiffSection(content: string): boolean {
  return /Binary files .* differ/i.test(content) || /GIT binary patch/i.test(content);
}

export interface FilterDiffResult {
  filteredDiff: string;
  excludedFiles: string[];
}

/**
 * Diff içeriğini işler; yalnızca ikili (binary) diff bölümlerini eler.
 * Dosya adı veya uzantısına göre hariç tutma yapılmaz.
 */
export function filterDiff(diff: string): FilterDiffResult {
  const starts: number[] = [];
  const expression = /^diff --git /gm;
  for (let match = expression.exec(diff); match; match = expression.exec(diff)) {
    starts.push(match.index);
  }

  if (starts.length === 0) {
    if (isBinaryDiffSection(diff)) {
      return { filteredDiff: '', excludedFiles: [] };
    }
    return { filteredDiff: diff, excludedFiles: [] };
  }

  const keptSections: string[] = [];
  const excludedFiles = new Set<string>();

  if (starts[0] > 0) {
    const preamble = diff.slice(0, starts[0]);
    if (preamble.trim()) {
      keptSections.push(preamble);
    }
  }

  starts.forEach((start, index) => {
    const sectionContent = diff.slice(start, starts[index + 1] ?? diff.length);
    const files = diffSectionFiles(sectionContent);
    const isBinary = isBinaryDiffSection(sectionContent);

    if (isBinary) {
      files.forEach((f) => excludedFiles.add(f));
    } else {
      keptSections.push(sectionContent);
    }
  });

  return {
    filteredDiff: keptSections.join(''),
    excludedFiles: Array.from(excludedFiles),
  };
}
