/**
 * EI-21290961259437085: how a gate tick that ABORTED without rendering a verdict
 * should be described to a reader — and, specifically, whether re-firing would hit
 * the same wall.
 *
 * ## Why this is a shared table rather than two `if` chains
 *
 * An aborted tick is reported in TWO places, and they must agree:
 *
 *  - `git-pipeline-position.ts`'s `nextAction` — the ONE lever a reader acts on;
 *  - the same file's gate `detail`/`summary` sentence, which is what a reader
 *    actually reads first.
 *
 * They drifted, twice, in the same direction. `deadline-exceeded` (WI-39841) and
 * `infra-inconclusive` (EI-20767792192323374) each earned a specific `nextAction`
 * saying a re-fire is NOT blocked — while the summary sentence beside them kept
 * asserting, unconditionally, that "firing another run will abort the same way".
 * Fixing a lever without the sentence is what left the same defect half-closed on
 * two separate occasions, so both now derive from this table and cannot disagree.
 *
 * ## Why "clear the abort condition" is not a safe default
 *
 * The generic advice — *clear the condition, a re-fire aborts identically* — is
 * only true for an abort that names a STANDING condition. Applied to an abort that
 * merely RECORDS something that already happened, it tells the reader to clear a
 * condition that does not exist and warns them off the one action that would help.
 * Observed live on 2026-08-24: papercusp's gate sat at `inconclusive.status =
 * 'cancelled'` — an external SIGTERM, recorded, not latched — and every reader was
 * told to "clear the gate's abort condition (cancelled) ... re-firing aborts the
 * same way". Neither clause was true, and the advisory manufactured the paralysis
 * it described.
 *
 * ⚠ The inverse error is just as expensive, which is why this is a classification
 * and not a boolean: `disk-headroom` and `migrations-pending` genuinely ARE standing
 * conditions, and telling a reader to re-fire into one burns a ~55min suite to
 * reproduce a known abort. Do not "simplify" this into "aborts never block a
 * re-fire".
 */

/**
 * The statuses that can actually reach a reader as `gate_health.inconclusive`.
 *
 * ⚠ This is deliberately NOT `classifyGateStallStatus`'s `'noop'` class, which is a
 * larger and different set. `'noop'` answers "should this tick disturb the red
 * streak?"; this answers "can this tick be SEEN by a reader as an abort?". Two noop
 * members (`skipped-locked`, `disk-headroom`) are never recorded as inconclusive and
 * so never reach `nextAction` by this path — routing on the noop class instead would
 * pull in statuses this advice does not fit.
 *
 * SINGLE SOURCE: `release-actions.ts` writes `gate_health.inconclusive` for exactly
 * these statuses and imports this constant to do it, so the recorded set and the
 * advised set cannot drift apart.
 */
export const RECORDED_INCONCLUSIVE_STATUSES = [
  'migrations-pending',
  'infra-inconclusive',
  'deadline-exceeded',
  'cancelled',
  'repair-in-progress',
  'repair-staging-mismatch',
] as const;

export type RecordedInconclusiveStatus = (typeof RECORDED_INCONCLUSIVE_STATUSES)[number];

export function isRecordedInconclusiveStatus(status: string): status is RecordedInconclusiveStatus {
  return (RECORDED_INCONCLUSIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * What KIND of thing the abort names — which is what decides the advice.
 *
 *  - `standing-condition` — a real blocker persists. Clear it; a re-fire hits it again.
 *  - `transient`          — the tick was killed or faulted by something that has already
 *                           happened. Nothing to clear, and a re-fire may well finish.
 *  - `peer-owned`         — progress is owned by someone else's in-flight run or repair.
 *                           Nothing for THIS reader to clear, and a re-fire contends.
 *  - `unknown`            — an unclassified status. Advice falls back to the conservative
 *                           generic wording; see `gateAbortRefireClause`.
 */
export type GateAbortKind = 'standing-condition' | 'transient' | 'peer-owned' | 'unknown';

const KIND_BY_STATUS: Record<RecordedInconclusiveStatus, Exclude<GateAbortKind, 'unknown'>> = {
  // The dev PG is behind the candidate: a real, standing precondition.
  'migrations-pending': 'standing-condition',
  // The repair queue's staging expectation does not match the tree: standing until reconciled.
  'repair-staging-mismatch': 'standing-condition',
  // The gate's own vite-node module cache was deleted mid-run — HOST weather, already past.
  'infra-inconclusive': 'transient',
  // SIGTERMd at the suite budget: it ran out of clock, it is not blocked.
  'deadline-exceeded': 'transient',
  // Externally SIGTERMed (exit 143) before publishing a marker. RECORDS a kill; latches nothing.
  cancelled: 'transient',
  // A repair phase owns progress outside the full-suite verdict path.
  'repair-in-progress': 'peer-owned',
};

export function classifyGateAbort(status: string): GateAbortKind {
  return isRecordedInconclusiveStatus(status) ? KIND_BY_STATUS[status] : 'unknown';
}

/**
 * The clause the gate's summary sentence appends after "it rendered NO verdict".
 *
 * Returns the FULL sentence fragment (leading space included) so the caller cannot
 * accidentally reintroduce the unconditional claim by concatenating around it.
 */
export function gateAbortRefireClause(status: string): string {
  switch (classifyGateAbort(status)) {
    case 'standing-condition':
      return ' and firing another run will abort the same way until that condition clears.';
    case 'transient':
      // The correction this module exists for: nothing latched, so do not warn the
      // reader off a re-fire — but do NOT promise the pipeline is otherwise clear.
      return (
        ' — this RECORDS what stopped the run, it does not latch anything, so nothing about it' +
        ' blocks a re-fire.'
      );
    case 'peer-owned':
      return ' and another owner is mid-progress, so a re-fire contends with them rather than clearing it.';
    case 'unknown':
    default:
      // Conservative: an unclassified status keeps the pre-existing generic wording
      // rather than inheriting either confident claim.
      return ' — see the green-checkpoint log for whether the condition still stands.';
  }
}

/**
 * The `nextAction` lever for a recorded abort that has no hand-written arm of its own.
 *
 * Callers keep their earned, status-specific arms (`migrations-pending`,
 * `infra-inconclusive`, `deadline-exceeded`) — those carry detail this table does not
 * try to reproduce. This covers the rest.
 */
export function gateAbortLever(status: string): string {
  switch (classifyGateAbort(status)) {
    case 'transient':
      return (
        `the last run was stopped before it recorded a verdict (${status}) — nothing is blocking a re-fire, ` +
        `so release:checkpoint-run once you know what stopped it; ⚠ do NOT triage the files an earlier red ` +
        `named, this tick judged no code at all. An external kill has a CAUSE worth finding first ` +
        `(a reaper, a pkill pattern, a scope stop, OOM), or the next run dies the same way`
      );
    case 'peer-owned':
      return (
        `wait for the owner of the in-flight repair to finish (${status}) — there is nothing for you to ` +
        `clear, and a re-fire contends with them; ⚠ do NOT triage the files an earlier red named, this tick ` +
        `judged no code at all`
      );
    case 'standing-condition':
    case 'unknown':
    default:
      return `clear the gate's abort condition (${status}) — it renders no verdict until then, and re-firing aborts the same way`;
  }
}
