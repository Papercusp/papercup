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
  runGovernedSpendAttempt,
  type GovernedSpendAttemptInput,
  type GovernorGlueDeps,
} from './registrants';
import type {
  RecordLearningSpendInput,
  RegisterLearningLoopInput,
  ReserveLearningSpendResult,
  SettleLearningSpendResult,
} from './store';

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
    // P-004: hermetic pot resolve — 'the pot that owns hive-X is hive-X' for
    // hive-shaped slugs, unresolvable otherwise (the workspace-brain case).
    resolvePot: async (q) => (q.harnessSlug.startsWith('hive-') ? q.harnessSlug : null),
    check: async () => ({ allow: true, remainingUsd: 5 }),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

/**
 * A governor stub for the attempt seam (P-005): grants what is asked and
 * records every settlement, so a test can assert that an attempt CLOSED and
 * with which disposition.
 */
function fakeAttemptDeps(
  opts: { enabled?: boolean; reserve?: ReserveLearningSpendResult; settleThrows?: boolean; settlement?: SettleLearningSpendResult } = {},
) {
  const settlements: Array<{ disposition: string; usedUsd?: number }> = [];
  const logs: string[] = [];
  const granted: ReserveLearningSpendResult = opts.reserve ?? {
    ok: true,
    clamped: false,
    headroomUsd: 9,
    reservation: {
      id: 'res-1',
      workspaceId: 'w',
      loopId: 'frontier:x',
      potSlug: null,
      attemptKind: 'proposer',
      requestedUsd: 1,
      reservedUsd: 1,
      usedUsd: 0,
      status: 'open',
      signalOrigin: 'organic',
      runRef: null,
      note: null,
      createdAt: 0,
      settledAt: null,
    },
  };
  const deps: GovernorGlueDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    reserve: async () => granted,
    settle: async (_sql, input) => {
      if (opts.settleThrows) throw new Error('settlement write failed');
      settlements.push({ disposition: input.disposition, usedUsd: input.usedUsd });
      if (opts.settlement) return opts.settlement;
      if (!granted.ok) throw new Error('cannot settle a refused reservation');
      return {
        ok: true,
        reservation: { ...granted.reservation, usedUsd: input.usedUsd ?? 0,
          status: input.disposition === 'used' ? 'settled' : input.disposition, settledAt: 123 },
        event: null,
        releasedUsd: granted.reservation.reservedUsd - (input.usedUsd ?? 0),
        overrunUsd: 0,
      };
    },
    log: (m) => logs.push(m),
  };
  return { deps, settlements, logs };
}

describe('runGovernedSpendAttempt — every attempt settles exactly once', () => {
  const attempt = <T,>(run: GovernedSpendAttemptInput<T>['run']): GovernedSpendAttemptInput<T> => ({
    workspaceId: 'w',
    loopId: 'frontier:x',
    attemptKind: 'proposer',
    requestedUsd: 1,
    run,
  });

  it('settles a completed attempt as used, at its actual cost', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.4, value: 'lessons' })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.4, cancelled: false });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: {
      id: 'res-1', requestedUsd: 1, reservedUsd: 1, usedUsd: 0.4, status: 'settled', settledAt: 123,
    } } });
    expect(settlements).toEqual([{ disposition: 'used', usedUsd: 0.4 }]);
  });

  it('settles a PARTIAL attempt at the partial cost, not the reservation', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.1, value: '3 of 10 tasks' })),
      deps,
    );
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0.1, status: 'settled' } } });
    expect(settlements).toEqual([{ disposition: 'used', usedUsd: 0.1 }]);
  });

  it('settles a CANCELLED attempt as cancelled', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0, value: null, cancelled: true })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, cancelled: true });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0, status: 'cancelled' } } });
    expect(settlements).toEqual([{ disposition: 'cancelled', usedUsd: 0 }]);
  });

  it('settles a THROWN attempt as failed, charged for what it burned first', async () => {
    // The proposer case: tokens spent, then the parse blows up. Pre-P-005 this
    // ledgered nothing at all.
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        throw Object.assign(new Error('bad JSON'), { costUsd: 0.02 });
      }),
      deps,
    );
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'bad JSON', costUsd: 0.02 });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0.02, status: 'failed' } } });
    expect(settlements).toEqual([{ disposition: 'failed', usedUsd: 0.02 }]);
  });

  it('settles a thrown attempt at zero when nothing was burned', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    await runGovernedSpendAttempt(
      attempt(async () => {
        throw new Error('transcript unreadable');
      }),
      deps,
    );
    expect(settlements).toEqual([{ disposition: 'failed', usedUsd: 0 }]);
  });

  it('does NOT run the work when the reservation is refused', async () => {
    let ran = false;
    const { deps, settlements } = fakeAttemptDeps({
      reserve: { ok: false, reason: 'no-headroom', requestedUsd: 1, headroomUsd: 0 },
    });
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        ran = true;
        return { costUsd: 1, value: null };
      }),
      deps,
    );
    expect(ran).toBe(false);
    expect(out).toMatchObject({ ok: false, reason: 'refused', refusal: 'no-headroom' });
    expect(settlements).toEqual([]);
  });

  it('flag OFF ⇒ governor-dark, and the work never runs', async () => {
    let ran = false;
    const { deps } = fakeAttemptDeps({ enabled: false });
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        ran = true;
        return { costUsd: 1, value: null };
      }),
      deps,
    );
    expect(ran).toBe(false);
    expect(out).toEqual({ ok: false, reason: 'governor-dark' });
  });

  it('a settlement write failure preserves the work and leaves settlement explicitly unknown', async () => {
    // A transport failure may happen before or after commit; it proves neither
    // a closed reservation nor an open one.
    const { deps, logs } = fakeAttemptDeps({ settleThrows: true });
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.3, value: 'lessons' })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.3 });
    expect(out).toMatchObject({ settlement: null, settlementError: 'settlement write failed' });
    expect(logs.join('\n')).toMatch(/settlement outcome unconfirmed/s);
  });

  it.each(['not-found', 'already-settled', 'exact-settlement-required'] as const)(
    'retains the actual %s settlement refusal without masking the work', async (reason) => {
      const settlement: SettleLearningSpendResult = { ok: false, reason, reservation: null };
      const { deps, logs } = fakeAttemptDeps({ settlement });
      const out = await runGovernedSpendAttempt(attempt(async () => ({ costUsd: 0.4, value: 'lessons' })), deps);
      expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.4, settlement });
      expect(logs.join('\n')).toContain(reason);
    },
  );

  it('retains the persisted charge rather than rebuilding it from the work report', async () => {
    const { deps } = fakeAttemptDeps();
    const settle = deps.settle!;
    deps.settle = async (sql, input) => {
      const result = await settle(sql, { ...input, usedUsd: 0.25 });
      return result;
    };
    const out = await runGovernedSpendAttempt(attempt(async () => ({ costUsd: 0.4, value: 'lessons' })), deps);
    expect(out).toMatchObject({ costUsd: 0.4, settlement: { ok: true, reservation: { usedUsd: 0.25 } } });
  });

  it('retains settlement uncertainty when the spending work also failed', async () => {
    const { deps } = fakeAttemptDeps({ settleThrows: true });
    const out = await runGovernedSpendAttempt(attempt(async () => {
      throw Object.assign(new Error('bad JSON'), { costUsd: 0.02 });
    }), deps);
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'bad JSON', costUsd: 0.02,
      settlement: null, settlementError: 'settlement write failed' });
  });
});

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
        potSlug: 'alpha',
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
      { workspaceId: 'w', loopId: 'gym:hive-beta', potSlug: 'hive-beta', costUsd: 0.9, runRef: 'gym-cycle:hive-beta', note: 'gym autoloop cycle', accumulate: false },
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
      loopId: 'blender:papercup',
      budgetKind: 'per-cycle',
      budgetUsd: 1.5,
      enforcement: 'native',
    });
    expect(calls.spend).toEqual([
      {
        workspaceId: 'w',
        loopId: 'blender:papercup',
        potSlug: null,
        costUsd: 0.4,
        runRef: 'scout-9',
        note: 'scout ideation cycle',
        accumulate: true,
      },
    ]);
  });

  it('P-004 re-key: a resolved pot keys BOTH the registration and the spend by blender:<pot>', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'hive-acme', perCycleBudgetUsd: 1.5, fired: { costUsd: 0.4, cycleId: 'scout-10' } },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register[0]).toMatchObject({ loopId: 'blender:hive-acme', potSlug: 'hive-acme' });
    expect(calls.spend[0]).toMatchObject({ loopId: 'blender:hive-acme', potSlug: 'hive-acme' });
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
