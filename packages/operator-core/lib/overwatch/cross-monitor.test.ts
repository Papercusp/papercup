/**
 * Unit tests for the overwatch-liveness cross-monitor leg
 * (overwatch-role-2026-06-15 B-09 / D-004). The flag (B-10), control-state (B-07),
 * and wake-liveness (./liveness) seams are mocked. These pin the CONSERVATIVE
 * "alive" predicate: not-in-play and armed and never-woken all read alive; only a
 * genuinely-expected, unarmed, stale role is DARK — and a flaky read never
 * manufactures a false `*-dark` alarm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));

const getOverwatchStarted = vi.fn();
vi.mock('./control-state', () => ({ getOverwatchStarted: (...a: unknown[]) => getOverwatchStarted(...a) }));

const overwatchLivenessCheck = vi.fn();
vi.mock('./liveness', () => ({ overwatchLivenessCheck: (...a: unknown[]) => overwatchLivenessCheck(...a) }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));

import { isOverwatchAlive, overwatchAliveForQueen, crossMonitorDarkSec } from './cross-monitor';

const WS = 'ws-1';
const SLUG = 'papercup-hive';
const NOW = 1_750_000_000_000;
const DARK_MS = crossMonitorDarkSec() * 1_000;

const liveness = (over: Partial<{ armed: boolean; staleForMs: number | null }>) =>
  overwatchLivenessCheck.mockResolvedValue({ armed: false, nextFireAt: null, lastFiredAt: null, staleForMs: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  getFlag.mockResolvedValue(true);
  getOverwatchStarted.mockResolvedValue(true);
  liveness({});
});

describe('isOverwatchAlive (boolean | null — null = not in play / not computable)', () => {
  it('flag OFF ⇒ null (not in play — never a false dark)', async () => {
    getFlag.mockResolvedValue(false);
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBeNull();
    expect(overwatchLivenessCheck).not.toHaveBeenCalled();
  });

  it('flag ON but NOT started ⇒ null (paused is intentional, not dark)', async () => {
    getOverwatchStarted.mockResolvedValue(false);
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBeNull();
  });

  it('expected + armed ⇒ alive (a wake is scheduled)', async () => {
    liveness({ armed: true });
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBe(true);
  });

  it('expected + never woken (staleForMs null) ⇒ alive (starting, not dead)', async () => {
    liveness({ armed: false, staleForMs: null });
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBe(true);
  });

  it('expected + unarmed + recently active (< dark threshold) ⇒ alive', async () => {
    liveness({ armed: false, staleForMs: DARK_MS - 60_000 });
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBe(true);
  });

  it('expected + unarmed + stale past the dark threshold ⇒ DARK', async () => {
    liveness({ armed: false, staleForMs: DARK_MS + 60_000 });
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBe(false);
  });

  it('a flaky liveness read ⇒ null (never a fabricated dark alarm)', async () => {
    overwatchLivenessCheck.mockRejectedValue(new Error('db blip'));
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW })).toBeNull();
  });

  it('respects an explicit darkMs override', async () => {
    liveness({ armed: false, staleForMs: 10_000 });
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW, darkMs: 5_000 })).toBe(false);
    expect(await isOverwatchAlive(WS, SLUG, { now: NOW, darkMs: 20_000 })).toBe(true);
  });
});

describe('overwatchAliveForQueen (the Queen-brief adapter: null → undefined)', () => {
  it('not in play ⇒ undefined (the Queen-brief line is omitted)', async () => {
    getFlag.mockResolvedValue(false);
    expect(await overwatchAliveForQueen(WS, SLUG, { now: NOW })).toBeUndefined();
  });

  it('alive ⇒ true', async () => {
    liveness({ armed: true });
    expect(await overwatchAliveForQueen(WS, SLUG, { now: NOW })).toBe(true);
  });

  it('dark ⇒ false (the Queen escalates)', async () => {
    liveness({ armed: false, staleForMs: DARK_MS + 60_000 });
    expect(await overwatchAliveForQueen(WS, SLUG, { now: NOW })).toBe(false);
  });
});
