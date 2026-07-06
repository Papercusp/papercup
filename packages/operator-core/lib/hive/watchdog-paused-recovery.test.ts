/**
 * Paused-hive recovery — the missing detector for a hive PAUSED while work is
 * queued (autonomous-loop-canary-reliability-2026-06-29 P-003). The started-only
 * watchdog seams skip a paused hive, so this was a silent outage (the multi-day
 * daily-canary stall). Pure tests for the act-decision + the env tunables; the IO
 * deps are mocked only so importing ./watchdog has no load-time side effects.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('./wake', () => ({
  declareHiveTimeWake: vi.fn(),
  getHiveTimeWake: vi.fn(),
  readHiveWakeState: vi.fn(),
}));
vi.mock('./started', () => ({
  getHiveStarted: vi.fn(),
  listStartedWorkspaceLoops: vi.fn(),
  listPausedHives: vi.fn(),
  setHiveStarted: vi.fn(),
}));

import {
  shouldActOnPausedHive,
  pausedRecoveryStaleSec,
  pausedRecoveryAutoResume,
  effectiveAutoResumeForPause,
} from './watchdog';

const HOUR = 3_600_000;

describe('shouldActOnPausedHive', () => {
  const base = {
    pausedAtMs: 0,
    now: 48 * HOUR,
    thresholdMs: 24 * HOUR,
    hasDemand: true,
    alreadyFiredRecently: false,
  };
  it('acts on a long-paused hive with demand', () => {
    expect(shouldActOnPausedHive(base)).toBe(true);
  });
  it('skips when paused less than the threshold (deliberate brief pause)', () => {
    expect(shouldActOnPausedHive({ ...base, now: 1 * HOUR })).toBe(false);
  });
  it('skips when there is no demand (idle by choice)', () => {
    expect(shouldActOnPausedHive({ ...base, hasDemand: false })).toBe(false);
  });
  it('skips when the pause time is unknown (never act blind)', () => {
    expect(shouldActOnPausedHive({ ...base, pausedAtMs: null })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldActOnPausedHive({ ...base, alreadyFiredRecently: true })).toBe(false);
  });
});

describe('paused-recovery tunables', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('defaults to a 24h stale threshold', () => {
    delete process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC;
    expect(pausedRecoveryStaleSec()).toBe(86_400);
  });
  it('honors PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '3600';
    expect(pausedRecoveryStaleSec()).toBe(3600);
    process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC = '0';
    expect(pausedRecoveryStaleSec()).toBe(0);
  });
  it('auto-resumes by default; off/0/false disable it', () => {
    delete process.env.PAPERCUSP_HIVE_PAUSED_AUTO_RESUME;
    expect(pausedRecoveryAutoResume()).toBe(true);
    for (const v of ['off', '0', 'false']) {
      process.env.PAPERCUSP_HIVE_PAUSED_AUTO_RESUME = v;
      expect(pausedRecoveryAutoResume()).toBe(false);
    }
  });
});
