import * as vscode from 'vscode';
import type {
  AggregatedPattern,
  AnalysisEntry,
  AnalysisMetrics,
  AnalysisResultBundle,
} from '../types';
import { taskStatusLabelRu } from '../taskStatusRu';

export class ReportPanel {
  private static instance: ReportPanel | undefined;
  private panel: vscode.WebviewPanel;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'analyzerReport',
      'Отчёт анализа кэша',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      ReportPanel.instance = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'goToLine') {
        this.revealLine(msg.line, msg.column);
      }
    });
  }

  static show(_extensionUri: vscode.Uri, results: AnalysisEntry[]): void {
    const rp = ReportPanel.getInstance();
    rp.panel.webview.html = rp.getDetailedHtml(results);
    rp.panel.reveal();
  }

  static showMetrics(_extensionUri: vscode.Uri, metrics: AnalysisMetrics): void {
    const rp = ReportPanel.getInstance();
    rp.panel.webview.html = rp.getMetricsHtml(metrics);
    rp.panel.reveal();
  }

  /**
   * showServerReport — единое представление серверного результата:
   * метрики (если есть), таблица паттернов из AggregatedEntry (со всеми
   * статическими и динамическими полями), баннер ошибки (если есть).
   * Используется по умолчанию после серверного `analyzer.runAnalysis`.
   */
  static showServerReport(_extensionUri: vscode.Uri, bundle: AnalysisResultBundle): void {
    const rp = ReportPanel.getInstance();
    rp.panel.webview.html = rp.getServerReportHtml(bundle);
    rp.panel.reveal();
  }

  private static getInstance(): ReportPanel {
    if (ReportPanel.instance) {
      return ReportPanel.instance;
    }
    const rp = new ReportPanel();
    ReportPanel.instance = rp;
    return rp;
  }

  private revealLine(line: number, column: number | undefined): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const col = Math.max(0, (column ?? 1) - 1);
    const position = new vscode.Position(Math.max(0, line - 1), col);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(position, position);
    vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }

  private getMetricsHtml(m: AnalysisMetrics): string {
    const hitPct = (m.hit_rate * 100).toFixed(1);
    const missPct = (m.miss_rate * 100).toFixed(1);
    const missColor = m.miss_rate > 0.5 ? '#f44336' : m.miss_rate > 0.2 ? '#ff9800' : '#4caf50';
    const hitColor = m.hit_rate > 0.7 ? '#4caf50' : m.hit_rate > 0.4 ? '#ff9800' : '#f44336';
    const scoreColor = m.optimization_score > 70 ? '#4caf50' : m.optimization_score > 40 ? '#ff9800' : '#f44336';

    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h2>📊 Отчёт анализа кэша</h2>

  <div class="grid">
    <div class="card">
      <div class="card-label">Доля попаданий</div>
      <div class="card-value" style="color:${hitColor}">${hitPct}%</div>
    </div>
    <div class="card">
      <div class="card-label">Доля промахов</div>
      <div class="card-value" style="color:${missColor}">${missPct}%</div>
    </div>
    <div class="card">
      <div class="card-label">Оценка оптимизации</div>
      <div class="card-value" style="color:${scoreColor}">${m.optimization_score.toFixed(1)}</div>
    </div>
    <div class="card">
      <div class="card-label">Обращений к памяти</div>
      <div class="card-value" style="color:#fff">${m.total_memory_accesses.toLocaleString()}</div>
    </div>
  </div>

  <div class="gauge">
    <div class="gauge-label"><span>Попадания</span><span>${hitPct}%</span></div>
    <div class="gauge-track"><div class="gauge-fill" style="width:${hitPct}%;background:${hitColor}"></div></div>
  </div>
  <div class="gauge" style="margin-top:12px">
    <div class="gauge-label"><span>Промахи</span><span>${missPct}%</span></div>
    <div class="gauge-track"><div class="gauge-fill" style="width:${missPct}%;background:${missColor}"></div></div>
  </div>

  <div class="section">
    <div class="info-row"><span class="info-label">Попадания</span><span class="info-value" style="color:#4caf50">${m.cache_hits.toLocaleString()}</span></div>
    <div class="info-row"><span class="info-label">Промахи</span><span class="info-value" style="color:#f44336">${m.cache_misses.toLocaleString()}</span></div>
    <div class="info-row"><span class="info-label">Всего обращений</span><span class="info-value">${m.total_memory_accesses.toLocaleString()}</span></div>
    <div class="info-row"><span class="info-label">ID задачи</span><span class="info-value" style="font-size:11px;opacity:0.6">${m.task_id}</span></div>
    <div class="info-row"><span class="info-label">Статус</span><span class="info-value">${escapeHtml(taskStatusLabelRu(String(m.status)))}</span></div>
  </div>
</body>
</html>`;
  }

  private getServerReportHtml(bundle: AnalysisResultBundle): string {
    const { task, metrics, patterns } = bundle;
    const errorBanner = task.error_message?.trim()
      ? this.renderErrorBanner(task.error_message)
      : '';

    const reuseBanner = task.reused_from_task_id?.trim()
      ? `<div class="reuse-banner">♻ Результаты переиспользованы из задачи <code>${escapeHtml(task.reused_from_task_id.slice(0, 8))}…</code></div>`
      : '';

    const metricsBlock = metrics
      ? this.renderMetricsCards(metrics)
      : '<div class="empty">Метрики кэша недоступны (стадия кэш-симуляции не выполнена).</div>';

    const distribution = this.renderPatternDistribution(patterns);
    const table = this.renderPatternsTable(patterns);

    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <style>${BASE_STYLES}${SERVER_STYLES}</style>
</head>
<body>
  <header class="report-header">
    <h2>📊 Отчёт: доступ к памяти и кэш</h2>
    <div class="header-meta">
      <span class="status-pill status-${task.status}">${escapeHtml(taskStatusLabelRu(task.status))}</span>
      <span class="task-id" title="${escapeHtml(task.id)}">${escapeHtml(task.id.slice(0, 8))}…</span>
    </div>
  </header>

  ${errorBanner}
  ${reuseBanner}
  ${metricsBlock}
  ${distribution}
  ${table}

  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('tr.pattern-row').forEach((row) => {
      row.addEventListener('click', () => {
        const line = parseInt(row.getAttribute('data-line') || '1', 10);
        const column = parseInt(row.getAttribute('data-column') || '1', 10);
        vscode.postMessage({ command: 'goToLine', line, column });
      });
    });
  </script>
</body></html>`;
  }

  private renderErrorBanner(message: string): string {
    return `
      <div class="error-banner">
        <div class="error-title">⚠ Ошибка анализа</div>
        <div class="error-body">${escapeHtml(message)}</div>
        <div class="error-hint">Статические паттерны ниже всё равно собраны — используйте их для оптимизации.</div>
      </div>`;
  }

  private renderMetricsCards(m: AnalysisMetrics): string {
    const hitPct = (m.hit_rate * 100).toFixed(1);
    const missPct = (m.miss_rate * 100).toFixed(1);
    const missColor = m.miss_rate > 0.5 ? '#f44336' : m.miss_rate > 0.2 ? '#ff9800' : '#4caf50';
    const hitColor = m.hit_rate > 0.7 ? '#4caf50' : m.hit_rate > 0.4 ? '#ff9800' : '#f44336';
    const scoreColor = m.optimization_score > 70 ? '#4caf50' : m.optimization_score > 40 ? '#ff9800' : '#f44336';

    return `
      <div class="grid">
        <div class="card">
          <div class="card-label">Доля попаданий</div>
          <div class="card-value" style="color:${hitColor}">${hitPct}%</div>
        </div>
        <div class="card">
          <div class="card-label">Доля промахов</div>
          <div class="card-value" style="color:${missColor}">${missPct}%</div>
        </div>
        <div class="card">
          <div class="card-label">Оценка оптимизации</div>
          <div class="card-value" style="color:${scoreColor}">${m.optimization_score.toFixed(1)}</div>
        </div>
        <div class="card">
          <div class="card-label">Всего обращений</div>
          <div class="card-value" style="color:#fff">${m.total_memory_accesses.toLocaleString()}</div>
        </div>
        <div class="card">
          <div class="card-label">Попадания в кэш</div>
          <div class="card-value" style="color:#4caf50">${m.cache_hits.toLocaleString()}</div>
        </div>
        <div class="card">
          <div class="card-label">Промахи</div>
          <div class="card-value" style="color:#f44336">${m.cache_misses.toLocaleString()}</div>
        </div>
      </div>
    `;
  }

  private renderPatternDistribution(patterns: AggregatedPattern[]): string {
    if (patterns.length === 0) {
      return '<div class="empty">Паттерны доступа не собраны.</div>';
    }

    // Группируем по pattern_type, считаем доли. Для группировки берём ровно
    // одну строку на (sequence_index, base_symbol) — иначе L1/L2-дубли исказят
    // картинку «сколько разных паттернов в коде».
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const p of patterns) {
      const key = `${p.sequence_index}:${p.base_symbol}:${p.cache_level}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(p.pattern_type, (counts.get(p.pattern_type) ?? 0) + 1);
    }

    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const cls =
          type === 'gather_scatter' || type === 'indirect' || type === 'random'
            ? 'bar-bad'
            : type === 'non_unit_stride' || type === 'broadcast' || type === 'strided'
              ? 'bar-warn'
              : 'bar-good';
        const share = ((count / total) * 100).toFixed(0);
        return `
          <div class="bar-row">
            <span class="bar-label">${escapeHtml(type)}</span>
            <div class="bar-track">
              <div class="bar-fill ${cls}" style="width:${share}%"></div>
            </div>
            <span class="bar-count">${count}</span>
          </div>`;
      })
      .join('');

    return `
      <div class="section">
        <h3>Распределение паттернов</h3>
        ${rows}
      </div>
    `;
  }

  private renderPatternsTable(patterns: AggregatedPattern[]): string {
    if (patterns.length === 0) {
      return '';
    }

    // Сортируем по misses_total: самые «дорогие» строки сверху.
    const sorted = [...patterns].sort((a, b) => {
      if (b.misses_total !== a.misses_total) return b.misses_total - a.misses_total;
      return a.source_line - b.source_line;
    });

    const rows = sorted
      .map((p) => {
        const patternCls =
          p.pattern_type === 'gather_scatter' || p.pattern_type === 'indirect' || p.pattern_type === 'random'
            ? 'badge-bad'
            : p.pattern_type === 'non_unit_stride' || p.pattern_type === 'broadcast' || p.pattern_type === 'strided'
              ? 'badge-warn'
              : 'badge-good';

        const levelCls = p.cache_level === 'L1' ? 'level-l1' : p.cache_level === 'L2' ? 'level-l2' : '';
        const stride = typeof p.stride === 'number' ? formatStride(p.stride) : '—';
        const alignment = p.alignment != null ? String(p.alignment) : '—';
        const fp = p.pattern_fingerprint
          ? `<code title="${escapeHtml(p.pattern_fingerprint)}">${escapeHtml(p.pattern_fingerprint.slice(0, 10))}…</code>`
          : '—';

        return `
          <tr class="pattern-row" data-line="${p.source_line}" data-column="${p.source_column}">
            <td>${p.sequence_index}</td>
            <td>${p.source_line}:${p.source_column}</td>
            <td><code>${escapeHtml(p.function || '—')}</code></td>
            <td><code>${escapeHtml(p.base_symbol)}</code></td>
            <td><span class="badge ${patternCls}">${escapeHtml(p.pattern_type)}</span></td>
            <td>${escapeHtml(p.access_kind || '—')}</td>
            <td>${stride}</td>
            <td>${p.depth}</td>
            <td>${(p.fill_factor * 100).toFixed(0)}%</td>
            <td><span class="level-pill ${levelCls}">${escapeHtml(p.cache_level || '—')}</span></td>
            <td class="num">${p.misses_total.toLocaleString()}</td>
            <td class="num small">${p.misses_read.toLocaleString()} / ${p.misses_write.toLocaleString()}</td>
            <td class="small">${formatBytes(p.working_set_bytes)}</td>
            <td class="num small">${p.load_count} / ${p.store_count}</td>
            <td class="small">${escapeHtml(p.dependence || '—')}</td>
            <td class="small">${alignment}</td>
            <td class="small">${fp}</td>
          </tr>`;
      })
      .join('');

    return `
      <div class="section">
        <h3>Паттерны (${patterns.length})</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Строка</th>
                <th>Функция</th>
                <th>Символ</th>
                <th>Паттерн</th>
                <th>Доступ</th>
                <th>Шаг</th>
                <th>Глуб.</th>
                <th>Заполн.</th>
                <th>Кэш</th>
                <th>Промахи</th>
                <th>Чт./зап.</th>
                <th>РБ</th>
                <th>З/З</th>
                <th>Завис.</th>
                <th>Выравн.</th>
                <th>Отпечаток</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private getDetailedHtml(results: AnalysisEntry[]): string {
    const patternCounts: Record<string, number> = {};
    let totalAccesses = 0;
    let totalMisses = 0;

    for (const r of results) {
      patternCounts[r.pattern_type] = (patternCounts[r.pattern_type] || 0) + 1;
      totalAccesses += r.access_count;
      totalMisses += r.miss_count;
    }

    const overallMissRate = totalAccesses > 0 ? ((totalMisses / totalAccesses) * 100).toFixed(2) : '0';

    const patternBars = Object.entries(patternCounts)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([type, count]) => `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(type)}</span>
          <div class="bar-track">
            <div class="bar-fill ${type === 'gather_scatter' ? 'bar-bad' : type === 'unit_stride' ? 'bar-good' : 'bar-warn'}"
                 style="width:${(count / results.length) * 100}%"></div>
          </div>
          <span class="bar-count">${count}</span>
        </div>`,
      )
      .join('');

    const tableRows = results
      .sort((a, b) => b.miss_rate - a.miss_rate)
      .map(
        (r) => `
        <tr class="pattern-row row-${r.severity}" data-line="${r.source_line}" data-column="${r.source_column}">
          <td>${r.source_line}</td>
          <td><code>${escapeHtml(r.base_symbol)}[${escapeHtml(r.index_expr)}]</code></td>
          <td><span class="badge badge-${r.pattern_type === 'unit_stride' ? 'good' : r.pattern_type === 'gather_scatter' ? 'bad' : 'warn'}">${escapeHtml(r.pattern_type)}</span></td>
          <td>${r.stride}</td>
          <td>${(r.fill_factor * 100).toFixed(0)}%</td>
          <td class="${r.miss_rate > 0.5 ? 'text-bad' : r.miss_rate > 0.1 ? 'text-warn' : 'text-good'}">${(r.miss_rate * 100).toFixed(1)}%</td>
          <td>${r.access_count.toLocaleString()}</td>
          <td>${escapeHtml(r.function_name)}</td>
        </tr>`,
      )
      .join('');

    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <style>${BASE_STYLES}${SERVER_STYLES}</style>
</head>
<body>
  <h2>📊 Отчёт: доступ к памяти и кэш</h2>
  <div class="summary">
    <div class="card"><div class="card-value">${results.length}</div><div class="card-label">Обращения</div></div>
    <div class="card"><div class="card-value" style="color:${Number(overallMissRate) > 30 ? '#f44336' : '#4caf50'}">${overallMissRate}%</div><div class="card-label">Промахи, %</div></div>
    <div class="card"><div class="card-value">${Object.keys(patternCounts).length}</div><div class="card-label">Паттерны</div></div>
  </div>
  <div class="section"><h3>Распределение паттернов</h3>${patternBars}</div>
  <div class="section"><h3>Все обращения</h3>
    <div class="table-wrap">
      <table><thead><tr><th>Строка</th><th>Символ</th><th>Паттерн</th><th>Шаг</th><th>Заполн.</th><th>Промах %</th><th>Обращения</th><th>Функция</th></tr></thead>
      <tbody>${tableRows}</tbody></table>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('tr.pattern-row').forEach((row) => {
      row.addEventListener('click', () => {
        const line = parseInt(row.getAttribute('data-line') || '1', 10);
        const column = parseInt(row.getAttribute('data-column') || '1', 10);
        vscode.postMessage({ command: 'goToLine', line, column });
      });
    });
  </script>
</body></html>`;
  }
}

const BASE_STYLES = `
  :root { --bg: #1e1e1e; --fg: #ccc; --border: #333; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; margin: 0; font-size: 13px; }
  h2 { color: #fff; margin: 0 0 12px; font-size: 16px; }
  h3 { color: #ddd; margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .card { background: #252526; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .card-value { font-size: 22px; font-weight: 700; color: #fff; }
  .card-label { font-size: 11px; color: #888; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .section { margin-bottom: 20px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .bar-label { width: 140px; font-size: 12px; text-align: right; }
  .bar-track { flex: 1; height: 16px; background: #333; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-good { background: #4caf50; } .bar-warn { background: #ff9800; } .bar-bad { background: #f44336; }
  .bar-count { width: 32px; font-size: 12px; color: #aaa; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #252526; position: sticky; top: 0; text-align: left; padding: 7px 6px; font-size: 11px; color: #888; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 6px; border-bottom: 1px solid #2a2a2a; font-size: 12px; }
  tr.pattern-row { cursor: pointer; }
  tr.pattern-row:hover { background: #2a2d3a; }
  .row-error { border-left: 3px solid #f44336; } .row-warning { border-left: 3px solid #ff9800; } .row-info { border-left: 3px solid #4caf50; }
  code { background: #333; padding: 2px 5px; border-radius: 3px; font-size: 11px; }
  .badge { padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; display: inline-block; }
  .badge-good { background: #1b3a1b; color: #4caf50; } .badge-warn { background: #3a2e1b; color: #ff9800; } .badge-bad { background: #3a1b1b; color: #f44336; }
  .text-good { color: #4caf50; font-weight: 600; } .text-warn { color: #ff9800; font-weight: 600; } .text-bad { color: #f44336; font-weight: 600; }
  .gauge { margin-top: 12px; }
  .gauge-label { font-size: 12px; color: #aaa; margin-bottom: 6px; display: flex; justify-content: space-between; }
  .gauge-track { height: 10px; background: #333; border-radius: 5px; overflow: hidden; }
  .gauge-fill { height: 100%; border-radius: 5px; transition: width 1s ease; }
  .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #2a2a2a; font-size: 13px; }
  .info-label { color: #888; }
  .info-value { color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
`;

const SERVER_STYLES = `
  .report-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .report-header h2 { margin: 0; }
  .header-meta { display: flex; align-items: center; gap: 8px; }
  .status-pill { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .status-done { background: #1b3a1b; color: #4caf50; }
  .status-error { background: #3a1b1b; color: #f44336; }
  .status-static_done, .status-cache_running, .status-static_running, .status-pending { background: #2a2a3a; color: #888; }
  .task-id { font-family: monospace; font-size: 11px; color: #666; }
  .error-banner { background: #3a1b1b; border: 1px solid #c62828; border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; }
  .error-title { color: #ff8a80; font-weight: 700; margin-bottom: 4px; }
  .error-body { color: #ffcdd2; font-size: 12px; white-space: pre-wrap; line-height: 1.45; }
  .error-hint { color: #b0a0a0; font-size: 11px; margin-top: 6px; }
  .reuse-banner { background: #2a1f3a; border: 1px solid #6a3aa0; border-radius: 8px; padding: 10px 14px; margin-bottom: 18px; color: #d8bfff; font-size: 12px; }
  .empty { padding: 16px; text-align: center; color: #666; font-size: 12px; }
  .table-wrap { overflow-x: auto; max-height: 60vh; }
  .level-pill { padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .level-l1 { background: #1e3050; color: #82b1ff; }
  .level-l2 { background: #3a2050; color: #b388ff; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  td.small { font-size: 11px; color: #aaa; }
`;

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatStride(stride: number): string {
  if (Math.abs(stride - Math.round(stride)) < 1e-6) return String(Math.round(stride));
  return stride.toFixed(2);
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
