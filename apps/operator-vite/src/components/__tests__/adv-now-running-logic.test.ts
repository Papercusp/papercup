/**
 * adv-now-running-logic.test.ts — pure-logic tests for the harness status
 * bar's "N plans waiting" nudge (AdvNowRunning).
 *
 * The nudge appears when the harness is STOPPED but plans have been started
 * (startStatus === 'started'), meaning nothing is running to pick them up.
 * These tests cover the count + label helpers without mounting the
 * component (which needs live polling + nuqs router context).
 */

import { describe, expect, it } from 'vitest';
import { countWaitingPlans, waitingLabel } from '../adv/AdvNowRunning';
import type { PlanStartStatus } from '@/app/admin/plans/plans-api';

const p = (startStatus: PlanStartStatus) => ({ startStatus });

describe('countWaitingPlans', () => {
  it('returns 0 for an empty list', () => {
    expect(countWaitingPlans([])).toBe(0);
  });

  it('counts only plans with startStatus "started"', () => {
    const plans = [p('started'), p('paused'), p('done'), p(null), p('started')];
    expect(countWaitingPlans(plans)).toBe(2);
  });

  it('ignores paused / done / never-started plans entirely', () => {
    expect(countWaitingPlans([p('paused'), p('done'), p(null)])).toBe(0);
  });

  it('counts every started plan when all are started', () => {
    expect(countWaitingPlans([p('started'), p('started'), p('started')])).toBe(3);
  });
});

describe('waitingLabel', () => {
  it('uses the singular form for exactly one plan', () => {
    expect(waitingLabel(1)).toBe('1 plan waiting');
  });

  it('uses the plural form for more than one plan', () => {
    expect(waitingLabel(3)).toBe('3 plans waiting');
  });

  it('uses the plural form for zero (matches "0 plans")', () => {
    expect(waitingLabel(0)).toBe('0 plans waiting');
  });
});
