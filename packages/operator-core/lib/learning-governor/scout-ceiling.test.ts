/**
 * scout-ceiling.test.ts — the P-051 workspace-wide scout spend ceiling gate
 * (per-hive-learning-loops-2026-06-14 / D-005). Pins, with injected deps + zero
 * PG/flags IO:
 *   - flag OFF ⇒ the gate is a no-op ALLOW (the kill-switch);
 *   - UNDER cap ⇒ allow; OVER cap ⇒ refuse (workspace-ceiling-exceeded);
 *   - the ceiling SUMS across hives (aggregate `scout:<hive>` spend);
 *   - the env override (PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD) is honored;
 *   - an IO error FAILS OPEN (allow) — a safety cap over already-bounded cycles
 *     must not freeze the fleet on a transient ledger-read failure.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  resolveScoutWorkspaceCeilingUsd,
  scoutWorkspaceCeilingGate,
  type ScoutCeilingDeps,
} from './scout-ceiling';
import { DEFAULT_SCOUT_WORKSPACE_CEILING_USD, scoutLoopId, type LearningLoopRegistration } from './core';

const SQL = {} as Sql;

function reg(loopId: string, spentUsd: number): LearningLoopRegistration {
  return {
    workspaceId: 'w',
    loopId,
    displayName: loopId,
    budgetKind: 'per-cycle',
    budgetUsd: 0.5,
    spentUsd,
    priority: 60,
    enabled: true,
    enforcement: 'native',
    meta: null,
    registeredAt: 1,
    updatedAt: 1,
  };
}

function fakeDeps(opts: { enabled?: boolean; loops?: LearningLoopRegistration[]; ceilingUsd?: number } = {}): {
  deps: ScoutCeilingDeps;
  calls: { listed: number; logs: string[] };
} {
  const calls = { listed: 0, logs: [] as string[] };
  const deps: ScoutCeilingDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    listLoops: async () => {
      calls.listed += 1;
      return opts.loops ?? [];
    },
    ceilingUsd: () => opts.ceilingUsd ?? 10,
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

describe('resolveScoutWorkspaceCeilingUsd (env override)', () => {
  it('falls back to the default when unset / empty', () => {
    expect(resolveScoutWorkspaceCeilingUsd({})).toBe(DEFAULT_SCOUT_WORKSPACE_CEILING_USD);
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
  });
  it('honors a finite ≥ 0 override (0 is an honest cap)', () => {
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' })).toBe(25);
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '0' })).toBe(0);
  });
  it('ignores a non-numeric / negative override (falls back to default)', () => {
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: 'nope' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '-5' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
  });
});

describe('scoutWorkspaceCeilingGate', () => {
  it('flag OFF ⇒ ALLOW no-op (kill-switch), the ledger is never read', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(true);
    expect(calls.listed).toBe(0); // the ledger read is short-circuited
  });

  it('UNDER cap ⇒ proceed', async () => {
    const { deps } = fakeDeps({ loops: [reg(scoutLoopId('a'), 1), reg(scoutLoopId('b'), 2)], ceilingUsd: 10 });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(true);
    expect(v.totalScoutSpentUsd).toBe(3);
  });

  it('OVER cap ⇒ refuse + log (the ceiling SUMS across hives)', async () => {
    const { deps, calls } = fakeDeps({
      // Three hives, each individually small, sum past the workspace cap.
      loops: [reg(scoutLoopId('a'), 4), reg(scoutLoopId('b'), 4), reg(scoutLoopId('c'), 4)],
      ceilingUsd: 10,
    });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('workspace-ceiling-exceeded');
    expect(v.totalScoutSpentUsd).toBe(12);
    expect(v.scoutLoopCount).toBe(3);
    expect(calls.logs.join('\n')).toMatch(/REFUSING new scout cycle/);
  });

  it('gym + frontier registrant spend does NOT count toward the scout ceiling', async () => {
    const { deps } = fakeDeps({
      loops: [reg(scoutLoopId('a'), 3), reg('gym:a', 99), reg('frontier:transfer-harness', 99)],
      ceilingUsd: 10,
    });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.totalScoutSpentUsd).toBe(3);
    expect(v.allow).toBe(true);
  });

  it('FAILS OPEN (allow) + logs on an IO error — never freezes the fleet on a transient read failure', async () => {
    const calls = { logs: [] as string[] };
    const deps: ScoutCeilingDeps = {
      enabled: async () => true,
      getSql: async () => {
        throw new Error('pg down');
      },
      ceilingUsd: () => 10,
      log: (m) => calls.logs.push(m),
    };
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(true); // fail-OPEN (the inverse of the frontier preflight's fail-closed)
    expect(calls.logs.join('\n')).toMatch(/fail-open/);
  });
});
