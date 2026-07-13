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

/**
 * PURE: is this failure a CAPACITY ceiling (the pool had nothing to give) rather than a
 * genuine cycle failure? Matched on the provider/gateway's own message, since the capacity
 * signal arrives as a thrown Error from deep inside the ideator's LLM transport and there is
 * no typed carrier for it today.
 *
 * The live signatures (measured over the recent 200-tick window, 2026-07-12):
 *   - "rate-limit pause exceeds maxWait"                    — the gateway governor's own wait bail
 *   - "429 ... rate_limit_error"                            — the raw provider ceiling
 *   - the ideator's transport-death wrapper carrying either — "scout: all N ideator LLM call(s)
 *     failed — transport death (0 ideas, $0 spent): rate-limit pause exceeds maxWait"
 *
 * Deliberately NARROW. A TIMEOUT is NOT treated as capacity even though it is plausibly
 * capacity-induced (a call queued behind an exhausted account's backoff until it times out):
 * that link is unproven, and mis-classifying a real hang as "pool busy" would hide a genuine
 * defect — the exact failure this classification exists to prevent, pointed the other way.
 * Keep timeouts as errors until the correlation is actually demonstrated.
 */
export function isCapacityError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('rate-limit pause exceeds maxwait') ||
    m.includes('rate_limit_error') ||
    (m.includes('429') && m.includes('rate limit')) ||
    m.includes('rate limit exceeded')
  );
}
