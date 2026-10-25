/** Called by the background census only. Source dispatch does not depend on mining. */
export type MiningStage = 'source' | 'aggregate' | 'commit' | 'alert' | 'purge';
export function miningFailureReason(error: unknown): string {
  const e = error as { message?: string; code?: string } | null;
  // Error messages may contain raw SQL/paths/credentials. Retain typed causes, never that text.
  if (e?.code && /^[A-Z0-9]{5}$/.test(e.code)) return `database-${e.code}`;
  if (e?.message && ['sql_mining_time_budget', 'sql_mining_window_cap', 'sql_corpus_source_denied',
    'invalid_sql_mining_scope', 'invalid_sql_mining_token', 'sql_mining_source_missing'].includes(e.message)) return e.message;
  return error instanceof Error ? 'dependency-error' : 'unknown-failure';
}
export async function boundedStage<T>(work: () => Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('sql_mining_time_budget')), budgetMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
