import { describe, expect, it } from 'vitest';
import {
  computeHeadcountDeficit,
  nextHeadcountBackoff,
  resolveFleetHeadcountLaunchRole,
  resolveFleetHeadcountProfile,
} from './fleet-headcount-action';

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

  describe('resolveFleetHeadcountLaunchRole (D-016)', () => {
    it('binds the declared drain fleet to the drain-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'goal-drain-goal-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('drain-fleet-member');
    });

    it('binds another fleet in the same goal to the plan-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'plan-fleet-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('plan-fleet-member');
    });

    it('leaves the role layer absent when the fleet has no goal context', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: null,
        fleetSlug: 'standalone-fleet',
        drainFleetSlug: null,
      })).toBeNull();
    });
  });
});
