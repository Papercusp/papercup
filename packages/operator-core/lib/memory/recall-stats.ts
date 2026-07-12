/**
 * memory_recall_stats writer + health aggregate (EI-366 / consume-edges
 * P-031, migration 240).
 *
 * Records what each memory recall actually returned, so the Learning tab
 * can tell "no relevant memory" (healthy zero) from "index degraded"
 * (zero-hit-rate spiking, top-score distribution collapsing, fragments
 * leaking back in). The surfaces that write here: the memory:search tool
 * (pull), the generic pre-turn injection helper (push), and — per
 * memory-delivery-unification-2026-07-12 P-005 — each distinct injection PORT
 * (D-006), so per-entry-point recall quality is measurable separately (an
 * initialize prime that returns junk is a different regression from a
 * turn-start delta that does). The surface column is free-text (no CHECK), so
 * adding a port needs no migration — just a member here.
 *
 * Writes are FIRE-AND-FORGET — recall telemetry must never slow or fail a
 * turn. Callers invoke `recordRecallStats` without awaiting; all failures
 * are swallowed (one warn per process).
 */
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';

/**
 * The generic surfaces (`search` pull, `injection` push) plus the per-port
 * labels the launch/injection ports stamp (memory-delivery-unification P-005 /
 * D-006). `session.port` flows straight through as the surface, so these MUST
 * stay in sync with the `port` values the ports pass (launch-profile /
 * claim-port / the initialize + compact + turn-start callers). An unknown
 * string still records fine (free-text column) — the union is the documented
 * set, not a DB constraint.
 */
export type RecallSurface =
  | 'search'
  | 'injection'
  | 'initialize'
  | 'compact'
  | 'turn-start'
  | 'brief'
  | 'orient'
  | 'claim'
  | 'create';

export interface RecallStatsInput {
  /** The documented set (RecallSurface) OR any port string — free-text column. */
  surface: RecallSurface | (string & {});
  /** The recall's result set (post score-floor, pre per-call caps). */
  entries: readonly MemoryEntry[];
}

/** Results whose metadata carries entityType — entity-store leakage (the
 *  EI-366 junk class). Always 0 after the canonical-store segregation fix;
 *  non-zero is the regression canary the health card surfaces. */
export function countFragmentHits(entries: readonly MemoryEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (typeof e.metadata?.entityType === 'string') n += 1;
  }
  return n;
}

// Warn THROTTLE, not a one-shot latch. A single warn-then-permanent-silence
// (the old `_warned` boolean) is how a persistent write failure hides: when a
// stale surface CHECK silently rejected every per-port write for hours
// (memory-delivery-unification P-005), the ONE log line scrolled away and the
// black-hole was invisible until a live probe forced it out. Re-warn at most
// once per window, and carry the count swallowed since the last warn, so an
// ongoing breakage keeps surfacing instead of going quiet after line one.
const RECALL_STATS_WARN_WINDOW_MS = 5 * 60_000;
let _lastWarnedAt = 0;
let _suppressedSinceWarn = 0;

/** Insert one stats row. Never throws; never load-bearing. Call WITHOUT awaiting. */
export async function recordRecallStats(sql: Sql, input: RecallStatsInput): Promise<void> {
  try {
    const scores = input.entries
      .map((e) => e.score)
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
    const topScore = scores.length > 0 ? Math.max(...scores) : null;
    await sql`
      INSERT INTO harness_shared.memory_recall_stats
        (surface, hit_count, top_score, scores, fragment_count)
      VALUES (
        ${input.surface},
        ${input.entries.length},
        ${topScore},
        ${JSON.stringify(scores)}::text::jsonb,
        ${countFragmentHits(input.entries)}
      )
    `;
  } catch (err) {
    _suppressedSinceWarn += 1;
    const now = Date.now();
    if (now - _lastWarnedAt >= RECALL_STATS_WARN_WINDOW_MS) {
      const alsoSuppressed = _suppressedSinceWarn - 1;
      console.warn(
        `[memory-recall-stats] capture failed (surface='${input.surface}')` +
          (alsoSuppressed > 0 ? ` — +${alsoSuppressed} more since last warn` : '') +
          `; re-warns at most once/${RECALL_STATS_WARN_WINDOW_MS / 60_000}min:`,
        (err as Error).message,
      );
      _lastWarnedAt = now;
      _suppressedSinceWarn = 0;
    }
  }
}

/** Test hook: reset the warn throttle so a suite can assert re-warn behavior. */
export function _resetRecallStatsWarnThrottleForTests(): void {
  _lastWarnedAt = 0;
  _suppressedSinceWarn = 0;
}

export interface RecallHealth {
  /** Recalls recorded in the trailing 7 days (both surfaces). */
  recalls7d: number;
  /** Of those, how many returned nothing. */
  zeroHit7d: number;
  /** zeroHit7d / recalls7d (0 when no recalls recorded). */
  zeroHitRate7d: number;
  /** Median top_score across non-empty recalls, 7d (null when none). */
  topScoreP50: number | null;
  /** 90th percentile top_score across non-empty recalls, 7d. */
  topScoreP90: number | null;
  /** Entity-fragment results that leaked into recalls, 7d — regression canary. */
  fragmentHits7d: number;
}

/** One-roundtrip trailing-window aggregate for the memory-health card. */
export async function readRecallHealth(sql: Sql): Promise<RecallHealth> {
  const rows = (await sql`
    SELECT
      count(*)::int                                   AS recalls,
      count(*) FILTER (WHERE hit_count = 0)::int      AS zero_hits,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE top_score IS NOT NULL)          AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE top_score IS NOT NULL)          AS p90,
      coalesce(sum(fragment_count), 0)::int           AS fragment_hits
    FROM harness_shared.memory_recall_stats
    WHERE created_at >= now() - interval '7 days'
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const recalls = Number(r.recalls ?? 0);
  const zeroHit = Number(r.zero_hits ?? 0);
  return {
    recalls7d: recalls,
    zeroHit7d: zeroHit,
    zeroHitRate7d: recalls > 0 ? zeroHit / recalls : 0,
    topScoreP50: r.p50 == null ? null : Number(r.p50),
    topScoreP90: r.p90 == null ? null : Number(r.p90),
    fragmentHits7d: Number(r.fragment_hits ?? 0),
  };
}

/** Per-surface slice of the same trailing-window aggregate. */
export interface RecallSurfaceHealth extends RecallHealth {
  surface: string;
}

/**
 * The SAME 7-day aggregate as readRecallHealth, segmented per surface
 * (orient-recall-quality-2026-07-12 P-006). With every entry point stamping its
 * own surface (search / orient / initialize / turn-start / claim / create / …,
 * P-001 + memory-delivery P-005), the blended aggregate can hide a
 * single-surface regression — e.g. orient's zero-hit-rate spiking (intent
 * queries too narrow, index degraded for short statements) while chat search
 * stays healthy. One GROUP BY roundtrip, busiest surfaces first. Consumed by
 * the memory-health read (knowledge-read.ts); the drift ALERTING for live
 * retrieval stays with the recall canary (recall-canary.ts) — this is the
 * observability slice, not a third alert system.
 */
export async function readRecallHealthBySurface(sql: Sql): Promise<RecallSurfaceHealth[]> {
  const rows = (await sql`
    SELECT
      surface,
      count(*)::int                                   AS recalls,
      count(*) FILTER (WHERE hit_count = 0)::int      AS zero_hits,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE top_score IS NOT NULL)          AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE top_score IS NOT NULL)          AS p90,
      coalesce(sum(fragment_count), 0)::int           AS fragment_hits
    FROM harness_shared.memory_recall_stats
    WHERE created_at >= now() - interval '7 days'
    GROUP BY surface
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const zeroHit = Number(r.zero_hits ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      recalls7d: recalls,
      zeroHit7d: zeroHit,
      zeroHitRate7d: recalls > 0 ? zeroHit / recalls : 0,
      topScoreP50: r.p50 == null ? null : Number(r.p50),
      topScoreP90: r.p90 == null ? null : Number(r.p90),
      fragmentHits7d: Number(r.fragment_hits ?? 0),
    };
  });
}
