import * as vscode from 'vscode';

export class PRDiffProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'yk-review-diff';
  
  private diffs = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.diffs.get(uri.path) || 'Diff bulunamadı.';
  }

  public setDiff(id: string, content: string): void {
    const path = `/${id}`;
    this.diffs.set(path, content);
    this.onDidChangeEmitter.fire(vscode.Uri.parse(`${PRDiffProvider.scheme}:${path}`));
  }
}
