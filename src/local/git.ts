import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import * as path from 'node:path';

export type GitEnvironment = Record<string, string>;
export interface Snapshot { title: string; diff: string; fingerprint: string }

export function git(root: string, args: string[], env: GitEnvironment = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: root, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(new Error(`Git komutu başarısız: ${args[0]} (${error.code ?? 'hata'}).`));
      else resolve(stdout);
    });
  });
}

const diffOptions = ['--no-ext-diff', '--no-textconv', '--binary', '--no-color', '--no-renames'];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function stagedSnapshot(root: string, env: GitEnvironment = {}): Promise<Snapshot> {
  const diff = await git(root, ['diff', '--cached', ...diffOptions], env);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], env).catch(() => 'unborn');
  return { title: 'Yerel değişiklikler · staged', diff, fingerprint: hash(head + diff) };
}

export async function localSnapshot(root: string): Promise<Snapshot> {
  // Keep staged and unstaged sections separate: opposite edits must not cancel out.
  const staged = await stagedSnapshot(root);
  const unstaged = await git(root, ['diff', ...diffOptions]);
  let diff = staged.diff ? `Staged değişiklikler:\n${staged.diff}` : '';
  if (unstaged) diff += `\nUnstaged değişiklikler:\n${unstaged}`;
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of untracked) {
    const absolute = path.join(root, file);
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error(`İncelenemeyen untracked dosya: ${file}`);
    if (stat.size > 8 * 1024 * 1024) throw new Error(`Untracked dosya çok büyük: ${file}`);
    const content = await readFile(absolute);
    diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n`;
    if (content.includes(0)) diff += 'Binary dosya (metin içeriği incelenemiyor)\n';
    else {
      const lines = content.toString('utf8').split('\n');
      diff += `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
    }
  }
  return { title: 'Yerel değişiklikler · staged, unstaged ve untracked', diff, fingerprint: hash(diff) };
}
