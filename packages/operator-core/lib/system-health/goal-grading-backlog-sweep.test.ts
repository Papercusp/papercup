import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalGradingBacklogInput } from '../goal-grading-backlog';
import {
  goalGradingBacklogConditionKey,
  runGoalGradingBacklogSweepOnce,
  type GoalGradingBacklogGoal,
  type GoalGradingBacklogSweepDeps,
} from './goal-grading-backlog-sweep';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
const sql = {} as Sql;

const BACKLOG: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-backlog' };
const HEALTHY: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-healthy' };

/** Ten active holder hours, none covered by a final card; the grader filed only a
 *  provisional card 10h ago, so both alerts fire. */
function backlogInput(goal: GoalGradingBacklogGoal, author: string | null = 'su-grader'): GoalGradingBacklogInput {
  return {
    goalId: goal.goalId,
    nowMs: NOW,
    activityMs: Array.from({ length: 10 }, (_, i) => NOW - (i + 1) * HOUR),
    cards: author
      ? [{ windowStartMs: NOW - 12 * HOUR, windowEndMs: NOW - 11 * HOUR, createdMs: NOW - 10 * HOUR, final: false }]
      : [],
    lastCardAuthor: author,
  };
}

/** Same activity, fully covered by a fresh final card. */
function healthyInput(goal: GoalGradingBacklogGoal): GoalGradingBacklogInput {
  return {
    goalId: goal.goalId,
    nowMs: NOW,
    activityMs: Array.from({ length: 10 }, (_, i) => NOW - (i + 1) * HOUR),
    cards: [{ windowStartMs: NOW - 11 * HOUR, windowEndMs: NOW, createdMs: NOW - HOUR, final: true }],
    lastCardAuthor: 'su-grader',
  };
}

function alive(): LivenessVerdict {
  return { sessionState: 'live' } as LivenessVerdict;
}
function dead(): LivenessVerdict {
  return { sessionState: 'ended' } as LivenessVerdict;
}

function deps(overrides: Partial<GoalGradingBacklogSweepDeps> = {}): GoalGradingBacklogSweepDeps {
  return {
    readGoals: vi.fn(async () => [BACKLOG]),
    readInput: vi.fn(async (goal) => (goal.goalId === HEALTHY.goalId ? healthyInput(goal) : backlogInput(goal))),
    resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, alive()]))),
    escalate: vi.fn(async () => ({ coalesced: false })),
    wakeGrader: vi.fn(async () => undefined),
    resolveCleared: vi.fn(async () => 0),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    ...overrides,
  };
}

describe('runGoalGradingBacklogSweepOnce', () => {
  it('does nothing when the kill-switch flag is off', async () => {
    const d = deps({ flagEnabled: vi.fn(async () => false) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out.skipped).toBe(true);
    expect(d.readGoals).not.toHaveBeenCalled();
    expect(d.escalate).not.toHaveBeenCalled();
  });

  it('escalates a backlog and wakes the live grader once', async () => {
    const d = deps();
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ scanned: 1, alerting: 1, escalated: 1, wokeGrader: 1, failed: 0 });
    expect(d.escalate).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(d.escalate).mock.calls[0]![0];
    expect(alert.graderId).toBe('su-grader');
    expect(alert.graderAlive).toBe(true);
    expect(alert.verdict.ungradedActiveHours).toBe(10);
    expect(alert.verdict.alerts).toEqual(['grading-backlog', 'grader-idle']);
    expect(d.wakeGrader).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.wakeGrader).mock.calls[0]![0].graderId).toBe('su-grader');
    expect(d.resolveCleared).not.toHaveBeenCalled();
  });

  it('does not re-wake the grader when the escalation coalesces', async () => {
    const d = deps({ escalate: vi.fn(async () => ({ coalesced: true })) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ alerting: 1, escalated: 0, wokeGrader: 0 });
    expect(d.wakeGrader).not.toHaveBeenCalled();
  });

  it('escalates but does not wake a grader that is not alive', async () => {
    const d = deps({ resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, dead()]))) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 0 });
    expect(vi.mocked(d.escalate).mock.calls[0]![0].graderAlive).toBe(false);
    expect(d.wakeGrader).not.toHaveBeenCalled();
  });

  it('treats a failed liveness read as not alive: escalates, no wake', async () => {
    const d = deps({
      resolveLiveness: vi.fn(async () => {
        throw new Error('oracle down');
      }),
    });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 0, failed: 0 });
    expect(d.wakeGrader).not.toHaveBeenCalled();
  });

  it('escalates with no grader when no card names one, and skips the liveness read', async () => {
    const d = deps({ readInput: vi.fn(async (goal) => backlogInput(goal, null)) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 0 });
    expect(vi.mocked(d.escalate).mock.calls[0]![0].graderId).toBeNull();
    expect(d.resolveLiveness).not.toHaveBeenCalled();
  });

  it('resolves the open escalation for a goal that reads healthy, without escalating', async () => {
    const d = deps({
      readGoals: vi.fn(async () => [HEALTHY]),
      resolveCleared: vi.fn(async () => 1),
    });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ scanned: 1, alerting: 0, resolved: 1 });
    expect(d.resolveCleared).toHaveBeenCalledWith(HEALTHY);
    expect(d.escalate).not.toHaveBeenCalled();
  });

  it('contains a per-goal failure so other goals are still swept', async () => {
    const broken: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-broken' };
    const d = deps({
      readGoals: vi.fn(async () => [broken, BACKLOG, HEALTHY]),
      readInput: vi.fn(async (goal) => {
        if (goal.goalId === broken.goalId) throw new Error('read failed');
        return goal.goalId === HEALTHY.goalId ? healthyInput(goal) : backlogInput(goal);
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await runGoalGradingBacklogSweepOnce(sql, d);
      expect(out).toMatchObject({ scanned: 3, failed: 1, alerting: 1, escalated: 1, wokeGrader: 1 });
      expect(d.resolveCleared).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('goal-broken');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('goalGradingBacklogConditionKey', () => {
  it('is stable per goal and carries no counts or timestamps', () => {
    expect(goalGradingBacklogConditionKey(BACKLOG)).toBe('goal-grading-backlog:ws:goal-backlog');
    expect(goalGradingBacklogConditionKey(BACKLOG)).toBe(goalGradingBacklogConditionKey({ ...BACKLOG }));
    expect(goalGradingBacklogConditionKey(BACKLOG)).not.toBe(goalGradingBacklogConditionKey(HEALTHY));
  });
});
