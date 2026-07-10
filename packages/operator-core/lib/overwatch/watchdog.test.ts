/**
 * Unit tests for the overwatch liveness watchdog
 * (overwatch-role-2026-06-15 B-09 / D-004 — who-watches-the-watcher).
 *
 * The control-state (B-07), wake-state (./liveness), and flag (B-10) seams are
 * mocked; the PG handle is a fake tagged-template routing by statement text.
 * These pin the backstop's CONTRACT: it is fully INERT until activated (flag +
 * started), it arms a default SLEEP (never an immediate re-invoke), it is
 * idempotent across racing seams, and every sweep condition gates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));

const getOverwatchStarted = vi.fn();
const setOverwatchStarted = vi.fn();
// K1 (workspace-scoped-coordination P-004 — Phase C): listGuardedOverwatches now
// consumes the DE-DUPED supervisor set (listStartedWorkspaceOverwatches), the exact
// mirror of the Queen watchdog consuming listStartedWorkspaceLoops.
const listStartedWorkspaceOverwatches = vi.fn();
vi.mock('./control-state', () => ({
  getOverwatchStarted: (...a: unknown[]) => getOverwatchStarted(...a),
  setOverwatchStarted: (...a: unknown[]) => setOverwatchStarted(...a),
  listStartedWorkspaceOverwatches: (...a: unknown[]) => listStartedWorkspaceOverwatches(...a),
}));

const declareOverwatchTimeWake = vi.fn();
const clearOverwatchTimeWake = vi.fn();
const overwatchLivenessCheck = vi.fn();
vi.mock('./liveness', () => ({
  declareOverwatchTimeWake: (...a: unknown[]) => declareOverwatchTimeWake(...a),
  clearOverwatchTimeWake: (...a: unknown[]) => clearOverwatchTimeWake(...a),
  overwatchLivenessCheck: (...a: unknown[]) => overwatchLivenessCheck(...a),
}));

const isRegisteredHive = vi.fn();
vi.mock('../harness-registry', () => ({
  isRegisteredHive: (...a: unknown[]) => isRegisteredHive(...a),
}));

// Fake PG: collect INSERTs into `fires`, serve the mid-turn read + count read.
const fires: Array<unknown[]> = [];
let midTurnRows: unknown[] = [];
const fakeSql = (strings: TemplateStringsArray | string[], ...values: unknown[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/INSERT INTO harness_shared\.hive_watchdog_fires/i.test(text)) {
    fires.push(values);
    return Promise.resolve([]);
  }
  if (/adv_sessions/i.test(text)) return Promise.resolve(midTurnRows);
  if (/count\(\*\)::int AS n/i.test(text)) return Promise.resolve([{ n: fires.length }]);
  return Promise.resolve([]);
};
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fakeSql }) }));

import {
  armFallbackOverwatchWake,
  listGuardedOverwatches,
  overwatchBootCheck,
  overwatchTurnEndCheck,
  overwatchWatchdogSleepSec,
  overwatchWatchdogSweep,
  overwatchWatchdogStaleSec,
  recentOverwatchWatchdogFires,
} from './watchdog';

const NOW = 1_750_000_000_000;
const WS = 'ws-1';
const SLUG = 'papercup-hive';

const unarmed = () => overwatchLivenessCheck.mockResolvedValue({ armed: false, nextFireAt: null, lastFiredAt: null, staleForMs: null });

beforeEach(() => {
  vi.clearAllMocks();
  fires.length = 0;
  midTurnRows = [];
  getFlag.mockResolvedValue(true); // flag ON by default in tests
  getOverwatchStarted.mockResolvedValue(true);
  listStartedWorkspaceOverwatches.mockResolvedValue([{ workspaceId: WS, installSlug: SLUG }]);
  isRegisteredHive.mockResolvedValue(true);
  declareOverwatchTimeWake.mockImplementation(async (_sql: unknown, opts: { at: Date }) => ({ at: opts.at, clamped: false }));
  unarmed();
});

describe('listGuardedOverwatches (the activation gate — inert until on)', () => {
  it('flag OFF ⇒ empty (the role ships dark, B-10/D-009)', async () => {
    getFlag.mockResolvedValue(false);
    expect(await listGuardedOverwatches()).toEqual([]);
    expect(listStartedWorkspaceOverwatches).not.toHaveBeenCalled();
  });

  it('flag ON ⇒ exactly B-07s started supervisor set', async () => {
    expect(await listGuardedOverwatches()).toEqual([{ workspaceId: WS, installSlug: SLUG }]);
  });
});

describe('armFallbackOverwatchWake (a default sleep, never an immediate re-invoke)', () => {
  it('skips when the overwatch flag is off', async () => {
    getFlag.mockResolvedValue(false);
    const res = await armFallbackOverwatchWake({ workspaceId: WS, installSlug: SLUG, source: 'tick', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('skips when not started (B-07 pause disarms the watchdog)', async () => {
    getOverwatchStarted.mockResolvedValue(false);
    const res = await armFallbackOverwatchWake({ workspaceId: WS, installSlug: SLUG, source: 'tick', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('skips when a wake is already armed (idempotent across racing seams)', async () => {
    overwatchLivenessCheck.mockResolvedValue({ armed: true, nextFireAt: new Date(NOW + 5_000), lastFiredAt: null, staleForMs: null });
    const res = await armFallbackOverwatchWake({ workspaceId: WS, installSlug: SLUG, source: 'turn-end', reason: 'r' });
    expect(res.outcome).toBe('skipped');
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('arms the DEFAULT SLEEP (now + sleep, not now+floor) with a self-announcing kickoff, and records the fire', async () => {
    const res = await armFallbackOverwatchWake({ workspaceId: WS, installSlug: SLUG, source: 'turn-end', reason: 'turn ended unarmed', now: NOW });
    expect(res.outcome).toBe('armed');
    const call = declareOverwatchTimeWake.mock.calls[0][1] as { at: Date; kickoff: string };
    expect(call.at.getTime()).toBe(NOW + overwatchWatchdogSleepSec() * 1_000);
    expect(call.kickoff).toMatch(/watchdog/i);
    expect(call.kickoff).toMatch(/declare/i);
    expect(fires).toHaveLength(1);
    // recorded under an overwatch-* source so it never pollutes the hive's count.
    expect(String(fires[0]).includes('overwatch-turn-end') || JSON.stringify(fires[0]).includes('overwatch-turn-end')).toBe(true);
    // REGRESSION (live B-12 bug): wake_at must bind as an ISO STRING, never a raw
    // Date — the real PG client throws "Received an instance of Date" on a Date
    // bind, which silently broke the fire-record on the live operator. The fake sql
    // collects the template VALUES; wake_at is index 4 (ws, slug, source, reason,
    // wake_at, demand).
    const wakeAtBind = (fires[0] as unknown[])[4];
    expect(typeof wakeAtBind).toBe('string');
    expect(new Date(wakeAtBind as string).getTime()).toBe(NOW + overwatchWatchdogSleepSec() * 1_000);
  });
});

describe('the three seams', () => {
  it('turn-end arms with no stale gate — turn ended unarmed IS the violation', async () => {
    const res = await overwatchTurnEndCheck({ workspaceId: WS, installSlug: SLUG });
    expect(res.outcome).toBe('armed');
  });

  it('boot check sweeps every guarded overwatch', async () => {
    listStartedWorkspaceOverwatches.mockResolvedValue([
      { workspaceId: WS, installSlug: 'h1' },
      { workspaceId: WS, installSlug: 'h2' },
    ]);
    const res = await overwatchBootCheck();
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.outcome === 'armed')).toBe(true);
  });

  it('boot check is empty when the flag is off (no false re-arm of a dark role)', async () => {
    getFlag.mockResolvedValue(false);
    expect(await overwatchBootCheck()).toHaveLength(0);
  });
});

describe('overwatchWatchdogSweep (every condition gates)', () => {
  const stale = () =>
    overwatchLivenessCheck.mockResolvedValue({
      armed: false,
      nextFireAt: null,
      lastFiredAt: new Date(NOW - (overwatchWatchdogStaleSec() + 60) * 1_000),
      staleForMs: (overwatchWatchdogStaleSec() + 60) * 1_000,
    });

  it('no guarded overwatches → nothing', async () => {
    listStartedWorkspaceOverwatches.mockResolvedValue([]);
    expect(await overwatchWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('missing registry Hive → self-clears the started bit and wake instead of re-arming', async () => {
    isRegisteredHive.mockResolvedValue(false);
    const res = await overwatchWatchdogSweep({ now: NOW });
    expect(res).toEqual([{ outcome: 'skipped', reason: 'started Overwatch Hive missing from registry; self-cleared' }]);
    expect(setOverwatchStarted).toHaveBeenCalledWith(WS, SLUG, false);
    expect(clearOverwatchTimeWake).toHaveBeenCalledWith(fakeSql, SLUG, { workspaceId: WS });
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('flag off → nothing (the load-bearing gate)', async () => {
    getFlag.mockResolvedValue(false);
    stale();
    expect(await overwatchWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('armed → no fire', async () => {
    overwatchLivenessCheck.mockResolvedValue({ armed: true, nextFireAt: new Date(NOW + 9_000), lastFiredAt: null, staleForMs: null });
    expect(await overwatchWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('recently active (not yet stale) → no fire (the turn-end/boot seams own the fresh cases)', async () => {
    overwatchLivenessCheck.mockResolvedValue({ armed: false, nextFireAt: null, lastFiredAt: new Date(NOW - 30_000), staleForMs: 30_000 });
    expect(await overwatchWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('mid-turn → no fire (never wake an overwatch that is awake)', async () => {
    stale();
    midTurnRows = [{ 1: 1 }];
    expect(await overwatchWatchdogSweep({ now: NOW })).toHaveLength(0);
  });

  it('started + stale + unarmed + idle → FIRES', async () => {
    stale();
    const res = await overwatchWatchdogSweep({ now: NOW });
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('armed');
    expect(fires).toHaveLength(1);
  });

  it('a never-woken overwatch (null staleness) passes the stale gate', async () => {
    unarmed(); // staleForMs null
    const res = await overwatchWatchdogSweep({ now: NOW });
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('armed');
  });
});

describe('recentOverwatchWatchdogFires', () => {
  it('counts fires (filtered to the overwatch-* source)', async () => {
    fires.push(['x']); // simulate a prior fire so the count read returns 1
    expect(await recentOverwatchWatchdogFires(WS, SLUG)).toBe(1);
  });
});
