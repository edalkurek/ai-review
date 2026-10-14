// Isolated, synthetic desktop fixture. Never uses the user's model or remote.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ykb-desktop-'));
  const root = path.join(base, 'AI-Review-Smoke');
  const profile = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'AI Review Test'); git('config', 'user.email', 'review@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'example.ts'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-m', 'base');
  const remote = path.join(base, 'remote.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      requests.push(JSON.parse(body));
      void fs.writeFile(path.join(base, 'model-requests.json'), JSON.stringify(requests, null, 2));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Yerel kod değişiklikleri incelendi.', riskLevel: 'low', findings: [], testSuggestions: ['Değişen değerin kullanıldığı davranışı doğrulayın.'], finalComment: 'İncelenen değişiklikte aksiyon gerektiren bir bulgu yok.' }) } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
    'git.confirmSync': false, 'git.openRepositoryInParentFolders': 'never',
    'bitbucketAiReview.model.baseUrl': `http://127.0.0.1:${server.address().port}/v1`,
    'bitbucketAiReview.model.name': 'desktop-test',
    'bitbucketAiReview.automaticReview.enabled': false,
    'extensions.ignoreRecommendations': true,
  }, null, 2));
  await fs.writeFile(path.join(root, 'example.ts'), 'export const value = 2;\n'); git('add', '.');
  console.log(JSON.stringify({ base, root, profile, pid: process.pid }));
  const executable = path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  spawn(executable, ['--new-window', '--user-data-dir', profile, '--extensions-dir', path.join(base, 'extensions'), '--extensionDevelopmentPath', process.cwd(), '--skip-welcome', '--skip-release-notes', root], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }).unref();
}
main().catch(error => { console.error(error); process.exit(1); });
