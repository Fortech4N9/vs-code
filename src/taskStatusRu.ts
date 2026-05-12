/** Человекочитаемые подписи статусов задачи (как во фронте). */
export const TASK_STATUS_LABELS_RU: Record<string, string> = {
  pending: 'В очереди',
  static_running: 'Статический анализ…',
  static_done: 'Статика завершена',
  cache_running: 'Кэш-симуляция…',
  done: 'Завершено',
  error: 'Ошибка',
}

export function taskStatusLabelRu(status: string): string {
  const s = (status ?? '').trim()
  return TASK_STATUS_LABELS_RU[s] ?? s
}
