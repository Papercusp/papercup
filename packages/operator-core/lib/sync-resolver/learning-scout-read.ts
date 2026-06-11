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
 *     migration 208, mirroring watchdog_ticks: tick_at / status ran|gated|error /
 *     gate / detail jsonb). The migration may not be applied yet on a given
 *     substrate, so the read is best-effort: undefined-table (42P01) silently
 *     omits the tick half, any other error warns + omits, and
 *     {@link normalizeScoutTick} maps the row into one stable shape for the UI.
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
  /** The tick's outcome (migration 208 `status`: ran | gated | error). */
  outcome: string | null;
  /** The named self-gate for gated ticks (min-interval | no-trigger | circuit), or the error/reason detail. */
  detail: string | null;
}

/** One routed idea, as the Scout view lists it (the ledger row, UI-shaped). */
export interface ScoutRoutedItem {
  ideaId: string;
  /** Creative lens that produced the idea (analogical | reframing | …). */
  lens: string;
  /** The rail it routed into: 'plan' | 'gym' | 'improvement' | 'instance' (open set). */
  rail: string;
  /** Change-feed ref of the created artifact: "plan:<slug>" | "wi:EI-…" | "gym:…". */
  routedRef: string;
  title: string | null;
  /** ISO timestamp of routing. */
  routedAt: string | null;
  /** Cached outcome from the change-feed join (won/lost/pending), when classified. */
  outcome: string | null;
}

export interface ScoutSnapshot {
  totalRouted: number;
  railCounts: ScoutRailCount[];
  /** Newest routed ideas (ledger rows, newest-first) — the per-item view across ALL rails. */
  recent: ScoutRoutedItem[];
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
 * Map one scout_ticks row into the stable UI shape. Pinned to the migration-208
 * columns (`tick_at` / `status` / `gate` / `detail` jsonb) with mild tolerance
 * for alternate spellings so a schema tweak degrades to nulls, never a crash.
 */
export function normalizeScoutTick(row: Record<string, unknown> | null | undefined): ScoutTickSummary | null {
  if (!row) return null;
  const detailObj =
    row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : null;
  return {
    at: toIso(row.tick_at ?? row.ticked_at ?? row.created_at ?? row.at),
    outcome: firstString(row, ['status', 'gate_outcome', 'outcome', 'decision']),
    detail:
      firstString(row, ['gate', 'gate_reason', 'reason', 'note']) ??
      (detailObj ? firstString(detailObj, ['reason', 'error', 'stop']) : null),
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

  // The per-item half: newest ledger rows so the tab can show WHICH ideas
  // routed where (owner ask 2026-06-11), not just counts. routed_at is
  // epoch-ms (bigint) in migration 194.
  const items = (await sql`
    SELECT idea_id, lens, rail, routed_ref, title, routed_at, outcome
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${workspaceId}
     ORDER BY routed_at DESC
     LIMIT 50
  `) as Array<Record<string, unknown>>;
  const recent: ScoutRoutedItem[] = items.map((r) => ({
    ideaId: String(r.idea_id ?? ''),
    lens: String(r.lens ?? ''),
    rail: String(r.rail ?? ''),
    routedRef: String(r.routed_ref ?? ''),
    title: typeof r.title === 'string' && r.title ? r.title : null,
    routedAt: toIso(typeof r.routed_at === 'string' ? Number(r.routed_at) : r.routed_at),
    outcome: typeof r.outcome === 'string' && r.outcome ? r.outcome : null,
  }));

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

  return { totalRouted, railCounts, recent, lastTick };
}
