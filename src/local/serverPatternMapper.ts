import type {
  AggregatedPattern,
  AnalysisEntry,
  PatternType,
  Severity,
} from '../types';

/**
 * mapAggregatedToEntries — конвертирует «толстый» AggregatedPattern
 * из analysis-api в локальный AnalysisEntry, который понимают существующие
 * decoration/diagnostics/hover/codelens менеджеры.
 *
 * Тонкости:
 *  - Один статический паттерн может прийти дважды (L1, L2). Мы оставляем оба
 *    уровня для hover-подсказки: decoration всё равно группируется per-line,
 *    а пользователь видит полное описание по строке.
 *  - В access_count кладём load_count + store_count (динамики у нас может не
 *    быть). hit_count/miss_count считаем по misses_total / load+store.
 *  - severity подбираем по совокупности: «плохой» pattern_type сразу делает
 *    запись error/warning, и доля промахов > 50% — error.
 */
export function mapAggregatedToEntries(patterns: AggregatedPattern[]): AnalysisEntry[] {
  if (patterns.length === 0) return [];

  return patterns.map((p, idx) => {
    const accessCount = Math.max(0, (p.load_count || 0) + (p.store_count || 0));
    const missCount = Math.max(0, p.misses_total || 0);
    const hitCount = Math.max(0, accessCount - missCount);
    const missRate =
      accessCount > 0 ? Math.min(1, missCount / accessCount) : 1 - clamp(p.fill_factor || 0);

    const severity = computeSeverity(p, missRate);
    const patternType = normalizePatternType(p.pattern_type);
    const stride = typeof p.stride === 'number' ? p.stride : 0;

    return {
      id: `srv_${p.sequence_index ?? idx}_${p.cache_level || 'static'}_${p.base_symbol}`,
      source_line: Math.max(1, p.source_line || 1),
      source_column: Math.max(1, p.source_column || 1),
      source_file: p.source_file,
      sequence_index: p.sequence_index,
      base_symbol: p.base_symbol,
      base_kind: p.base_kind,
      index_expr: p.access_kind || '*',
      instruction: `${p.base_symbol}@${p.function || 'global'}`,
      pattern_type: patternType,
      raw_pattern_type: p.pattern_type,
      pattern_signature: p.pattern_signature,
      pattern_fingerprint: p.pattern_fingerprint,
      access_kind: p.access_kind,
      stride,
      element_size: 0,
      fill_factor: clamp(p.fill_factor || 0),
      cache_level: p.cache_level,
      access_count: accessCount,
      hit_count: hitCount,
      miss_count: missCount,
      misses_read: Math.max(0, p.misses_read || 0),
      misses_write: Math.max(0, p.misses_write || 0),
      miss_rate: missRate,
      cache_line_utilization: clamp(p.fill_factor || 0),
      loop_depth: p.depth || 0,
      working_set_bytes: p.working_set_bytes,
      load_count: p.load_count,
      store_count: p.store_count,
      dependence: p.dependence,
      alignment: p.alignment,
      cache_profile_hash: p.cache_profile_hash,
      function_name: p.function || '<global>',
      severity,
      suggestion: buildSuggestion(p),
    };
  });
}

function computeSeverity(p: AggregatedPattern, missRate: number): Severity {
  const t = (p.pattern_type || '').toLowerCase();
  if (t === 'gather_scatter' || t === 'indirect' || t === 'random') {
    return missRate > 0.3 ? 'error' : 'warning';
  }
  if (t === 'non_unit_stride' || t === 'broadcast' || t === 'strided') {
    return missRate > 0.5 ? 'error' : 'warning';
  }
  if (missRate >= 0.5) return 'error';
  if (missRate >= 0.2) return 'warning';
  return 'info';
}

function normalizePatternType(raw: string): PatternType {
  const t = (raw || '').toLowerCase();
  if (t === 'unit_stride') return 'unit_stride';
  if (t === 'non_unit_stride' || t === 'strided') return 'non_unit_stride';
  if (t === 'gather_scatter' || t === 'indirect') return 'gather_scatter';
  if (t === 'constant' || t === 'broadcast' || t === 'constant_stride') return 'constant';
  return 'random';
}

function buildSuggestion(p: AggregatedPattern): string {
  const t = (p.pattern_type || '').toLowerCase();
  const dep = p.dependence?.trim();
  const depHint = dep ? ` Зависимость: ${dep}.` : '';
  const strideHint =
    typeof p.stride === 'number' && Math.abs(p.stride) > 1
      ? ` Шаг ${p.stride} — теряется часть кэш-линии.`
      : '';

  switch (t) {
    case 'unit_stride':
      return `Линейный доступ — оптимальная утилизация кэш-линии.${depHint}`;
    case 'constant':
      return `Константный индекс — высокий повтор использования.${depHint}`;
    case 'constant_stride':
      return `Стабильный шаг — хорошее предсказание префетчинга.${strideHint}${depHint}`;
    case 'non_unit_stride':
    case 'strided':
      return `Шаг > 1 — рассмотрите AoS→SoA или объединение полей.${strideHint}${depHint}`;
    case 'broadcast':
      return `Broadcast — повтор одной кэш-линии (типично для редукций).${depHint}`;
    case 'gather_scatter':
    case 'indirect':
      return `Косвенный доступ — попробуйте сортировку индексов или blocking.${depHint}`;
    case 'random':
      return `Случайный паттерн — высокий процент промахов почти неизбежен.${depHint}`;
    default:
      return `Паттерн «${p.pattern_type || 'неизвестный'}».${depHint}`;
  }
}

function clamp(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
