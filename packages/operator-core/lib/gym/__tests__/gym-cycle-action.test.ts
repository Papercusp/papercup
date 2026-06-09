/**
 * Registration + env-knob tests for the `system:gym-cycle` routine action
 * (harness/routines/gym-actions.ts — learning-system-audit P-031). The tick
 * LOGIC lives in autoloop-tick.ts and is covered by autoloop-tick.test.ts;
 * this file pins the thin glue: the action registers at import (the
 * register-system-actions boot contract) and the budget-floor env override
 * parses honestly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
// Side-effect import registers system:gym-cycle (and exercises the import path the
// routines engine takes at boot).
import { GYM_CYCLE_FIRE_ROLE, gymBudgetFloorUsd } from '../../harness/routines/gym-actions';
import { getSystemAction, listSystemActions } from '../../harness/routines/system-actions';
import { GYM_AUTOLOOP_BUDGET_FLOOR_USD } from '../autoloop-tick';

describe('gym-actions registration (P-031)', () => {
  it('registers system:gym-cycle', () => {
    expect(listSystemActions()).toContain('gym-cycle');
    expect(typeof getSystemAction('gym-cycle')).toBe('function');
  });

  it('keys its fire-gate/backoff state under the gym-cycle role', () => {
    expect(GYM_CYCLE_FIRE_ROLE).toBe('gym-cycle');
  });
});

describe('gymBudgetFloorUsd — env override parsing', () => {
  const VAR = 'PAPERCUSP_GYM_BUDGET_FLOOR_USD';
  afterEach(() => {
    delete process.env[VAR];
    vi.restoreAllMocks();
  });

  it('defaults to the tick floor when unset or blank', () => {
    expect(gymBudgetFloorUsd()).toBe(GYM_AUTOLOOP_BUDGET_FLOOR_USD);
    process.env[VAR] = '   ';
    expect(gymBudgetFloorUsd()).toBe(GYM_AUTOLOOP_BUDGET_FLOOR_USD);
  });

  it('parses a numeric override (including an explicit 0)', () => {
    process.env[VAR] = '2.5';
    expect(gymBudgetFloorUsd()).toBe(2.5);
    process.env[VAR] = '0';
    expect(gymBudgetFloorUsd()).toBe(0);
  });

  it('falls back on garbage / negative values (warning, not silence)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[VAR] = 'nope';
    expect(gymBudgetFloorUsd()).toBe(GYM_AUTOLOOP_BUDGET_FLOOR_USD);
    process.env[VAR] = '-1';
    expect(gymBudgetFloorUsd()).toBe(GYM_AUTOLOOP_BUDGET_FLOOR_USD);
    expect(warn).toHaveBeenCalledTimes(2);
  });

});
