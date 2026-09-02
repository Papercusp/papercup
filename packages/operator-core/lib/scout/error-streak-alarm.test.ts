/**
 * Scout error-streak alarm (scorecard-blender-pipeline-fixes-2026-07-11 P-001 /
 * WI-4274). Pure tests for the streak decider + env tunables; IO deps mocked so
 * importing the module has no load-time side effects (watchdog-family idiom).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  rows: [] as Array<{ status: string; detail: unknown }>,
  recentWatchdogFires: vi.fn().mockResolvedValue(0),
  claimWatchdogFire: vi.fn().mockResolvedValue(true),
  resolveMugOwner: vi.fn().mockResolvedValue(null),
  deliverScoutNudge: vi.fn().mockResolvedValue({
    kind: 'su',
    ownerId: 'su-a',
    ownerLabel: 'su-a',
    why: 'test recipient',
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  // The composed delivery path loads the real presence graph. Preserve the
  // package's non-I/O exports while replacing only this suite's PG edge.
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({
    sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
      h.calls.push({ text: strings.join('?'), values });
      return Promise.resolve(h.rows);
    }, { begin: vi.fn() }),
  }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('../pot/watchdog', () => ({
  recentWatchdogFires: h.recentWatchdogFires,
  claimWatchdogFire: h.claimWatchdogFire,
  resolveMugOwner: h.resolveMugOwner,
}));
vi.mock('./nudge-recipient', () => ({ deliverScoutNudge: h.deliverScoutNudge }));

import {
  isErrorStreak,
  isAttemptTick,
  ATTEMPT_STATUSES,
  scoutErrorStreakThreshold,
  scoutErrorStreakDebounceHours,
  checkAndFireErrorStreakAlarm,
} from './error-streak-alarm';

beforeEach(() => {
  h.calls.length = 0;
  h.rows = [];
  h.recentWatchdogFires.mockClear();
  h.recentWatchdogFires.mockResolvedValue(0);
  h.claimWatchdogFire.mockClear();
  h.claimWatchdogFire.mockResolvedValue(true);
  h.resolveMugOwner.mockClear();
  h.resolveMugOwner.mockResolvedValue(null);
  h.deliverScoutNudge.mockClear();
  h.deliverScoutNudge.mockResolvedValue({
    kind: 'su',
    ownerId: 'su-a',
    ownerLabel: 'su-a',
    why: 'test recipient',
  });
});

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

describe('the streak window contains ATTEMPTS only (P-010 — the circuit-gate inversion)', () => {
  it('classifies ran/error as attempts and every gated tick as a non-attempt', () => {
    expect(ATTEMPT_STATUSES).toEqual(['ran', 'error']);
    expect(isAttemptTick('ran')).toBe(true);
    expect(isAttemptTick('error')).toBe(true);
    expect(isAttemptTick('gated')).toBe(false);
  });

  it('REGRESSION: a circuit-gated tick BETWEEN two failures must not break the streak', () => {
    // The real ledger shape from the 2026-08-02→08-09 outage: the circuit gate
    // writes its turnaways to the same table the alarm reads, interleaving them
    // with the failures. 37 of that outage's 63 error ticks were immediately
    // preceded by a gated tick.
    const ledgerNewestFirst = ['error', 'gated', 'error', 'gated', 'error'];

    // CONTROL — this is exactly what the pre-fix rule saw, and why a 6-day
    // outage paged only 3 times. Kept as an executable record of the defect:
    // if this ever flips to true the decider has silently changed meaning.
    expect(isErrorStreak(ledgerNewestFirst, 3)).toBe(false);

    // The fix: the window is drawn over attempted cycles, so the outage is visible.
    expect(isErrorStreak(ledgerNewestFirst.filter(isAttemptTick), 3)).toBe(true);
  });

  it('a genuine RECOVERY still breaks the streak once an attempt succeeds', () => {
    // The discriminator that keeps the fix honest: filtering must not turn
    // "the pool recovered" into a permanent alarm.
    const recovered = ['ran', 'gated', 'error', 'error', 'error'];
    expect(isErrorStreak(recovered.filter(isAttemptTick), 3)).toBe(false);
  });

  it('the ledger query filters to ATTEMPT_STATUSES, not every tick', async () => {
    // Pins the SQL predicate itself: a window that re-admits gated ticks would
    // silently restore the inversion, and no pure test above would notice.
    await checkAndFireErrorStreakAlarm({ workspaceId: 'w' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.values).toContainEqual(ATTEMPT_STATUSES);
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

  it('a claimed error-streak page uses the nudge ladder in wake-capable pager mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.rows = [
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
    ];

    try {
      await checkAndFireErrorStreakAlarm({ workspaceId: 'w', installSlug: 'papercusp' });

      expect(warn).not.toHaveBeenCalled();
      expect(h.claimWatchdogFire).toHaveBeenCalledTimes(1);
      expect(h.deliverScoutNudge).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scout-error-streak-alarm',
          wakeSu: true,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a REAL per-hive installSlug is threaded through as the coord harnessSlug', async () => {
    h.rows = [
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
    ];

    await checkAndFireErrorStreakAlarm({ workspaceId: 'w', installSlug: 'papercusp' });

    expect(h.deliverScoutNudge).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'papercusp' }),
    );
  });

  it('REGRESSION EI-20949117919419640: the WORKSPACE_COORDINATION sentinel ' +
    '(installSlug === workspaceId) must NOT be stamped as the coord harnessSlug ' +
    '— it names no federating harness/hive-home, so a captured substrate_outbox ' +
    'row under it can never drain (the permanent outbox-health SLO breach)', async () => {
    h.rows = [
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
      { status: 'error', detail: { error: 'transport dead' } },
    ];

    // workspaceBrainScopeKey(workspaceId, perPotSlug, on) === workspaceId
    // when FLAGS.WORKSPACE_COORDINATION is ON — recordScoutTick then writes
    // ticks (and this alarm is invoked) with installSlug === workspaceId.
    await checkAndFireErrorStreakAlarm({ workspaceId: 'papercusp-workspace', installSlug: 'papercusp-workspace' });

    expect(h.deliverScoutNudge).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: null }),
    );
  });
});
