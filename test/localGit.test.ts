import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { git, localSnapshot, stagedSnapshot } from '../src/local/git';
import { uninstallHooks } from '../src/local/hookInstaller';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'ykb-review-'));
  const root = path.join(base, 'repo with spaces');
  const remote = path.join(base, 'remote.git');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'review-test@example.invalid']);
  await git(root, ['config', 'user.name', 'Review Test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['init', '--bare', remote]);
  await git(root, ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(root, 'file.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  return { base, root, remote, head: (await git(root, ['rev-parse', 'HEAD'])).trim() };
}

async function change(root: string, content = 'changed\n') {
  await writeFile(path.join(root, 'file.txt'), content);
  await git(root, ['add', 'file.txt']);
}

test('local review includes staged, unstaged and untracked; staged snapshot excludes working edits', async () => {
  const { root, head } = await fixture();
  await change(root, 'staged-only\n');
  await writeFile(path.join(root, 'file.txt'), 'working-only\n');
  await writeFile(path.join(root, 'new file.txt'), 'untracked-only\n');
  const staged = await stagedSnapshot(root);
  assert.match(staged.diff, /staged-only/);
  assert.doesNotMatch(staged.diff, /working-only|untracked-only/);
  const local = await localSnapshot(root);
  assert.match(local.diff, /staged-only/);
  assert.match(local.diff, /working-only/);
  assert.match(local.diff, /untracked-only/);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), head);
  assert.equal((await stagedSnapshot(root)).fingerprint, staged.fingerprint);
});

test('uninstallHooks restores original core.hooksPath if state.json recorded it', async () => {
  const { root } = await fixture();
  const legacyDir = path.join(root, '.git', 'ykb-ai-review-hooks');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'state.json'), JSON.stringify({ originalPath: 'custom-hooks-dir' }));
  await git(root, ['config', '--local', 'core.hooksPath', legacyDir.replace(/\\/g, '/')]);

  await uninstallHooks(root);

  const restored = (await git(root, ['config', '--local', '--get', 'core.hooksPath'])).trim();
  assert.equal(restored, 'custom-hooks-dir');
});

test('uninstallHooks unsets core.hooksPath and deletes legacy files when no custom hooks existed', async () => {
  const { root } = await fixture();
  const legacyDir = path.join(root, '.git', 'ykb-ai-review-hooks');
  const descriptor = path.join(root, '.git', 'ykb-ai-review.json');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'bridge.cjs'), '// dummy');
  await writeFile(descriptor, '{}');
  await git(root, ['config', '--local', 'core.hooksPath', legacyDir.replace(/\\/g, '/')]);

  await uninstallHooks(root);

  const remaining = (await git(root, ['config', '--local', '--get', 'core.hooksPath']).catch(() => '')).trim();
  assert.equal(remaining, '');
  await assert.rejects(readFile(descriptor));
});

test('ordinary git push and commit execute freely without any blocking', async () => {
  const { root, remote } = await fixture();
  await change(root, 'new-content\n');
  await git(root, ['commit', '-m', 'unblocked commit']);
  await git(root, ['push', 'origin', 'main']);

  const remoteHead = (await git(root, ['ls-remote', remote, 'refs/heads/main'])).trim();
  const localHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
  assert.match(remoteHead, new RegExp(localHead));
});
