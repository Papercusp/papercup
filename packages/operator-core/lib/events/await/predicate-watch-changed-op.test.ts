/**
 * The `changed` operator (state-plane-interest-and-hardening-2026-08-21 P-004).
 *
 * `changed` is the only BASELINE-relative op: it compares each observation to the
 * PREVIOUS one rather than to a caller-supplied operand. It exists because the
 * measured alternative was worse than merely awkward — expressing "wake me when
 * this moves" with `ne` requires transcribing the value's current reading into the
 * subscription, which races (a move landing between the read and the subscribe arms
 * the watch against a stale operand, and it then never fires).
 *
 * The tests that matter here are the two REFUSALS, not the match. A predicate watch
 * fires a WAKE, and this module's whole history is spurious-true regressions that
 * shipped green: `ne` firing on a null (WI-6279), every string operand round-tripping
 * to null so `ne` fired on the first poll (WI-6490). Both were false all-clears that
 * resumed an agent on a condition never established, and both survived because the
 * existing tests happened to use operands that dodged the bug. `changed` has exactly
 * one shape of that failure available to it — firing on its own registration eval,
 * when there is no baseline to have changed FROM — so that case is pinned first and
 * hardest, with a paired positive control proving the assertion can fail.
 */
import { describe, expect, it } from 'vitest';
import { comparePredicate, PREDICATE_OPS, type PredicateBaseline } from './predicate-watch';

const noBaseline: PredicateBaseline = { established: false, value: undefined };
const from = (value: unknown): PredicateBaseline => ({ established: true, value });

describe('changed — the no-baseline refusal (the spurious-wake guard)', () => {
  it('NEVER fires before any evaluation has been recorded', () => {
    // This is the registration-time inline eval. Firing here would wake the caller
    // instantly and report a change that no observation established.
    expect(comparePredicate('abc123', 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate(0, 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate(false, 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate({ a: 1 }, 'changed', undefined, noBaseline)).toBe(false);
  });

  it('POSITIVE CONTROL — the same observations DO fire once a baseline exists', () => {
    // Without this, the assertions above would pass just as happily against an op
    // that can never fire at all, which is not what is being claimed.
    expect(comparePredicate('abc123', 'changed', undefined, from('def456'))).toBe(true);
    expect(comparePredicate(0, 'changed', undefined, from(1))).toBe(true);
    expect(comparePredicate(false, 'changed', undefined, from(true))).toBe(true);
    expect(comparePredicate({ a: 1 }, 'changed', undefined, from({ a: 2 }))).toBe(true);
  });

  it('treats an OMITTED baseline as no baseline (a caller that forgot to pass one)', () => {
    expect(comparePredicate('abc123', 'changed', undefined)).toBe(false);
    expect(comparePredicate('abc123', 'changed', undefined, undefined)).toBe(false);
  });

  it('distinguishes "never polled" from "polled and observed null" — the reason `established` is a separate flag', () => {
    // last_value is null in BOTH cases; only last_eval separates them. Collapsing
    // them would make a fresh row fire on its first real observation.
    expect(comparePredicate('a-sha', 'changed', undefined, { established: false, value: null })).toBe(false);
    expect(comparePredicate('a-sha', 'changed', undefined, { established: true, value: null })).toBe(true);
  });
});

describe('changed — the absent-observation refusal', () => {
  it('a value that became UNREADABLE is a loss of evidence, not an observed change', () => {
    expect(comparePredicate(undefined, 'changed', undefined, from('was-a-sha'))).toBe(false);
    expect(comparePredicate(null, 'changed', undefined, from('was-a-sha'))).toBe(false);
  });

  it('a MISSPELLED path (undefined forever) can never fire it', () => {
    // The WI-6279 shape: a typo'd path used to be a guaranteed instant false wake.
    expect(comparePredicate(undefined, 'changed', undefined, from(null))).toBe(false);
    expect(comparePredicate(undefined, 'changed', undefined, noBaseline)).toBe(false);
  });

  it('but a value APPEARING is a genuine change — the observation is present', () => {
    expect(comparePredicate('now-a-sha', 'changed', undefined, from(null))).toBe(true);
  });
});

describe('changed — steady state', () => {
  it('does not fire while the value is unchanged, including falsy and structural values', () => {
    expect(comparePredicate('same', 'changed', undefined, from('same'))).toBe(false);
    expect(comparePredicate(0, 'changed', undefined, from(0))).toBe(false);
    expect(comparePredicate(false, 'changed', undefined, from(false))).toBe(false);
    expect(comparePredicate({ a: 1, b: [2] }, 'changed', undefined, from({ a: 1, b: [2] }))).toBe(false);
  });

  it('IGNORES the `value` operand entirely — there is nothing to transcribe', () => {
    // The point of the op. A caller who passes an operand anyway must not be able to
    // change the outcome with it, or the transcription hazard is back through a side door.
    for (const operand of ['whatever', null, 0, { junk: true }]) {
      expect(comparePredicate('b', 'changed', operand, from('a'))).toBe(true);
      expect(comparePredicate('a', 'changed', operand, from('a'))).toBe(false);
    }
  });

  it('does not disturb the operand-relative ops', () => {
    // A baseline is now passed on EVERY comparison; no other op may read it.
    expect(comparePredicate('a', 'eq', 'a', from('zzz'))).toBe(true);
    expect(comparePredicate('a', 'ne', 'b', from('a'))).toBe(true);
    expect(comparePredicate(5, 'gt', 3, from(99))).toBe(true);
    expect(comparePredicate(null, 'ne', 'b', from('a'))).toBe(false);
    expect(comparePredicate('abc', 'contains', 'b', from('abc'))).toBe(true);
  });
});

describe('changed — registration', () => {
  it('is a member of PREDICATE_OPS, so both state:subscribe and watch:create accept it', () => {
    // Both tools build their zod enum from this array; the DB CHECK constraint
    // (migration 869) is widened to match.
    expect(PREDICATE_OPS).toContain('changed');
  });

  it('did not displace any existing op', () => {
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']) {
      expect(PREDICATE_OPS).toContain(op);
    }
  });
});
