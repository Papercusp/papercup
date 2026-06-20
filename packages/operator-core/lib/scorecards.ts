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
      rubricCriteriaKeys.set(observation.rubricRef, rubric ? rubric.criteria.map((c) => c.key) : null);
    }
    const criteriaKeys = rubricCriteriaKeys.get(observation.rubricRef) ?? null;
    const rubricResolved = criteriaKeys !== null;
    const missingKeys = rubricResolved ? criteriaKeys!.filter((k) => !ratedKeys.has(k)) : [];

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

function computeDirection(series: readonly { at: string; rating: string }[]): TrendDirection {
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
        direction: computeDirection(series),
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
  };
}
