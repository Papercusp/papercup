/**
 * tripwire-refresh.ts — plan blender-goal-amendment-rail-2026-08-19 P-004.
 *
 * THE DEFECT THIS CLOSES, as MEASURED rather than asserted (2026-08-19):
 * every tripwire on every ACTIVE goal carried `current: null`. The only goals
 * whose tripwires held a value were `achieved`/`killed` ones, filled in by hand
 * at close time. A kill criterion that is only ever scored after the goal is
 * over is decorative — it can never fire.
 *
 * ⚠ THE MEASUREMENT WAS NEVER MISSING. That is the whole finding, and it is why
 * this module is a JOIN rather than an instrument. `spend-rollup.ts` has been
 * computing fully-attributed goal spend for every active goal every 5 minutes
 * and writing it to `metadata.spentCents` — one field away from the tripwire it
 * was supposed to advance. Measured at the time of writing:
 *
 *   goal                                     metadata.spentCents   spend tripwire
 *   the-papercusp-desktop-app-…7273ca        34618 (measured)      threshold 50 usd, current NULL
 *
 * $346.18 of measured spend against a declared $50 ceiling, showing in the UI as
 * unmeasured. The number was right there. Nothing carried it across.
 *
 * ── WHY THIS LIVES BESIDE THE ROLLUP AND NOT IN THE BLENDER (D-014) ──────────
 * P-004 is worded "let the Blender refresh tripwires[].current", written before
 * the rollup tick was known to exist. Routing the SPEND metric through an
 * ideation agent would contradict D-003 of goal-mode-design-intent-hardening
 * ("spend truth comes from the platform cost ledger rolled up by goal_id; agents
 * never hand-write spentCents"). The advance therefore happens platform-side, in
 * the same sweep that already computed the number, with no agent in the loop.
 *
 * ── THE TWO RULES THAT KEEP THIS HONEST ──────────────────────────────────────
 *  1. NEVER INVENT. A metric with no generic resolver (`species_covered`,
 *     `hours_since_verdict_advance`) is left EXACTLY as it was. Only the goal's
 *     own executor can score those, and a plausible-looking number that nobody
 *     measured is worse than a blank.
 *  2. NEVER PROMOTE A FLOOR TO A MEASUREMENT. `computeGoalSpendRollup` reports
 *     `measured: false` when any sample is unpriced — the total is then a lower
 *     bound. Advancing a ceiling-governing tripwire from a floor would read as
 *     "you are safely under" when the true figure is unknown, so an unmeasured
 *     rollup advances nothing. Measured live: the-gui-chat-surface-…8fa0ed had 8
 *     of 17 samples unpriced, and correctly stays blank.
 *
 * Both rules are one-directional: a refresh never clears or lowers a value it
 * cannot currently measure, so a transient unpriced sample cannot blank a
 * tripwire that was already scored.
 */

/**
 * The stored tripwire shape — mirrors `GoalTripwire` (sync-resolver/goals.ts).
 *
 * A `type` and not an `interface` deliberately: only a type alias gets TypeScript's
 * implicit index signature, and without one this is not assignable to postgres-js's
 * `JSONValue`, so the round-trip back into the jsonb column would not typecheck.
 */
export type GoalTripwireLike = {
  metric: string;
  label: string;
  threshold: number;
  current?: number | null;
  unit?: string;
};

/**
 * The facts a tripwire may be advanced FROM. Deliberately tiny: every field here
 * is platform-measured, and anything not derivable from these is left alone by
 * rule 1 above.
 */
export interface TripwireMeasurement {
  /**
   * Total attributed spend in CENTS, or null when the rollup is a floor
   * (`measured: false`) or absent. Null advances no spend tripwire.
   */
  measuredSpentCents: number | null;
  /** Age of the goal at measurement time, in ms. Negative values are treated as 0. */
  goalAgeMs: number;
}

/** Why a tripwire did or did not move. */
export type TripwireRefreshReason =
  /** advanced to a freshly measured value */
  | 'advanced'
  /** a resolver exists and produced the value already stored */
  | 'unchanged'
  /** no generic resolver for this metric — the executor's to score (rule 1) */
  | 'no-resolver'
  /** a resolver exists but the input was absent or a floor (rule 2) */
  | 'unmeasured';

export interface TripwireRefreshOutcome {
  metric: string;
  before: number | null;
  after: number | null;
  reason: TripwireRefreshReason;
}

export interface TripwireRefreshResult {
  /** The tripwire array to persist. Referentially equal to the input when nothing moved. */
  next: GoalTripwireLike[];
  outcomes: TripwireRefreshOutcome[];
  /** How many tripwires took a new value. `changed` is `advanced > 0`. */
  advanced: number;
  changed: boolean;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * A resolver returns the value a metric should now hold, or null for "I cannot
 * measure this right now" (which never overwrites).
 *
 * Keyed by METRIC NAME, not the free-text `unit` field: the metric name is the
 * contract a goal author writes against, while `unit` is a display label that
 * has been observed to disagree with it. `spend_usd` therefore yields dollars
 * whatever `unit` says.
 */
const RESOLVERS: Record<string, (m: TripwireMeasurement) => number | null> = {
  /** Dollars, 2dp — the ceiling most goals declare. */
  spend_usd: (m) => (m.measuredSpentCents === null ? null : Math.round(m.measuredSpentCents) / 100),
  /** Cents, as stored. */
  spend_cents: (m) => (m.measuredSpentCents === null ? null : Math.round(m.measuredSpentCents)),
  /** Whole days since the goal was created. */
  days_elapsed: (m) => Math.floor(Math.max(0, m.goalAgeMs) / MS_PER_DAY),
  /** Whole hours since the goal was created. */
  hours_elapsed: (m) => Math.floor(Math.max(0, m.goalAgeMs) / MS_PER_HOUR),
};

/** The metrics this module can advance without an executor. Exported for tests + docs. */
export const GENERICALLY_MEASURABLE_METRICS: readonly string[] = Object.keys(RESOLVERS).sort();

/** Normalise a stored `current` (absent | null | non-finite) to null. */
function readCurrent(t: GoalTripwireLike): number | null {
  return typeof t.current === 'number' && Number.isFinite(t.current) ? t.current : null;
}

/**
 * Advance every generically-measurable tripwire, leaving the rest untouched.
 *
 * PURE — no clock, no I/O. The caller supplies the measurement, which is what
 * makes the whole policy (rules 1 and 2 above) testable without a database.
 */
export function refreshTripwireCurrents(
  tripwires: readonly GoalTripwireLike[] | null | undefined,
  measurement: TripwireMeasurement,
): TripwireRefreshResult {
  const input = tripwires ?? [];
  if (input.length === 0) {
    return { next: [], outcomes: [], advanced: 0, changed: false };
  }

  const outcomes: TripwireRefreshOutcome[] = [];
  const next: GoalTripwireLike[] = [];
  let advanced = 0;

  for (const t of input) {
    const before = readCurrent(t);
    const resolver = RESOLVERS[t.metric];

    if (!resolver) {
      // Rule 1 — the executor's to score. Pass the tripwire through byte-identical.
      outcomes.push({ metric: t.metric, before, after: before, reason: 'no-resolver' });
      next.push(t);
      continue;
    }

    const value = resolver(measurement);
    if (value === null || !Number.isFinite(value)) {
      // Rule 2 — a floor, or nothing measured. Never clears an existing value.
      outcomes.push({ metric: t.metric, before, after: before, reason: 'unmeasured' });
      next.push(t);
      continue;
    }

    if (before !== null && before === value) {
      outcomes.push({ metric: t.metric, before, after: before, reason: 'unchanged' });
      next.push(t);
      continue;
    }

    outcomes.push({ metric: t.metric, before, after: value, reason: 'advanced' });
    next.push({ ...t, current: value });
    advanced += 1;
  }

  // Referential identity when nothing moved, so a caller can skip the write.
  if (advanced === 0) {
    return { next: input as GoalTripwireLike[], outcomes, advanced: 0, changed: false };
  }
  return { next, outcomes, advanced, changed: true };
}

/**
 * Which PLATFORM-MEASURED tripwires are now AT OR PAST their threshold.
 *
 * The point of advancing `current` at all: a kill criterion that scores itself
 * can fire. This reports the breaches for the caller to log/surface — it does
 * NOT act on them. Killing a goal on a measured breach is a separate, deliberate
 * decision (and an owner-facing one); silently escalating a reporting sweep into
 * a terminal action is exactly the kind of leap this plan is written against.
 *
 * Executor-owned domain metrics are deliberately excluded. The platform has no
 * resolver for them, so their stored `current` may be a seeded value, a stale
 * snapshot, or a decreasing-to-zero progress count. Treating every numeric value
 * as an upper-bound measurement previously auto-killed goals such as
 * `openReleaseWalls: current=2, threshold=0` even though zero had not been
 * reached. Only metrics in RESOLVERS have the measurement semantics required for
 * a platform-side terminal transition; executors remain responsible for acting
 * on their own domain tripwires.
 */
export function breachedTripwires(
  tripwires: readonly GoalTripwireLike[],
): Array<{ metric: string; current: number; threshold: number; unit?: string }> {
  const out: Array<{ metric: string; current: number; threshold: number; unit?: string }> = [];
  for (const t of tripwires) {
    if (!RESOLVERS[t.metric]) continue;
    const current = readCurrent(t);
    if (current === null || !Number.isFinite(t.threshold)) continue;
    if (current >= t.threshold) {
      out.push({
        metric: t.metric,
        current,
        threshold: t.threshold,
        ...(t.unit ? { unit: t.unit } : {}),
      });
    }
  }
  return out;
}
