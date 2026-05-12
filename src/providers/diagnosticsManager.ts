import * as vscode from 'vscode';
import type { AnalysisEntry, Severity } from '../types';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class DiagnosticsManager {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('cache-analyzer');
  }

  apply(document: vscode.TextDocument, results: AnalysisEntry[]): void {
    const severityOrder: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
    const byLine = new Map<number, AnalysisEntry[]>();

    for (const entry of results) {
      if (entry.severity === 'info') continue;
      const line = entry.source_line - 1;
      if (line < 0 || line >= document.lineCount) continue;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push(entry);
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const [line, entries] of byLine) {
      const worst = entries.reduce((a, b) =>
        severityOrder[b.severity] > severityOrder[a.severity] ? b : a,
      );
      const lineText = document.lineAt(line).text;
      const symbols = [...new Set(entries.map((entry) => entry.base_symbol))];
      const firstSymbol = symbols[0] ?? worst.base_symbol;
      const colStart = lineText.indexOf(firstSymbol);
      const col = colStart >= 0 ? colStart : 0;
      const colEnd = Math.min(lineText.length, col + Math.max(firstSymbol.length, 1));
      const range = new vscode.Range(line, col, line, colEnd);
      const levels = [...new Set(entries.map((entry) => entry.cache_level).filter(Boolean))].join('/');

      const msg = [
        `${symbols.join(', ')}: ${entries.length} паттерн(а/ов)${levels ? ` (${levels})` : ''}`,
        `Худший: ${worst.raw_pattern_type || worst.pattern_type}`,
        `Промахи: ${(worst.miss_rate * 100).toFixed(1)}%, заполнение: ${(worst.fill_factor * 100).toFixed(0)}%`,
        worst.suggestion,
      ].join(' — ');

      const diag = new vscode.Diagnostic(range, msg, SEVERITY_MAP[worst.severity]);
      diag.source = 'Анализатор кэша';
      diag.code = worst.raw_pattern_type || worst.pattern_type;
      diagnostics.push(diag);
    }

    this.collection.set(document.uri, diagnostics);
  }

  clear(uri?: vscode.Uri): void {
    if (uri) {
      this.collection.delete(uri);
    } else {
      this.collection.clear();
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}
