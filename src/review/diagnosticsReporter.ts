import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewFinding } from '../ai/types';

export class ReviewDiagnosticsReporter implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  public constructor(collection?: vscode.DiagnosticCollection) {
    this.collection = collection ?? vscode.languages?.createDiagnosticCollection('ykb-ai-review');
  }

  public reportFindings(
    workspaceRoot: string,
    findings: readonly ReviewFinding[],
  ): void {
    this.clear();
    if (!this.collection) {
      return;
    }

    const diagnosticsByUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

    for (const finding of findings) {
      if (!finding.file) {
        continue;
      }

      const normalizedRelative = finding.file.replace(/^[ab]\//, '');
      const absolutePath = path.isAbsolute(normalizedRelative)
        ? normalizedRelative
        : path.resolve(workspaceRoot, normalizedRelative);
      const uri = vscode.Uri.file(absolutePath);
      const uriKey = uri.toString();

      let entry = diagnosticsByUri.get(uriKey);
      if (!entry) {
        entry = { uri, diagnostics: [] };
        diagnosticsByUri.set(uriKey, entry);
      }

      const line = finding.line !== undefined && Number.isInteger(finding.line)
        ? Math.max(0, finding.line - 1)
        : 0;

      const range = new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, Number.MAX_SAFE_INTEGER),
      );

      const severity = this.mapSeverity(finding.severity);
      const message = finding.suggestion
        ? `${finding.message}\n💡 Öneri: ${finding.suggestion}`
        : finding.message;

      const diagnostic = new vscode.Diagnostic(range, message, severity);
      diagnostic.source = 'YKB AI Review';
      diagnostic.code = finding.type;

      entry.diagnostics.push(diagnostic);
    }

    for (const { uri, diagnostics } of diagnosticsByUri.values()) {
      this.collection.set(uri, diagnostics);
    }
  }

  private mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity) {
      case 'high':
        return vscode.DiagnosticSeverity.Error;
      case 'medium':
        return vscode.DiagnosticSeverity.Warning;
      case 'low':
      default:
        return vscode.DiagnosticSeverity.Information;
    }
  }

  public clear(): void {
    this.collection?.clear();
  }

  public dispose(): void {
    this.collection?.dispose();
  }
}
