/**
 * planItemClaimCollision — P-006 (agent-trap-guards-2026-07-26).
 *
 * Given a work-item, does its linked plan item now carry a LIVE claim held by
 * someone OTHER than the work-item's own assignee? The passive readback half
 * of closing "holding the linked work-item is not holding the plan item" (the
 * proactive-notify half is notifyImplementingWorkItemHolderOfCollision,
 * pinned in plan-items/notify-collision.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolvePlanItemStamp = vi.fn();
vi.mock('./plan-item-lane-guard', () => ({
  resolvePlanItemStamp: (...a: unknown[]) => resolvePlanItemStamp(...a),
}));

const getClaim = vi.fn();
vi.mock('../plan-items/claims', () => ({
  getClaim: (...a: unknown[]) => getClaim(...a),
}));

const resolvePlanScope = vi.fn();
vi.mock('../agent-tools/plans/source', () => ({
  resolvePlanScope: (...a: unknown[]) => resolvePlanScope(...a),
}));

import { planItemClaimCollision } from './plan-item-claim-collision';

const liveClaim = (owner: string, ownerLabel: string | null = null) => ({
  owner,
  ownerLabel,
  expired: false,
});
const lapsedClaim = (owner: string) => ({ owner, ownerLabel: null, expired: true });

type Item = Parameters<typeof planItemClaimCollision>[0];
const baseItem = (overrides: Partial<Item> = {}): Item => ({
  id: 'F-100',
  harness: 'papercup',
  family: 'feature',
  payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-9' } },
  assignee: 'su-A',
  ...overrides,
});

beforeEach(() => {
  resolvePlanItemStamp.mockReset();
  getClaim.mockReset();
  resolvePlanScope.mockReset().mockResolvedValue({ workspaceId: 'default', harnessSlug: 'papercup' });
});

describe('planItemClaimCollision (P-006)', () => {
  it('reports a collision when the linked plan item is LIVE-claimed by someone else', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
    getClaim.mockResolvedValue(liveClaim('su-B', 'su · B'));
    const r = await planItemClaimCollision(baseItem());
    expect(getClaim).toHaveBeenCalledWith('default', 'papercup', 'a-plan', 'P-9');
    expect(r).toMatchObject({ planSlug: 'a-plan', itemId: 'P-9', claimedBy: 'su-B', claimedByLabel: 'su · B' });
    expect(r?.note).toMatch(/a-plan#P-9/);
  });

  it('returns null when the live claim owner MATCHES the work-item assignee (no collision)', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
    getClaim.mockResolvedValue(liveClaim('su-A'));
    const r = await planItemClaimCollision(baseItem());
    expect(r).toBeNull();
  });

  it('returns null when the plan item has no claim at all', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
    getClaim.mockResolvedValue(null);
    const r = await planItemClaimCollision(baseItem());
    expect(r).toBeNull();
  });

  it('returns null when the diverging claim is EXPIRED (lapsed — not a live collision)', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
    getClaim.mockResolvedValue(lapsedClaim('su-B'));
    const r = await planItemClaimCollision(baseItem());
    expect(r).toBeNull();
  });

  it('returns null when the work-item carries no plan-item linkage', async () => {
    resolvePlanItemStamp.mockResolvedValue(null);
    const r = await planItemClaimCollision(baseItem({ payload: {} }));
    expect(getClaim).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it('returns null when the work-item is unassigned (nothing to diverge from)', async () => {
    const r = await planItemClaimCollision(baseItem({ assignee: null }));
    expect(resolvePlanItemStamp).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it('fails OPEN on a claims-store lookup error (never wedges the read)', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
    getClaim.mockRejectedValue(new Error('plan_item_claims pg down'));
    const r = await planItemClaimCollision(baseItem());
    expect(r).toBeNull();
  });

  it('checks EVERY linked item_id and reports the first live divergence', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-8', 'P-9'] });
    getClaim.mockImplementation(async (_ws: string, _h: string, _plan: string, itemId: string) =>
      itemId === 'P-8' ? liveClaim('su-A') : liveClaim('su-B'),
    );
    const r = await planItemClaimCollision(baseItem());
    expect(r).toMatchObject({ itemId: 'P-9', claimedBy: 'su-B' });
  });
});
