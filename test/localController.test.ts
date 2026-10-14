import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { git } from '../src/local/git';
import type { LocalReviewController } from '../src/local/localReviewController';

const require = createRequire(import.meta.url);
class Event<T> {
  listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
}
class Panel {
  closed = false;
  disposed = new Event<void>();
  messages = new Event<unknown>();
  webview = { html: '', onDidReceiveMessage: this.messages.event };
  onDidDispose = this.disposed.event;
  constructor(public view: string, public options: { enableScripts: boolean }) {}
  dispose() { if (!this.closed) { this.closed = true; this.disposed.fire(); } }
}
const panels: Panel[] = [];
const errors: string[] = [];
const opened = new Event<unknown>();
let root = '';
let modelCalls: string[] = [];
const result = { summary: '<script>unsafe</script>', riskLevel: 'low', findings: [], testSuggestions: [], finalComment: 'reviewed' };
const vscode = {
  Uri: { file: (fsPath: string) => ({ fsPath }) }, ViewColumn: { One: 1, Beside: 2 }, ProgressLocation: { Notification: 15 },
  workspace: {
    isTrusted: true, onDidGrantWorkspaceTrust: new Event<void>().event,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => ({ 'model.baseUrl': 'http://model.invalid/v1', 'model.name': 'test-model' })[key] ?? fallback }),
    onDidChangeConfiguration: new Event<void>().event,
  },
  extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({ repositories: [{ rootUri: { fsPath: root } }], onDidOpenRepository: opened.event }) }) }) },
  window: {
    createWebviewPanel: (view: string, _title: string, _column: number, options: { enableScripts: boolean }) => { const panel = new Panel(view, options); panels.push(panel); return panel; },
    showErrorMessage: async (message: string) => { errors.push(message); },
    showQuickPick: async () => undefined,
    withProgress: async (_options: unknown, callback: Function) => callback({}, { onCancellationRequested: new Event<void>().event }),
  },
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const Controller = require('../out/local/localReviewController').LocalReviewController as typeof LocalReviewController;
Module._load = originalLoad;

async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), 'ykb-controller-'));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(root, 'file.txt'), 'base\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  panels.length = 0; errors.length = 0; modelCalls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    modelCalls.push(String(options?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  };
  const controller = new Controller({ asAbsolutePath: (value: string) => path.resolve(value) } as never, { get: async () => undefined } as never, { error: () => {} } as never);
  await controller.start();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  return { controller, head, dispose: () => { controller.dispose(); globalThis.fetch = previousFetch; } };
}

async function staged(content = 'staged\n') { await writeFile(path.join(root, 'file.txt'), content); await git(root, ['add', '.']); }

test('manual SCM review renders report without Commit/Push or approval actions', async t => {
  const f = await fixture(); t.after(f.dispose);
  await staged(); await writeFile(path.join(root, 'file.txt'), 'working\n');
  await writeFile(path.join(root, 'new.txt'), 'untracked\n');
  const indexBefore = await readFile(path.join(root, '.git/index'));
  await f.controller.reviewLocal({ rootUri: { fsPath: root } } as never);
  assert.equal(panels.length, 1); assert.equal(panels[0].options.enableScripts, false);
  assert.doesNotMatch(panels[0].webview.html, /Onayla ve Devam Et/);
  assert.match(modelCalls.join(), /staged/); assert.match(modelCalls.join(), /working/); assert.match(modelCalls.join(), /untracked/);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), f.head);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), indexBefore);
});

test('controller start automatically uninstalls legacy hooks and unsets core.hooksPath', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'ykb-legacy-'));
  await git(repo, ['init', '-b', 'main']);
  const legacyHooks = path.join(repo, '.git', 'ykb-ai-review-hooks');
  await mkdir(legacyHooks, { recursive: true });
  await writeFile(path.join(legacyHooks, 'pre-push'), '#!/bin/sh\nexit 1\n');
  await git(repo, ['config', '--local', 'core.hooksPath', legacyHooks.replace(/\\/g, '/')]);
  await writeFile(path.join(repo, '.git', 'ykb-ai-review.json'), '{}');

  root = repo;
  const controller = new Controller({ asAbsolutePath: (value: string) => path.resolve(value) } as never, { get: async () => undefined } as never, { error: () => {} } as never);
  await controller.start();
  t.after(() => { controller.dispose(); void rm(repo, { recursive: true, force: true }); });

  const hooksPath = (await git(repo, ['config', '--local', '--get', 'core.hooksPath']).catch(() => '')).trim();
  assert.equal(hooksPath, '');
});
