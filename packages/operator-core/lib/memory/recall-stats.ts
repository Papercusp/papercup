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

/**
 * One pool's contribution to a multi-pool (push-path) recall — migration 703 /
 * context-injection-audit-2026-07-28 P-026.
 *
 * `limit` and `scopes` are recorded rather than inferred at read time, and that
 * is the whole point of the shape. A saturation test (`hits === limit`) computed
 * against TODAY's constant is wrong for every row written before the constant
 * was retuned — and P-032/P-033 exist specifically to retune them. Likewise a
 * pool that returns zero because it was queried under a scope key nothing writes
 * to is indistinguishable, after the fact, from a pool that simply held nothing
 * relevant — unless the scope it actually queried was captured at the time.
 */
export interface RecallPoolStats {
  /** This pool's results (post score-floor, pre policy filtering). */
  entries: readonly MemoryEntry[];
  /** The per-pool budget in effect for THIS call. */
  limit: number;
  /** The scope keys actually queried for this pool. */
  scopes: readonly string[];
}

interface RecallStatsCommon {
  /** The documented set (RecallSurface) OR any port string — free-text column. */
  surface: RecallSurface | (string & {});
  /** Workspace this recall ran for. Migration 290 added the column; nothing
   *  ever wrote it (0 of 56,841 rows) until P-026 — see the migration note. */
  workspaceId?: string | null;
  /** Pot/hive slug this recall ran for. Same dead-column history as workspaceId. */
  potSlug?: string | null;
}

/**
 * Either a FLAT result set (the pull path — one scope, no fan-out) or a
 * PER-POOL breakdown (the push path — user + harness + hive, each with its own
 * budget). Deliberately a discriminated union with `never` arms rather than two
 * optional fields: when `pools` is supplied the flat totals are DERIVED from it,
 * so `hit_count` can never drift from the sum of the pool counts. A caller
 * cannot supply both and cannot supply a breakdown that disagrees with itself.
 */
export type RecallStatsInput =
  | (RecallStatsCommon & {
      /** The recall's result set (post score-floor, pre per-call caps). */
      entries: readonly MemoryEntry[];
      pools?: never;
    })
  | (RecallStatsCommon & {
      /** Per-pool breakdown; the flat columns are derived from it. */
      pools: Readonly<Record<string, RecallPoolStats>>;
      entries?: never;
    });

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

/** Finite scores only — a non-numeric or NaN score is absent, not zero. */
function finiteScores(entries: readonly MemoryEntry[]): number[] {
  return entries
    .map((e) => e.score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
}

/** The `pools` jsonb payload: per pool, what it returned against what it was allowed. */
function poolsPayload(
  pools: Readonly<Record<string, RecallPoolStats>>,
): Record<string, { hits: number; top: number | null; limit: number; scopes: string[] }> {
  const out: Record<string, { hits: number; top: number | null; limit: number; scopes: string[] }> = {};
  for (const [name, pool] of Object.entries(pools)) {
    const scores = finiteScores(pool.entries);
    out[name] = {
      hits: pool.entries.length,
      top: scores.length > 0 ? Math.max(...scores) : null,
      limit: pool.limit,
      // Bounded: a fan-out is capped at MAX_HARNESS_FANOUT upstream, but this
      // row must stay small whatever a future caller passes.
      scopes: pool.scopes.slice(0, 16).map(String),
    };
  }
  return out;
}

/** Insert one stats row. Never throws; never load-bearing. Call WITHOUT awaiting. */
export async function recordRecallStats(sql: Sql, input: RecallStatsInput): Promise<void> {
  try {
    // A per-pool input DERIVES its flat totals, so hit_count/top_score/scores keep
    // exactly the meaning they have always had and cannot disagree with `pools`.
    const entries: readonly MemoryEntry[] = input.pools
      ? Object.values(input.pools).flatMap((p) => [...p.entries])
      : input.entries;
    const scores = finiteScores(entries);
    const topScore = scores.length > 0 ? Math.max(...scores) : null;
    const pools = input.pools ? JSON.stringify(poolsPayload(input.pools)) : null;
    await sql`
      INSERT INTO harness_shared.memory_recall_stats
        (surface, hit_count, top_score, scores, fragment_count, pools, workspace_id, pot_slug)
      VALUES (
        ${input.surface},
        ${entries.length},
        ${topScore},
        ${JSON.stringify(scores)}::text::jsonb,
        ${countFragmentHits(entries)},
        ${pools}::text::jsonb,
        ${input.workspaceId ?? null},
        ${input.potSlug ?? null}
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
