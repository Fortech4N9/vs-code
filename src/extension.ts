import * as vscode from 'vscode';
import { ApiClient, NoAccountError } from './api/client';
import { DecorationManager } from './providers/decorationManager';
import { AnalysisHoverProvider } from './providers/hoverProvider';
import { DiagnosticsManager } from './providers/diagnosticsManager';
import { AnalysisCodeLensProvider } from './providers/codeLensProvider';
import { ReportPanel } from './ui/reportPanel';
import { taskStatusLabelRu } from './taskStatusRu';
import { initTreeSitter, isReady, analyzeLocally } from './local/treeSitterAnalyzer';
import { mapAggregatedToEntries } from './local/serverPatternMapper';
import {
  CACHE_SIMULATOR_SAMPLE_JSON,
  type AnalysisEntry,
  type AnalysisMetrics,
  type AnalysisResultBundle,
  type CacheSimulatorConfig,
} from './types';

let lastResults: AnalysisEntry[] = [];
let lastBundle: AnalysisResultBundle | undefined;
let statusBarItem: vscode.StatusBarItem;
let cacheSimulatorStatusItem: vscode.StatusBarItem;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

type CacheSimPickRow = vscode.QuickPickItem & { rowAction: 'existing' | 'upload' };

export function activate(context: vscode.ExtensionContext): void {
  const apiClient = new ApiClient(context);
  const decorationManager = new DecorationManager();
  const diagnosticsManager = new DiagnosticsManager();
  const hoverProvider = new AnalysisHoverProvider();
  const codeLensProvider = new AnalysisCodeLensProvider();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'analyzer.runAnalysis';
  context.subscriptions.push(statusBarItem);

  cacheSimulatorStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  cacheSimulatorStatusItem.command = 'analyzer.selectCacheSimulatorConfig';
  context.subscriptions.push(cacheSimulatorStatusItem);

  apiClient.loadToken().then(() => refreshStatusBars(apiClient));

  // ── Tree-sitter initialization ──────────────────────────
  initTreeSitter(context.extensionPath)
    .then(() => {
      console.log('Tree-sitter инициализирован');
      refreshStatusBars(apiClient);
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'c') {
        runLocalAnalysis(editor);
      }
    })
    .catch((err) => {
      console.warn('Ошибка инициализации Tree-sitter:', err?.message ?? err);
    });

  function runLocalAnalysis(editor: vscode.TextEditor): void {
    if (!isReady()) return;
    try {
      const source = editor.document.getText();
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || 'input.c';
      const entries = analyzeLocally(source, fileName);

      lastResults = entries;
      lastBundle = undefined;

      if (entries.length > 0) {
        decorationManager.apply(editor, entries);
        diagnosticsManager.apply(editor.document, entries);
        hoverProvider.setResults(entries);
        codeLensProvider.setResults(entries);
      } else {
        decorationManager.clear(editor);
        diagnosticsManager.clear(editor.document.uri);
        hoverProvider.setResults([]);
        codeLensProvider.setResults([]);
      }
    } catch (err: any) {
      console.error('Ошибка локального анализа:', err);
    }
  }

  const hoverDisposable = vscode.languages.registerHoverProvider(
    { language: 'c', scheme: 'file' },
    hoverProvider,
  );

  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { language: 'c', scheme: 'file' },
    codeLensProvider,
  );

  async function ensureAuthenticated(): Promise<boolean> {
    if (apiClient.isAuthenticated()) {
      return true;
    }

    try {
      const email = await apiClient.autoAuthenticate();
      vscode.window.showInformationMessage(`Анализатор: подключено как ${email}`);
      refreshStatusBars(apiClient);
      return true;
    } catch (err: any) {
      if (err instanceof NoAccountError) {
        const action = await vscode.window.showErrorMessage(
          'Анализатор кэша: войдите в учётную запись VS Code (GitHub или Microsoft), чтобы использовать расширение.',
          'Войти через GitHub',
        );
        if (action === 'Войти через GitHub') {
          try {
            await vscode.authentication.getSession('github', ['user:email'], { createIfNone: true });
            return ensureAuthenticated();
          } catch {
            return false;
          }
        }
        return false;
      }
      const action = await vscode.window.showErrorMessage(
        `Ошибка автоматического входа: ${err.message}`,
        'Войти через email',
      );
      if (action === 'Войти через email') {
        return promptPlatformLogin();
      }
      return false;
    }
  }

  async function promptPlatformLogin(): Promise<boolean> {
    const email = await vscode.window.showInputBox({
      title: 'Вход в Diploma Platform',
      prompt: 'Введите email пользователя платформы',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'Email обязателен';
        if (!trimmed.includes('@')) return 'Введите корректный email';
        return undefined;
      },
    });
    if (!email) {
      return false;
    }

    const password = await vscode.window.showInputBox({
      title: 'Вход в Diploma Platform',
      prompt: `Пароль для ${email.trim()}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.length === 0 ? 'Пароль обязателен' : undefined),
    });
    if (!password) {
      return false;
    }

    try {
      const loggedInEmail = await apiClient.loginWithPassword(email, password);
      vscode.window.showInformationMessage(`Анализатор: подключено как ${loggedInEmail}`);
      refreshStatusBars(apiClient);
      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Не удалось войти: ${err.message}`);
      return false;
    }
  }

  function updateStatusBar(client: ApiClient): void {
    if (client.isAuthenticated()) {
      const email = client.getEmail() || 'user';
      statusBarItem.text = `$(pass-filled) Анализатор: ${email}`;
      statusBarItem.tooltip = 'Анализатор кэша — выполнен вход';
    } else {
      statusBarItem.text = '$(beaker) Анализатор';
      statusBarItem.tooltip = 'Анализатор кэша — при первом запуске выполнится авто-подключение';
    }
    statusBarItem.show();
  }

  function refreshStatusBars(client: ApiClient): void {
    updateStatusBar(client);
    const id = client.getStoredCacheSimulatorConfigId();
    if (id) {
      cacheSimulatorStatusItem.text = `$(library) симулятор: ${id.slice(0, 8)}…`;
      cacheSimulatorStatusItem.tooltip = `Активный JSON-конфиг симулятора кэша.\nПолный id: ${id}\nКоманда или клик — сменить.`;
    } else {
      cacheSimulatorStatusItem.text = '$(warning) симулятор: не выбран';
      cacheSimulatorStatusItem.tooltip = 'Не выбран конфиг симулятора (analysis/cache-configs). Кликните, чтобы выбрать или загрузить .json.';
    }
    cacheSimulatorStatusItem.show();
  }

  function formatKb(n: number): string {
    if (n <= 0) return '0 KiB';
    return `${Math.max(n / 1024, 0.01).toFixed(1)} KiB`;
  }

  /** Загрузка JSON из диска → POST cache-configs, сохраняет id активного конфига. */
  async function uploadCacheSimulatorConfigFromDisk(): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: 'JSON-конфиг симулятора кэша',
      canSelectMany: false,
      openLabel: 'Загрузить на сервер',
      filters: { 'JSON конфиг': ['json'] },
    });
    const uri = uris?.[0];
    if (!uri) return undefined;

    const bytes = await vscode.workspace.fs.readFile(uri);
    const baseName =
      decodeURIComponent(uri.fsPath.replace(/\\/g, '/').split('/').pop() || 'simulator-config.json');

    const displayName =
      (
        await vscode.window.showInputBox({
          title: 'Отображаемое имя конфига',
          prompt: 'Необязательно; если пусто — подставится из имени файла',
          value: baseName.replace(/\.json$/i, ''),
          ignoreFocusOut: true,
        })
      )?.trim() ?? '';

    try {
      const cfg = await apiClient.uploadCacheSimulatorConfig(bytes, baseName, displayName || undefined);
      await apiClient.setStoredCacheSimulatorConfigId(cfg.id);
      refreshStatusBars(apiClient);
      vscode.window.showInformationMessage(`Конфиг симулятора загружен: ${cfg.display_name}`);
      return cfg.id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Не удалось загрузить конфиг: ${msg}`);
      return undefined;
    }
  }

  async function pickActiveCacheSimulatorConfig(): Promise<void> {
    if (!(await ensureAuthenticated())) {
      return;
    }
    apiClient.refreshBaseUrl();

    let list: CacheSimulatorConfig[] = [];
    try {
      list = await apiClient.listCacheSimulatorConfigs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Список конфигов недоступен: ${msg}`);
      return;
    }

    const uploadRow: CacheSimPickRow = {
      label: '$(cloud-upload) Загрузить новый файл .json с диска…',
      description: '',
      rowAction: 'upload',
    };

    const rows: CacheSimPickRow[] = [
      uploadRow,
      ...list.map((c): CacheSimPickRow => ({
        label: c.display_name || c.original_filename,
        description: c.id,
        detail: `${c.original_filename}, ${formatKb(c.size_bytes)}`,
        rowAction: 'existing',
      })),
    ];

    const sel = await vscode.window.showQuickPick(rows, {
      title: 'Конфиг симулятора кэша',
      placeHolder:
        rows.length <= 1
          ? 'Сначала добавьте JSON-конфиг (до 256 KiB, как во встроенном Sandbox)'
          : 'Выберите существующий конфиг или загрузите новый',
    });

    if (!sel?.rowAction) {
      return;
    }

    if (sel.rowAction === 'upload') {
      await uploadCacheSimulatorConfigFromDisk();
      return;
    }

    if (sel.rowAction === 'existing' && sel.description) {
      await apiClient.setStoredCacheSimulatorConfigId(sel.description);
      refreshStatusBars(apiClient);
      const meta = list.find((c) => c.id === sel.description);
      vscode.window.showInformationMessage(
        meta ? `Активный конфиг: ${meta.display_name}` : 'Конфиг симулятора выбран',
      );
    }
  }

  async function resolveSimulatorConfigIdBeforeUpload(): Promise<string | undefined> {
    const cached = apiClient.getStoredCacheSimulatorConfigId();
    if (cached) {
      return cached;
    }

    const go = await vscode.window.showWarningMessage(
      'Для серверного анализа нужен JSON-конфиг симулятора кэша (команда добавления — как во встроенном Sandbox).',
      'Выбрать или загрузить…',
      'Отмена',
    );
    if (go !== 'Выбрать или загрузить…') {
      return undefined;
    }

    await pickActiveCacheSimulatorConfig();
    return apiClient.getStoredCacheSimulatorConfigId();
  }

  /**
   * applyServerResultToEditor — главный «маршалер» серверного ответа в IDE.
   * Если bundle.patterns не пустой — рисуем per-line декорации и диагностики
   * по реальным строкам (как фронт-Sandbox). Иначе, если есть metrics — рисуем
   * одну summary-декорацию на первой строке (как раньше), чтобы пользователь
   * хотя бы видел итоговые метрики.
   */
  function applyServerResultToEditor(
    editor: vscode.TextEditor,
    bundle: AnalysisResultBundle,
  ): void {
    lastBundle = bundle;
    const entries = mapAggregatedToEntries(bundle.patterns);

    if (entries.length > 0) {
      lastResults = entries;
      decorationManager.apply(editor, entries);
      diagnosticsManager.apply(editor.document, entries);
      hoverProvider.setResults(entries);
      codeLensProvider.setResults(entries);
      return;
    }

    if (bundle.metrics) {
      const summary = buildSummaryEntry(bundle.metrics);
      lastResults = summary;
      if (summary.length > 0) {
        decorationManager.apply(editor, summary);
        diagnosticsManager.apply(editor.document, summary);
        hoverProvider.setResults(summary);
        codeLensProvider.setResults(summary);
      }
      return;
    }

    lastResults = [];
    decorationManager.clear(editor);
    diagnosticsManager.clear(editor.document.uri);
    hoverProvider.setResults([]);
    codeLensProvider.setResults([]);
  }

  function buildSummaryEntry(metrics: AnalysisMetrics): AnalysisEntry[] {
    if (metrics.total_memory_accesses === 0) return [];

    const hitPct = (metrics.hit_rate * 100).toFixed(1);
    const missPct = (metrics.miss_rate * 100).toFixed(1);
    const score = metrics.optimization_score.toFixed(1);
    const totalAccesses = metrics.total_memory_accesses.toLocaleString();

    const severity: 'info' | 'warning' | 'error' =
      metrics.miss_rate > 0.5 ? 'error' : metrics.miss_rate > 0.2 ? 'warning' : 'info';

    return [
      {
        id: metrics.task_id,
        source_line: 1,
        source_column: 1,
        base_symbol: 'summary',
        index_expr: '*',
        instruction: '',
        pattern_type: 'unit_stride',
        stride: 0,
        element_size: 0,
        fill_factor: metrics.hit_rate,
        access_count: metrics.total_memory_accesses,
        hit_count: metrics.cache_hits,
        miss_count: metrics.cache_misses,
        miss_rate: metrics.miss_rate,
        cache_line_utilization: metrics.hit_rate,
        loop_depth: 0,
        function_name: 'file',
        severity,
        suggestion: `Попадания: ${hitPct}% | Промахи: ${missPct}% | Оценка: ${score} | Обращений: ${totalAccesses}`,
      },
    ];
  }

  const loginCommand = vscode.commands.registerCommand('analyzer.login', async () => {
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Войти через email платформы', value: 'email' },
        { label: 'Автовход через аккаунт VS Code', value: 'auto' },
      ],
      {
        title: 'Анализатор: вход',
        placeHolder: 'Выберите способ входа',
      },
    );
    if (!action) return;

    if (action.value === 'email') {
      await promptPlatformLogin();
      return;
    }

    await ensureAuthenticated();
  });

  const logoutCommand = vscode.commands.registerCommand('analyzer.logout', async () => {
    await apiClient.setStoredCacheSimulatorConfigId(undefined);
    await apiClient.logout();
    refreshStatusBars(apiClient);
    vscode.window.showInformationMessage('Вы вышли из анализатора');
  });

  const runAnalysisCommand = vscode.commands.registerCommand('analyzer.runAnalysis', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Сначала откройте файл на языке C');
      return;
    }

    if (editor.document.languageId !== 'c') {
      vscode.window.showWarningMessage('Анализатор работает только с файлами C');
      return;
    }

    if (!(await ensureAuthenticated())) {
      return;
    }

    apiClient.refreshBaseUrl();

    const simulatorConfigId = await resolveSimulatorConfigIdBeforeUpload();
    if (!simulatorConfigId) {
      vscode.window.showWarningMessage('Серверный анализ отменён: не выбран конфиг симулятора.');
      return;
    }

    const code = editor.document.getText();
    const fileName = editor.document.fileName.split(/[\\/]/).pop() || 'input.c';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Анализ кэша',
        cancellable: true,
      },
      async (progress) => {
        try {
          progress.report({ message: 'Загрузка файла…' });
          const task = await apiClient.submitAnalysis(code, fileName, simulatorConfigId);

          progress.report({ message: 'Ожидание анализа…' });
          const bundle = await apiClient.pollUntilDone(task.id, (status) => {
            progress.report({ message: taskStatusLabelRu(status) });
          });

          applyServerResultToEditor(editor, bundle);

          if (bundle.task.status === 'error') {
            // Не блокируем — статика всё равно может быть отрисована per-line.
            const reason =
              bundle.task.error_message?.trim() || 'Анализ на сервере завершился с ошибкой';
            const action = await vscode.window.showErrorMessage(
              `Анализатор: ${reason}`,
              'Показать отчёт',
            );
            if (action === 'Показать отчёт') {
              ReportPanel.showServerReport(context.extensionUri, bundle);
            }
            return;
          }

          const metrics = bundle.metrics;
          const patternsCount = bundle.patterns.length;
          const summary = metrics
            ? `Попадания: ${(metrics.hit_rate * 100).toFixed(1)}%, промахи: ${(metrics.miss_rate * 100).toFixed(1)}%, оценка: ${metrics.optimization_score.toFixed(1)}`
            : 'Метрик кэша нет';
          const reuseHint = bundle.task.reused_from_task_id
            ? ` (переиспользовано из ${bundle.task.reused_from_task_id.slice(0, 8)})`
            : '';
          const action = await vscode.window.showInformationMessage(
            `Анализ завершён — ${summary}, паттернов: ${patternsCount}${reuseHint}`,
            'Показать отчёт',
          );

          if (action === 'Показать отчёт') {
            ReportPanel.showServerReport(context.extensionUri, bundle);
          }
        } catch (err: any) {
          if (err.message?.includes('expired') || err.message?.includes('Session expired')) {
            await apiClient.setStoredCacheSimulatorConfigId(undefined);
            await apiClient.logout();
            refreshStatusBars(apiClient);
            vscode.window.showWarningMessage('Сессия истекла — запустите анализ снова для повторного входа');
          } else {
            vscode.window.showErrorMessage(`Ошибка анализа: ${err.message}`);
          }
        }
      },
    );
  });

  const clearCommand = vscode.commands.registerCommand('analyzer.clearDecorations', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      decorationManager.clear(editor);
      diagnosticsManager.clear(editor.document.uri);
      hoverProvider.setResults([]);
      codeLensProvider.setResults([]);
      lastResults = [];
      lastBundle = undefined;
    }
  });

  const showReportCommand = vscode.commands.registerCommand('analyzer.showReport', () => {
    if (lastBundle) {
      ReportPanel.showServerReport(context.extensionUri, lastBundle);
      return;
    }
    if (lastResults.length > 0) {
      ReportPanel.show(context.extensionUri, lastResults);
      return;
    }
    vscode.window.showWarningMessage('Сначала запустите анализ');
  });

  const localAnalysisCommand = vscode.commands.registerCommand('analyzer.localAnalysis', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'c') {
      vscode.window.showWarningMessage('Сначала откройте файл на языке C');
      return;
    }
    if (!isReady()) {
      vscode.window.showWarningMessage('Дождитесь инициализации Tree-sitter…');
      return;
    }
    runLocalAnalysis(editor);
    vscode.window.showInformationMessage(
      `Локальный анализ: найдено паттернов доступа: ${lastResults.length}`,
    );
  });

  const selectCacheSimulatorConfigCommand = vscode.commands.registerCommand(
    'analyzer.selectCacheSimulatorConfig',
    () => pickActiveCacheSimulatorConfig(),
  );

  const addCacheSimulatorConfigCommand = vscode.commands.registerCommand(
    'analyzer.addCacheSimulatorConfig',
    async () => {
      if (!(await ensureAuthenticated())) {
        return;
      }
      await uploadCacheSimulatorConfigFromDisk();
    },
  );

  const newSampleCacheSimulatorConfigCommand = vscode.commands.registerCommand(
    'analyzer.newSampleCacheSimulatorConfig',
    async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: CACHE_SIMULATOR_SAMPLE_JSON,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(
        'Сохраните как .json и выполните «Анализатор: добавить конфиг симулятора (JSON)…» для отправки на сервер.',
      );
    },
  );

  const forgetCacheSimulatorConfigCommand = vscode.commands.registerCommand(
    'analyzer.forgetCacheSimulatorConfig',
    async () => {
      await apiClient.setStoredCacheSimulatorConfigId(undefined);
      refreshStatusBars(apiClient);
      vscode.window.showInformationMessage('Сохранённый конфиг симулятора сброшен');
    },
  );

  // ── Auto-analysis on text change (debounced) ────────────
  vscode.workspace.onDidChangeTextDocument((e) => {
    const auto = vscode.workspace.getConfiguration('analyzer').get<boolean>('autoLocalAnalysis', true);
    if (!auto || !isReady()) return;
    if (e.document.languageId !== 'c') return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runLocalAnalysis(editor), 800);
  });

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.languageId === 'c') {
      if (isReady()) {
        runLocalAnalysis(editor);
      } else if (lastResults.length > 0) {
        decorationManager.apply(editor, lastResults);
      }
    }
  });

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('analyzer')) {
      apiClient.refreshBaseUrl();
      const editor = vscode.window.activeTextEditor;
      if (editor && lastResults.length > 0) {
        decorationManager.apply(editor, lastResults);
      }
    }
  });

  context.subscriptions.push(
    hoverDisposable,
    codeLensDisposable,
    loginCommand,
    logoutCommand,
    runAnalysisCommand,
    clearCommand,
    showReportCommand,
    localAnalysisCommand,
    selectCacheSimulatorConfigCommand,
    addCacheSimulatorConfigCommand,
    newSampleCacheSimulatorConfigCommand,
    forgetCacheSimulatorConfigCommand,
    decorationManager,
    diagnosticsManager,
    codeLensProvider,
  );
}

export function deactivate(): void {}
