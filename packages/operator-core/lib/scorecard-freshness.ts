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
  /** The rubric whose emission freshness to check (e.g. 'pot-coordination-health'). */
  rubricRef: string;
  /** Restrict to one source-hive (freshness is per-hive when set). */
  sourceHive?: string;
  /** Window start (ISO) — pass the Overwatch's last wake for a precise "since last wake" check. */
  since?: string;
  /** Fallback window size when `since` is omitted (default 2h). */
  lookbackMs?: number;
  /**
   * Count SYNTHESIZED floor scorecards toward freshness. Default FALSE — freshness measures
   * the AGENT's every-turn emission, so the deterministic backstop floor
   * (overwatch/scorecard-backstop) does NOT make a silently-skipping Overwatch read 'fresh'.
   */
  includeSynthesized?: boolean;
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
    // Default-false: freshness reflects the AGENT's emission, never the synthesized floor.
    includeSynthesized: filter.includeSynthesized ?? false,
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

/**
 * Overwatch operational context for INTERPRETING a coordination-health freshness verdict —
 * the fields lifted from the existing overwatch liveness model (`deriveOverwatchLiveness` in
 * overwatch/snapshot.ts). `loopAlive`/`loopStale` are that model's ALIVE/STALE bits (a
 * started+enabled loop is `stale` once its last fire is older than 2× cadence; a paused/dark
 * loop is neither). Kept as a tiny plain interface so the interpreter stays PURE + DB-free.
 */
export interface OverwatchEmissionContext {
  /** the papercusp-overwatch flag is on */
  flagEnabled: boolean;
  /** the kettle:start bit is set */
  started: boolean;
  /** the wake loop fired within its stale window (liveness.alive) */
  loopAlive: boolean;
  /** started+enabled but the wake loop is past its stale window / never fired (liveness.stale) */
  loopStale: boolean;
  /** the loop's last fire time (ISO), or null if it never fired */
  lastRunAt: string | null;
}

/**
 * The disambiguated verdict for a coordination-health freshness read. A bare `stale` /
 * `partial-only` status cannot tell the Queen WHY emission lapsed — the exact
 * "monitor-the-monitor is silent" gap (WI-1724): a dark monitor, a paused/not-started
 * monitor, a DEAD wake-loop, and a live-loop-but-skipping AGENT all read `stale`, yet only
 * two are actionable and each needs a DIFFERENT action.
 */
export type FreshnessVerdict =
  | 'fresh' // a complete scorecard landed in-window — mandate met
  | 'overwatch-disabled' // flag off — staleness EXPECTED, ignore
  | 'overwatch-not-started' // enabled but not started (pre-armed) — ignore until start
  | 'loop-dead' // started+enabled but the wake loop is stale/never-fired — REVIVE the loop
  | 'agent-skipping'; // loop firing but no COMPLETE scorecard — fix the AGENT (the D-005 case)

export interface FreshnessInterpretation {
  verdict: FreshnessVerdict;
  /** true = a real, unexpected gap the Queen should ACT on; false = expected / ignore. */
  actionable: boolean;
  /** one-line explanation of WHY the verdict holds and what to do about it. */
  note: string;
}

/**
 * Turn a raw freshness `status` + the overwatch operational context into a SELF-INTERPRETING
 * verdict (WI-1724). Pure + deterministic (no PG / flags / clock) so it unit-tests exhaustively;
 * the `scorecards:freshness` tool supplies the live context via `getOverwatchLiveness`.
 *
 * Precedence (why the gap exists, most-benign first): disabled → not-started → dead loop →
 * skipping agent. `disabled`/`not-started` are NON-actionable (the emission gap is expected);
 * `loop-dead`/`agent-skipping` are actionable but point at DIFFERENT fixes (revive the loop vs.
 * fix the agent turn), which a bare `stale` could never distinguish.
 */
export function interpretOverwatchEmission(
  status: ScorecardFreshnessStatus,
  ctx: OverwatchEmissionContext,
): FreshnessInterpretation {
  if (status === 'fresh') {
    return {
      verdict: 'fresh',
      actionable: false,
      note: 'A complete scorecard landed in-window — the Overwatch emission mandate is met.',
    };
  }
  // status is 'partial-only' | 'stale' — there IS an emission gap; disambiguate WHY.
  if (!ctx.flagEnabled) {
    return {
      verdict: 'overwatch-disabled',
      actionable: false,
      note: 'Overwatch is DISABLED (papercusp-overwatch flag off) — scorecard staleness is EXPECTED, not a broken monitor. Ignore.',
    };
  }
  if (!ctx.started) {
    return {
      verdict: 'overwatch-not-started',
      actionable: false,
      note: 'Overwatch is enabled but NOT started (pre-armed) — no emission is expected until kettle:start. Ignore.',
    };
  }
  if (ctx.loopStale || !ctx.loopAlive) {
    return {
      verdict: 'loop-dead',
      actionable: true,
      note: `Overwatch is enabled + started but its WAKE LOOP is stale (last run ${ctx.lastRunAt ?? 'never'}) — the emission gap is a DEAD MONITOR LOOP, not an agent skip. Revive it (kettle:start / kettle:declare-wake) and investigate the overwatch liveness watchdog.`,
    };
  }
  // The wake loop IS firing, yet no COMPLETE scorecard landed — the AGENT is skipping /
  // truncating its mandate (the original D-005 silent-skip / silent-truncation case).
  return {
    verdict: 'agent-skipping',
    actionable: true,
    note:
      status === 'partial-only'
        ? 'Overwatch loop is firing but emitted only PARTIAL scorecards in-window — the agent is TRUNCATING (silent partials). Check latestMissingKeys for the dropped criteria.'
        : 'Overwatch loop is firing but emitted NO complete scorecard in-window — the agent is SKIPPING its mandate despite a live loop. Check the agent turn / prompt.',
  };
}
