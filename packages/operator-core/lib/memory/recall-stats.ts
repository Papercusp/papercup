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
import { parseEnvelope, payloadSha256 } from '../turn-provenance/turn-provenance';
import type { MemoryEntry, ScoreScale } from './backend';

/**
 * Upper bound of an RRF score at the PRODUCTION fusion defaults
 * (`(1 + lexWeight) / (k + 1)` = 2/61), i.e. an entry ranked 1st in BOTH legs.
 * Used only by `classifyLegacyScoreScale` — live rows carry their scale
 * explicitly and must never be classified by value.
 */
export const RRF_SCORE_CEILING = 2 / 61;

/**
 * Lowest score an admitted COSINE hit can carry: the relevance floor applied on
 * admission. Observed minimum on the live table is 0.50.
 */
export const COSINE_ADMISSION_FLOOR = 0.45;

/**
 * Best-effort scale for a row written BEFORE migration 705 (`score_scale IS
 * NULL`). A transition aid, deliberately confined to this one function.
 *
 * This is an INFERENCE, and the only reason it is defensible is that the live
 * distribution is almost perfectly bimodal — measured over 45,069 rows / 30d
 * before it was written: 32,547 at <= 0.032787 (rrf), 12,517 at >= 0.50
 * (cosine), and just 5 rows (0.011%) anywhere in the 13x-wide gap between. The
 * separation is structural, not lucky: RRF is bounded above by 2/61 while an
 * admitted cosine hit is floored at ~0.45.
 *
 * It is nonetheless valid ONLY while k=60 / lexWeight=1 hold (raising lexWeight
 * to 2 lifts the RRF ceiling to 3/61 and starts eating into the gap), which is
 * exactly why new rows record the scale instead of relying on this. Returns
 * 'unknown' inside the gap rather than guessing — an unknown row is excluded
 * from comparisons, which is the safe direction.
 */
export function classifyLegacyScoreScale(topScore: number | null | undefined): ScoreScale {
  if (typeof topScore !== 'number' || !Number.isFinite(topScore)) return 'unknown';
  if (topScore <= RRF_SCORE_CEILING) return 'rrf';
  if (topScore >= COSINE_ADMISSION_FLOOR) return 'cosine';
  return 'unknown';
}

/**
 * The SHAPE of a recall query — what was ASKED, recorded alongside what came
 * back (migration 706 / P-041).
 *
 * Shape rather than the query text itself: the questions this has to answer
 * ("how much recall traffic is machine boilerplate", "how often is the query a
 * near-empty prompt", "how often is it a repeat") are all answerable without
 * carrying prompt content into a retained telemetry table.
 */
export interface RecallQueryShape {
  /**
   * Chars actually handed to the backend — turn-origin envelope INCLUDED,
   * because that is what got embedded. Sitting exactly at a caller's clamp
   * (turn-start clamps to 1000) is itself the truncation signal.
   */
  chars: number;
  /** sha256 of the ENVELOPE-STRIPPED, CRLF-normalized query — see below. */
  sha256: string;
  /** The origin CLAIMED by the envelope; null when there was none. */
  origin: string | null;
}

/**
 * Derive the recorded shape of one recall query.
 *
 * ⚠ THE ENVELOPE IS STRIPPED BEFORE HASHING, and that is the whole reason this
 * function exists rather than an inline `sha256(query)` at each call site.
 * Machine-injected turns arrive prefixed with `⟦turn-origin:<origin>
 * nonce:<hex>⟧`, the nonce is freshly minted per turn, and the turn-start path
 * embeds the raw prompt verbatim — so hashing the raw text would make every
 * machine-injected query unique BY CONSTRUCTION. The duplicate rate would read
 * 0.0% however identical the real prompts were, and 0% duplicates reads as
 * healthy. That is the same structural blindness as judging query quality by an
 * RRF `top_score` (D-015): a metric that cannot detect the thing it is for.
 *
 * The envelope is not discarded, it is RECORDED (`origin`) — but as the
 * envelope's CLAIM only. The ledger-corroborated verdict (turn-provenance's
 * `classify`) needs a filesystem read and has no place on a fire-and-forget
 * telemetry path; nothing here is adversarial and nothing gates on it.
 *
 * `parseEnvelope`/`payloadSha256` are imported rather than re-implemented on
 * purpose: a second copy of the envelope regex would silently misclassify every
 * row the day the envelope format changes.
 */
export function describeRecallQuery(query: string): RecallQueryShape {
  const envelope = parseEnvelope(query);
  return {
    chars: query.length,
    sha256: payloadSha256(envelope ? envelope.payload : query),
    origin: envelope?.origin ?? null,
  };
}

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
  /**
   * The scale `entries[].score` is on (migration 705 / P-036) — read off the
   * backend that produced them (`backend.scoreScale`, or `lexicalScoreScale`
   * when the caller took the embed-free fallback leg).
   *
   * Supply it. Omitting it records NULL, which every scale-aware reader treats
   * as 'unknown' and EXCLUDES from percentiles rather than pooling with a
   * labelled row — the scores are silently unusable, not merely unlabelled.
   */
  scoreScale?: ScoreScale | null;
  /**
   * The query text this recall ran on (migration 706 / P-041) — pass it RAW,
   * exactly as handed to the backend. Only its SHAPE is stored
   * (`describeRecallQuery`); the text itself never reaches the table.
   *
   * Supply it. Omitting it records NULLs, and a NULL query row is excluded from
   * every query-quality measurement — which is the pre-P-041 state where the
   * table could say in detail what came BACK and nothing at all about what was
   * ASKED, and no query-side defect was measurable.
   */
  query?: string | null;
  /**
   * Session this recall ran for (push path: `session.sessionId`). Null on the
   * pull path, which has no session identity on its ctx.
   *
   * Load-bearing for the duplicate measurement specifically: "the same query as
   * last turn" is only defined WITHIN a session, and this table interleaves
   * every concurrent agent on the box. Lagging by created_at across sessions
   * compares one agent's turn to a different agent's — a number that means
   * nothing while looking like a rate.
   */
  sessionId?: string | null;
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
    // P-041 / migration 706: the query's SHAPE. A caller that passes no query
    // records NULLs and is excluded from query-quality reads, rather than
    // contributing a zero-length row that would read as a real empty query.
    const q = typeof input.query === 'string' ? describeRecallQuery(input.query) : null;
    await sql`
      INSERT INTO harness_shared.memory_recall_stats
        (surface, hit_count, top_score, scores, fragment_count, pools, workspace_id, pot_slug, score_scale,
         query_chars, query_sha256, query_origin, session_id)
      VALUES (
        ${input.surface},
        ${entries.length},
        ${topScore},
        ${JSON.stringify(scores)}::text::jsonb,
        ${countFragmentHits(entries)},
        ${pools}::text::jsonb,
        ${input.workspaceId ?? null},
        ${input.potSlug ?? null},
        ${input.scoreScale ?? null},
        ${q ? q.chars : null},
        ${q ? q.sha256 : null},
        ${q ? q.origin : null},
        ${input.sessionId ?? null}
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

/*
 * A row's EFFECTIVE score scale in SQL is the recorded label when present
 * (migration 705 onward), else the legacy value-based classification:
 *
 *   CASE WHEN score_scale IS NOT NULL THEN score_scale
 *        WHEN top_score IS NULL       THEN 'unknown'
 *        WHEN top_score <= ${RRF_SCORE_CEILING}      THEN 'rrf'
 *        WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
 *        ELSE 'unknown' END
 *
 * It is written out inline in each query below rather than shared as a nested
 * `sql` fragment. A helper returning sql`…` reads better but INVOKES the tagged
 * template, which is indistinguishable from a query to a call-counting test
 * double — it silently consumed a response and made a mocked aggregate return
 * zeros, i.e. read as perfectly healthy. The duplicated text is three lines;
 * the NUMBERS stay single-sourced through the two constants above, which is
 * where drift would actually be dangerous.
 */

export interface RecallHealth {
  /** Recalls recorded in the trailing 7 days (both surfaces). */
  recalls7d: number;
  /** Of those, how many returned nothing. */
  zeroHit7d: number;
  /** zeroHit7d / recalls7d (0 when no recalls recorded). */
  zeroHitRate7d: number;
  /**
   * Median top_score across non-empty recalls, 7d (null when none) — computed
   * over `topScoreScale` ONLY. See that field: this is NOT a percentile over
   * every recall in the window, and deliberately so.
   */
  topScoreP50: number | null;
  /** 90th percentile top_score, same single-scale population as topScoreP50. */
  topScoreP90: number | null;
  /**
   * WHICH scale the two percentiles above are on (P-036) — the dominant scale
   * in the window, by scored-row count. Null when no scored rows.
   *
   * Percentiles are single-scale because a percentile over MIXED scales is not
   * a weak number, it is a meaningless one: rrf tops out at 0.033 while cosine
   * starts at 0.50, so a blended median reports the workload MIX (which path
   * ran more often) rather than retrieval quality, and shifts by 25x when the
   * mix shifts with retrieval unchanged. Render this next to the number; a
   * bare score with no scale is exactly the ambiguity D-001 had to retract.
   */
  topScoreScale: ScoreScale | null;
  /** Scored rows behind the percentiles (i.e. rows on `topScoreScale`). */
  topScoreSamples: number;
  /** Scored rows in the window per scale — the mix the percentiles exclude. */
  scaleMix: Record<string, number>;
  /** Entity-fragment results that leaked into recalls, 7d — regression canary. */
  fragmentHits7d: number;
}

/** Percentile + mix columns shared by the window aggregates below. */
function scaleAggregate(
  perScale: Array<Record<string, unknown>>,
): Pick<RecallHealth, 'topScoreP50' | 'topScoreP90' | 'topScoreScale' | 'topScoreSamples' | 'scaleMix'> {
  const scaleMix: Record<string, number> = {};
  for (const s of perScale) scaleMix[String(s.scale)] = Number(s.scored ?? 0);
  // Dominant = most scored rows. 'unknown' can never be dominant: its rows are
  // of INDETERMINATE scale, so a percentile over them is the same mixing bug.
  const ranked = perScale
    .filter((s) => String(s.scale) !== 'unknown' && Number(s.scored ?? 0) > 0)
    .sort((a, b) => Number(b.scored ?? 0) - Number(a.scored ?? 0));
  const top = ranked[0];
  return {
    topScoreP50: top?.p50 == null ? null : Number(top.p50),
    topScoreP90: top?.p90 == null ? null : Number(top.p90),
    topScoreScale: top ? (String(top.scale) as ScoreScale) : null,
    topScoreSamples: top ? Number(top.scored ?? 0) : 0,
    scaleMix,
  };
}

/** One-roundtrip trailing-window aggregate for the memory-health card. */
export async function readRecallHealth(sql: Sql): Promise<RecallHealth> {
  const rows = (await sql`
    WITH scoped AS (
      SELECT hit_count, fragment_count, top_score,
             CASE
               WHEN score_scale IS NOT NULL THEN score_scale
               WHEN top_score IS NULL THEN 'unknown'
               WHEN top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
               WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
               ELSE 'unknown'
             END AS scale
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - interval '7 days'
    ),
    per_scale AS (
      SELECT scale,
             count(*)::int AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score) AS p90
        FROM scoped WHERE top_score IS NOT NULL GROUP BY scale
    )
    SELECT
      (SELECT count(*) FROM scoped)::int                            AS recalls,
      (SELECT count(*) FROM scoped WHERE hit_count = 0)::int        AS zero_hits,
      (SELECT coalesce(sum(fragment_count), 0) FROM scoped)::int    AS fragment_hits,
      (SELECT coalesce(jsonb_agg(to_jsonb(per_scale)), '[]'::jsonb) FROM per_scale) AS per_scale
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const recalls = Number(r.recalls ?? 0);
  const zeroHit = Number(r.zero_hits ?? 0);
  return {
    recalls7d: recalls,
    zeroHit7d: zeroHit,
    zeroHitRate7d: recalls > 0 ? zeroHit / recalls : 0,
    ...scaleAggregate(Array.isArray(r.per_scale) ? (r.per_scale as Array<Record<string, unknown>>) : []),
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
/** One pool's trailing-window recall health (migration 703 / P-026). */
export interface RecallPoolHealth {
  /** Surface the pool was recalled under (turn-start, orient, …). */
  surface: string;
  /** Pool name as the writer stamped it (user | harness | hive). */
  pool: string;
  /** Recalls in the window where this pool participated. */
  recalls: number;
  /** Of those, how many returned NOTHING from this pool. */
  zeroHit: number;
  /** zeroHit / recalls. THE gate-2 detector: a pool keyed on a scope nothing
   *  writes to sits at 1.0 while the blended surface zero-hit-rate reads 0.0. */
  zeroHitRate: number;
  /** Of those, how many returned exactly the pool's own budget. */
  saturated: number;
  /** saturated / recalls. THE gate-4 detector: a top-K selector that always
   *  fills its budget is sizing the result by the limit, not by relevance. */
  saturationRate: number;
  /** Median hits contributed by this pool. */
  hitsP50: number | null;
  /** Median of this pool's OWN top score — not maskable by a sibling pool.
   *  Single-scale: see `scoreScale`, which is part of this row's identity. */
  topScoreP50: number | null;
  /** The scale `topScoreP50` is on (P-036). Part of the GROUP BY key, not a
   *  decoration: the same surface+pool appears once PER SCALE, because
   *  medianing a pool's rrf rows together with its cosine rows reports the
   *  backend mix rather than the pool's retrieval quality. */
  scoreScale: ScoreScale;
  /** Distinct scope keys this pool was queried under in the window. A pool
   *  whose scope set CHANGED mid-window is the unmigrated-rename signature. */
  scopes: string[];
}

/**
 * Per-POOL slice of the trailing window (context-injection-audit-2026-07-28
 * P-026). The sibling of readRecallHealthBySurface, one level down.
 *
 * readRecallHealthBySurface can only see a surface's BLENDED result, and the
 * push path concatenates three independently-budgeted pools before it is
 * recorded — so a pool contributing nothing on every single call reads as a
 * perfectly healthy surface as long as the other two fill the block. That is
 * not hypothetical: it is exactly how a harness pool orphaned by an unmigrated
 * slug rename stayed invisible while its surface reported a 0.0% zero-hit rate.
 *
 * `saturationRate` is the same argument for the budget: a pool that returns
 * exactly its limit on ~every call is not answering "what is relevant", it is
 * answering "what is the limit" — and comparing hits against the limit STORED
 * ON THE ROW keeps that true across constant retunes.
 *
 * Rows written before migration 703 have `pools IS NULL` and are excluded, so
 * the counts here are honestly smaller than the surface aggregate's until the
 * window rolls past the deploy. One GROUP BY roundtrip.
 */
export async function readRecallHealthByPool(
  sql: Sql,
  opts: { days?: number; surface?: string } = {},
): Promise<RecallPoolHealth[]> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.floor(opts.days as number) : 7;
  const rows = (await sql`
    WITH exploded AS (
      SELECT
        s.surface,
        p.key                                   AS pool,
        (p.value ->> 'hits')::int               AS hits,
        (p.value ->> 'limit')::int              AS budget,
        (p.value ->> 'top')::double precision   AS top,
        -- Every pool top came from the same backend call as the row's
        -- top_score, so the row-level scale governs them all (P-036).
        CASE
          WHEN s.score_scale IS NOT NULL THEN s.score_scale
          WHEN s.top_score IS NULL THEN 'unknown'
          WHEN s.top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
          WHEN s.top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
          ELSE 'unknown'
        END                                     AS scale,
        p.value -> 'scopes'                     AS scopes
      FROM harness_shared.memory_recall_stats s
      CROSS JOIN LATERAL jsonb_each(s.pools) AS p(key, value)
      WHERE s.pools IS NOT NULL
        AND s.created_at >= now() - make_interval(days => ${days}::int)
        ${opts.surface ? sql`AND s.surface = ${opts.surface}` : sql``}
    )
    SELECT
      surface,
      pool,
      scale,
      count(*)::int                                          AS recalls,
      count(*) FILTER (WHERE hits = 0)::int                  AS zero_hits,
      count(*) FILTER (WHERE budget > 0 AND hits >= budget)::int AS saturated,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY hits)      AS hits_p50,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top)
        FILTER (WHERE top IS NOT NULL)                       AS top_p50,
      coalesce(
        jsonb_agg(DISTINCT sc.scope) FILTER (WHERE sc.scope IS NOT NULL),
        '[]'::jsonb
      )                                                      AS scope_keys
    FROM exploded
    LEFT JOIN LATERAL jsonb_array_elements_text(scopes) AS sc(scope) ON true
    GROUP BY surface, pool, scale
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const zeroHit = Number(r.zero_hits ?? 0);
    const saturated = Number(r.saturated ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      pool: String(r.pool ?? 'unknown'),
      scoreScale: (r.scale ? String(r.scale) : 'unknown') as ScoreScale,
      recalls,
      zeroHit,
      zeroHitRate: recalls > 0 ? zeroHit / recalls : 0,
      saturated,
      saturationRate: recalls > 0 ? saturated / recalls : 0,
      hitsP50: r.hits_p50 == null ? null : Number(r.hits_p50),
      topScoreP50: r.top_p50 == null ? null : Number(r.top_p50),
      scopes: Array.isArray(r.scope_keys) ? (r.scope_keys as unknown[]).map(String) : [],
    };
  });
}

/**
 * The length under which a query is counted "short" by
 * `readRecallQueryHealth`. 40 is not arbitrary and not a threshold anything
 * acts on: it is exactly the `MIN_PROMPT_CHARS` gate that P-035 (F-E) DELETED,
 * so the bucket answers a specific historical question — how much traffic that
 * gate was silently dropping.
 *
 * ⚠ DESCRIPTIVE ONLY. This must never become a gate again. The gate was deleted
 * because prompt length does not predict recall signal (it dropped the owner's
 * 23-char question while a 40-char pleasantry sailed through), and relevance is
 * now decided by the relevance floor. A high "short query" rate is a fact about
 * the traffic mix, NOT evidence that short prompts should be skipped.
 */
export const SHORT_QUERY_CHARS = 40;

/** Per-surface shape of what was ASKED in the window (migration 706 / P-041). */
export interface RecallQueryHealth {
  surface: string;
  /** Rows in the window that recorded a query shape (pre-706 rows excluded). */
  recalls: number;
  /** Of those, how many carried a turn-origin envelope — i.e. the query text
   *  was a relayed machine-injected prompt rather than something typed. */
  machineOrigin: number;
  /** machineOrigin / recalls. */
  machineOriginRate: number;
  /** Claimed origins → count. `(no-envelope)` covers the rest; see the note on
   *  `readRecallQueryHealth` — its meaning is surface-dependent. */
  originMix: Record<string, number>;
  /** Median query length (chars actually embedded). */
  charsP50: number | null;
  /** 10th-percentile query length — where the near-empty tail lives. */
  charsP10: number | null;
  /** Queries shorter than SHORT_QUERY_CHARS — descriptive, never a gate. */
  shortQueries: number;
  /** shortQueries / recalls. */
  shortQueryRate: number;
  /** Rows that HAVE a predecessor in the same session+surface, i.e. rows for
   *  which "is this a repeat" is even a defined question. */
  repeatEligible: number;
  /** Of those, how many repeated the previous query's hash exactly. */
  repeats: number;
  /** repeats / repeatEligible (0 when nothing is eligible). */
  repeatRate: number;
}

/**
 * Per-surface aggregate of the QUERY side of recall (P-041 / migration 706) —
 * the sibling of readRecallHealthBySurface, on the other half of the call.
 *
 * Everything else in this module measures what a recall RETURNED. That side is
 * structurally incapable of answering whether the QUERY was any good: the push
 * path's `top_score` is an RRF rank, so something is always rank 1 and the
 * number is identical for a precise question and for the word "continue"
 * (D-015). This is the read that makes query quality visible at all.
 *
 * ⚠ THE REPEAT RATE EXCLUDES SESSION-LESS ROWS, DELIBERATELY. Postgres treats
 * NULLs as equal in a PARTITION BY, so lagging over `session_id` with the pull
 * path's NULLs included would silently lump every session-less recall on the
 * box into ONE partition and compare one agent's query against an unrelated
 * agent's — manufacturing both false repeats and false non-repeats at a rate
 * that would look entirely plausible. `repeatEligible` is reported alongside
 * `repeats` so the denominator is never guessed at.
 *
 * ⚠ `originMix`'s `(no-envelope)` bucket is SURFACE-DEPENDENT and must not be
 * read as "human-typed" globally. On `turn-start` the query IS the submitted
 * prompt, so no envelope does mean owner-typed. On a surface that builds its
 * own query (orient, claim, brief, the cup-wake dossier) there was never an
 * envelope to carry, and the absence says nothing about a human.
 */
export async function readRecallQueryHealth(
  sql: Sql,
  opts: { days?: number; surface?: string } = {},
): Promise<RecallQueryHealth[]> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.floor(opts.days as number) : 7;
  const rows = (await sql`
    WITH scoped AS (
      SELECT surface, session_id, query_chars, query_sha256, query_origin, created_at, id
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - make_interval(days => ${days}::int)
         AND query_sha256 IS NOT NULL
         ${opts.surface ? sql`AND surface = ${opts.surface}` : sql``}
    ),
    -- Sequenced ONLY over rows that carry a session. See the doc comment: a
    -- NULL session_id would form one giant cross-agent partition.
    seq AS (
      SELECT surface, query_sha256,
             lag(query_sha256) OVER (PARTITION BY session_id, surface ORDER BY created_at, id) AS prev_sha
        FROM scoped WHERE session_id IS NOT NULL
    ),
    repeats AS (
      SELECT surface,
             count(*) FILTER (WHERE prev_sha IS NOT NULL)::int                       AS eligible,
             count(*) FILTER (WHERE prev_sha IS NOT NULL AND prev_sha = query_sha256)::int AS repeated
        FROM seq GROUP BY surface
    ),
    origins AS (
      SELECT surface, coalesce(query_origin, '(no-envelope)') AS origin, count(*)::int AS n
        FROM scoped GROUP BY surface, coalesce(query_origin, '(no-envelope)')
    )
    SELECT
      s.surface,
      count(*)::int                                                   AS recalls,
      count(*) FILTER (WHERE s.query_origin IS NOT NULL)::int          AS machine_origin,
      count(*) FILTER (WHERE s.query_chars < ${SHORT_QUERY_CHARS})::int AS short_queries,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY s.query_chars)       AS chars_p50,
      percentile_cont(0.1) WITHIN GROUP (ORDER BY s.query_chars)       AS chars_p10,
      coalesce((SELECT jsonb_object_agg(o.origin, o.n) FROM origins o WHERE o.surface = s.surface), '{}'::jsonb) AS origin_mix,
      coalesce((SELECT r.eligible FROM repeats r WHERE r.surface = s.surface), 0)  AS repeat_eligible,
      coalesce((SELECT r.repeated FROM repeats r WHERE r.surface = s.surface), 0)  AS repeat_count
    FROM scoped s
    GROUP BY s.surface
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const machineOrigin = Number(r.machine_origin ?? 0);
    const shortQueries = Number(r.short_queries ?? 0);
    const repeatEligible = Number(r.repeat_eligible ?? 0);
    const repeats = Number(r.repeat_count ?? 0);
    const mixRaw = (r.origin_mix ?? {}) as Record<string, unknown>;
    const originMix: Record<string, number> = {};
    for (const [k, v] of Object.entries(mixRaw)) originMix[k] = Number(v ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      recalls,
      machineOrigin,
      machineOriginRate: recalls > 0 ? machineOrigin / recalls : 0,
      originMix,
      charsP50: r.chars_p50 == null ? null : Number(r.chars_p50),
      charsP10: r.chars_p10 == null ? null : Number(r.chars_p10),
      shortQueries,
      shortQueryRate: recalls > 0 ? shortQueries / recalls : 0,
      repeatEligible,
      repeats,
      repeatRate: repeatEligible > 0 ? repeats / repeatEligible : 0,
    };
  });
}

export async function readRecallHealthBySurface(sql: Sql): Promise<RecallSurfaceHealth[]> {
  // Segmenting by surface does NOT segment by scale — measured on the live
  // table, a single surface carries both scales on the same day (2026-07-28
  // `search`: 17 rrf-scale rows alongside 94 cosine-scale). So this aggregate
  // needs the same per-scale split as the global one; grouping by surface alone
  // would still blend.
  const rows = (await sql`
    WITH scoped AS (
      SELECT surface, hit_count, fragment_count, top_score,
             CASE
               WHEN score_scale IS NOT NULL THEN score_scale
               WHEN top_score IS NULL THEN 'unknown'
               WHEN top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
               WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
               ELSE 'unknown'
             END AS scale
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - interval '7 days'
    ),
    per_scale AS (
      SELECT surface, scale,
             count(*)::int AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score) AS p90
        FROM scoped WHERE top_score IS NOT NULL GROUP BY surface, scale
    )
    SELECT
      s.surface,
      count(*)::int                                AS recalls,
      count(*) FILTER (WHERE s.hit_count = 0)::int AS zero_hits,
      coalesce(sum(s.fragment_count), 0)::int      AS fragment_hits,
      coalesce(
        (SELECT jsonb_agg(to_jsonb(p)) FROM per_scale p WHERE p.surface = s.surface),
        '[]'::jsonb
      )                                            AS per_scale
    FROM scoped s
    GROUP BY s.surface
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
      ...scaleAggregate(Array.isArray(r.per_scale) ? (r.per_scale as Array<Record<string, unknown>>) : []),
      fragmentHits7d: Number(r.fragment_hits ?? 0),
    };
  });
}
