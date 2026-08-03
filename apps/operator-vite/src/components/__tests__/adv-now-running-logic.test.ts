/**
 * adv-now-running-logic.test.ts — pure-logic tests for the harness status
 * bar's "N plans waiting" nudge (AdvNowRunning).
 *
 * The nudge appears when the harness is STOPPED but plans have been started
 * (startStatus === 'started'), meaning nothing is running to pick them up.
 * These tests cover the label helper without mounting the component (which
 * needs live polling + nuqs router context).
 *
 * ⚠ There is deliberately NO `countWaitingPlans` test here, and re-adding one
 * would be a regression, not a fix. The count is NOT computed client-side any
 * more: EI-19409535742567802 replaced a whole-`plans.list` fetch (~700KB on a
 * route that renders no plan list, counted row-by-row in the browser) with the
 * server-side `plans.waitingCount` aggregate, which returns one integer. So
 * `AdvNowRunning` exports `waitingLabel` only. This file used to import a
 * `countWaitingPlans` helper that no longer exists, which failed the suite as
 * `TypeError: countWaitingPlans is not a function` AND put a
 * no-exported-member error into operator-vite's typecheck ratchet. If you want
 * coverage for the counting rule, test the `plans.waitingCount` resolver
 * server-side — that is where the logic now lives.
 */

import { describe, expect, it } from 'vitest';
import { waitingLabel } from '../adv/AdvNowRunning';

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
