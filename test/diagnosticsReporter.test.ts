import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { ReviewFinding } from '../src/ai/types';

const require = createRequire(import.meta.url);

// Mock vscode module before loading ReviewDiagnosticsReporter
const storedDiagnostics = new Map<string, unknown[]>();
const mockCollection = {
  name: 'ykb-ai-review',
  set: (uri: { toString: () => string; fsPath: string }, diagnostics: unknown[]) => {
    storedDiagnostics.set(uri.toString(), diagnostics);
  },
  delete: (uri: { toString: () => string }) => {
    storedDiagnostics.delete(uri.toString());
  },
  clear: () => {
    storedDiagnostics.clear();
  },
  dispose: () => {
    storedDiagnostics.clear();
  },
};

const mockVscode = {
  Uri: {
    file: (fsPath: string) => ({
      fsPath: path.resolve(fsPath),
      toString: () => `file:///${path.resolve(fsPath).replace(/\\/g, '/')}`,
    }),
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
  Diagnostic: class {
    public source?: string;
    public code?: string;
    constructor(
      public range: unknown,
      public message: string,
      public severity: number,
    ) {}
  },
  languages: {
    createDiagnosticCollection: () => mockCollection,
  },
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name: string, ...args: unknown[]) {
  return name === 'vscode' ? mockVscode : originalLoad.call(this, name, ...args);
};
const { ReviewDiagnosticsReporter } = require('../out/review/diagnosticsReporter');
Module._load = originalLoad;

test('ReviewDiagnosticsReporter maps findings to VS Code diagnostics with proper severity', () => {
  storedDiagnostics.clear();
  const reporter = new ReviewDiagnosticsReporter();
  const root = path.resolve('/workspace');

  const findings: ReviewFinding[] = [
    {
      file: 'src/security.ts',
      line: 10,
      severity: 'high',
      type: 'security',
      message: 'SQL Injection riski',
      suggestion: 'Parametreli sorgu kullanın.',
    },
    {
      file: 'src/utils.ts',
      line: 25,
      severity: 'medium',
      type: 'performance',
      message: 'Gereksiz döngü',
      suggestion: 'Map kullanın.',
    },
    {
      file: 'src/utils.ts',
      line: 50,
      severity: 'low',
      type: 'readability',
      message: 'Değişken adı belirsiz',
      suggestion: 'Daha açıklayıcı ad verin.',
    },
  ];

  reporter.reportFindings(root, findings);

  assert.equal(storedDiagnostics.size, 2);

  // Check security finding in security.ts
  const secKey = `file:///${path.resolve(root, 'src/security.ts').replace(/\\/g, '/')}`;
  const secDiagnostics = storedDiagnostics.get(secKey) as Array<{
    severity: number;
    message: string;
    source: string;
    code: string;
    range: { start: { line: number } };
  }>;
  assert.ok(secDiagnostics);
  assert.equal(secDiagnostics.length, 1);
  assert.equal(secDiagnostics[0].severity, 0); // Error
  assert.equal(secDiagnostics[0].source, 'YKB AI Review');
  assert.equal(secDiagnostics[0].code, 'security');
  assert.equal(secDiagnostics[0].range.start.line, 9); // 0-indexed line 10 -> 9
  assert.ok(secDiagnostics[0].message.includes('SQL Injection riski'));
  assert.ok(secDiagnostics[0].message.includes('Parametreli sorgu kullanın.'));

  // Check utils.ts has 2 diagnostics
  const utilsKey = `file:///${path.resolve(root, 'src/utils.ts').replace(/\\/g, '/')}`;
  const utilsDiagnostics = storedDiagnostics.get(utilsKey) as Array<{
    severity: number;
    code: string;
  }>;
  assert.ok(utilsDiagnostics);
  assert.equal(utilsDiagnostics.length, 2);
  assert.equal(utilsDiagnostics[0].severity, 1); // Warning
  assert.equal(utilsDiagnostics[1].severity, 2); // Information

  reporter.clear();
  assert.equal(storedDiagnostics.size, 0);
});
