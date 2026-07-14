import { describe, it, expect } from 'vitest';
import { admissionDenialFrom, isCapacityError } from './capacity-errors';

/**
 * capacity-errors is a one-function leaf module, but it is a LOAD-BEARING one: it decides
 * whether a scout failure counts against the "cycle error rate < 5%" release bar (quality-
 * metrics, the READ path) and whether it false-pages the Mug's error-streak alarm (scheduler,
 * the WRITE path). It had no test of its own — which is how a WRONG rationale sat in its doc
 * comment for a day (WI-4475).
 *
 * These tests pin the DECISION, not the implementation: an ADMISSION failure is NOT capacity.
 * The temptation to widen the match is real and recurring — WI-4475 proved timeouts ARE
 * capacity-induced, which makes "so classify them as capacity" look obviously correct. It is
 * not: WI-4541 (the gateway serializing the fleet through one admission slot while 9-10 of 12
 * sat idle) is an admission-path BUG that is indistinguishable, from the message alone, from a
 * genuinely walled pool. Excluding it as "capacity" would hide the defect from the one metric
 * that should catch it. If you are here to make these tests pass by widening isCapacityError,
 * read the module's doc comment first — the fix is a TYPED reason from the governor, not a
 * broader string match.
 */
describe('isCapacityError — the pool genuinely had nothing to give', () => {
  it('matches a typed all-accounts-paused denial', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'all-accounts-paused', pausedAccounts: 3, freeSlots: 0 } })).toBe(true);
  });

  it('matches a typed provider-429 denial', () => {
    expect(isCapacityError({ turn: { admissionDenial: { reason: 'provider-429' } } })).toBe(true);
  });

  it('recovers the typed denial from an LlmCallError-shaped value', () => {
    expect(admissionDenialFrom({ turn: { admissionDenial: { reason: 'all-accounts-paused', freeSlots: 0 } } })).toEqual({
      reason: 'all-accounts-paused',
      freeSlots: 0,
    });
  });

  it('does not infer capacity from provider prose', () => {
    expect(isCapacityError('429 rate_limit_error: too many requests')).toBe(false);
  });
});

describe('isCapacityError — an ADMISSION failure is NOT capacity (WI-4475 / WI-4541)', () => {
  // The exact message ideators.ts emits when the cycle's remaining budget elapsed before the
  // governor ever granted a permit. It is capacity-SHAPED, and that is precisely the trap:
  // a broken admission path (WI-4541) emits the identical message with the pool wide open.
  const neverAdmitted =
    "Scout ideator contrarian was never admitted within 420000ms — no capacity within the cycle's remaining budget (not a transport timeout)";

  it('does NOT classify a never-admitted ideator as capacity — it stays a loud error', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'no-free-slot', freeSlots: 0 } })).toBe(false);
  });

  it('does not accidentally match on the phrase "no capacity" (the message says it in prose)', () => {
    // Guards the substring-matching implementation: the classifier must key on the PROVIDER's
    // signal, never on our own prose about capacity — otherwise our error text steers our metric.
    expect(isCapacityError(neverAdmitted)).toBe(false);
  });

  it('does NOT classify a GENERATION timeout as capacity (the model was streaming)', () => {
    expect(
      isCapacityError(
        'Scout ideator analogical timed out after 180000ms of GENERATION (admitted — the model was streaming; this is not a capacity wait)',
      ),
    ).toBe(false);
  });

  it('does NOT classify the legacy bare timeout as capacity (ambiguous — fail loud)', () => {
    expect(isCapacityError('Scout ideator reframing timed out after 180000ms')).toBe(false);
  });

  it('does not classify a genuine cycle defect as capacity', () => {
    expect(isCapacityError('TypeError: cannot read property "ideas" of undefined')).toBe(false);
    expect(isCapacityError('invalid JSON in ideator response')).toBe(false);
    expect(isCapacityError('')).toBe(false);
  });
});
