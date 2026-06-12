/**
 * governor.test.ts — the miner's D-004 gate (self-learning-frontier P-010 /
 * FB-04 follow-up). Pins, with injected GovernorGlueDeps and zero PG/flags IO:
 *   - governor-dark refuses WITHOUT touching the registry;
 *   - first armed contact self-registers UNBUDGETED (budgetUsd omitted — the
 *     owner's P-001 arming act sets it) and still returns the refusal;
 *   - a registered + budgeted loop is allowed through;
 *   - a registration failure is swallowed (refusal already protects the run).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { GovernorGlueDeps } from '../learning-governor/registrants';
import { NEGATIVE_SPACE_LOOP_ID, negativeSpaceGovernorGate } from './governor';

const SQL = {} as Sql;

function fakeDeps(over: Partial<GovernorGlueDeps> = {}) {
  const logs: string[] = [];
  const register = vi.fn(async () => {});
  const deps: GovernorGlueDeps = {
    enabled: async () => true,
    getSql: async () => SQL,
    register,
    check: async () => ({ allow: false, reason: 'unregistered', remainingUsd: null }),
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, register, logs };
}

describe('negativeSpaceGovernorGate (FB-01/D-004 unattended-refusal glue)', () => {
  it('governor-dark ⇒ refuses without touching the registry', async () => {
    const { deps, register } = fakeDeps({ enabled: async () => false });
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'governor-dark', remainingUsd: null });
    expect(register).not.toHaveBeenCalled();
  });

  it('first armed contact self-registers UNBUDGETED (budgetUsd omitted) and still refuses', async () => {
    const { deps, register } = fakeDeps();
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'unregistered', remainingUsd: null });
    expect(register).toHaveBeenCalledTimes(1);
    const [sql, input] = register.mock.calls[0] as unknown as [Sql, Record<string, unknown>];
    expect(sql).toBe(SQL);
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      loopId: NEGATIVE_SPACE_LOOP_ID,
      budgetKind: 'per-cycle',
      enforcement: 'governor',
    });
    // The arming act is the OWNER setting the budget — registration must not.
    expect('budgetUsd' in input).toBe(false);
  });

  it('unbudgeted (already registered) ⇒ refuses without re-registering (owner row untouched)', async () => {
    const { deps, register } = fakeDeps({
      check: async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }),
    });
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v.reason).toBe('unbudgeted');
    expect(register).not.toHaveBeenCalled();
  });

  it('registered + budgeted ⇒ allowed through', async () => {
    const { deps, register } = fakeDeps({ check: async () => ({ allow: true, remainingUsd: 0 }) });
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: true, remainingUsd: 0 });
    expect(register).not.toHaveBeenCalled();
  });

  it('registration failure is swallowed — the refusal still protects the run', async () => {
    const { deps, logs } = fakeDeps({
      register: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v.allow).toBe(false);
    expect(logs.some((m) => m.includes('self-registration failed'))).toBe(true);
  });

  it('preflight IO failure ⇒ fail-CLOSED governor-error, no registration attempt', async () => {
    const { deps, register } = fakeDeps({
      check: async () => {
        throw new Error('ledger broke');
      },
    });
    const v = await negativeSpaceGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'governor-error', remainingUsd: null });
    expect(register).not.toHaveBeenCalled();
  });
});
