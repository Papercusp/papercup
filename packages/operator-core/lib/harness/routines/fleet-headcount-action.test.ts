import { describe, expect, it } from 'vitest';
import { computeHeadcountDeficit, nextHeadcountBackoff, resolveFleetHeadcountProfile } from './fleet-headcount-action';

describe('fleet headcount governor guards (WI-2479)', () => {
  it('opens only the missing member deficit and never a negative wave', () => {
    expect(computeHeadcountDeficit(5, 2)).toBe(3);
    expect(computeHeadcountDeficit(5, 5)).toBe(0);
    expect(computeHeadcountDeficit(5, 9)).toBe(0);
  });

  it('uses bounded exponential retry delays', () => {
    expect(nextHeadcountBackoff(0)).toBe(60_000);
    expect(nextHeadcountBackoff(60_000)).toBe(120_000);
    expect(nextHeadcountBackoff(60 * 60_000)).toBe(15 * 60_000);
  });

  it('defaults legacy profiles headless while preserving every explicit launch knob', () => {
    expect(resolveFleetHeadcountProfile({ plan: 'drain', harness: 'papercusp', agent: 'codex' }).headless).toBe(true);
    expect(resolveFleetHeadcountProfile({
      plan: 'drain',
      harness: 'papercusp',
      agent: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
      account: 'default',
      carry: 'warm',
      contextSize: 'full',
      compactionLimit: 825_000,
      headless: false,
      brief: 'drain bugs',
    })).toMatchObject({
      headless: false,
      effort: 'max',
      carry: 'warm',
      compactionLimit: 825_000,
      brief: 'drain bugs',
    });
  });
});
