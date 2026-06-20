/**
 * scorecard-freshness — the emission-freshness signal
 * (plan-templates-and-rubric-v2-2026-06-20 P-014b / D-005).
 *
 * "Has the Overwatch emitted a COMPLETE scorecard since its last wake?" The runtime teeth for the
 * every-turn mandate's SECOND half: P-014a's completeness GATE makes a partial scorecard fail at
 * WRITE; this makes a NO-emit or partial-only turn VISIBLE at READ — so monitor-the-monitor can see
 * the Overwatch silently skipping or truncating (D-005: a ~4h emission gap + 2-of-4 partials were
 * invisible until a raw PG read). Built on `listScorecards` (P-013, su-3a5d7): a pure roll-up that
 * inherits its workspace-scope + organic-only + rubric filtering, and stays correct as the storage
 * evolves (Phase-3 rubric-as-a-plan re-point keeps the listScorecards seam).
 *
 * A "complete" scorecard = `rubricResolved && missingKeys.length === 0` (every rubric criterion
 * rated). `rubricResolved === false` (unknown rubric) is NEVER counted complete — an empty
 * `missingKeys` from an unresolved rubric must not be misread as "all rated".
 *
 * The caller passes `since` = the Overwatch's last wake (the freshness window). Omitted ⇒ a lookback
 * default that comfortably covers a typical wake interval, so a one-off query still answers usefully.
 */
import { listScorecards, type ScorecardRow } from './scorecards';

export type ScorecardFreshnessStatus = 'fresh' | 'partial-only' | 'stale';

export interface ScorecardFreshness {
  rubricRef: string;
  sourceHive?: string;
  /** The resolved window start (ISO) — scorecards filed at/after this count. */
  since: string;
  /**
   * fresh        — a COMPLETE scorecard landed in-window (the mandate is met).
   * partial-only — scorecard(s) landed but NONE complete (silent truncation — the D-005 case).
   * stale        — nothing landed in-window (silent skip / emission gap — the other D-005 case).
   */
  status: ScorecardFreshnessStatus;
  /** Any scorecard (complete or not) in-window. */
  emitted: boolean;
  /** A COMPLETE scorecard in-window — the actual mandate. */
  complete: boolean;
  /** # scorecards in-window. */
  count: number;
  /** # in-window scorecards that were CONFIRMED incomplete (rubricResolved && missingKeys > 0). */
  partialCount: number;
  /** Newest in-window scorecard's createdAt (any completeness), or null when none. */
  lastEmittedAt: string | null;
  /** Newest in-window COMPLETE scorecard's createdAt, or null when none. */
  lastCompleteAt: string | null;
  /** The newest in-window scorecard's missingKeys — what is unrated right now (empty if complete/none). */
  latestMissingKeys: string[];
}

/** 2h — generous vs a typical Overwatch wake interval, so a since-less query is still meaningful. */
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

export interface CheckScorecardFreshnessDeps {
  /** Injectable for hermetic tests; defaults to the real P-013 listScorecards. */
  listScorecards?: typeof listScorecards;
}

export interface CheckScorecardFreshnessFilter {
  /** The rubric whose emission freshness to check (e.g. 'hive-coordination-health'). */
  rubricRef: string;
  /** Restrict to one source-hive (freshness is per-hive when set). */
  sourceHive?: string;
  /** Window start (ISO) — pass the Overwatch's last wake for a precise "since last wake" check. */
  since?: string;
  /** Fallback window size when `since` is omitted (default 2h). */
  lookbackMs?: number;
}

/**
 * Compute the emission-freshness of a rubric's scorecards over the window. Reads
 * {@link listScorecards} (newest-first) and derives the fresh / partial-only / stale verdict so a
 * no-emit or partial-emit turn is VISIBLE to the curation/watchdog layer instead of silently missed.
 */
export async function checkScorecardFreshness(
  filter: CheckScorecardFreshnessFilter,
  deps: CheckScorecardFreshnessDeps = {},
): Promise<ScorecardFreshness> {
  const list = deps.listScorecards ?? listScorecards;
  const since =
    filter.since ?? new Date(Date.now() - (filter.lookbackMs ?? DEFAULT_LOOKBACK_MS)).toISOString();

  const rows: ScorecardRow[] = await list({
    rubricRef: filter.rubricRef,
    sourceHive: filter.sourceHive,
    since,
  });

  // A valid "complete" requires the rubric to have resolved — an empty missingKeys from an
  // UNresolved rubric is not "all rated", it is "unknowable" (mirrors listScorecards's own note).
  const isComplete = (r: ScorecardRow) => r.rubricResolved && r.missingKeys.length === 0;
  const completes = rows.filter(isComplete);
  const partials = rows.filter((r) => r.rubricResolved && r.missingKeys.length > 0);

  const emitted = rows.length > 0;
  const complete = completes.length > 0;
  const status: ScorecardFreshnessStatus = complete ? 'fresh' : emitted ? 'partial-only' : 'stale';

  return {
    rubricRef: filter.rubricRef,
    ...(filter.sourceHive ? { sourceHive: filter.sourceHive } : {}),
    since,
    status,
    emitted,
    complete,
    count: rows.length,
    partialCount: partials.length,
    // listScorecards is newest-first → rows[0] / completes[0] are the most recent.
    lastEmittedAt: rows[0]?.createdAt ?? null,
    lastCompleteAt: completes[0]?.createdAt ?? null,
    latestMissingKeys: rows[0]?.missingKeys ?? [],
  };
}
