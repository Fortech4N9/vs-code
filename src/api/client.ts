import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import type {
  AggregatedPattern,
  AnalysisMetrics,
  AnalysisResultBundle,
  AnalysisTask,
} from '../types';

interface AuthResponse {
  token: string;
  user: { id: string; email: string };
}

const DEFAULT_API_URL = 'http://localhost:8080/api/v1';
const LEGACY_LOCAL_API_URL = 'http://localhost:80/api/v1';

export class ApiClient {
  private baseUrl: string;
  private token: string | undefined;
  private userEmail: string | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.baseUrl = this.readBaseUrl();
  }

  async loadToken(): Promise<void> {
    this.token = await this.context.secrets.get('analyzer_token');
    this.userEmail = this.context.globalState.get<string>('analyzer_email');
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  getEmail(): string | undefined {
    return this.userEmail;
  }

  refreshBaseUrl(): void {
    this.baseUrl = this.readBaseUrl();
  }

  private readBaseUrl(): string {
    return vscode.workspace
      .getConfiguration('analyzer')
      .get<string>('apiUrl', DEFAULT_API_URL);
  }

  /** Resolve the user's email from a linked GitHub or Microsoft account. */
  async resolveVSCodeEmail(): Promise<string> {
    const providers = ['github', 'microsoft'] as const;
    const scopes: Record<string, string[]> = {
      github: ['user:email'],
      microsoft: ['email', 'profile', 'openid'],
    };

    for (const provider of providers) {
      try {
        const session = await vscode.authentication.getSession(
          provider,
          scopes[provider],
          { silent: true },
        );
        if (session) {
          const email = this.extractEmail(session);
          if (email) {
            return email;
          }
        }
      } catch {
        // provider unavailable, try next
      }
    }

    // No silent session — ask the user to authorize GitHub (one-time browser popup)
    try {
      const session = await vscode.authentication.getSession(
        'github',
        ['user:email'],
        { createIfNone: true },
      );
      const email = this.extractEmail(session);
      if (email) {
        return email;
      }
    } catch {
      // user cancelled the GitHub auth popup
    }

    throw new NoAccountError();
  }

  private extractEmail(session: vscode.AuthenticationSession): string | null {
    const label = session.account.label;
    if (label.includes('@')) {
      return label;
    }
    // GitHub accounts without a public email — build a service email
    return `${label}@vscode-analyzer.local`;
  }

  /** Get or create a stable service password for this extension installation. */
  private async getServicePassword(): Promise<string> {
    const key = 'analyzer_service_pwd';
    let pwd = await this.context.secrets.get(key);
    if (!pwd) {
      pwd = crypto.randomBytes(32).toString('hex');
      await this.context.secrets.store(key, pwd);
    }
    return pwd;
  }

  /** Fully automatic auth: try login, fall back to register. */
  async autoAuthenticate(): Promise<string> {
    this.refreshBaseUrl();
    const email = await this.resolveVSCodeEmail();
    const password = await this.getServicePassword();

    // Try login first
    try {
      return await this.authenticate('login', email, password);
    } catch {
      // Login failed — account probably doesn't exist yet, register
    }

    try {
      return await this.authenticate('register', email, password);
    } catch {
      // Registration also failed — maybe account exists with different password, retry login
    }

    return this.authenticate('login', email, password);
  }

  async loginWithPassword(email: string, password: string): Promise<string> {
    this.refreshBaseUrl();
    return this.authenticate('login', email.trim(), password);
  }

  private async authenticate(mode: 'login' | 'register', email: string, password: string): Promise<string> {
    const resp = await this.request<AuthResponse>('POST', `/auth/${mode}`, { email, password });
    this.token = resp.token;
    this.userEmail = resp.user.email;
    await this.context.secrets.store('analyzer_token', resp.token);
    await this.context.globalState.update('analyzer_email', resp.user.email);
    return resp.user.email;
  }

  async logout(): Promise<void> {
    this.token = undefined;
    this.userEmail = undefined;
    await this.context.secrets.delete('analyzer_token');
    await this.context.globalState.update('analyzer_email', undefined);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestWithBase<T>(this.baseUrl, method, path, body).catch((err) => {
      if (this.shouldRetryLocal8080(err)) {
        return this.requestWithBase<T>(DEFAULT_API_URL, method, path, body);
      }
      throw err;
    });
  }

  private requestWithBase<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const base = baseUrl.replace(/\/+$/, '');
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const url = new URL(`${base}${cleanPath}`);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(data as unknown as T);
            }
          } else if (res.statusCode === 401) {
            this.token = undefined;
            reject(new Error('Session expired'));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`${err.message} (${method} ${url.toString()})`));
      });
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  private shouldRetryLocal8080(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      this.baseUrl.replace(/\/+$/, '') === LEGACY_LOCAL_API_URL &&
      (message.includes('ECONNREFUSED') || message.includes('socket hang up'))
    );
  }

  /** Find or create a default project for the extension. */
  async getOrCreateProject(): Promise<string> {
    const savedId = this.context.globalState.get<string>('analyzer_project_id');
    if (savedId) {
      return savedId;
    }

    const projects = await this.request<{ projects: Array<{ id: string; name: string }> }>(
      'GET', '/projects',
    );

    const existing = projects.projects?.find((p) => p.name === 'VSCode Analyzer');
    if (existing) {
      await this.context.globalState.update('analyzer_project_id', existing.id);
      return existing.id;
    }

    const created = await this.request<{ id: string; name: string }>(
      'POST', '/projects', { name: 'VSCode Analyzer' },
    );
    await this.context.globalState.update('analyzer_project_id', created.id);
    return created.id;
  }

  /** Upload code as a .c file via multipart form to the real /analysis/upload endpoint. */
  async submitAnalysis(code: string, fileName: string): Promise<AnalysisTask> {
    const projectId = await this.getOrCreateProject();

    const boundary = `----ExtBoundary${Date.now()}`;
    const fileBuffer = Buffer.from(code, 'utf-8');

    const parts: Buffer[] = [];

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="project_id"\r\n\r\n` +
      `${projectId}\r\n`,
    ));

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: text/x-csrc\r\n\r\n`,
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const resp = await this.multipartRequest<{ task: AnalysisTask }>(
      '/analysis/upload', body, boundary,
    );
    return resp.task;
  }

  private multipartRequest<T>(path: string, body: Buffer, boundary: string): Promise<T> {
    return this.multipartRequestWithBase<T>(this.baseUrl, path, body, boundary).catch((err) => {
      if (this.shouldRetryLocal8080(err)) {
        return this.multipartRequestWithBase<T>(DEFAULT_API_URL, path, body, boundary);
      }
      throw err;
    });
  }

  private multipartRequestWithBase<T>(
    baseUrl: string,
    path: string,
    body: Buffer,
    boundary: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const base = baseUrl.replace(/\/+$/, '');
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const url = new URL(`${base}${cleanPath}`);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(data as unknown as T);
            }
          } else if (res.statusCode === 401) {
            this.token = undefined;
            reject(new Error('Session expired'));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`${err.message} (POST ${url.toString()})`));
      });
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  async getTaskStatus(taskId: string): Promise<AnalysisTask> {
    return this.request<AnalysisTask>('GET', `/analysis/tasks/${taskId}`);
  }

  async getTaskMetrics(taskId: string): Promise<AnalysisMetrics> {
    return this.request<AnalysisMetrics>('GET', `/analysis/tasks/${taskId}/metrics`);
  }

  /** /tasks/:id/aggregated — JOIN static_patterns + dynamic_pattern_metrics. */
  async getTaskAggregated(taskId: string): Promise<AggregatedPattern[]> {
    const resp = await this.request<{ patterns: AggregatedPattern[] }>(
      'GET',
      `/analysis/tasks/${taskId}/aggregated`,
    );
    return Array.isArray(resp.patterns) ? resp.patterns : [];
  }

  /** /tasks/:id/static-patterns — нет JOIN-а с динамикой. Полезно, если
   *  cache-стадия упала, а статика всё равно собралась. */
  async getTaskStaticPatterns(taskId: string): Promise<AggregatedPattern[]> {
    const resp = await this.request<{ patterns: AggregatedPattern[] }>(
      'GET',
      `/analysis/tasks/${taskId}/static-patterns`,
    );
    return Array.isArray(resp.patterns) ? resp.patterns : [];
  }

  /** pollUntilDone — ждёт terminal-статуса задачи и собирает «толстый» bundle:
   *  status + (если успели) metrics + (если статика собрана) patterns. На
   *  ошибке НЕ бросает исключение, чтобы UI смог показать статические данные
   *  и причину падения. Исключение поднимается только на сетевых сбоях. */
  async pollUntilDone(
    taskId: string,
    onProgress?: (status: string) => void,
  ): Promise<AnalysisResultBundle> {
    const intervalMs = vscode.workspace
      .getConfiguration('analyzer')
      .get<number>('pollingIntervalMs', 2500);

    const terminalStatuses = ['done', 'error'];

    let task = await this.getTaskStatus(taskId);
    onProgress?.(task.status);

    while (!terminalStatuses.includes(task.status)) {
      await new Promise((r) => setTimeout(r, intervalMs));
      task = await this.getTaskStatus(taskId);
      onProgress?.(task.status);
    }

    const [metricsResult, aggregatedResult] = await Promise.allSettled([
      this.getTaskMetrics(taskId),
      this.getTaskAggregated(taskId),
    ]);

    const metrics =
      metricsResult.status === 'fulfilled' ? metricsResult.value : null;
    let patterns =
      aggregatedResult.status === 'fulfilled' ? aggregatedResult.value : [];

    // Если динамика не успела (типичный кейс — упал cache stage из-за float),
    // /aggregated будет пустым, но /static-patterns ещё что-то отдаст.
    if (patterns.length === 0) {
      try {
        patterns = await this.getTaskStaticPatterns(taskId);
      } catch {
        // тихо игнорируем — UI просто отрисует placeholder
      }
    }

    return { task, metrics, patterns };
  }
}

export class NoAccountError extends Error {
  constructor() {
    super(
      'Учётная запись VS Code не найдена. Выполните вход:\n' +
        '1. Нажмите на иконку пользователя в левом нижнем углу VS Code\n' +
        '2. Войдите через GitHub или Microsoft\n' +
        '3. Запустите анализ снова',
    );
    this.name = 'NoAccountError';
  }
}
