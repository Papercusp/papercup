/**
 * governor.test.ts — the Red Queen's D-004 gate (self-learning-frontier
 * P-031 / FB-20). Pins, with injected GovernorGlueDeps and zero PG/flags IO
 * (the fleet-ekg governor.test.ts pattern):
 *   - governor-dark refuses WITHOUT touching the registry;
 *   - first armed contact self-registers UNBUDGETED (budgetUsd omitted — the
 *     owner's P-001 arming act sets it) and still returns the refusal;
 *   - a registered + budgeted loop is allowed through;
 *   - a registration failure is swallowed (refusal already protects the run).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { GovernorGlueDeps } from '../learning-governor/registrants';
import { redQueenGovernorGate } from './governor';
import { RED_QUEEN_LOOP_ID } from './types';

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

describe('redQueenGovernorGate (FB-01/D-004 unattended-refusal glue)', () => {
  it('governor-dark ⇒ refuses without touching the registry', async () => {
    const { deps, register } = fakeDeps({ enabled: async () => false });
    const v = await redQueenGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'governor-dark', remainingUsd: null });
    expect(register).not.toHaveBeenCalled();
  });

  it('first armed contact self-registers UNBUDGETED (budgetUsd omitted) and still refuses', async () => {
    const { deps, register } = fakeDeps();
    const v = await redQueenGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'unregistered', remainingUsd: null });
    expect(register).toHaveBeenCalledTimes(1);
    const [sql, input] = register.mock.calls[0] as unknown as [Sql, Record<string, unknown>];
    expect(sql).toBe(SQL);
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      loopId: RED_QUEEN_LOOP_ID,
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
    const v = await redQueenGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: false, reason: 'unbudgeted', remainingUsd: null });
    expect(register).not.toHaveBeenCalled();
  });

  it('registered + budgeted ⇒ allowed through', async () => {
    const { deps, register } = fakeDeps({ check: async () => ({ allow: true, remainingUsd: 0 }) });
    const v = await redQueenGovernorGate('ws-1', deps);
    expect(v).toEqual({ allow: true, remainingUsd: 0 });
    expect(register).not.toHaveBeenCalled();
  });

  it('a registration failure is swallowed — the refusal already protects the run', async () => {
    const { deps, logs } = fakeDeps({
      register: vi.fn(async () => { throw new Error('pg down'); }),
    });
    const v = await redQueenGovernorGate('ws-1', deps);
    expect(v.allow).toBe(false);
    expect(logs.some((l) => l.includes('self-registration failed'))).toBe(true);
  });
});
