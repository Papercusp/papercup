import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../work-items';
import {
  assignActionableWorkItems,
  assignAndWakeActionableWorkItems,
  type ActionableWorkItemDispatchDeps,
  type StableAgentTargetState,
} from './actionable-work-item-dispatch';

function workItem(
  id: string,
  state = 'open',
  assignee: string | null = null,
): WorkItem {
  return {
    id,
    kind: 'feature',
    family: 'feature',
    harness: 'email',
    title: id,
    summary: id,
    state,
    assignee,
    payload: {},
  } as WorkItem;
}

function target(
  ownerId = 'agent-email-stable',
  patch: Partial<StableAgentTargetState> = {},
): StableAgentTargetState {
  return {
    requested: ownerId,
    ownerId,
    present: true,
    sessionState: 'parked',
    wakeable: true,
    ...patch,
  };
}

function deps(
  patch: Partial<ActionableWorkItemDispatchDeps> = {},
): ActionableWorkItemDispatchDeps {
  return {
    observe: vi.fn(async (id) => ({
      item: workItem(id),
      available: true,
      claimedBy: null,
    })),
    claim: vi.fn(async (id, assignee) => workItem(id, 'open', assignee)),
    blockers: vi.fn(async () => []),
    planBlock: vi.fn(async () => null),
    planClaim: vi.fn(async () => null),
    resolveTarget: vi.fn(async ({ targetAgent }) => target(targetAgent)),
    wake: vi.fn(async (owners: readonly string[]) => ({
      targets: [...owners],
      keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
      queued: 1,
      woken: 1,
      pickupConfirmed: false,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    })),
    ...patch,
  };
}

describe('assignActionableWorkItems', () => {
  it('claims only the current dependency frontier and preserves blocked descendants', async () => {
    const claim = vi.fn(async (id: string, assignee: string) => workItem(id, 'open', assignee));
    const d = deps({
      claim,
      blockers: vi.fn(async (id) =>
        id === 'WI-BLOCKED' ? [{ ref: 'WI-ROOT', kind: 'feature' }] : [],
      ),
    });

    const result = await assignActionableWorkItems(
      {
        workItemIds: ['WI-READY', 'WI-BLOCKED'],
        targetAgent: 'agent-email-stable',
        harness: 'email',
      },
      d,
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith('WI-READY', 'agent-email-stable', { harness: 'email' });
    expect(result.assigned).toEqual(['WI-READY']);
    expect(result.executionWorkItemIds).toEqual(['WI-READY']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        workItemId: 'WI-BLOCKED',
        code: 'dependency_blocked',
        blockers: ['WI-ROOT'],
      }),
    ]);
  });

  it('never force-claims an item held by another agent', async () => {
    const claim = vi.fn();
    const d = deps({
      claim,
      observe: vi.fn(async (id) => ({
        item: workItem(id, 'open', 'agent-other'),
        available: false,
        claimedBy: 'agent-other',
      })),
    });

    const result = await assignActionableWorkItems(
      { workItemIds: ['WI-HELD'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(result.executionWorkItemIds).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      workItemId: 'WI-HELD',
      code: 'held_by_other',
      holder: 'agent-other',
    });
  });
});

describe('assignAndWakeActionableWorkItems', () => {
  it('does not wake when every requested descendant is still plan-blocked', async () => {
    const wake = vi.fn();
    const d = deps({
      wake,
      observe: vi.fn(async (id) => ({
        item: workItem(id),
        available: false,
        claimedBy: null,
        planItemBlocked: {
          reason: 'plan-item run#P-002 is effectively blocked (blocked-by: P-001)',
          planSlug: 'run',
          itemId: 'P-002',
          effectiveStatus: 'blocked',
        },
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-BLOCKED'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.ok).toBe(true);
    expect(result.assignment.skipped[0]?.code).toBe('plan_lane_blocked');
    expect(result.wake).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(result.warning).toMatch(/remain unassigned.*not woken/i);
  });

  it('replays an already-held runnable item without re-claiming, then wakes once', async () => {
    const claim = vi.fn();
    const wake = vi.fn(async (owners: readonly string[]) => ({
      targets: [...owners],
      keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
      queued: 1,
      woken: 1,
      pickupConfirmed: false,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    }));
    const d = deps({
      claim,
      wake,
      observe: vi.fn(async (id) => ({
        item: workItem(id, 'wip', 'agent-email-stable'),
        available: false,
        claimedBy: 'agent-email-stable',
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-RUNNING'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(result.assignment.retained).toEqual(['WI-RUNNING']);
    expect(result.assignment.executionWorkItemIds).toEqual(['WI-RUNNING']);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('keeps a landed assignment recoverable and fails loudly when the stable target is dead', async () => {
    const d = deps({
      resolveTarget: vi.fn(async ({ targetAgent }) =>
        target(targetAgent, { sessionState: 'ended', wakeable: false }),
      ),
      wake: vi.fn(async (owners: readonly string[]) => ({
        targets: [...owners],
        keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
        queued: 0,
        woken: 0,
        pickupConfirmed: false,
        staged: 0,
        stagedTargets: [],
        fanoutCapped: [],
        timedOutTargets: [],
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-READY'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.assignment.assigned).toEqual(['WI-READY']);
    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({
      code: 'target_dead',
      target: 'agent-email-stable',
      recoverable: true,
      queuePreserved: true,
    });
    expect(result.warning).toMatch(/must be relaunched/i);
  });

  it('trusts an authoritative queued wake when the best-effort presence read missed the target', async () => {
    const d = deps({
      resolveTarget: vi.fn(async ({ targetAgent }) =>
        target(targetAgent, { present: false, sessionState: null, wakeable: null }),
      ),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-READY'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.assignment.assigned).toEqual(['WI-READY']);
    expect(result.wake?.queued).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });
});
