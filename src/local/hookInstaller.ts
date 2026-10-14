import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './git';

interface HookState { originalPath: string }

export async function uninstallHooks(root: string): Promise<void> {
  try {
    const worktreeConfig = (await git(root, ['config', '--get', 'extensions.worktreeConfig']).catch(() => '')).trim() === 'true';
    const configScope = worktreeConfig ? '--worktree' : '--local';

    const currentHooksPath = (await git(root, ['config', configScope, '--get', 'core.hooksPath']).catch(() => '')).trim();
    const descriptorPath = (await git(root, ['rev-parse', '--git-path', 'ykb-ai-review.json']).catch(() => '')).trim();
    const descriptor = descriptorPath ? path.resolve(root, descriptorPath) : '';

    let base = '';
    if (worktreeConfig && descriptor) {
      base = path.dirname(descriptor);
    } else {
      const commonDir = (await git(root, ['rev-parse', '--git-common-dir']).catch(() => '')).trim();
      if (commonDir) {
        base = path.resolve(root, commonDir);
      }
    }

    const directory = base ? path.join(base, 'ykb-ai-review-hooks') : '';
    const normalizedDir = directory ? directory.replace(/\\/g, '/') : '';
    const normalizedCurrent = currentHooksPath ? path.resolve(root, currentHooksPath).replace(/\\/g, '/') : '';

    if (directory && (normalizedCurrent === normalizedDir || currentHooksPath.endsWith('ykb-ai-review-hooks'))) {
      const stateFile = path.join(directory, 'state.json');
      let originalPath: string | undefined;
      try {
        const state = JSON.parse(await readFile(stateFile, 'utf8')) as HookState;
        if (state && typeof state.originalPath === 'string') {
          originalPath = state.originalPath;
        }
      } catch {
        // state file might not exist or be unreadable
      }

      if (originalPath && !originalPath.endsWith('ykb-ai-review-hooks')) {
        await git(root, ['config', configScope, 'core.hooksPath', originalPath.replace(/\\/g, '/')]).catch(() => '');
      } else {
        await git(root, ['config', configScope, '--unset', 'core.hooksPath']).catch(() => '');
      }
    }

    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    if (descriptor) {
      await rm(descriptor, { force: true }).catch(() => {});
    }
  } catch {
    // Safely ignore if git commands fail
  }
}
