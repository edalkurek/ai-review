import type { ReviewFinding } from '../ai/types';
import type { InlineCommentLocation } from '../bitbucket';
export { changedLineLocations, diffLineLocations } from '../util/diffLocations';

export function findInlineLocation(finding: ReviewFinding, locations: InlineCommentLocation[]): InlineCommentLocation | undefined {
  const file = finding.file.replace(/\\/g, '/').replace(/^\.\//, '');
  const matchesPath = (location: InlineCommentLocation, path: string): boolean =>
    location.path === path || (location.side === 'old' && location.srcPath === path);
  // Prefer an exact repository path; a/ and b/ can also be real directories.
  const path = locations.some((location) => matchesPath(location, file)) ? file : file.replace(/^[ab]\//, '');
  const matches = locations.filter((location) => location.line === finding.line
    && (finding.side === undefined || location.side === finding.side) && matchesPath(location, path));
  // A missing side is recoverable only if the diff identifies exactly one anchor.
  return matches.length === 1 ? matches[0] : undefined;
}
