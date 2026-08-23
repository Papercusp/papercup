/**
 * goal-start-action.test.ts — the `system:goal-start` action's WIRING
 * (work-on-everything-goal-2026-08-23 P-020, D-006 ruling 3): payload → the one
 * activation primitive, ok vs refusal mapping, and the missing-target throw.
 * The primitive's own guards are pinned in start-goal-by-id.test.ts; here we
 * inject it and test only what this action adds.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/harness/routines/goal-start-action.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

const FAKE_SQL = vi.hoisted(() => Symbol('sql')) as never;

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: FAKE_SQL }),
}));

import {
  GOAL_START_LAUNCHER,
  runGoalStartAction,
} from './goal-start-action';
import { getSystemAction } from './system-actions';
import type { SystemActionCtx } from './system-actions';

const ctx = (payload: Record<string, unknown> | null): SystemActionCtx => ({
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: payload,
});

describe('runGoalStartAction (system:goal-start)', () => {
  it('dispatches the primitive with the payload goal + the schedule launcher stamp', async () => {
    const startGoal = vi.fn(async () => ({
      ok: true as const,
      goalId: 'goal-sched-1',
      ownerId: 'su-sched-holder-1',
      warnings: [],
      startBlockedOverride: null,
    }));
    const res = await runGoalStartAction(ctx({ goalId: 'goal-sched-1' }), { startGoal });
    expect(res).toEqual({ started: true, goalId: 'goal-sched-1', ownerId: 'su-sched-holder-1' });
    expect(startGoal).toHaveBeenCalledWith(FAKE_SQL, {
      workspaceId: 'papercusp-workspace',
      goalId: 'goal-sched-1',
      launcherOwnerId: GOAL_START_LAUNCHER,
    });
  });

  it('a primitive refusal is a RESULT, never a throw — the guard working, not a failed fire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startGoal = vi.fn(async () => ({
      ok: false as const,
      reason: 'already-held' as never,
      detail: 'live holder su-elsewhere',
    }));
    const res = await runGoalStartAction(ctx({ goalId: 'goal-sched-1' }), { startGoal });
    expect(res).toEqual({ started: false, goalId: 'goal-sched-1', refusal: 'already-held' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('already-held'))).toBe(true);
    warn.mockRestore();
  });

  it('a routine with no goal target THROWS — a materialization bug must fail loudly', async () => {
    const startGoal = vi.fn();
    await expect(runGoalStartAction(ctx(null), { startGoal })).rejects.toThrow(
      'system:goal-start requires payload_template.goalId',
    );
    await expect(runGoalStartAction(ctx({ goalId: '  ' }), { startGoal })).rejects.toThrow(
      'system:goal-start requires payload_template.goalId',
    );
    expect(startGoal).not.toHaveBeenCalled();
  });

  it('registers as the `goal-start` system action (target_role system:goal-start)', () => {
    expect(getSystemAction('goal-start')).toBeTypeOf('function');
  });
});
