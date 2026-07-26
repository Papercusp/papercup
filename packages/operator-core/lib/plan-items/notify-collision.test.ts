/**
 * notifyImplementingWorkItemHolderOfCollision — P-006 (agent-trap-guards-2026-07-26).
 *
 * Unit-pins the wiring only (dynamic-import seams mocked): when a plan item is
 * claimed and it has an implementing work-item whose assignee differs from the
 * new claimant, the assignee is notified via sendMessage; every other case is a
 * silent no-op, and a lookup/send failure never throws (best-effort).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findImplementingWorkItem = vi.fn();
vi.mock('./convert', () => ({
  findImplementingWorkItem: (...a: unknown[]) => findImplementingWorkItem(...a),
  TERMINAL_WORK_ITEM_STATES: new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']),
}));

const sendMessage = vi.fn();
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

import { notifyImplementingWorkItemHolderOfCollision } from './liveness';
import type { ClaimPlanItemOpts } from './liveness';

const baseOpts: ClaimPlanItemOpts = {
  workspaceId: 'default',
  harnessSlug: 'papercup',
  planSlug: 'a-plan',
  itemId: 'P-9',
  owner: 'su-B',
  ownerLabel: 'su · B',
  ownerName: null,
  ownerUser: 'gh-1',
};

beforeEach(() => {
  findImplementingWorkItem.mockReset();
  sendMessage.mockReset().mockResolvedValue(undefined);
});

describe('notifyImplementingWorkItemHolderOfCollision (P-006)', () => {
  it('notifies the implementing work-item\'s assignee when a DIFFERENT agent claims the plan item', async () => {
    findImplementingWorkItem.mockResolvedValue({ id: 'WI-100', assignee: 'su-A', state: 'wip' });
    await notifyImplementingWorkItemHolderOfCollision(baseOpts);
    expect(findImplementingWorkItem).toHaveBeenCalledWith('a-plan', 'P-9');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendMessage.mock.calls[0];
    expect(opts.to).toEqual(['su-A']);
    expect(opts.category).toBe('plan-item-claim-collision');
    expect(opts.summary).toMatch(/WI-100/);
    expect(opts.summary).toMatch(/su · B/);
    expect(opts.extra).toMatchObject({
      plan_slug: 'a-plan',
      item_id: 'P-9',
      work_item_id: 'WI-100',
      claimed_by: 'su-B',
    });
  });

  it('does NOT notify when there is no implementing work-item (unconverted item — the common case)', async () => {
    findImplementingWorkItem.mockResolvedValue(null);
    await notifyImplementingWorkItemHolderOfCollision(baseOpts);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT notify when the implementing work-item has no assignee', async () => {
    findImplementingWorkItem.mockResolvedValue({ id: 'WI-100', assignee: null, state: 'open' });
    await notifyImplementingWorkItemHolderOfCollision(baseOpts);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT notify when the work-item\'s assignee IS the new claimant (no collision, reclaiming their own)', async () => {
    findImplementingWorkItem.mockResolvedValue({ id: 'WI-100', assignee: 'su-B', state: 'wip' });
    await notifyImplementingWorkItemHolderOfCollision(baseOpts);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT notify when the implementing work-item is already TERMINAL (no one is executing it)', async () => {
    findImplementingWorkItem.mockResolvedValue({ id: 'WI-100', assignee: 'su-A', state: 'done' });
    await notifyImplementingWorkItemHolderOfCollision(baseOpts);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is best-effort: a lookup failure never throws', async () => {
    findImplementingWorkItem.mockRejectedValue(new Error('coord_links pg down'));
    await expect(notifyImplementingWorkItemHolderOfCollision(baseOpts)).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is best-effort: a send failure never throws', async () => {
    findImplementingWorkItem.mockResolvedValue({ id: 'WI-100', assignee: 'su-A', state: 'wip' });
    sendMessage.mockRejectedValue(new Error('coord outbox down'));
    await expect(notifyImplementingWorkItemHolderOfCollision(baseOpts)).resolves.toBeUndefined();
  });
});
