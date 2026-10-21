import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_INSTRUCTION_CHARS, SharedInstructionsCache, resolveInstructions } from '../src/review/instructions';
import { parseRemoteUrl, parseRepositoryUrl } from '../src/bitbucket/urlParser';
import { parseBitbucketSetupInput } from '../src/setup/bitbucketSetupData';

const target = { projectKey: 'PAY', repositorySlug: 'payment-api', settingsKey: 'git.test/pay/payment-api' };
const settings = { extraInstructions: 'Kişisel genel', repoInstructions: { 'GIT.test/PAY/payment-api': 'Kişisel repo', 'git.test/pay/other': 'Başka' } };

test('combines shared and personal instructions from general to specific', async () => {
  const files: Record<string, string> = {
    'general.md': 'Ortak genel',
    'projects/PAY/general.md': 'PAY kuralları',
    'projects/PAY/repos/payment-api.md': 'Repo kuralları',
    'projects/CRM/general.md': 'CRM kuralları',
  };
  const resolved = await resolveInstructions(target, settings, async (path) => files[path]);
  const order = ['Ortak genel', 'PAY kuralları', 'Repo kuralları', 'Kişisel genel', 'Kişisel repo'].map((text) => resolved.text.indexOf(text));
  assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), resolved.text);
  assert.doesNotMatch(resolved.text, /CRM|Başka/);
  assert.match(resolved.text, /## Ortak talimatlar · PAY projesi\nPAY kuralları/);
  assert.deepEqual(resolved.sources, ['general.md', 'projects/PAY/general.md', 'projects/PAY/repos/payment-api.md',
    'ayarlar: review.extraInstructions', 'ayarlar: review.repoInstructions[git.test/pay/payment-api]']);
  assert.equal(resolved.truncated, false);
});

test('falls back to lower-case folders, skips missing or empty files and reports unreadable ones', async () => {
  const requested: string[] = [];
  const resolved = await resolveInstructions({ ...target, repositorySlug: 'Payment-API' }, { extraInstructions: '', repoInstructions: {} },
    async (path) => {
      requested.push(path);
      if (path === 'general.md') throw new Error('403');
      return { 'projects/pay/general.md': '  ', 'projects/pay/repos/payment-api.md': 'küçük harf repo' }[path];
    });
  assert.equal(resolved.text, '## Ortak talimatlar · Payment-API reposu\nküçük harf repo');
  assert.deepEqual(resolved.failed, ['general.md']);
  assert.ok(requested.indexOf('projects/PAY/repos/Payment-API.md') < requested.indexOf('projects/pay/repos/payment-api.md'));
});

test('without a shared repository only the settings apply, exactly as before', async () => {
  const resolved = await resolveInstructions(target, settings);
  assert.equal(resolved.text, '## Kişisel ayarlar · Genel\nKişisel genel\n\n## Kişisel ayarlar · Repo\nKişisel repo');
});

test('drops the most general parts first when the total is too long', async () => {
  const resolved = await resolveInstructions(target, { extraInstructions: '', repoInstructions: {} }, async (path) =>
    path === 'general.md' ? 'g'.repeat(MAX_INSTRUCTION_CHARS) : path === 'projects/PAY/repos/payment-api.md' ? 'Repo kuralı' : undefined);
  assert.equal(resolved.truncated, true);
  assert.deepEqual(resolved.sources, ['projects/PAY/repos/payment-api.md']);
});

test('cache reuses content within the TTL and serves the last value when a later read fails', async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const cache = new SharedInstructionsCache(() => now, 1000);
  const read = cache.reader('repo', async () => {
    calls++;
    if (fail) throw new Error('down');
    return `v${calls}`;
  });
  assert.equal(await read('general.md'), 'v1');
  assert.equal(await read('general.md'), 'v1');
  now = 2000;
  fail = true;
  assert.equal(await read('general.md'), 'v1');
  assert.equal(calls, 2);
  await assert.rejects(read('other.md'), /down/);
});

test('parses repository browser URLs and git remotes of Bitbucket Server', () => {
  assert.deepEqual(parseRepositoryUrl('https://git.test/bitbucket/projects/AI/repos/review-instructions/browse/general.md'),
    { provider: 'server', baseUrl: 'https://git.test/bitbucket', projectKey: 'AI', repositorySlug: 'review-instructions' });
  assert.throws(() => parseRepositoryUrl('https://git.test/bitbucket/projects/AI'), /projects\/<PROJE>\/repos/);
  const expected = { host: 'git.test', projectKey: 'PAY', repositorySlug: 'payment-api' };
  assert.deepEqual(parseRemoteUrl('https://git.test/bitbucket/scm/PAY/payment-api.git'), expected);
  assert.deepEqual(parseRemoteUrl('https://user@git.test/scm/PAY/payment-api'), expected);
  assert.deepEqual(parseRemoteUrl('ssh://git@GIT.test:7999/PAY/payment-api.git'), expected);
  assert.deepEqual(parseRemoteUrl('git@git.test:PAY/payment-api.git'), expected);
  assert.equal(parseRemoteUrl('not a url'), undefined);
  assert.equal(parseRemoteUrl('https://git.test/scm/PAY/payment-api/extra.git'), undefined);
});

test('setup form accepts an optional instructions repository on the same server only', () => {
  const form = {
    action: 'save', baseUrl: 'https://git.test/bitbucket', extraInstructions: '', modelName: 'm', modelBaseUrl: 'https://model.test/v1',
    bitbucketToken: '', modelApiKey: '', automaticReviewEnabled: false, automaticReviewIntervalMinutes: 5, repoInstructions: {},
  };
  assert.equal(parseBitbucketSetupInput(form).instructionsRepository, '');
  const withRepository = parseBitbucketSetupInput({ ...form, instructionsRepository: ' https://git.test/bitbucket/projects/AI/repos/rules ', instructionsBranch: 'main' });
  assert.equal(withRepository.instructionsRepository, 'https://git.test/bitbucket/projects/AI/repos/rules');
  assert.equal(withRepository.instructionsBranch, 'main');
  assert.throws(() => parseBitbucketSetupInput({ ...form, instructionsRepository: 'https://evil.test/projects/AI/repos/rules' }), /aynı sunucuda/);
});
