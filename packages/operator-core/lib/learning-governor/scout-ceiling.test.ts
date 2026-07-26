/**
 * scout-ceiling.test.ts — the P-051 workspace-wide scout spend ceiling gate
 * (per-hive-learning-loops-2026-06-14 / D-005), WINDOWED since 2026-07-26 (the
 * lifetime-sum froze scout permanently once a workspace had ever spent the cap).
 * Pins, with injected deps + zero PG/flags IO:
 *   - flag OFF ⇒ the gate is a no-op ALLOW (the kill-switch);
 *   - UNDER cap ⇒ allow; OVER cap ⇒ refuse (workspace-ceiling-exceeded);
 *   - the sum is WINDOWED — the gate asks the ledger for spend at/after
 *     now − SCOUT_WORKSPACE_CEILING_WINDOW_MS, never lifetime;
 *   - the env override (PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD) is honored;
 *   - an IO error FAILS OPEN (allow) — a safety cap over already-bounded cycles
 *     must not freeze the fleet on a transient ledger-read failure.
 * (The `blender:*`-only scoping of the sum lives in the SQL — sumScoutSpendSince,
 * store.integration.test.ts — and in the pure rule's prefix filter, core.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  resolveScoutWorkspaceCeilingUsd,
  scoutWorkspaceCeilingGate,
  type ScoutCeilingDeps,
} from './scout-ceiling';
import { DEFAULT_SCOUT_WORKSPACE_CEILING_USD, SCOUT_WORKSPACE_CEILING_WINDOW_MS } from './core';

const SQL = {} as Sql;
const NOW = 1_800_000_000_000;

function fakeDeps(
  opts: { enabled?: boolean; totalUsd?: number; loopCount?: number; ceilingUsd?: number } = {},
): {
  deps: ScoutCeilingDeps;
  calls: { summed: number; sinceMs: number[]; logs: string[] };
} {
  const calls = { summed: 0, sinceMs: [] as number[], logs: [] as string[] };
  const deps: ScoutCeilingDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    sumSpendSince: async (_sql, q) => {
      calls.summed += 1;
      calls.sinceMs.push(q.sinceMs);
      return { totalUsd: opts.totalUsd ?? 0, loopCount: opts.loopCount ?? 1 };
    },
    ceilingUsd: () => opts.ceilingUsd ?? 10,
    nowMs: () => NOW,
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
    expect(calls.summed).toBe(0); // the ledger read is short-circuited
  });

  it('asks the ledger for the WINDOWED sum — sinceMs = now − the accounting window, never lifetime', async () => {
    const { deps, calls } = fakeDeps({ totalUsd: 1 });
    await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(calls.sinceMs).toEqual([NOW - SCOUT_WORKSPACE_CEILING_WINDOW_MS]);
  });

  it('UNDER cap ⇒ proceed', async () => {
    const { deps } = fakeDeps({ totalUsd: 3, loopCount: 2, ceilingUsd: 10 });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(true);
    expect(v.totalScoutSpentUsd).toBe(3);
  });

  it('OVER cap ⇒ refuse + log (aggregate windowed spend across hives)', async () => {
    const { deps, calls } = fakeDeps({ totalUsd: 12, loopCount: 3, ceilingUsd: 10 });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('workspace-ceiling-exceeded');
    expect(v.totalScoutSpentUsd).toBe(12);
    expect(v.scoutLoopCount).toBe(3);
    expect(calls.logs.join('\n')).toMatch(/REFUSING new scout cycle/);
    expect(calls.logs.join('\n')).toMatch(/in the last 24h/);
  });

  it('exactly AT the cap ⇒ refuse (strictly-under semantics)', async () => {
    const { deps } = fakeDeps({ totalUsd: 10, ceilingUsd: 10 });
    const v = await scoutWorkspaceCeilingGate({ workspaceId: 'w' }, deps);
    expect(v.allow).toBe(false);
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
