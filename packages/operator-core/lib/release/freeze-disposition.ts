/**
 * Pure projection of "what did the gate just do with freeze-and-converge, and WHY" into the
 * `gate_health.freezeAndConverge` blob every status surface reads.
 *
 * WHY THIS EXISTS (WI-2141736 P-004, measured 2026-09-02)
 * -------------------------------------------------------
 * Freeze-and-converge was effectively OFF fleet-wide for a full day — 20 frozen candidates
 * retired, 0 resumed — and the ONLY evidence of it was a grep across per-run checkpoint
 * logs. Nothing a reader could query said so. `release:deploy status` showed `repairQueue`,
 * which is null precisely when a candidate has just been retired, so the surface was
 * silent in exactly the state that mattered; and a run log is not a read.
 *
 * So the disposition is recorded as STATE, not narration. Two properties earn it a place
 * here rather than on `CheckpointResult`:
 *
 *  · It must survive the queue it describes. A retire CLEARS the queue row, so anything
 *    hanging off `repairQueue` disappears at the moment it becomes interesting — the same
 *    reasoning that put `fossilAbandonment` on the result (EI-21763163890991789), one level
 *    further out.
 *  · It must survive a run that goes on to render an ordinary verdict. A retire does not
 *    return early: the gate retires the queue and continues to judge a fresh tip, and that
 *    terminal return does not pass through the result wrapper the hold paths use.
 *
 * This module performs no git, filesystem, database, or process work.
 */

/**
 * What the gate did with freeze-and-converge on this tick.
 *
 * ⚠ `off` and `none` are NOT synonyms and conflating them is the misread this whole item
 * exists to prevent: `off` means the owner switched the mechanism off (D-007's flag), while
 * `none` means the mechanism is on and simply had no frozen candidate to act on — a green
 * gate's normal state. Rendering both as "not freezing" is how a day of silent suppression
 * looked like an ordinary week.
 */
export type FreezeAndConvergeState =
  /** The owner-visible off switch is OFF; reds do not freeze a candidate at all. */
  | 'off'
  /** Enabled, but this tick had no frozen candidate — nothing to hold or retire. */
  | 'none'
  /** A frozen candidate is being HELD: no verdict, no queue mutation, re-measured next tick. */
  | 'held'
  /** A frozen candidate was RETIRED this tick; the gate falls through to a fresher candidate. */
  | 'retired'
  /** A frozen candidate is live and being repaired (fixer dispatched, or repairHead advancing). */
  | 'converging';

export interface FreezeAndConvergeDisposition {
  /** Is the mechanism switched on at all? False ONLY for state 'off'. */
  enabled: boolean;
  state: FreezeAndConvergeState;
  /**
   * One line answering "why is it in that state". This is the sentence that previously
   * existed only inside a run log, and it is the entire point of the record — a state
   * without its reason still sends a reader back to the logs.
   */
  reason: string;
  /** The frozen candidate this disposition is about, when there is one. */
  candidate?: string | null;
  /** `held` only: the epoch ms at which the hold gives up and retires anyway. */
  holdUntilMs?: number | null;
  /** `held` only: when the measured provider wall is expected to lift. */
  capacityRetryAtMs?: number | null;
}

/** The shape merged into `gate_health` (a SHALLOW merge — never a replace). */
export interface FreezeAndConvergeGateHealth {
  freezeAndConverge: {
    enabled: boolean;
    state: FreezeAndConvergeState;
    reason: string;
    candidate: string | null;
    holdUntilMs: number | null;
    capacityRetryAtMs: number | null;
    /**
     * When this disposition was observed. Load-bearing, not decoration: without it a
     * reader cannot tell a CURRENT `retired` from one left behind by a run hours ago,
     * and a stale disposition read as live is worse than none — it is the false-green
     * class (WI-6228) applied to the freeze.
     */
    observedAtMs: number;
  };
}

/** How long a stored disposition may be trusted as describing the CURRENT tick. */
export const FREEZE_DISPOSITION_FRESH_MS = 3 * 60 * 60 * 1_000;

/**
 * PURE: project a disposition into the gate_health fragment.
 *
 * Every optional field is written EXPLICITLY as null rather than omitted. Under a shallow
 * `||` merge an omitted key leaves the PREVIOUS tick's value in place, so a hold that
 * cleared would keep advertising its old `holdUntilMs` — a stale bound presented as a live
 * deadline, which is precisely the archaeology this record was added to end.
 */
export function buildFreezeAndConvergeGateHealth(
  disposition: FreezeAndConvergeDisposition,
  nowMs: number,
): FreezeAndConvergeGateHealth {
  return {
    freezeAndConverge: {
      enabled: disposition.enabled,
      state: disposition.state,
      reason: disposition.reason,
      candidate: disposition.candidate ?? null,
      holdUntilMs: disposition.holdUntilMs ?? null,
      capacityRetryAtMs: disposition.capacityRetryAtMs ?? null,
      observedAtMs: nowMs,
    },
  };
}

/**
 * What a tick looked like from OUTSIDE the freeze decision tree — the minimum a terminal
 * handler already holds. Structural on purpose: this module must not import
 * `CheckpointResult` from `apps/operator`, and the backstop must keep working when a new
 * result field is added.
 */
export interface TickFreezeObservation {
  /** FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT as the run actually read it. */
  flagEnabled: boolean;
  /** The frozen repair queue the tick ended holding, when there was one. */
  repairQueue?: { candidate?: string | null } | null;
  /** The run's own one-line summary — the honest reason when no branch recorded a richer one. */
  summary?: string | null;
  /** Did the tick reach a green verdict? */
  green?: boolean | null;
}

/**
 * PURE: derive the disposition a tick would have recorded if no branch recorded one.
 *
 * WHY A BACKSTOP EXISTS (P-008, measured 2026-09-03)
 * --------------------------------------------------
 * The four explicit `recordFreezeDisposition` call sites cover `retired` (x2), `held` and
 * `off`. `converging` and `none` are recorded NOWHERE — and because the stored record is
 * SHALLOW-MERGED and never cleared, the last `held` stands unchanged while the freeze
 * converges or clears. A reader inside the freshness window then sees `state: 'held'`,
 * with the hold's reason and candidate, for a candidate that is no longer frozen: a stale
 * disposition presented as current, which is the exact false-green class the record was
 * added to end, one level up.
 *
 * Enumerating branches does not fix that — it is hand-maintained metadata about control
 * flow, and the NEXT branch added misses it again in the same silent way. So the tick's
 * terminal handler derives a disposition from what it already holds and writes it only if
 * nothing else did. Every tick then leaves exactly one record describing THAT tick.
 *
 * A branch-recorded disposition always wins: it carries the measured sentence (a capacity
 * wall, a retirement rationale) that this projection cannot reconstruct.
 */
export function deriveTickFreezeDisposition(
  observation: TickFreezeObservation,
): FreezeAndConvergeDisposition {
  const candidate = observation.repairQueue?.candidate ?? null;
  if (!observation.flagEnabled) {
    return {
      enabled: false,
      state: 'off',
      reason:
        'FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT is OFF (owner-set): this tick did not ' +
        'freeze anything, and the next tick re-cuts at tip',
      candidate,
    };
  }
  if (candidate) {
    return {
      enabled: true,
      state: 'converging',
      reason:
        observation.summary?.trim() ||
        `frozen candidate ${candidate.slice(0, 12)} is live and being repaired; the tick ` +
          `ended without a branch-recorded disposition`,
      candidate,
    };
  }
  return {
    enabled: true,
    state: 'none',
    reason:
      observation.green === true
        ? 'freeze-and-converge is on and had nothing to do: the gate went green, so no candidate is frozen'
        : observation.summary?.trim() ||
          'freeze-and-converge is on and no candidate is frozen this tick',
    candidate: null,
  };
}

/**
 * PURE: the one-line answer to "is the freeze currently on, and if not why not" — the
 * literal question P-004 exists to make a read.
 *
 * Returns null for an ABSENT record, deliberately, so a caller renders "not measured"
 * rather than inventing a healthy-sounding default. An unmeasured freeze and a working one
 * must never look the same; that equivalence is what hid the original outage.
 */
export function summarizeFreezeAndConverge(
  gateHealth: unknown,
  nowMs: number,
): string | null {
  const record = readFreezeAndConverge(gateHealth);
  if (!record) return null;
  const ageMs = nowMs - record.observedAtMs;
  const stale = ageMs > FREEZE_DISPOSITION_FRESH_MS;
  const staleNote = stale
    ? ` ⚠ last observed ${Math.round(ageMs / 60_000)}m ago — the gate has not reported since, so treat this as history, not current state.`
    : '';
  const subject = record.candidate
    ? ` (candidate ${record.candidate.slice(0, 12)})`
    : '';
  const head = record.enabled
    ? `freeze-and-converge is ON, ${record.state}${subject}`
    : `freeze-and-converge is OFF${subject}`;
  return `${head}: ${record.reason}${staleNote}`;
}

/**
 * PURE: read the stored record back, or null when it is absent or malformed.
 *
 * Fails CLOSED to null on every shape it does not recognise. A partially-written blob
 * coerced into a plausible-looking record is a confident wrong answer about whether the
 * release gate is freezing, which is strictly worse than "not measured".
 */
export function readFreezeAndConverge(
  gateHealth: unknown,
): FreezeAndConvergeGateHealth['freezeAndConverge'] | null {
  if (!gateHealth || typeof gateHealth !== 'object') return null;
  const raw = (gateHealth as Record<string, unknown>)['freezeAndConverge'];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const state = r['state'];
  const validState =
    state === 'off' ||
    state === 'none' ||
    state === 'held' ||
    state === 'retired' ||
    state === 'converging';
  if (!validState) return null;
  if (typeof r['enabled'] !== 'boolean') return null;
  if (typeof r['reason'] !== 'string' || r['reason'] === '') return null;
  if (typeof r['observedAtMs'] !== 'number' || !Number.isFinite(r['observedAtMs'])) {
    return null;
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    enabled: r['enabled'],
    state,
    reason: r['reason'],
    candidate: typeof r['candidate'] === 'string' ? r['candidate'] : null,
    holdUntilMs: num(r['holdUntilMs']),
    capacityRetryAtMs: num(r['capacityRetryAtMs']),
    observedAtMs: r['observedAtMs'],
  };
}
