import { describe, expect, it, vi } from 'vitest';
import {
  armedGuardVerdict,
  expectArmed,
  type ArmedGuardInterim,
  type SkippableTestContext,
} from './testing-armed-guard';

const INTERIM: ArmedGuardInterim = {
  why: 'the operatorTurns.byConversation resolver entry is still registered',
  armBy: '2026-08-09',
  tracking: 'EI-19372323793235963',
};

/** A stand-in for vitest's TestContext whose `skip` records instead of throwing. */
function fakeCtx() {
  const calls: (string | undefined)[] = [];
  const ctx: SkippableTestContext = {
    skip: ((note?: string) => {
      calls.push(note);
      // The real ctx.skip throws to abort the test; mimic that so the wiring
      // tests below prove control flow actually stops.
      throw new Error('__SKIPPED__');
    }) as SkippableTestContext['skip'],
  };
  return { ctx, calls };
}

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('armedGuardVerdict', () => {
  it('reports armed when the gate has closed, so assertions run', () => {
    expect(armedGuardVerdict(true, INTERIM, at('2026-08-01'))).toEqual({ kind: 'armed' });
  });

  it('reports dormant — never armed — while the interim is still inside its window', () => {
    const verdict = armedGuardVerdict(false, INTERIM, at('2026-08-01'));
    expect(verdict.kind).toBe('dormant');
  });

  it('names the arming condition, the tracking ref and the date in the skip note', () => {
    const verdict = armedGuardVerdict(false, INTERIM, at('2026-08-01'));
    if (verdict.kind !== 'dormant') throw new Error(`expected dormant, got ${verdict.kind}`);

    // The note IS the fix — a dormant guard that does not say why it is asleep
    // is no more legible than the green tick it replaced.
    expect(verdict.note).toContain('the operatorTurns.byConversation resolver entry is still registered');
    expect(verdict.note).toContain('EI-19372323793235963');
    expect(verdict.note).toContain('2026-08-09');
  });

  it('omits the tracking clause cleanly when no ref was given', () => {
    const verdict = armedGuardVerdict(false, { why: 'some interim', armBy: '2026-08-09' }, at('2026-08-01'));
    if (verdict.kind !== 'dormant') throw new Error(`expected dormant, got ${verdict.kind}`);
    expect(verdict.note).not.toContain('tracking:');
    expect(verdict.note).not.toContain('undefined');
  });

  it('is still dormant ON the armBy date — the named day is granted, not consumed', () => {
    expect(armedGuardVerdict(false, INTERIM, at('2026-08-09')).kind).toBe('dormant');
  });

  it('goes overdue the day AFTER armBy — a dormant guard cannot outlive its window quietly', () => {
    expect(armedGuardVerdict(false, INTERIM, at('2026-08-10')).kind).toBe('overdue');
  });

  it('explains, in the overdue message, that nothing has been asserted and what to do about it', () => {
    const verdict = armedGuardVerdict(false, INTERIM, at('2026-08-10'));
    if (verdict.kind !== 'overdue') throw new Error(`expected overdue, got ${verdict.kind}`);
    expect(verdict.message).toContain('asserted NOTHING');
    expect(verdict.message).toContain('2026-08-09');
    expect(verdict.message).toContain('EI-19372323793235963');
    // The remedy has to be named, or the next reader deletes the guard.
    expect(verdict.message).toContain('extend armBy');
  });

  it('an armed guard is never overdue — expiry polices dormancy, not age', () => {
    expect(armedGuardVerdict(true, INTERIM, at('2030-01-01'))).toEqual({ kind: 'armed' });
  });

  it('decides by UTC, so the verdict does not depend on the runner timezone', () => {
    // 2026-08-10T00:30Z is still 2026-08-09 in any negative-offset zone. If this
    // used local time, a US-based runner would disagree with CI about expiry.
    expect(armedGuardVerdict(false, INTERIM, new Date('2026-08-10T00:30:00.000Z')).kind).toBe('overdue');
    expect(armedGuardVerdict(false, INTERIM, new Date('2026-08-09T23:30:00.000Z')).kind).toBe('dormant');
  });

  it.each(['2026-8-9', '09-08-2026', 'next tuesday', '', '2026-08-09T00:00:00Z'])(
    'refuses the unparseable armBy %o instead of treating it as never-expires',
    (armBy) => {
      // An expiry that silently never fires is the exact failure this module
      // exists to prevent, so a malformed date must be loud.
      expect(() => armedGuardVerdict(false, { why: 'x', armBy }, at('2026-08-01'))).toThrow(/ISO YYYY-MM-DD/);
    },
  );

  it('refuses a malformed armBy even when armed, so the bug cannot hide behind a closed gate', () => {
    expect(() => armedGuardVerdict(true, { why: 'x', armBy: 'whenever' }, at('2026-08-01'))).toThrow(
      /ISO YYYY-MM-DD/,
    );
  });
});

describe('expectArmed wiring', () => {
  // These are the tests that matter: a helper that computes a correct verdict
  // and never acts on it is exactly the vacuous-green failure, one level up.

  it('actually calls ctx.skip, with the note, when dormant', () => {
    const { ctx, calls } = fakeCtx();
    expect(() => expectArmed(ctx, false, INTERIM, at('2026-08-01'))).toThrow('__SKIPPED__');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('guard not armed');
    expect(calls[0]).toContain('EI-19372323793235963');
  });

  it('aborts the test at the call site when dormant, so assertions below never run', () => {
    const { ctx } = fakeCtx();
    const ran = vi.fn();
    expect(() => {
      expectArmed(ctx, false, INTERIM, at('2026-08-01'));
      ran();
    }).toThrow('__SKIPPED__');
    // If skip did not abort, a dormant guard would fall through into assertions
    // written to assume it was armed.
    expect(ran).not.toHaveBeenCalled();
  });

  it('returns quietly and skips nothing when armed, so the guard really asserts', () => {
    const { ctx, calls } = fakeCtx();
    const ran = vi.fn();
    expectArmed(ctx, true, INTERIM, at('2026-08-01'));
    ran();
    expect(calls).toHaveLength(0);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('throws rather than skipping when overdue — an expired interim must be a RED, not a skip', () => {
    const { ctx, calls } = fakeCtx();
    // A skip here would be the whole bug back again: quiet, green-ish, ignorable.
    expect(() => expectArmed(ctx, false, INTERIM, at('2026-08-10'))).toThrow(/dormant past its armBy date/);
    expect(calls).toHaveLength(0);
  });
});
