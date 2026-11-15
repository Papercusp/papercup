/**
 * WI-6554700010049338: an agent that holds one item from an unstarted plan and a
 * second, plan-less item was refused EVERY write, because the plan-less item was
 * invisible to the census, the census named one plan, and the goal selector was
 * skipped. Plan-less held work is now an unbound census member: the durable goal
 * attributes the write, and only the unstarted plan's own writes are refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkPlanExecutionGuard, otherHeldWorkRemedy, selectExecutionPlanBindings } from './plan-execution-guard';
import type { ExecutionPlanBinding } from './plan-execution-guard';
import { resolveAgentGoal } from '../../agent-goal-ref';

const lockCall = { ownerId: 'su-member', workspaceId: 'ws', toolName: 'locks:acquire',
  args: { intent: 'cluster A2', paths: ['scripts/psu-launcher.mjs'] } };
const unstarted: ExecutionPlanBinding = { planSlug: 'green-main-ratchet-convergence-2026-10-17', harnessSlug: 'papercusp',
  source: 'work-item', sourceRef: 'WI-unstarted-item' };
const unbound: ExecutionPlanBinding = { planSlug: '', harnessSlug: 'papercusp', source: 'work-item',
  sourceRef: 'WI-adhoc-item', unbound: true };
// A plain function, not a mock: wrapping a shared vi.fn in a per-test vi.fn
// shares its call history, so one test's calls leak into another's count.
const notStarted = async (_binding: ExecutionPlanBinding) => ['plan_not_started'];
const goalOn = (id: string) => async () => ({ goal: resolveAgentGoal({ workItems: [{ id }] }), diagnostics: [] });

describe('plan-execution guard with plan-less held work (WI-6554700010049338)', () => {
  it('lets a holder of two items lock a file for the plan-less item it declared as its goal', async () => {
    const checkPlan = vi.fn(notStarted);
    const resolveGoal = vi.fn(goalOn('WI-adhoc-item'));
    const result = await checkPlanExecutionGuard(lockCall, {
      readBindings: async () => [unstarted, unbound], resolveGoal, checkPlan,
    });
    expect(result).toBeNull();
    // The selector must run: before the fix the single-plan skip bypassed it.
    expect(resolveGoal).toHaveBeenCalledTimes(1);
    expect(checkPlan).not.toHaveBeenCalled();
  });

  it('still refuses writes attributed to the unstarted plan\'s own item, naming the other held item', async () => {
    const result = await checkPlanExecutionGuard(lockCall, {
      readBindings: async () => [unstarted, unbound], resolveGoal: goalOn('WI-unstarted-item'), checkPlan: notStarted,
    });
    expect(result).toMatchObject({ code: 'plan_execution_not_ready', planSlug: unstarted.planSlug,
      blockers: ['plan_not_started'] });
    expect(result?.reason).toContain('You also hold WI-adhoc-item');
    expect(result?.reason).toContain('declared_goal_refs');
  });

  it('fails closed when no goal attributes the write, or the goal read times out', async () => {
    for (const resolveGoal of [
      async () => ({ goal: null, diagnostics: [] }),
      async () => new Promise<never>(() => { /* never settles */ }),
    ]) {
      const result = await checkPlanExecutionGuard(lockCall, {
        readBindings: async () => [unstarted, unbound], resolveGoal, checkPlan: notStarted, goalResolutionBudgetMs: 5,
      });
      expect(result).toMatchObject({ planSlug: unstarted.planSlug, blockers: ['plan_not_started'] });
    }
  });

  it('keeps the single-plan selector skip when no plan-less work is held', async () => {
    const resolveGoal = vi.fn(goalOn('WI-adhoc-item'));
    const timings: string[] = [];
    const result = await checkPlanExecutionGuard({ ...lockCall, observeTiming: t => { timings.push(t.stage); } }, {
      readBindings: async () => [unstarted], resolveGoal, checkPlan: notStarted,
    });
    expect(result).toMatchObject({ blockers: ['plan_not_started'] });
    expect(resolveGoal).not.toHaveBeenCalled();
    expect(timings).toContain('goal_selector_skipped');
    expect(result?.reason).not.toContain('You also hold');
  });

  it('never checks an unbound binding, alone or selected', async () => {
    const checkPlan = vi.fn(notStarted);
    expect(await checkPlanExecutionGuard(lockCall, { readBindings: async () => [unbound], checkPlan })).toBeNull();
    expect(checkPlan).not.toHaveBeenCalled();
    expect(selectExecutionPlanBindings([unstarted, unbound], resolveAgentGoal({ workItems: [{ id: 'WI-adhoc-item' }] })))
      .toEqual([]);
  });

  it('names only other held work in the remedy', () => {
    expect(otherHeldWorkRemedy([unstarted], unstarted.planSlug)).toBe('');
    expect(otherHeldWorkRemedy([unstarted, unbound, { ...unbound }], unstarted.planSlug))
      .toContain('You also hold WI-adhoc-item.');
  });
});
