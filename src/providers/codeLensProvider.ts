import * as vscode from 'vscode';
import type { AnalysisEntry } from '../types';

export class AnalysisCodeLensProvider implements vscode.CodeLensProvider {
  private results: AnalysisEntry[] = [];
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  setResults(results: AnalysisEntry[]): void {
    this.results = results;
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const functionMap = new Map<string, AnalysisEntry[]>();

    for (const entry of this.results) {
      if (!functionMap.has(entry.function_name)) {
        functionMap.set(entry.function_name, []);
      }
      functionMap.get(entry.function_name)!.push(entry);
    }

    const lenses: vscode.CodeLens[] = [];

    for (const [funcName, entries] of functionMap) {
      const firstLine = Math.min(...entries.map((e) => e.source_line)) - 1;
      const funcLine = this.findFunctionDeclaration(document, funcName, firstLine);
      const line = funcLine >= 0 ? funcLine : firstLine;

      const range = new vscode.Range(line, 0, line, 0);

      const totalAccesses = entries.reduce((s, e) => s + e.access_count, 0);
      const totalMisses = entries.reduce((s, e) => s + e.miss_count, 0);
      const overallMissRate = totalAccesses > 0 ? totalMisses / totalAccesses : 0;
      const worstEntry = entries.reduce((a, b) => (b.miss_rate > a.miss_rate ? b : a));

      const icon = overallMissRate > 0.5 ? '🔴' : overallMissRate > 0.1 ? '🟡' : '🟢';

      lenses.push(
        new vscode.CodeLens(range, {
          title: `${icon} ${funcName}(): ${entries.length} обращ., ${(overallMissRate * 100).toFixed(1)}% промахов (сводно)`,
          command: '',
        }),
      );

      if (worstEntry.miss_rate > 0.1) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `  └─ худший случай: ${worstEntry.base_symbol}[${worstEntry.index_expr}] — ${worstEntry.pattern_type}, ${(worstEntry.miss_rate * 100).toFixed(1)}% промахов`,
            command: '',
          }),
        );
      }
    }

    return lenses;
  }

  private findFunctionDeclaration(
    document: vscode.TextDocument,
    funcName: string,
    nearLine: number,
  ): number {
    const pattern = new RegExp(`\\b${funcName}\\s*\\(`);
    const searchStart = Math.max(0, nearLine - 10);

    for (let i = searchStart; i <= nearLine; i++) {
      if (pattern.test(document.lineAt(i).text)) {
        return i;
      }
    }
    return -1;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
