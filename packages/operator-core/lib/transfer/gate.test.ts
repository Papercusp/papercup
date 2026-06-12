/**
 * gate.test.ts — the pure D-006 transfer gate (P-022 / FB-08).
 * Verdict margins, tier transitions (promote / demote / retire), and the
 * payload option parsing. Zero IO.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSFER_GATE,
  DEFAULT_TRANSFER_TICK,
  applyTransferVerdict,
  transferOptionsFromPayload,
  transferVerdict,
} from './gate';

describe('transferVerdict', () => {
  it('passes only when with-lesson beats baseline by MORE than minDelta', () => {
    expect(transferVerdict({ withComposite: 8.1, baselineComposite: 7.0 }, { minDelta: 1 })).toBe('passed');
    expect(transferVerdict({ withComposite: 8.0, baselineComposite: 7.0 }, { minDelta: 1 })).toBe('failed'); // exactly minDelta = fail
    expect(transferVerdict({ withComposite: 7.0, baselineComposite: 7.0 }, { minDelta: 0 })).toBe('failed'); // a tie earned nothing
    expect(transferVerdict({ withComposite: 6.0, baselineComposite: 7.0 }, { minDelta: 0.5 })).toBe('failed');
  });

  it('default margin is half a composite point', () => {
    expect(DEFAULT_TRANSFER_GATE.minDelta).toBe(0.5);
    expect(transferVerdict({ withComposite: 7.6, baselineComposite: 7.0 })).toBe('passed');
    expect(transferVerdict({ withComposite: 7.4, baselineComposite: 7.0 })).toBe('failed');
  });
});

describe('applyTransferVerdict', () => {
  const fresh = { tier: 'probationary' as const, passCount: 0, failCount: 0 };

  it('a pass promotes to validated', () => {
    const t = applyTransferVerdict(fresh, 'passed');
    expect(t).toMatchObject({ tier: 'validated', status: 'passed', passCount: 1, failCount: 0, forgetMemory: false });
  });

  it('a fail stays probationary below the retire bar', () => {
    const t = applyTransferVerdict(fresh, 'failed', { maxFailsBeforeRetire: 3 });
    expect(t).toMatchObject({ tier: 'probationary', status: 'failed', failCount: 1, forgetMemory: false });
  });

  it('a validated lesson that fails a retest DEMOTES to probationary (the re-runnable memory unit test)', () => {
    const t = applyTransferVerdict({ tier: 'validated', passCount: 1, failCount: 0 }, 'failed');
    expect(t.tier).toBe('probationary');
    expect(t.forgetMemory).toBe(false);
  });

  it('repeated failures with ZERO passes retire (and forget the memory entry)', () => {
    const t = applyTransferVerdict({ tier: 'probationary', passCount: 0, failCount: 2 }, 'failed', {
      maxFailsBeforeRetire: 3,
    });
    expect(t).toMatchObject({ tier: 'retired', status: 'failed', failCount: 3, forgetMemory: true });
  });

  it('a lesson that ever passed is never retired — it demotes instead', () => {
    const t = applyTransferVerdict({ tier: 'validated', passCount: 1, failCount: 5 }, 'failed', {
      maxFailsBeforeRetire: 3,
    });
    expect(t.tier).toBe('probationary');
    expect(t.forgetMemory).toBe(false);
  });
});

describe('transferOptionsFromPayload', () => {
  it('defaults on null/garbage payloads', () => {
    expect(transferOptionsFromPayload(null)).toEqual(DEFAULT_TRANSFER_TICK);
    expect(transferOptionsFromPayload('junk')).toEqual(DEFAULT_TRANSFER_TICK);
    expect(transferOptionsFromPayload({ windowHours: 'NaN' })).toEqual(DEFAULT_TRANSFER_TICK);
  });

  it('overrides ride the payload (the owner-tunable knobs)', () => {
    const opts = transferOptionsFromPayload({
      windowHours: 48,
      maxTranscriptsPerTick: 2,
      maxLessonsPerTranscript: 1,
      maxTestsPerTick: 1,
      minDelta: 1.5,
      maxFailsBeforeRetire: 5,
      memoryScope: 'harness:other',
    });
    expect(opts).toEqual({
      windowMs: 48 * 60 * 60_000,
      maxTranscriptsPerTick: 2,
      maxLessonsPerTranscript: 1,
      maxTestsPerTick: 1,
      minDelta: 1.5,
      maxFailsBeforeRetire: 5,
      memoryScope: 'harness:other',
    });
  });
});
