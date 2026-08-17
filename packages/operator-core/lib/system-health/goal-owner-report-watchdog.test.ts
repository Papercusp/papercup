import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  GOAL_OWNER_REPORT_MAX_SILENCE_MS,
  GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
  GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS,
  GOAL_OWNER_REPORT_REVIEW_BY,
  buildReportSkeleton,
  findOverdueReports,
  isPastReportFloorReview,
  runGoalOwnerReportSweepOnce,
  type GoalOwnerReportAlert,
  type GoalOwnerReportRowLike,
  type GoalOwnerReportSweepDeps,
} from './goal-owner-report-watchdog';

const NOW = 1_800_000_000_000;
const FLOOR = GOAL_OWNER_REPORT_MAX_SILENCE_MS;
const HOUR = 3600_000;

function makeRow(over: Partial<GoalOwnerReportRowLike> = {}): GoalOwnerReportRowLike {
  return {
    workspaceId: 'ws',
    goalId: 'g-1',
    agentId: 'su-goal-owner',
    baselineTsMs: NOW - 24 * HOUR,
    lastReportTsMs: null,
    ...over,
  };
}

// The default deps hit PG/flags/the liveness oracle — every sweep test injects the full surface.
const sqlNever = ((..._args: unknown[]) => {
  throw new Error('sql must not be called when all deps are injected');
}) as unknown as Sql;

function liveVerdict(ownerId: string): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'live',
    wakeable: true,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: true,
  };
}

function deadVerdict(ownerId: string): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'ended',
    wakeable: false,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: false,
  };
}

function makeDeps(over: Partial<GoalOwnerReportSweepDeps> = {}): GoalOwnerReportSweepDeps {
  return {
    readGoalModeOwners: vi.fn(async () => [] as GoalOwnerReportRowLike[]),
    resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, liveVerdict(id)]))),
    escalate: vi.fn(async () => ({ coalesced: false })),
    nudge: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    ...over,
  };
}

describe('findOverdueReports (pure)', () => {
  it('a long-silent owner with no report ever is overdue, measured from the baseline', () => {
    const alerts = findOverdueReports([makeRow()], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      workspaceId: 'ws',
      goalId: 'g-1',
      agentId: 'su-goal-owner',
      referenceTsMs: NOW - 24 * HOUR,
      silentMs: 24 * HOUR,
    });
  });

  it('a fresh report clears the condition', () => {
    const alerts = findOverdueReports([makeRow({ lastReportTsMs: NOW - HOUR })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it('grace: a freshly-taken goal with no report is NOT overdue until the floor elapses from baseline', () => {
    const alerts = findOverdueReports([makeRow({ baselineTsMs: NOW - HOUR })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it('a report that PREDATES the baseline is ignored — the reference is the baseline', () => {
    // Owner escalated about something else last week, then took this goal 1h ago:
    // that stale report must not start the clock early, and the fresh baseline
    // must not be overridden by it either.
    const fresh = findOverdueReports(
      [makeRow({ baselineTsMs: NOW - HOUR, lastReportTsMs: NOW - 7 * 24 * HOUR })],
      NOW,
    );
    expect(fresh).toHaveLength(0);
    // Same stale report, old baseline: overdue, and measured from the baseline.
    const stale = findOverdueReports(
      [makeRow({ baselineTsMs: NOW - 24 * HOUR, lastReportTsMs: NOW - 7 * 24 * HOUR })],
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].referenceTsMs).toBe(NOW - 24 * HOUR);
  });

  it('the floor is a strict bound: exactly-at-floor silence is not overdue, 1ms past is', () => {
    expect(
      findOverdueReports([makeRow({ baselineTsMs: NOW - FLOOR, lastReportTsMs: null })], NOW),
    ).toHaveLength(0);
    expect(
      findOverdueReports([makeRow({ baselineTsMs: NOW - FLOOR - 1, lastReportTsMs: null })], NOW),
    ).toHaveLength(1);
  });
});

describe('findOverdueReports — falsifiability controls (the fixtures can tell a broken predicate apart)', () => {
  // Deliberately-wrong implementations kept permanently as controls (mutation-probe
  // module tier): each must DISAGREE with the real predicate on the case built to
  // catch it, and AGREE on the calibration case — proving the fixtures distinguish
  // a broken implementation rather than passing anything shaped like a function.
  function brokenIgnoresReports(
    rows: readonly GoalOwnerReportRowLike[],
    nowMs: number,
  ): GoalOwnerReportAlert[] {
    // Defect: measures silence from the baseline alone — a compliant reporter
    // still gets nagged forever.
    return rows
      .filter((r) => nowMs - r.baselineTsMs > FLOOR)
      .map((r) => ({
        workspaceId: r.workspaceId,
        goalId: r.goalId,
        agentId: r.agentId,
        referenceTsMs: r.baselineTsMs,
        silentMs: nowMs - r.baselineTsMs,
      }));
  }

  function brokenMinReference(
    rows: readonly GoalOwnerReportRowLike[],
    nowMs: number,
  ): GoalOwnerReportAlert[] {
    // Defect: min instead of max — a stale pre-baseline report starts the clock
    // early, nuking the grace window for freshly-taken goals.
    return rows
      .filter((r) => nowMs - Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs) > FLOOR)
      .map((r) => ({
        workspaceId: r.workspaceId,
        goalId: r.goalId,
        agentId: r.agentId,
        referenceTsMs: Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs),
        silentMs: nowMs - Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs),
      }));
  }

  const freshReportRow = makeRow({ lastReportTsMs: NOW - HOUR });
  const staleReportFreshGoalRow = makeRow({
    baselineTsMs: NOW - HOUR,
    lastReportTsMs: NOW - 7 * 24 * HOUR,
  });
  const calibrationRow = makeRow(); // 24h silent, no report — everyone must alert

  it('control 1 (ignores reports) is CAUGHT by the fresh-report fixture', () => {
    expect(findOverdueReports([freshReportRow], NOW)).toHaveLength(0);
    expect(brokenIgnoresReports([freshReportRow], NOW)).toHaveLength(1);
  });

  it('control 2 (min reference) is CAUGHT by the stale-report-fresh-goal fixture', () => {
    expect(findOverdueReports([staleReportFreshGoalRow], NOW)).toHaveLength(0);
    expect(brokenMinReference([staleReportFreshGoalRow], NOW)).toHaveLength(1);
  });

  it('calibration: both controls AND the real predicate alert on plain long silence', () => {
    expect(findOverdueReports([calibrationRow], NOW)).toHaveLength(1);
    expect(brokenIgnoresReports([calibrationRow], NOW)).toHaveLength(1);
    expect(brokenMinReference([calibrationRow], NOW)).toHaveLength(1);
  });
});

describe('the cadence floor (D-016: a floor with no consequence is a comment)', () => {
  it('sits strictly ABOVE the measured healthy cadence — a compliant owner is never nagged', () => {
    expect(GOAL_OWNER_REPORT_MAX_SILENCE_MS).toBeGreaterThan(
      GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS,
    );
  });

  it('sits AT-OR-BELOW the measured failure silence — the observed failure would have been caught', () => {
    expect(GOAL_OWNER_REPORT_MAX_SILENCE_MS).toBeLessThanOrEqual(
      GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
    );
    // And the measured failure itself trips the predicate:
    const failureRow = makeRow({
      baselineTsMs: NOW - GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
      lastReportTsMs: null,
    });
    expect(findOverdueReports([failureRow], NOW)).toHaveLength(1);
  });

  it('the review date has consequence: this test FAILS once it passes', () => {
    // If you are reading this because it went red: the 4h floor's review date has
    // arrived. Re-litigate the number against current evidence (rubric trends,
    // scorecard cadence, real goal-mode runs since 2026-08), update the WHY on
    // GOAL_OWNER_REPORT_MAX_SILENCE_MS, and bump GOAL_OWNER_REPORT_REVIEW_BY.
    // Deleting or skipping this test instead is the exact decay D-016 names.
    expect(isPastReportFloorReview(GOAL_OWNER_REPORT_REVIEW_BY, new Date())).toBe(false);
  });

  it('isPastReportFloorReview is itself falsifiable: past ⇒ true, future ⇒ false, garbage ⇒ true', () => {
    const now = new Date('2026-08-17T00:00:00Z');
    expect(isPastReportFloorReview('2026-08-01', now)).toBe(true);
    expect(isPastReportFloorReview('2026-09-01', now)).toBe(false);
    expect(isPastReportFloorReview('not-a-date', now)).toBe(true);
  });
});

describe('buildReportSkeleton', () => {
  it("carries the GOAL contract's four report fields and points at the sanctioned rail", () => {
    const skeleton = buildReportSkeleton({
      workspaceId: 'ws',
      goalId: 'g-1',
      agentId: 'su-goal-owner',
      referenceTsMs: NOW - 5 * HOUR,
      silentMs: 5 * HOUR,
    });
    expect(Object.keys(skeleton)).toEqual([
      'channel',
      'whatMoved',
      'whatItCost',
      'ownerWalled',
      'whatYouKilled',
    ]);
    expect(skeleton.channel).toContain('coord:escalate');
    expect(skeleton.whatMoved).toContain('g-1');
  });
});

describe('runGoalOwnerReportSweepOnce', () => {
  // The sweep measures against REAL Date.now() (it takes no clock), so sweep
  // fixtures anchor there — the fixed NOW constant above is for the pure tests,
  // and a row anchored to it would sit in the future and never be overdue.
  const overdueRow = makeRow({ baselineTsMs: Date.now() - 24 * HOUR }); // 24h silent — overdue by construction

  it('flag off ⇒ skipped, and nothing is read', async () => {
    const deps = makeDeps({ flagEnabled: vi.fn(async () => false) });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r).toEqual({ scanned: 0, overdue: 0, nudged: 0, skipped: true });
    expect(deps.readGoalModeOwners).not.toHaveBeenCalled();
  });

  it('nothing overdue ⇒ no liveness read, no escalation, no nudge', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [makeRow({ lastReportTsMs: NOW - HOUR, baselineTsMs: Date.now() - HOUR })]),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.resolveLiveness).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('overdue + alive + newly-opened escalation ⇒ exactly one nudge, to that owner', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1);
    expect(r.nudged).toBe(1);
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.nudge).toHaveBeenCalledTimes(1);
    const alert = (deps.nudge as ReturnType<typeof vi.fn>).mock.calls[0][0] as GoalOwnerReportAlert;
    expect(alert.agentId).toBe('su-goal-owner');
    expect(alert.goalId).toBe('g-1');
  });

  it('ONE nudge per silence: a coalesced escalation suppresses the wake', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      escalate: vi.fn(async () => ({ coalesced: true })),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1);
    expect(r.nudged).toBe(0);
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('a dead owner is suppressed — the liveness watchdog owns that lane', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => new Map([['su-goal-owner', deadVerdict('su-goal-owner')]])),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('a MISSING liveness verdict is UNKNOWN, not alive — suppressed (the conservative rule)', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => new Map<string, LivenessVerdict>()),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('a THROWING liveness read suppresses every alert this tick, without failing the sweep', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => {
        throw new Error('oracle degraded');
      }),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1); // observed, reported honestly
    expect(r.nudged).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('an escalate failure skips the nudge (the dedup retry next tick is the recovery path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        readGoalModeOwners: vi.fn(async () => [overdueRow]),
        escalate: vi.fn(async () => {
          throw new Error('escalation store down');
        }),
      });
      const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
      expect(r.nudged).toBe(0);
      expect(deps.nudge).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a nudge failure is contained per alert — the sweep still returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        readGoalModeOwners: vi.fn(async () => [overdueRow]),
        nudge: vi.fn(async () => {
          throw new Error('wake fan down');
        }),
      });
      const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
      expect(r.overdue).toBe(1);
      expect(r.nudged).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
