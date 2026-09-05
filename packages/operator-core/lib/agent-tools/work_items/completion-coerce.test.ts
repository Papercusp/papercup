/**
 * Recurrence guard for `coerceCompletionShape`'s `selfReview` scalar-rescue branch.
 *
 * ## Why this file exists
 *
 * EI-21580906249884402 filed that `work_items:complete` rejected a SCALAR
 * `completion.selfReview.findings` ("the live schema requires an array of non-empty
 * strings"). That filing is now STALE — the coercion below wraps a lossless scalar
 * before Zod validates it, so the call succeeds. Measured 2026-09-05 with a
 * non-mutating probe (a real `work_items:complete` against a deliberately absent id,
 * whose argument validation runs BEFORE item lookup): a scalar `findings` passes
 * validation and reaches `work_item ... not found`, where it previously produced
 * `invalid_args`.
 *
 * But the FIX that made it stale had NO test of its own — there was no
 * `completion-coerce.test.ts` at all, and `selfReview` appeared in the work_items
 * suites only inside fixture payloads, never in an assertion. A hand-written coercion
 * with a four-branch contract and zero coverage can regress silently and re-create
 * exactly the filed bug, so closing the filing without pinning the behaviour would
 * bank the fix and leave the trap armed.
 *
 * ## What is asserted
 *
 * The branch is a PURE function, so every case is unit-testable with no fixtures. Each
 * rescue case is paired with a CONTROL that must NOT be rewritten — a genuine array is
 * left alone, and an absent `selfReview` is untouched — so a coercion that simply
 * wrapped everything (or one that did nothing at all) fails here rather than passing
 * vacuously in both directions.
 */
import { describe, expect, it } from 'vitest';

import { coerceCompletionShape } from './completion-coerce';

/** Narrow the `unknown` return to the shape these assertions read. */
function selfReviewOf(raw: unknown): Record<string, unknown> {
  const out = coerceCompletionShape(raw) as Record<string, unknown>;
  return out.selfReview as Record<string, unknown>;
}

describe('coerceCompletionShape: selfReview scalar rescue (EI-21580906249884402)', () => {
  it('wraps a scalar string `findings` into a one-element array', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', findings: 'a single scalar finding' },
    });

    expect(sr.findings).toEqual(['a single scalar finding']);
  });

  it('applies the same rescue to `changedAsResult`', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', changedAsResult: 'one yielded change' },
    });

    expect(sr.changedAsResult).toEqual(['one yielded change']);
  });

  // CONTROL. A genuine array must survive untouched. Without this, a coercion that
  // wrapped unconditionally (`[['a','b']]`) would still pass every case above.
  it('leaves a genuine array untouched rather than re-wrapping it', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', findings: ['first', 'second'] },
    });

    expect(sr.findings).toEqual(['first', 'second']);
  });

  // The documented compact spelling for "no findings". Wrapping it as `[false]` would
  // still violate the array-of-strings contract, so the zero is preserved as an empty
  // array instead.
  it('preserves `false` as an explicit empty array, not `[false]`', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', findings: false },
    });

    expect(sr.findings).toEqual([]);
  });

  // `true` carries no review prose, so it is deliberately NOT rescued into a valid
  // shape — it stays a wrapped scalar and is rejected downstream by Zod. Pinning this
  // records that the asymmetry with `false` is a decision, not an oversight.
  it('does not rescue `true` into a valid shape', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', findings: true },
    });

    expect(sr.findings).toEqual([true]);
  });

  it('drops a blank string rather than emitting an empty-string finding', () => {
    const sr = selfReviewOf({
      summary: 'closed something',
      selfReview: { lookedAt: 'the validator', findings: '   ' },
    });

    expect(sr.findings).toBeUndefined();
  });

  // CONTROL. A completion with no `selfReview` must not grow one.
  it('does not invent a selfReview record when the caller sent none', () => {
    const out = coerceCompletionShape({ summary: 'closed something' }) as Record<string, unknown>;

    expect(out.selfReview).toBeUndefined();
    expect(out.summary).toBe('closed something');
  });

  // CALIBRATION. Proves the function under test is actually running and reachable in
  // this suite: a non-object input is returned as-is. If the import were wrong or the
  // function inert, the rescue assertions could only fail — but this one anchors that
  // the module loaded and behaves, so a green run means the branch really was exercised.
  it('returns a non-object completion unchanged (calibration)', () => {
    expect(coerceCompletionShape(42)).toBe(42);
  });
});
