/**
 * work_items:get — planItemClaimCollision field (P-006, agent-trap-guards-2026-07-26).
 *
 * "Holding the linked work-item is not holding the plan item" — pins get.ts's
 * wiring only. `planItemClaimCollision` itself is unit-pinned separately in
 * scheduler/plan-item-claim-collision.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const getWorkItemCheckpointWithMeta = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
}));

const getPresence = vi.fn();
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));

const planItemLaneBlockReason = vi.fn();
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...a: unknown[]) => planItemLaneBlockReason(...a),
}));

const planItemClaimCollision = vi.fn();
vi.mock('../../scheduler/plan-item-claim-collision', () => ({
  planItemClaimCollision: (...a: unknown[]) => planItemClaimCollision(...a),
}));

import get from './get';

const ctx = { uiClientId: 'su-tester', workspaceId: 'default' } as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const env = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
const one = async (x: unknown) => (await env(x)).results[0];

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'F-100',
  harness: 'papercup',
  kind: 'feature',
  family: 'feature',
  title: 'plan-linked feature',
  state: 'wip',
  assignee: 'su-A',
  payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-9' } },
  ...overrides,
});

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  getPresence.mockReset().mockResolvedValue(null);
  planItemLaneBlockReason.mockReset().mockResolvedValue(null);
  planItemClaimCollision.mockReset().mockResolvedValue(null);
});

describe('work_items:get — planItemClaimCollision field (P-006)', () => {
  it('surfaces planItemClaimCollision when the linked plan item is now held by someone else', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    planItemClaimCollision.mockResolvedValue({
      planSlug: 'a-plan',
      itemId: 'P-9',
      claimedBy: 'su-B',
      claimedByLabel: 'su · B',
      note: "plan item a-plan#P-9 — which this work-item implements — is now held by a LIVE claim from su · B, not this work-item's assignee.",
    });
    const r = await one({ id: 'F-100' });
    expect(planItemClaimCollision).toHaveBeenCalledWith(expect.objectContaining({ id: 'F-100' }));
    expect(r).toMatchObject({
      ok: true,
      id: 'F-100',
      planItemClaimCollision: { planSlug: 'a-plan', itemId: 'P-9', claimedBy: 'su-B', claimedByLabel: 'su · B' },
    });
  });

  it('omits planItemClaimCollision (not even null) when there is no divergence', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    planItemClaimCollision.mockResolvedValue(null);
    const r = await one({ id: 'F-100' });
    expect(r).toMatchObject({ ok: true, id: 'F-100' });
    expect(r.planItemClaimCollision).toBeUndefined();
  });

  it('fail-soft: a collision-lookup error never fails the work_items:get read', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    planItemClaimCollision.mockRejectedValue(new Error('plan_item_claims pg down'));
    const r = await one({ id: 'F-100' });
    expect(r).toMatchObject({ ok: true, id: 'F-100' });
    expect(r.planItemClaimCollision).toBeUndefined();
  });

  it('surfaces on the detail path (args.detail:true) too', async () => {
    getWorkItemDetail.mockResolvedValue({ ...baseItem(), topics: [], posts: [], links: [] });
    planItemClaimCollision.mockResolvedValue({
      planSlug: 'a-plan',
      itemId: 'P-9',
      claimedBy: 'su-B',
      claimedByLabel: null,
      note: 'collision',
    });
    const r = await one({ id: 'F-100', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r.planItemClaimCollision).toMatchObject({ planSlug: 'a-plan', itemId: 'P-9', claimedBy: 'su-B' });
  });

  it('never consults the collision check for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(planItemClaimCollision).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});
