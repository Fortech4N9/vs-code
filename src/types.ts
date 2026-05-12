export interface AnalysisEntry {
  id: string;
  source_line: number;
  source_column: number;
  source_file?: string;
  sequence_index?: number;
  base_symbol: string;
  base_kind?: string;
  index_expr: string;
  instruction: string;
  pattern_type: PatternType;
  raw_pattern_type?: string;
  pattern_signature?: string;
  pattern_fingerprint?: string;
  access_kind?: string;
  stride: number;
  element_size: number;
  fill_factor: number;
  cache_level?: string;
  access_count: number;
  hit_count: number;
  miss_count: number;
  misses_read?: number;
  misses_write?: number;
  miss_rate: number;
  cache_line_utilization: number;
  loop_depth: number;
  working_set_bytes?: number;
  load_count?: number;
  store_count?: number;
  dependence?: string;
  alignment?: number | null;
  cache_profile_hash?: string;
  function_name: string;
  severity: Severity;
  suggestion: string;
}

export type PatternType =
  | 'unit_stride'
  | 'non_unit_stride'
  | 'gather_scatter'
  | 'constant'
  | 'random';

export type Severity = 'info' | 'warning' | 'error';

export interface AnalysisTask {
  id: string;
  file_id: string;
  status: 'pending' | 'static_running' | 'static_done' | 'cache_running' | 'done' | 'error';
  type: string;
  error_message?: string;
  reused_from_task_id?: string;
  static_artifact_s3_path?: string;
  cache_artifact_s3_path?: string;
  created_at: string;
  updated_at: string;
}

export interface AnalysisMetrics {
  task_id: string;
  status: string;
  total_memory_accesses: number;
  cache_hits: number;
  cache_misses: number;
  hit_rate: number;
  miss_rate: number;
  optimization_score: number;
}

// AggregatedPattern зеркалит analysis-api `AggregatedEntry`. Один и тот же
// статический паттерн (по fingerprint) приезжает дважды, если для него есть
// и L1, и L2 динамические метрики; поле cache_level различает строки.
export interface AggregatedPattern {
  sequence_index: number;
  source_file: string;
  source_line: number;
  source_column: number;
  base_symbol: string;
  base_kind: string;
  function: string;
  pattern_type: string;
  pattern_fingerprint: string;
  pattern_signature: string;
  access_kind: string;
  affine: number;
  stride?: number | null;
  depth: number;
  fill_factor: number;
  has_indexed_addressing: number;
  indexed_by_memory: number;
  conditional: number;
  alignment?: number | null;
  working_set_bytes: number;
  dependence: string;
  contiguous_block?: number | null;
  load_count: number;
  store_count: number;
  cache_profile_hash: string;
  cache_level: string;
  source_task_id?: string;
  misses_total: number;
  misses_read: number;
  misses_write: number;
}

// AnalysisResultBundle — единый «контракт» серверного ответа для UI VS Code.
// metrics и patterns могут быть пустыми (метрики — если не было cache-симуляции,
// patterns — если упал статический анализ); task.error_message заполнен,
// когда какая-то стадия упала, и UI должен это показать без блокировки.
export interface AnalysisResultBundle {
  task: AnalysisTask;
  metrics: AnalysisMetrics | null;
  patterns: AggregatedPattern[];
}
