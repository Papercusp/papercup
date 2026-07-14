/**
 * capacity-errors.ts — the ONE pure classifier for "was this scout failure a
 * CAPACITY ceiling (the LLM pool had nothing to give) rather than a genuine cycle
 * failure?". A leaf module (zero deps) so BOTH consumers import the SAME notion:
 *
 *   - scheduler.ts (the WRITE path) — reclassifies a live capacity failure from
 *     status:'error' to a 'no-capacity' gate at record time, so the pool's
 *     busy-ness stops being counted as breakage AND stops false-paging the Mug's
 *     error-streak alarm.
 *   - quality-metrics.ts (the READ path) — re-classifies HISTORICAL error ticks
 *     the same way when computing the error rate, so the "cycle error rate < 5%"
 *     bar reflects genuine failures regardless of WHEN the write-path
 *     reclassification went live. Without this, every capacity-failure tick
 *     written before the scheduler change stays status:'error' in the DB forever
 *     and keeps the bar red for the ~10 days it takes to age out of the window —
 *     a metric judging a fixed condition on stale rows (the measure-across-a-fix-
 *     boundary trap, blender-self-learning-2026-07-12 WI-4475).
 *
 * One classifier, two consumers — the same reuse contract as invariants.ts's
 * digestRefSet delegating to lenses.ts, so the write and read can never drift
 * into disagreeing about what "a capacity failure" is.
 */

import type { AdmissionDenial } from '@papercusp/papercusp-shared/agent';

/** Extract the typed admission fact from a TurnError/LlmCallError or persisted tick detail. */
export function admissionDenialFrom(input: unknown): AdmissionDenial | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const turn = value.turn && typeof value.turn === 'object' ? (value.turn as Record<string, unknown>) : undefined;
  const candidate = value.admissionDenial ?? turn?.admissionDenial;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const denial = candidate as Record<string, unknown>;
  const reason = denial.reason;
  if (reason !== 'all-accounts-paused' && reason !== 'no-free-slot' && reason !== 'provider-429') return undefined;
  return {
    reason,
    ...(typeof denial.pausedAccounts === 'number' ? { pausedAccounts: denial.pausedAccounts } : {}),
    ...(typeof denial.freeSlots === 'number' ? { freeSlots: denial.freeSlots } : {}),
  };
}

/**
 * PURE: is this failure a CAPACITY ceiling (the pool had nothing to give) rather than a
 * genuine cycle failure? The governor/gateway's typed denial is the only authoritative input.
 *
 * The live signatures (measured over the recent 200-tick window, 2026-07-12):
 *   - "rate-limit pause exceeds maxWait"                    — the gateway governor's own wait bail
 *   - "429 ... rate_limit_error"                            — the raw provider ceiling
 *   - the ideator's transport-death wrapper carrying either — "scout: all N ideator LLM call(s)
 *     failed — transport death (0 ideas, $0 spent): rate-limit pause exceeds maxWait"
 *
 * Deliberately NARROW: a TIMEOUT is NOT capacity. The REASON changed on 2026-07-13 (WI-4475) —
 * read this before you "fix" the classifier, because the obvious change is the wrong one.
 *
 * The ORIGINAL reason was "the timeout<->capacity link is unproven". That reason was WRONG, and
 * it was wrong in an instructive way: the correlation test behind it compared two error classes
 * the classifier CANNOT CO-EMIT (a tick records a timeout OR a maxWait bail, never both), so it
 * was structurally incapable of finding a link. Its null result was an ARTIFACT, not a finding.
 * WI-4475 then root-caused the timeout class outright: those calls were blocked in
 * governor.acquire() waiting out a shared rate-limit pause, having never sent a byte. The link is
 * PROVEN. Timeouts were capacity-induced all along.
 *
 * And yet they still do NOT belong in the capacity bucket. "We failed to get admitted" is not the
 * same proposition as "the pool was at its ceiling", and the message alone cannot tell them apart:
 *   - pool genuinely walled  => capacity (correctly excluded from the error rate)
 *   - the ADMISSION PATH is broken => a code defect that merely LOOKS like capacity
 * The second is not hypothetical — WI-4541 (same day) found the inference gateway serializing the
 * whole fleet through ONE admission slot with 9-10 of 12 idle. Under a "never admitted => capacity"
 * rule that defect would have been silently excluded from the very metric that should have caught
 * it: the classifier's own inversion, pointed the other way.
 *
 * So the tiebreak is ASYMMETRY OF HARM, not correlation: counting a capacity event as an error
 * OVER-reports breakage (visible, annoying, self-correcting); classifying an admission-path bug as
 * capacity UNDER-reports it (silent, hides defects). Prefer the loud failure. Timeouts stay errors.
 *
 * The real fix is to stop inferring intent from prose: the governor knows WHY it withheld a permit
 * (every account paused/walled = capacity; no free slot while accounts sit idle = defect) and
 * should carry that as a TYPED reason instead of making this module guess from a string. Until
 * that carrier exists, do not widen the match below to admission failures.
 */
export function isCapacityError(input: unknown): boolean {
  const reason = admissionDenialFrom(input)?.reason;
  return reason === 'all-accounts-paused' || reason === 'provider-429';
}
