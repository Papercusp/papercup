/**
 * bench-teardown — retire a benchmark run's work-items at run end so it never leaves DEBRIS in the
 * frontier (benchmark-coordination-topologies, recurrence fix).
 *
 * WHY: a crashed/finished xbench run left ~253 non-terminal work-items in the shared workspace; the
 * papercup-hive's WORKSPACE-WIDE survey treated them as ready→"Queen-unresolvable"→a ~13k aging-
 * escalation storm. The durable fix is for the bench driver to retire its own items at run end
 * (success, crash, AND signal-teardown paths). Idempotent + guarded: it only ever touches BENCHMARK
 * harnesses (xbench* / *instance_*), NEVER a real `papercup*` harness.
 */

/** Non-terminal feature states that, for a benchmark harness, are stale debris once the run is over. */
export const BENCH_NONTERMINAL_STATUSES = [
  'todo',
  'failing',
  'in_progress',
  'validating',
  'pending',
  'failed',
] as const;

/**
 * PURE: is this (harness_slug, status) a stale BENCHMARK work-item the run-end teardown should retire?
 * True iff it's a benchmark harness (xbench* or contains `instance_`) in a non-terminal state and NOT
 * a protected `papercup*` harness (the guard that makes a bulk retire safe). Mirrors the guarded SQL
 * in {@link retireBenchDebris} so the scope is unit-testable without PG.
 */
export function isStaleBenchDebris(harnessSlug: string, status: string): boolean {
  const isBench = /^xbench/.test(harnessSlug) || harnessSlug.includes('instance_');
  const isProtected = harnessSlug.startsWith('papercup');
  return isBench && !isProtected && (BENCH_NONTERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The minimal tagged-template sql surface {@link retireBenchDebris} needs (postgres-js shape). */
export type DebrisSql = <R = unknown>(strings: TemplateStringsArray, ...vals: unknown[]) => Promise<R[]>;

/**
 * Retire stale benchmark work-items (→ `deprecated`) so a finished OR crashed bench run leaves no
 * debris in the frontier. Idempotent + guarded (never touches `papercup*`). Call at run end + on
 * signal-teardown. Returns the count retired. Never throws into the caller — a best-effort cleanup.
 */
export async function retireBenchDebris(sql: DebrisSql, nowMs: number): Promise<number> {
  try {
    const rows = await sql<{ feature_id: string }>`
      UPDATE harness_shared.harness_features_consolidated
         SET status = 'deprecated', updated_ts = ${nowMs}
       WHERE (harness_slug LIKE 'xbench%' OR harness_slug LIKE '%instance\\_%' OR feature_id LIKE 'F-INSTANCE%')
         AND harness_slug NOT LIKE 'papercup%'
         AND status IN ('todo', 'failing', 'in_progress', 'validating', 'pending', 'failed')
      RETURNING feature_id`;
    return rows.length;
  } catch {
    return 0; // teardown is best-effort — never wedge a run on a cleanup failure
  }
}
