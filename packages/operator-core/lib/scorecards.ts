/**
 * scorecards — the structured-observation READ surface
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * A "scorecard" is a RUBRIC-GRADED structured observation: an
 * `engineer_issues.payload.observation` carrying a `rubricRef` + a `ratings`
 * Record (one rating+evidence per rubric criterion key). The Overwatch emits one
 * every turn against the `hive-coordination-health` rubric; Scout's digest (B9 /
 * rubric-driven-observations P-006) consumes them. Until now they were
 * WRITE-ONLY — invisible except via raw PG (the verification gap D-005 found:
 * partial scorecards + emission stalls could not be seen). This is the READ tool
 * that closes that gap and the linchpin the monitoring layer builds on (P-010
 * trend, P-014 emission-freshness, the Overwatch's own turn-over-turn
 * self-comparison).
 *
 * Reuse-first: the structured shape + parse come from the canonical
 * `observation-types.ts` (`asStructuredObservation`, the same validator the READ
 * path read-items.ts uses); `missingKeys` resolves through the existing
 * `getRubric` (so it survives v2's Phase-3 rubric-as-a-plan re-point — the seam
 * stays, the backing changes). Workspace scope reuses `issuesScopeWorkspace()` so
 * scorecards flip per-workspace exactly like the engineer_issues store they ride.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  asStructuredObservation,
  type ObservationRatings,
} from './harness/improvements/observation-types';
import { issuesScopeWorkspace } from './issues-engineer';
import { getRubric } from './rubrics';

/** The owner-mandated built-in rubric whose prompt/backstop contract is fixed. */
export const HIVE_COORDINATION_HEALTH_RUBRIC = 'hive-coordination-health';

/** The canonical 14 keys for hive-coordination-health. This is a fallback for
 * read-side completeness only: if the rubric-template store is temporarily
 * unreachable/unresolvable, the monitor-of-monitor must not mark a 14-key
 * owner-mandated scorecard partial. Unknown rubrics still stay unresolved. */
export const HIVE_COORDINATION_HEALTH_KEYS = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
] as const;

export function builtInCriterionKeysForRubric(rubricRef: string): string[] | null {
  return rubricRef === HIVE_COORDINATION_HEALTH_RUBRIC ? [...HIVE_COORDINATION_HEALTH_KEYS] : null;
}

/** One scorecard row — a rubric-graded observation projected for monitoring. */
export interface ScorecardRow {
  /** The engineer_issue id (EI-/WI-…) — the drill-back key. */
  issueId: string;
  /** ISO timestamp the scorecard was filed. */
  createdAt: string;
  /** Who emitted it (ownerId), when recorded. */
  createdBy: string | null;
  /** The hive the observation came FROM (the grouping axis), when set. */
  sourceHive?: string;
  /** The rubric graded against (a `rubrics.rubric_id`). */
  rubricRef: string;
  /** Per-criterion ratings, keyed by rubric criterion `key` (each {rating, evidence}). */
  ratings: ObservationRatings;
  /** How many criteria this scorecard rated (`Object.keys(ratings).length`). */
  nKeys: number;
  /**
   * Rubric criterion keys the scorecard did NOT rate — the completeness signal
   * (P-014's gate reads this). Empty when the scorecard is complete OR when the
   * rubric can't be resolved (then `rubricResolved` is false, so an empty list is
   * never misread as "complete"). Sorted in the rubric's own criteria order.
   */
  missingKeys: string[];
  /** Whether `rubricRef` resolved to a known rubric (so `missingKeys` is meaningful). */
  rubricResolved: boolean;
  /**
   * True when this scorecard is a SYNTHESIZED floor (`payload.observation.synthesized`),
   * not an agent emission — the deterministic backstop filed by overwatch/scorecard-backstop
   * when an Overwatch turn ended without one. EXCLUDED by default (see `includeSynthesized`)
   * so the agent-emission freshness/trend/staleness signals never count the floor as the
   * agent doing its job.
   */
  synthesized: boolean;
}

export interface ListScorecardsFilter {
  /** Restrict to one rubric (e.g. 'hive-coordination-health'). */
  rubricRef?: string;
  /** Restrict to scorecards from one source-hive. */
  sourceHive?: string;
  /** Only scorecards filed at/after this ISO timestamp (the time-window). */
  since?: string;
  /** Max rows (newest-first). Default 100, max 500. */
  limit?: number;
  /**
   * Include SYNTHESIZED floor scorecards (`payload.observation.synthesized`). Default
   * FALSE — every monitoring consumer (the agent-emission freshness detector, the trend,
   * the staleness signal, Scout's digest) reads AGENT scorecards only, so the deterministic
   * floor (overwatch/scorecard-backstop) never masks an agent skip nor pollutes the trend.
   * Set true only for an explicit "did the monitor speak at all (incl. the floor)" read.
   */
  includeSynthesized?: boolean;
}

interface ScorecardRowDb {
  issue_id: string;
  created_by: string | null;
  created_at: string | Date;
  payload: unknown | null;
}

function tsIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

/**
 * List rubric-graded scorecards (newest-first), optionally filtered by rubric,
 * source-hive, and time-window. A direct, workspace-scoped jsonb query over
 * `engineer_issues` (only rows whose `payload.observation.rubricRef` is set —
 * indexed by the sourceHive backfill), parsed through the canonical
 * `asStructuredObservation`, with `missingKeys` resolved via `getRubric`
 * (cached per rubric within the call). Organic emissions only — synthetic
 * (drill/replay/shadow) scorecards are not real Overwatch output and must not
 * pollute the monitoring read (mirrors read-items.ts's organic provenance gate;
 * a NULL origin reads organic, the backfill default).
 */
export async function listScorecards(filter: ListScorecardsFilter = {}): Promise<ScorecardRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

  const rows = await sql<ScorecardRowDb[]>`
    SELECT issue_id, created_by, created_at, payload
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND COALESCE(signal_origin, 'organic') = 'organic'
       AND payload -> 'observation' ->> 'rubricRef' IS NOT NULL
       AND ${filter.rubricRef ? sql`payload -> 'observation' ->> 'rubricRef' = ${filter.rubricRef}` : sql`TRUE`}
       AND ${filter.sourceHive ? sql`payload -> 'observation' ->> 'sourceHive' = ${filter.sourceHive}` : sql`TRUE`}
       AND ${filter.since ? sql`created_at >= ${filter.since}` : sql`TRUE`}
       AND ${filter.includeSynthesized ? sql`TRUE` : sql`payload -> 'observation' ->> 'synthesized' IS DISTINCT FROM 'true'`}
     ORDER BY created_at DESC
     LIMIT ${limit}`;

  // Resolve each distinct rubric ONCE (a scorecard read touches a handful of rubrics).
  const rubricCriteriaKeys = new Map<string, string[] | null>();
  const out: ScorecardRow[] = [];

  for (const row of rows) {
    const observation = asStructuredObservation((row.payload as { observation?: unknown } | null)?.observation);
    // The SQL guarantees rubricRef is set, but parse defensively (a malformed
    // payload yields no structured view) so a bad row degrades, never throws.
    if (!observation?.rubricRef || !observation.ratings) continue;
    const ratings = observation.ratings;
    const ratedKeys = new Set(Object.keys(ratings));

    if (!rubricCriteriaKeys.has(observation.rubricRef)) {
      const rubric = await getRubric(observation.rubricRef);
      rubricCriteriaKeys.set(
        observation.rubricRef,
        rubric ? rubric.criteria.map((c) => c.key) : builtInCriterionKeysForRubric(observation.rubricRef),
      );
    }
    const criteriaKeys = rubricCriteriaKeys.get(observation.rubricRef) ?? null;
    const rubricResolved = criteriaKeys !== null;
    const missingKeys = rubricResolved ? criteriaKeys!.filter((k) => !ratedKeys.has(k)) : [];
    // Read the synthesized marker from the RAW payload (not the parsed observation,
    // which may strip unknown keys) so the floor stays distinguishable.
    const synthRaw = (row.payload as { observation?: { synthesized?: unknown } } | null)?.observation?.synthesized;
    const synthesized = synthRaw === true || synthRaw === 'true';

    out.push({
      issueId: row.issue_id,
      createdAt: tsIso(row.created_at),
      createdBy: row.created_by,
      ...(observation.sourceHive ? { sourceHive: observation.sourceHive } : {}),
      rubricRef: observation.rubricRef,
      ratings,
      nKeys: ratedKeys.size,
      missingKeys,
      rubricResolved,
      synthesized,
    });
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Trend aggregation (P-010) — the qualitative health TREND over the scorecard
// time-series. The "data already exists" quick-win: every-turn scorecards ARE a
// per-criterion rating time-series; this rolls them up per criterion + computes
// a direction so the Queen/owner sees "queen-placement-health: degraded, worsening
// over 5 ratings / 3 days" instead of re-reading raw scorecards.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trend direction over the window, from the FIRST→LATEST assessable rating:
 *  - improving  — severity fell (e.g. broken → degraded → healthy)
 *  - worsening  — severity rose (e.g. healthy → degraded → broken)
 *  - stable     — first and latest assessable ratings are equal
 *  - unknown    — fewer than 2 assessable ratings (can't tell a direction)
 * It is the NET first→latest trend; the full `series` is returned alongside so a
 * consumer can see within-window oscillation the single direction summarises.
 */
export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'unknown';

/** Default-scale ordinal severity (healthy < degraded < broken). `unknown` and any
 *  custom per-criterion rating are NOT ordered (returns null → excluded from the
 *  direction calc) — only the shared default vocabulary has a meaningful order. */
const TREND_SEVERITY: Record<string, number> = { healthy: 0, degraded: 1, broken: 2 };
function trendSeverity(rating: string): number | null {
  const s = TREND_SEVERITY[rating.toLowerCase()];
  return s === undefined ? null : s;
}

/**
 * The net first→latest trend direction of a chronological rating series (default
 * ordinal healthy<degraded<broken; `unknown`/custom ratings are excluded as
 * unassessable). Exported so the (pure, DB-free) direction logic is unit-tested
 * exhaustively; `scorecardTrend` applies it per criterion.
 */
export function computeTrendDirection(series: readonly { at: string; rating: string }[]): TrendDirection {
  const assessable = series.map((s) => trendSeverity(s.rating)).filter((s): s is number => s !== null);
  if (assessable.length < 2) return 'unknown';
  const first = assessable[0];
  const last = assessable[assessable.length - 1];
  if (last > first) return 'worsening';
  if (last < first) return 'improving';
  return 'stable';
}

/** One criterion's standing over the window: its rating series + trend direction. */
export interface CriterionTrend {
  criterion: string;
  /** # scorecards (in-window) that rated this criterion. */
  count: number;
  /** rating value → how many scorecards gave it. */
  distribution: Record<string, number>;
  /** The earliest rating in the window (chronological). */
  first: { rating: string; at: string };
  /** The most-recent rating in the window. */
  latest: { rating: string; at: string };
  /** Net first→latest trend (see {@link TrendDirection}). */
  direction: TrendDirection;
  /** The full chronological series (oldest → newest). */
  series: { at: string; rating: string }[];
}

// ───────────────────────────────────────────────────────────────────────────
// Staleness signal (P-011 / D-004) — flag a rubric whose MODEL has drifted from
// reality. The signal: criteria the Overwatch persistently rates 'unknown' (it
// cannot ASSESS them) — the rubric's model/method for that criterion no longer
// matches how the system works. A stale rubric re-enters the queen↔scout loop for
// re-ratification (a new revision). "Start with a simple flag; don't over-automate"
// (D-004): this is detection only — surfaced on rubrics:trend so the Queen decides.
//
// Why 'unknown' (not persistent 'broken'): an unassessable criterion means the
// rubric drifted; a persistently-BROKEN criterion usually means the SYSTEM is broken
// (a real finding the trend's worsening/broken distribution already surfaces) — NOT a
// stale rubric. Defaulting to 'unknown' avoids false-positiving staleness onto a
// working rubric correctly reporting a broken system. Override `staleRatings` to widen.
// ───────────────────────────────────────────────────────────────────────────

/** One criterion flagged as stale (persistently unassessable). */
export interface CriterionStaleness {
  criterion: string;
  /** Fraction of in-window ratings that are a "stale" rating (default 'unknown'). */
  staleFraction: number;
  /** # in-window ratings for this criterion (the evidence base). */
  samples: number;
  reason: string;
}

/** A rubric's staleness assessment over the scorecard window. */
export interface RubricStaleness {
  /** true when ≥1 criterion is flagged stale — the rubric's model may have drifted. */
  stale: boolean;
  /** The criteria flagged stale + why (empty when not stale). */
  staleCriteria: CriterionStaleness[];
  /** Human-readable rubric-level summary. */
  reason: string;
}

export interface RubricStalenessOpts {
  /** Min in-window ratings for a criterion before staleness is judged (default 3) —
   *  too few ratings is "unknown", not "stale". */
  minSamples?: number;
  /** Stale-rating fraction at/above which a criterion is flagged (default 0.5). */
  staleFraction?: number;
  /** Ratings that count as "stale" evidence (default ['unknown']). Case-insensitive. */
  staleRatings?: readonly string[];
}

const STALENESS_DEFAULTS = {
  minSamples: 3,
  staleFraction: 0.5,
  staleRatings: ['unknown'] as readonly string[],
};

/**
 * Detect rubric staleness from its per-criterion trends (P-011). A criterion with
 * ≥ `minSamples` in-window ratings of which ≥ `staleFraction` are a stale rating
 * (default 'unknown') is flagged — the Overwatch keeps being unable to assess it, so
 * the rubric's model for it no longer matches reality. Pure (DB-free) so it unit-tests
 * exhaustively; `scorecardTrend` applies it over the criteria it builds.
 */
export function computeRubricStaleness(
  criteria: readonly CriterionTrend[],
  opts: RubricStalenessOpts = {},
): RubricStaleness {
  const minSamples = opts.minSamples ?? STALENESS_DEFAULTS.minSamples;
  const staleFraction = opts.staleFraction ?? STALENESS_DEFAULTS.staleFraction;
  const staleRatings = new Set(
    (opts.staleRatings ?? STALENESS_DEFAULTS.staleRatings).map((r) => r.toLowerCase()),
  );

  const staleCriteria: CriterionStaleness[] = [];
  for (const c of criteria) {
    if (c.count < minSamples) continue; // too little evidence → not "stale", just quiet
    const staleCount = Object.entries(c.distribution).reduce(
      (n, [rating, k]) => (staleRatings.has(rating.toLowerCase()) ? n + k : n),
      0,
    );
    const fraction = staleCount / c.count;
    if (fraction >= staleFraction) {
      staleCriteria.push({
        criterion: c.criterion,
        staleFraction: fraction,
        samples: c.count,
        reason: `${staleCount}/${c.count} recent ratings are ${[...staleRatings].join('/')} — the criterion's model may no longer match how the system works`,
      });
    }
  }

  const stale = staleCriteria.length > 0;
  return {
    stale,
    staleCriteria,
    reason: stale
      ? `${staleCriteria.length} criteri${staleCriteria.length === 1 ? 'on' : 'a'} persistently unassessable (${staleCriteria
          .map((s) => s.criterion)
          .join(', ')}) — the rubric model may have drifted; re-ratify via the queen↔scout loop`
      : 'no staleness detected (criteria are being assessed)',
  };
}

/** A rubric's qualitative health trend — per-criterion rating time-series + direction. */
export interface RubricTrend {
  rubricRef: string;
  sourceHive?: string;
  /** # scorecards aggregated in the window. */
  scorecardCount: number;
  /** The observed time span (oldest..newest scorecard) + the requested `since`. */
  window: { since?: string; from?: string; to?: string };
  /** Per-criterion trends, criterion key ASC (stable output). */
  criteria: CriterionTrend[];
  /** Staleness signal (P-011): criteria the Overwatch persistently can't assess,
   *  suggesting the rubric's model has drifted and should re-enter the queen↔scout
   *  loop for re-ratification. */
  staleness: RubricStaleness;
}

export interface ScorecardTrendFilter {
  /** The rubric to trend (required — a trend is per-rubric). */
  rubricRef: string;
  /** Restrict to one source-hive (trends are per-hive when set). */
  sourceHive?: string;
  /** Only scorecards filed at/after this ISO timestamp (the window). */
  since?: string;
  /** Max scorecards to aggregate (newest-first read; default 500). */
  limit?: number;
}

/**
 * Aggregate a rubric's scorecards into a per-criterion rating time-series + a
 * trend direction (P-010). Reads {@link listScorecards} (P-013) — the trend is a
 * pure roll-up of the scorecard read, so it inherits the same workspace scope +
 * organic-only + rubric filtering, and stays correct as the storage evolves.
 */
export async function scorecardTrend(filter: ScorecardTrendFilter): Promise<RubricTrend> {
  const rows = await listScorecards({
    rubricRef: filter.rubricRef,
    sourceHive: filter.sourceHive,
    since: filter.since,
    limit: filter.limit ?? 500,
  });
  // listScorecards is newest-first; the series wants chronological (oldest→newest).
  const chrono = [...rows].reverse();

  const byCriterion = new Map<string, { at: string; rating: string }[]>();
  for (const sc of chrono) {
    for (const [criterion, entry] of Object.entries(sc.ratings)) {
      const arr = byCriterion.get(criterion) ?? [];
      arr.push({ at: sc.createdAt, rating: entry.rating });
      byCriterion.set(criterion, arr);
    }
  }

  const criteria: CriterionTrend[] = [...byCriterion.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([criterion, series]) => {
      const distribution: Record<string, number> = {};
      for (const s of series) distribution[s.rating] = (distribution[s.rating] ?? 0) + 1;
      return {
        criterion,
        count: series.length,
        distribution,
        first: { rating: series[0].rating, at: series[0].at },
        latest: { rating: series[series.length - 1].rating, at: series[series.length - 1].at },
        direction: computeTrendDirection(series),
        series,
      };
    });

  return {
    rubricRef: filter.rubricRef,
    ...(filter.sourceHive ? { sourceHive: filter.sourceHive } : {}),
    scorecardCount: rows.length,
    window: {
      ...(filter.since ? { since: filter.since } : {}),
      ...(chrono.length ? { from: chrono[0].createdAt, to: chrono[chrono.length - 1].createdAt } : {}),
    },
    criteria,
    staleness: computeRubricStaleness(criteria),
  };
}
