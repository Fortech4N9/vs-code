import * as vscode from 'vscode';
import type { AnalysisEntry, Severity } from '../types';

interface DecorationSet {
  error: vscode.TextEditorDecorationType;
  warning: vscode.TextEditorDecorationType;
  info: vscode.TextEditorDecorationType;
}

export class DecorationManager {
  private decorations: DecorationSet;
  private currentResults: AnalysisEntry[] = [];

  constructor() {
    this.decorations = this.createDecorationTypes();
  }

  private createDecorationTypes(): DecorationSet {
    return {
      error: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('analyzer.errorBackground'),
        isWholeLine: true,
        overviewRulerColor: '#ff4444',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: {
          color: '#ff8888',
          margin: '0 0 0 2em',
          fontStyle: 'italic',
        },
        gutterIconPath: undefined,
      }),

      warning: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('analyzer.warningBackground'),
        isWholeLine: true,
        overviewRulerColor: '#ffaa00',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: {
          color: '#ddaa44',
          margin: '0 0 0 2em',
          fontStyle: 'italic',
        },
      }),

      info: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('analyzer.infoBackground'),
        isWholeLine: true,
        after: {
          color: '#66cc66',
          margin: '0 0 0 2em',
          fontStyle: 'italic',
        },
      }),
    };
  }

  apply(editor: vscode.TextEditor, results: AnalysisEntry[]): void {
    this.currentResults = results;

    const showInline = vscode.workspace
      .getConfiguration('analyzer')
      .get<boolean>('showInlineHints', true);

    const threshold = vscode.workspace
      .getConfiguration('analyzer')
      .get<string>('severityThreshold', 'info');

    const severityOrder: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
    const minSeverity = severityOrder[threshold as Severity] ?? 1;

    const grouped: Record<Severity, vscode.DecorationOptions[]> = {
      error: [],
      warning: [],
      info: [],
    };

    const lineMap = new Map<number, AnalysisEntry[]>();
    for (const entry of results) {
      const line = entry.source_line - 1;
      if (!lineMap.has(line)) {
        lineMap.set(line, []);
      }
      lineMap.get(line)!.push(entry);
    }

    for (const [line, entries] of lineMap) {
      if (line < 0 || line >= editor.document.lineCount) {
        continue;
      }

      const worst = entries.reduce((a, b) =>
        severityOrder[b.severity] > severityOrder[a.severity] ? b : a,
      );

      if (severityOrder[worst.severity] < minSeverity) {
        continue;
      }

      const lineLength = editor.document.lineAt(line).text.length;
      const range = new vscode.Range(line, 0, line, lineLength);

      const symbols = [...new Set(entries.map((e) => e.base_symbol))].join(', ');
      const missRatePercent = (worst.miss_rate * 100).toFixed(1);
      const levels = [...new Set(entries.map((e) => e.cache_level).filter(Boolean))].join('/');
      const levelSuffix = levels ? ` ${levels}` : '';

      let inlineText = '';
      if (showInline) {
        if (worst.severity === 'error') {
          inlineText = `  ⚠${levelSuffix} ${worst.raw_pattern_type || worst.pattern_type} — промахи ${missRatePercent}% [${symbols}]`;
        } else if (worst.severity === 'warning') {
          inlineText = `  ⚡${levelSuffix} шаг=${worst.stride}, заполнение ${(worst.fill_factor * 100).toFixed(0)}% [${symbols}]`;
        } else {
          inlineText = `  ✓${levelSuffix} оптимально [${symbols}]`;
        }
      }

      const decoration: vscode.DecorationOptions = {
        range,
        renderOptions: showInline
          ? { after: { contentText: inlineText } }
          : undefined,
        hoverMessage: this.buildHoverMarkdown(entries),
      };

      grouped[worst.severity].push(decoration);
    }

    editor.setDecorations(this.decorations.error, grouped.error);
    editor.setDecorations(this.decorations.warning, grouped.warning);
    editor.setDecorations(this.decorations.info, grouped.info);
  }

  private buildHoverMarkdown(entries: AnalysisEntry[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const line = entries[0]?.source_line;
    if (line) {
      md.appendMarkdown(`## 🔬 Результаты анализа: строка ${line}\n\n`);
    }

    for (const entry of entries) {
      const level = entry.cache_level ? ` · ${entry.cache_level}` : '';
      const rawPattern = entry.raw_pattern_type || entry.pattern_type;

      md.appendMarkdown(`### ${entry.base_symbol}[${entry.index_expr}]${level}\n\n`);
      md.appendMarkdown(`| Показатель | Значение |\n|---|---|\n`);
      md.appendMarkdown(`| Паттерн | \`${rawPattern}\` |\n`);
      md.appendMarkdown(`| Функция | \`${entry.function_name}()\` |\n`);
      if (entry.base_kind) {
        md.appendMarkdown(`| Тип символа | \`${entry.base_kind}\` |\n`);
      }
      md.appendMarkdown(`| Шаг | ${entry.stride} |\n`);
      md.appendMarkdown(`| Глубина циклов | ${entry.loop_depth} |\n`);
      md.appendMarkdown(`| Заполнение строки кэша | ${(entry.fill_factor * 100).toFixed(1)}% |\n`);
      md.appendMarkdown(`| Доля промахов | ${(entry.miss_rate * 100).toFixed(1)}% |\n`);
      md.appendMarkdown(`| Обращений | ${entry.access_count.toLocaleString()} |\n`);
      md.appendMarkdown(
        `| Попадания / промахи | ${entry.hit_count.toLocaleString()} / ${entry.miss_count.toLocaleString()} |\n`,
      );
      if (entry.misses_read !== undefined || entry.misses_write !== undefined) {
        md.appendMarkdown(
          `| Промахи чтение / запись | ${(entry.misses_read ?? 0).toLocaleString()} / ${(entry.misses_write ?? 0).toLocaleString()} |\n`,
        );
      }
      if (entry.load_count !== undefined || entry.store_count !== undefined) {
        md.appendMarkdown(
          `| Чтений / записей | ${(entry.load_count ?? 0).toLocaleString()} / ${(entry.store_count ?? 0).toLocaleString()} |\n`,
        );
      }
      if (entry.working_set_bytes !== undefined) {
        md.appendMarkdown(`| Рабочий набор | ${formatBytes(entry.working_set_bytes)} |\n`);
      }
      if (entry.dependence) {
        md.appendMarkdown(`| Зависимость | ${entry.dependence} |\n`);
      }
      if (entry.alignment !== undefined && entry.alignment !== null) {
        md.appendMarkdown(`| Выравнивание | ${entry.alignment} |\n`);
      }
      if (entry.pattern_fingerprint) {
        md.appendMarkdown(`| Отпечаток | \`${entry.pattern_fingerprint}\` |\n`);
      }
      if (entry.pattern_signature) {
        md.appendMarkdown(`| Сигнатура | \`${entry.pattern_signature}\` |\n`);
      }
      md.appendMarkdown(`\n`);

      if (entry.suggestion) {
        md.appendMarkdown(`> 💡 ${entry.suggestion}\n\n`);
      }
      md.appendMarkdown(`---\n\n`);
    }

    return md;
  }

  clear(editor: vscode.TextEditor): void {
    this.currentResults = [];
    editor.setDecorations(this.decorations.error, []);
    editor.setDecorations(this.decorations.warning, []);
    editor.setDecorations(this.decorations.info, []);
  }

  getResults(): AnalysisEntry[] {
    return this.currentResults;
  }

  dispose(): void {
    this.decorations.error.dispose();
    this.decorations.warning.dispose();
    this.decorations.info.dispose();
  }
}

function formatBytes(n: number): string {
  if (!n) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
