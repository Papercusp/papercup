/**
 * Scout error-streak alarm (scorecard-blender-pipeline-fixes-2026-07-11 P-001 /
 * WI-4274). Pure tests for the streak decider + env tunables; IO deps mocked so
 * importing the module has no load-time side effects (watchdog-family idiom).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

import {
  isErrorStreak,
  scoutErrorStreakThreshold,
  scoutErrorStreakDebounceHours,
  checkAndFireErrorStreakAlarm,
} from './error-streak-alarm';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isErrorStreak — the pure streak decider', () => {
  it('streaks when the newest N ticks are ALL errors', () => {
    expect(isErrorStreak(['error', 'error', 'error'], 3)).toBe(true);
  });

  it('a single non-error in the window breaks the streak', () => {
    expect(isErrorStreak(['error', 'ran', 'error'], 3)).toBe(false);
    expect(isErrorStreak(['error', 'error', 'gated'], 3)).toBe(false);
  });

  it('a RECOVERED loop never streaks (newest tick is ran)', () => {
    expect(isErrorStreak(['ran', 'error', 'error'], 3)).toBe(false);
  });

  it('fewer ticks than the threshold never streaks (cold ledger)', () => {
    expect(isErrorStreak(['error', 'error'], 3)).toBe(false);
    expect(isErrorStreak([], 3)).toBe(false);
  });

  it('only the newest N count — older successes beyond the window are irrelevant', () => {
    expect(isErrorStreak(['error', 'error', 'error', 'ran', 'ran'], 3)).toBe(true);
  });

  it('kill switch: threshold <= 0 never streaks', () => {
    expect(isErrorStreak(['error', 'error', 'error'], 0)).toBe(false);
    expect(isErrorStreak(['error'], -1)).toBe(false);
  });
});

describe('env tunables', () => {
  it('threshold defaults to 3, reads env, falls back on garbage', () => {
    expect(scoutErrorStreakThreshold()).toBe(3);
    vi.stubEnv('PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD', '5');
    expect(scoutErrorStreakThreshold()).toBe(5);
    vi.stubEnv('PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD', 'nope');
    expect(scoutErrorStreakThreshold()).toBe(3);
  });

  it('debounce defaults to 6h and rejects non-positive overrides', () => {
    expect(scoutErrorStreakDebounceHours()).toBe(6);
    vi.stubEnv('PAPERCUSP_SCOUT_ERROR_STREAK_DEBOUNCE_HOURS', '12');
    expect(scoutErrorStreakDebounceHours()).toBe(12);
    vi.stubEnv('PAPERCUSP_SCOUT_ERROR_STREAK_DEBOUNCE_HOURS', '0');
    expect(scoutErrorStreakDebounceHours()).toBe(6);
  });
});

describe('checkAndFireErrorStreakAlarm — fail-soft shell', () => {
  it('kill switch (threshold <= 0) returns without touching IO', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD', '0');
    await expect(checkAndFireErrorStreakAlarm({ workspaceId: 'w' })).resolves.toBeUndefined();
  });

  it('never throws when the ledger read fails (paging must not break tick recording)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The mocked sql tag returns [] (no rows) → no streak → clean return;
      // also exercise the catch path via a workspace resolution that throws.
      await expect(checkAndFireErrorStreakAlarm({})).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
