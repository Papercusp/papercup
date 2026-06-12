/**
 * The D-004 gate for system:calibration-resolve (P-041 / FB-13) — mirrors
 * negative-space/governor.test.ts: governor-dark short-circuit, first-contact
 * self-registration with budget OMITTED, owner-budget never clobbered,
 * registration failure swallowed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { GovernorVerdict } from '../learning-governor/core';
import type { RegisterLearningLoopInput } from '../learning-governor/store';
import { CALIBRATION_LOOP_ID, calibrationGovernorGate } from './governor';

const sqlStub = {} as Sql;

describe('calibrationGovernorGate', () => {
  it('governor flag OFF → governor-dark, no registration attempt', async () => {
    const register = vi.fn();
    const verdict = await calibrationGovernorGate('ws', {
      enabled: async () => false,
      register,
      getSql: async () => sqlStub,
      log: () => {},
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'governor-dark' });
    expect(register).not.toHaveBeenCalled();
  });

  it('unregistered → self-registers with budget OMITTED, verdict unchanged this round', async () => {
    const register = vi.fn(async (_sql: Sql, input: RegisterLearningLoopInput) => input);
    const verdict = await calibrationGovernorGate('ws', {
      enabled: async () => true,
      getSql: async () => sqlStub,
      check: async (): Promise<GovernorVerdict> => ({ allow: false, reason: 'unregistered', remainingUsd: null }),
      register,
      log: () => {},
    });
    expect(verdict.reason).toBe('unregistered');
    expect(register).toHaveBeenCalledTimes(1);
    const input = register.mock.calls[0][1];
    expect(input).toMatchObject({
      loopId: CALIBRATION_LOOP_ID,
      budgetKind: 'per-cycle',
      enforcement: 'governor',
    });
    expect('budgetUsd' in input).toBe(false);
  });

  it('any non-unregistered refusal passes through WITHOUT re-registering (owner budget untouched)', async () => {
    const register = vi.fn();
    const verdict = await calibrationGovernorGate('ws', {
      enabled: async () => true,
      getSql: async () => sqlStub,
      check: async (): Promise<GovernorVerdict> => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
      register,
      log: () => {},
    });
    expect(verdict.reason).toBe('unbudgeted');
    expect(register).not.toHaveBeenCalled();
  });

  it('an allowed verdict passes through', async () => {
    const verdict = await calibrationGovernorGate('ws', {
      enabled: async () => true,
      getSql: async () => sqlStub,
      check: async (): Promise<GovernorVerdict> => ({ allow: true, remainingUsd: 0 }),
      register: vi.fn(),
      log: () => {},
    });
    expect(verdict.allow).toBe(true);
  });

  it('registration failure is swallowed (next tick retries)', async () => {
    const verdict = await calibrationGovernorGate('ws', {
      enabled: async () => true,
      getSql: async () => sqlStub,
      check: async (): Promise<GovernorVerdict> => ({ allow: false, reason: 'unregistered', remainingUsd: null }),
      register: async () => {
        throw new Error('pg down');
      },
      log: () => {},
    });
    expect(verdict.reason).toBe('unregistered');
  });
});
