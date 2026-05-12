import * as vscode from 'vscode';
import type { AnalysisEntry } from '../types';

export class AnalysisHoverProvider implements vscode.HoverProvider {
  private results: AnalysisEntry[] = [];

  setResults(results: AnalysisEntry[]): void {
    this.results = results;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = position.line + 1;
    const matches = this.results.filter((r) => r.source_line === line);

    if (matches.length === 0) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    const lineRange = document.lineAt(position.line).range;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`## 🔬 Анализ доступа к памяти: строка ${line}\n\n`);

    for (const entry of matches) {
      const severityIcon =
        entry.severity === 'error' ? '🔴' : entry.severity === 'warning' ? '🟡' : '🟢';
      const level = entry.cache_level ? ` · ${entry.cache_level}` : '';
      const rawPattern = entry.raw_pattern_type || entry.pattern_type;

      md.appendMarkdown(`### ${severityIcon} \`${entry.base_symbol}[${entry.index_expr}]\`${level}\n\n`);
      md.appendMarkdown(`**Паттерн:** \`${rawPattern}\` · `);
      md.appendMarkdown(`**Шаг:** ${entry.stride} · `);
      md.appendMarkdown(`**Функция:** \`${entry.function_name}()\`\n\n`);

      md.appendMarkdown(`| Показатель | Значение |\n|:---|:---|\n`);
      if (entry.base_kind) {
        md.appendMarkdown(`| Тип символа | \`${entry.base_kind}\` |\n`);
      }
      md.appendMarkdown(`| Заполнение строки кэша | **${(entry.fill_factor * 100).toFixed(0)}%** |\n`);
      md.appendMarkdown(`| Доля промахов | **${(entry.miss_rate * 100).toFixed(1)}%** |\n`);
      md.appendMarkdown(`| Всего обращений | ${entry.access_count.toLocaleString()} |\n`);
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
      md.appendMarkdown(`| Глубина циклов | ${entry.loop_depth} |\n\n`);
      if (entry.dependence) {
        md.appendMarkdown(`**Зависимость:** ${entry.dependence}\n\n`);
      }
      if (entry.pattern_fingerprint) {
        md.appendMarkdown(`**Отпечаток:** \`${entry.pattern_fingerprint}\`\n\n`);
      }
      if (entry.pattern_signature) {
        md.appendMarkdown(`**Сигнатура:** \`${entry.pattern_signature}\`\n\n`);
      }

      if (entry.suggestion) {
        md.appendMarkdown(`> 💡 **Подсказка:** ${entry.suggestion}\n\n`);
      }
    }

    return new vscode.Hover(md, wordRange ?? lineRange);
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
