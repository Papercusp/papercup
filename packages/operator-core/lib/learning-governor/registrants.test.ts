/**
 * registrants.test.ts — the flag-gated governor glue (self-learning-frontier
 * P-003 / FB-01). Pins, with injected deps and zero PG/flags IO:
 *   - flag OFF ⇒ every entry point no-ops ('flag-off' / 'governor-dark');
 *   - the gym mirror registers every autoloop row and ledgers a ran cycle's
 *     spend WITHOUT accumulating (gym_autoloop_config stays authoritative);
 *   - the scout mirror registers the per-cycle cap and ACCUMULATES fired spend;
 *   - the never-throws contract (an IO error returns reason:'error');
 *   - the preflight fail-CLOSED contract ('governor-error' on IO failure).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  learningGovernorPreflight,
  recordGymTickToGovernor,
  recordScoutTickToGovernor,
  type GovernorGlueDeps,
} from './registrants';
import type { RecordLearningSpendInput, RegisterLearningLoopInput } from './store';

const SQL = {} as Sql;

function fakeDeps(opts: { enabled?: boolean } = {}) {
  const calls = { register: [] as RegisterLearningLoopInput[], spend: [] as RecordLearningSpendInput[], logs: [] as string[] };
  const deps: GovernorGlueDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    register: async (_sql, input) => {
      calls.register.push(input);
    },
    recordSpend: async (_sql, input) => {
      calls.spend.push(input);
    },
    check: async () => ({ allow: true, remainingUsd: 5 }),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

const AUTOLOOPS = [
  { workspaceId: 'w', harnessSlug: 'alpha', enabled: true, budgetUsd: 20, spentUsd: 2 },
  { workspaceId: 'w', harnessSlug: 'beta', enabled: false, budgetUsd: null, spentUsd: 0 },
];

describe('recordGymTickToGovernor', () => {
  it('flag OFF ⇒ no-op, no reads, no writes', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    let listed = 0;
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => ((listed += 1), AUTOLOOPS), ran: null },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'flag-off' });
    expect(listed).toBe(0); // the mirror source is only read once the flag check passes
    expect(calls.register).toHaveLength(0);
    expect(calls.spend).toHaveLength(0);
  });

  it('mirrors every autoloop row (budget + spent overwritten, native enforcement)', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => AUTOLOOPS, ran: null },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register.map((r) => r.loopId)).toEqual(['gym:alpha', 'gym:beta']);
    expect(calls.register[0]).toMatchObject({ budgetKind: 'lifetime', budgetUsd: 20, spentUsd: 2, enforcement: 'native' });
    expect(calls.register[1]).toMatchObject({ budgetUsd: null, enabled: false });
    expect(calls.spend).toHaveLength(0); // idle tick ⇒ no spend event
  });

  it('ledgers a ran cycle as an EVENT ONLY (accumulate:false — the row spent comes from the mirror)', async () => {
    const { deps, calls } = fakeDeps();
    await recordGymTickToGovernor(
      {
        workspaceId: 'w',
        sql: SQL,
        listAutoloops: async () => AUTOLOOPS,
        ran: { harnessSlug: 'alpha', spentUsd: 1.25, runRef: 'gym-cycle:alpha' },
      },
      deps,
    );
    expect(calls.spend).toEqual([
      {
        workspaceId: 'w',
        loopId: 'gym:alpha',
        costUsd: 1.25,
        runRef: 'gym-cycle:alpha',
        note: 'gym autoloop cycle',
        accumulate: false,
      },
    ]);
  });

  it('mirrors N per-hive rows to distinct gym:<hive> loops and ledgers the ran hive only (P-030)', async () => {
    // Per-hive-learning-loops P-030: the workspace sweep returns one gym autoloop
    // row per hive; the mirror must register EACH under its own gym:<hive> loopId
    // and ledger spend only against the hive that actually ran this tick.
    const perHive = [
      { workspaceId: 'w', harnessSlug: 'hive-acme', enabled: true, budgetUsd: 20, spentUsd: 2 },
      { workspaceId: 'w', harnessSlug: 'hive-beta', enabled: true, budgetUsd: 15, spentUsd: 7 },
      { workspaceId: 'w', harnessSlug: 'hive-gamma', enabled: false, budgetUsd: null, spentUsd: 0 },
    ];
    const { deps, calls } = fakeDeps();
    const out = await recordGymTickToGovernor(
      {
        workspaceId: 'w',
        sql: SQL,
        listAutoloops: async () => perHive,
        ran: { harnessSlug: 'hive-beta', spentUsd: 0.9, runRef: 'gym-cycle:hive-beta' },
      },
      deps,
    );
    expect(out).toEqual({ applied: true });
    // One registration per hive, each its own loopId + native enforcement.
    expect(calls.register.map((r) => r.loopId)).toEqual(['gym:hive-acme', 'gym:hive-beta', 'gym:hive-gamma']);
    expect(calls.register.every((r) => r.enforcement === 'native')).toBe(true);
    // Spend ledgered against the ran hive ONLY (event-only, the row spent comes from the mirror).
    expect(calls.spend).toEqual([
      { workspaceId: 'w', loopId: 'gym:hive-beta', costUsd: 0.9, runRef: 'gym-cycle:hive-beta', note: 'gym autoloop cycle', accumulate: false },
    ]);
  });

  it('skips the spend event for a zero-spend run', async () => {
    const { deps, calls } = fakeDeps();
    await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => [], ran: { harnessSlug: 'alpha', spentUsd: 0 } },
      deps,
    );
    expect(calls.spend).toHaveLength(0);
  });

  it('NEVER throws — an IO failure logs and returns reason:error', async () => {
    const { deps, calls } = fakeDeps();
    deps.register = async () => {
      throw new Error('pg down');
    };
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => AUTOLOOPS, ran: null },
      deps,
    );
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('error');
    expect(out.error).toMatch(/pg down/);
    expect(calls.logs.some((l) => l.includes('pg down'))).toBe(true);
  });
});

describe('recordScoutTickToGovernor', () => {
  it('flag OFF ⇒ no-op', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 1, fired: { costUsd: 0.5 } },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'flag-off' });
    expect(calls.register).toHaveLength(0);
    expect(calls.spend).toHaveLength(0);
  });

  it('mirrors the per-cycle cap and ACCUMULATES a fired cycle’s spend', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 1.5, fired: { costUsd: 0.4, cycleId: 'scout-9' } },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register[0]).toMatchObject({
      loopId: 'scout:papercup',
      budgetKind: 'per-cycle',
      budgetUsd: 1.5,
      enforcement: 'native',
    });
    expect(calls.spend).toEqual([
      {
        workspaceId: 'w',
        loopId: 'scout:papercup',
        costUsd: 0.4,
        runRef: 'scout-9',
        note: 'scout ideation cycle',
        accumulate: true,
      },
    ]);
  });

  it('a withheld tick mirrors the registration only', async () => {
    const { deps, calls } = fakeDeps();
    await recordScoutTickToGovernor({ workspaceId: 'w', harnessSlug: 'h', perCycleBudgetUsd: 1, fired: null }, deps);
    expect(calls.register).toHaveLength(1);
    expect(calls.spend).toHaveLength(0);
  });

  it('NEVER throws on IO failure', async () => {
    const { deps } = fakeDeps();
    deps.getSql = async () => {
      throw new Error('no pool');
    };
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'h', perCycleBudgetUsd: 1, fired: null },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'error', error: 'no pool' });
  });
});

describe('learningGovernorPreflight — the frontier gate', () => {
  it("flag OFF ⇒ refuses with 'governor-dark'", async () => {
    const { deps } = fakeDeps({ enabled: false });
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: false, reason: 'governor-dark', remainingUsd: null });
  });

  it('flag ON ⇒ returns the registration verdict', async () => {
    const { deps } = fakeDeps();
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: true, remainingUsd: 5 });
  });

  it("fail-CLOSED: an IO error refuses with 'governor-error' (never allows on a broken ledger)", async () => {
    const { deps, calls } = fakeDeps();
    deps.check = async () => {
      throw new Error('pg down');
    };
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: false, reason: 'governor-error', remainingUsd: null });
    expect(calls.logs.some((l) => l.includes('fail-closed'))).toBe(true);
  });
});
