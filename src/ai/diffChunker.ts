import { filterDiff } from './diffFilter';
import { annotateDiffLines, diffSectionFiles } from '../util/diffLocations';

export interface DiffChunk {
  index: number;
  total: number;
  files: string[];
  content: string;
}

interface DiffSection {
  files: string[];
  content: string;
}

function fileSections(diff: string): DiffSection[] {
  const starts: number[] = [];
  const expression = /^diff --git /gm;
  for (let match = expression.exec(diff); match; match = expression.exec(diff)) {
    starts.push(match.index);
  }
  if (starts.length === 0) {
    return [{ files: [], content: diff }];
  }

  const sections: DiffSection[] = [];
  if (starts[0] > 0 && diff.slice(0, starts[0]).trim()) {
    sections.push({ files: [], content: diff.slice(0, starts[0]) });
  }
  starts.forEach((start, index) => {
    const content = diff.slice(start, starts[index + 1] ?? diff.length);
    sections.push({ files: diffSectionFiles(content), content });
  });
  return sections;
}

function splitOversizedSection(section: DiffSection, maxChunkChars: number): DiffSection[] {
  if (section.content.length <= maxChunkChars) {
    return [section];
  }

  const result: DiffSection[] = [];
  let cursor = 0;
  while (cursor < section.content.length) {
    let end = Math.min(cursor + maxChunkChars, section.content.length);
    if (end < section.content.length) {
      const lastNewline = section.content.lastIndexOf('\n', end);
      if (lastNewline > cursor) {
        end = lastNewline + 1;
      }
    }
    result.push({ files: section.files, content: section.content.slice(cursor, end) });
    cursor = end;
  }
  return result;
}

/** Groups whole files where possible and falls back to bounded chunks for huge files. */
export function chunkDiff(
  diff: string,
  maxChunkChars = 24_000,
  includeLineLocations = false,
): DiffChunk[] {
  if (!Number.isInteger(maxChunkChars) || maxChunkChars <= 0) {
    throw new Error('maxChunkChars pozitif bir tam sayı olmalıdır.');
  }
  if (!diff.trim()) {
    return [];
  }

  const { filteredDiff } = filterDiff(diff);
  if (!filteredDiff.trim()) {
    return [];
  }

  const units = fileSections(includeLineLocations ? annotateDiffLines(filteredDiff) : filteredDiff).flatMap((section) =>
    splitOversizedSection(section, maxChunkChars),
  );
  const groups: DiffSection[] = [];
  let current: DiffSection = { files: [], content: '' };

  for (const unit of units) {
    if (current.content && current.content.length + unit.content.length > maxChunkChars) {
      groups.push(current);
      current = { files: [], content: '' };
    }
    current.content += unit.content;
    current.files.push(...unit.files);
  }
  if (current.content) {
    groups.push(current);
  }

  return groups.map((group, index) => ({
    index,
    total: groups.length,
    files: [...new Set(group.files)],
    content: group.content,
  }));
}
