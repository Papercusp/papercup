/**
 * learning-scout-read.ts — the read behind the Learning tab's "Scout" sub-view
 * (learning-system-audit-improvements-2026-06-09 P-042).
 *
 * Two halves over the scout control-plane tables, both workspace-scoped:
 *
 *  1. **Routed ideas by rail** — `harness_shared.scout_routed_ideas` (migration
 *     194, written by recordRoutedIdea): how many ideas Scout has actually
 *     dispatched into each rail (plan draft / gym experiment / work item).
 *     Today the ledger is empty — the UI renders a graceful "Scout has not
 *     routed ideas yet" — and the count-by-rail is the first signal it isn't.
 *
 *  2. **Last tick** — `harness_shared.scout_ticks` (P-034 tick observability,
 *     landing separately, mirroring watchdog_ticks). The table may not exist
 *     yet, and its exact column names are owned by P-034 — so the read is
 *     best-effort: undefined-table (42P01) silently omits the tick half, any
 *     other error warns + omits, and {@link normalizeScoutTick} maps a row's
 *     plausible column spellings into one stable shape for the UI.
 *
 * Pure SQL over an injected `Sql` (mirrors iq-battery/benchmark-read) so the
 * resolver test can stub the seam. Lives next to the resolver (not lib/scout/)
 * because it is the Learning tab's read, not part of the scout engine.
 */
import type { Sql } from 'postgres';

export interface ScoutRailCount {
  /** The routing rail: 'plan' | 'gym' | 'wi' (open set — render what arrives). */
  rail: string;
  count: number;
}

export interface ScoutTickSummary {
  /** ISO timestamp of the tick, when derivable. */
  at: string | null;
  /** The gate outcome / status of the tick (e.g. ran | skipped | gated). */
  outcome: string | null;
  /** Free-form gate reason / detail when the row carries one. */
  detail: string | null;
}

export interface ScoutSnapshot {
  totalRouted: number;
  railCounts: ScoutRailCount[];
  /** Newest scout tick, or null when none recorded (or the table doesn't exist yet). */
  lastTick: ScoutTickSummary | null;
}

const UNDEFINED_TABLE = '42P01';

/** True when a PG error means "the relation doesn't exist" (pre-migration). */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Map one scout_ticks row into the stable UI shape. The P-034 schema mirrors
 * watchdog_ticks (`tick_at` / `status`), but this read predates the table —
 * so it tolerates the plausible spellings rather than pinning one.
 */
export function normalizeScoutTick(row: Record<string, unknown> | null | undefined): ScoutTickSummary | null {
  if (!row) return null;
  return {
    at: toIso(row.tick_at ?? row.ticked_at ?? row.created_at ?? row.at),
    outcome: firstString(row, ['gate_outcome', 'outcome', 'status', 'gate', 'decision']),
    detail: firstString(row, ['gate_reason', 'reason', 'detail', 'note']),
  };
}

/** Routed-ideas-by-rail + last tick for one workspace. */
export async function readScoutSnapshot(sql: Sql, workspaceId: string): Promise<ScoutSnapshot> {
  const rails = (await sql`
    SELECT rail, count(*)::int AS count
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${workspaceId}
     GROUP BY rail
     ORDER BY count DESC, rail ASC
  `) as Array<Record<string, unknown>>;
  const railCounts: ScoutRailCount[] = rails.map((r) => ({
    rail: String(r.rail ?? ''),
    count: Number(r.count ?? 0),
  }));
  const totalRouted = railCounts.reduce((sum, r) => sum + r.count, 0);

  // scout_ticks lands with P-034 (a peer owns the migration); until then — and
  // under any column-shape drift — omit the tick half rather than failing the
  // routed-ideas half.
  let lastTick: ScoutTickSummary | null = null;
  try {
    const ticks = (await sql`
      SELECT * FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
       ORDER BY tick_at DESC
       LIMIT 1
    `) as Array<Record<string, unknown>>;
    lastTick = normalizeScoutTick(ticks[0]);
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] tick read failed:', err instanceof Error ? err.message : err);
    }
  }

  return { totalRouted, railCounts, lastTick };
}
