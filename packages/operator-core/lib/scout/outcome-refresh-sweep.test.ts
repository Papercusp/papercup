/**
 * outcome-refresh-sweep.test.ts — autonomous-loop-prod-audit-2026-07-02 P-006
 * (SPOF 5a/5b). Pure throttle decider + the sweep's orchestration (per-workspace
 * de-dup, refresh, stale-pending debounce/alert, fail-soft, kill switches) via
 * injected deps — no PG (mirrors rubric-staleness-watchdog.test.ts /
 * signal-accumulator.test.ts, the sibling watchdog-family sweeps).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../pot/started', () => ({
  listBlenderMaintenanceScopes: vi.fn(async () => []),
  listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
}));
vi.mock('./routed-ledger', () => ({
  refreshScoutOutcomes: vi.fn(async () => ({ total: 0, byLens: {}, ranked: [] })),
  countStalePendingIdeas: vi.fn(async () => 0),
}));
vi.mock('../pot/watchdog', () => ({
  recentWatchdogFires: vi.fn(async () => 0),
  recordFire: vi.fn(async () => undefined),
}));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({}) as never) }));

import {
  shouldRefreshNow,
  scoutOutcomeRefreshIntervalSec,
  scoutOutcomeStalePendingThresholdSec,
  scoutOutcomeRefreshSweep,
  __resetOutcomeRefreshThrottleForTests,
} from './outcome-refresh-sweep';

const NOW = Date.parse('2026-07-15T12:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
  __resetOutcomeRefreshThrottleForTests();
});

describe('shouldRefreshNow — the in-process throttle', () => {
  it('runs on the first call (no prior sweep)', () => {
    expect(shouldRefreshNow(null, NOW, 900)).toBe(true);
  });

  it('does not re-run before the interval elapses', () => {
    expect(shouldRefreshNow(NOW - 100_000, NOW, 900)).toBe(false);
  });

  it('re-runs once the interval has elapsed', () => {
    expect(shouldRefreshNow(NOW - 901_000, NOW, 900)).toBe(true);
  });

  it('never runs when the sweep interval is a kill switch (<=0)', () => {
    expect(shouldRefreshNow(null, NOW, 0)).toBe(false);
    expect(shouldRefreshNow(null, NOW, -1)).toBe(false);
  });
});

describe('env tunables', () => {
  it('default the refresh interval to 900s and the stale-pending threshold to 24h', () => {
    expect(scoutOutcomeRefreshIntervalSec()).toBe(900);
    expect(scoutOutcomeStalePendingThresholdSec()).toBe(86_400);
  });

  it('read the env override', () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC', '60');
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC', '3600');
    expect(scoutOutcomeRefreshIntervalSec()).toBe(60);
    expect(scoutOutcomeStalePendingThresholdSec()).toBe(3_600);
  });
});

describe('scoutOutcomeRefreshSweep — orchestration (injected deps, no PG)', () => {
  const deps = (over: Parameters<typeof scoutOutcomeRefreshSweep>[0] = {}) => ({
    listBlenderMaintenanceScopes: vi.fn(async () => [{ workspaceId: 'ws1', installSlug: 'papercusp' }]),
    refreshScoutOutcomes: vi.fn(async () => ({ total: 0, byLens: {}, ranked: [] }) as never),
    countStalePendingIdeas: vi.fn(async () => 0),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    now: NOW,
    ...over,
  });

  it('refreshes every started workspace and reports no stale-pending when clean', async () => {
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toEqual([
      {
        workspaceId: 'ws1',
        installSlug: 'papercusp',
        outcome: 'refreshed',
        evaluatedWorkspaceCount: 1,
        evaluatedScopeCount: 1,
        eligibleBacklogCount: 0,
        stalePendingCount: 0,
        alerted: false,
        reason: 'refreshed, no stale-pending',
      },
    ]);
    expect(d.refreshScoutOutcomes).toHaveBeenCalledWith({ workspaceId: 'ws1', harnessSlug: 'papercusp' });
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('de-dups by workspace — a multi-pot workspace refreshes once, not per pot', async () => {
    const d = deps({
      listBlenderMaintenanceScopes: vi.fn(async () => [
        { workspaceId: 'ws1', installSlug: 'papercusp' },
        { workspaceId: 'ws1', installSlug: 'papercusp-b' },
      ]),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toHaveLength(1);
    expect(d.refreshScoutOutcomes).toHaveBeenCalledTimes(1);
  });

  it('alerts (both channels) when ideas sit stale-pending and no recent fire exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ countStalePendingIdeas: vi.fn(async () => 3) });
    const results = await scoutOutcomeRefreshSweep(d);
    warn.mockRestore();
    expect(results[0]).toMatchObject({ outcome: 'refreshed', stalePendingCount: 3, alerted: true });
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.recordFire).mock.calls[0]![0]).toMatchObject({ source: 'scout-outcome-stale-pending' });
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    const esc = vi.mocked(d.openEscalation).mock.calls[0]![1] as { summary: string };
    expect(esc.summary).toContain('3 Scout-routed idea(s)');
  });

  it('debounces the stale-pending alert via the fires ledger', async () => {
    const d = deps({ countStalePendingIdeas: vi.fn(async () => 2), recentWatchdogFires: vi.fn(async () => 1) });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ stalePendingCount: 2, alerted: false });
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('skips the stale-pending check entirely when its threshold is a kill switch (<=0), refresh still runs', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC', '0');
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ outcome: 'refreshed', stalePendingCount: 0 });
    expect(d.countStalePendingIdeas).not.toHaveBeenCalled();
  });

  it('is fail-soft per workspace — a refresh error is recorded, never thrown', async () => {
    const d = deps({
      refreshScoutOutcomes: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ workspaceId: 'ws1', outcome: 'error', reason: 'pg down' });
  });

  it('is fail-soft overall — scope discovery error yields no throw (empty results)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({
      listBlenderMaintenanceScopes: vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    warn.mockRestore();
    expect(results).toEqual([]);
  });

  it('the env kill switch (refresh interval <=0) skips the whole sweep', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC', '0');
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toEqual([]);
    expect(d.listBlenderMaintenanceScopes).not.toHaveBeenCalled();
  });

  it('the in-process throttle skips a second sweep within the interval', async () => {
    const d = deps();
    const first = await scoutOutcomeRefreshSweep(d);
    expect(first).toHaveLength(1);
    const second = await scoutOutcomeRefreshSweep({ ...d, now: NOW + 1000 });
    expect(second).toEqual([]);
  });

  it('the throttle allows a fresh sweep once the interval elapses', async () => {
    const d = deps();
    await scoutOutcomeRefreshSweep(d);
    const later = await scoutOutcomeRefreshSweep({ ...d, now: NOW + 901_000 });
    expect(later).toHaveLength(1);
  });
});
