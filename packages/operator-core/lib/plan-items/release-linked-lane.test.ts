/**
 * P-006 (fleet-leadership-continuity-and-actuation-2026-08-01) — releaseLinkedPlanLane.
 *
 * Releasing a work-item used to leave its plan lane still naming the departed holder, so the next
 * claimant collided with a lane it could not take. The contract has three load-bearing parts, and
 * each has a test below because getting any one wrong is worse than not shipping this at all:
 *   1. it frees the releasing owner's own lane;
 *   2. it NEVER touches a peer's lane (this must not become a way to steal a claim);
 *   3. it fails OPEN — the voluntary release tool, the SessionEnd force-release and the
 *      stale-claim reaper all route through the caller, so a claims-store hiccup must not
 *      wedge any of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePlanItemStamp = vi.fn();
vi.mock('../scheduler/plan-item-lane-guard', () => ({
  resolvePlanItemStamp: (...a: unknown[]) => resolvePlanItemStamp(...a),
}));

const getClaim = vi.fn();
const releaseClaim = vi.fn();
vi.mock('./claims', () => ({
  getClaim: (...a: unknown[]) => getClaim(...a),
  releaseClaim: (...a: unknown[]) => releaseClaim(...a),
}));

vi.mock('../agent-tools/plans/source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-1', harnessSlug: 'papercup' })),
}));

const { releaseLinkedPlanLane } = await import('./release-linked-lane');

const ITEM = { id: 'F-100', harness: 'papercup', payload: {} } as never;
const liveClaim = (owner: string) => ({ owner, claimId: 'c-1', expired: false, ownerLabel: null });

beforeEach(() => {
  vi.clearAllMocks();
  resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-9'] });
  getClaim.mockResolvedValue(liveClaim('su-A'));
  releaseClaim.mockResolvedValue(true);
});

describe('releaseLinkedPlanLane (P-006)', () => {
  it('frees the releasing owner\'s own lane claim', async () => {
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(r).toEqual({ planSlug: 'a-plan', released: ['P-9'], failed: [] });
    expect(releaseClaim).toHaveBeenCalledWith('ws-1', 'papercup', 'a-plan', 'P-9', 'c-1', 'su-A');
  });

  it('NEVER touches a lane held by a PEER — that is their live work', async () => {
    getClaim.mockResolvedValue(liveClaim('su-OTHER'));
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it('skips an already-expired claim (nothing to free)', async () => {
    getClaim.mockResolvedValue({ ...liveClaim('su-A'), expired: true });
    expect(await releaseLinkedPlanLane(ITEM, 'su-A')).toBeNull();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('is a no-op when the work-item has no plan linkage', async () => {
    resolvePlanItemStamp.mockResolvedValue(null);
    expect(await releaseLinkedPlanLane(ITEM, 'su-A')).toBeNull();
    expect(getClaim).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no releasing owner', async () => {
    expect(await releaseLinkedPlanLane(ITEM, null)).toBeNull();
    expect(resolvePlanItemStamp).not.toHaveBeenCalled();
  });

  it('reports a lane it could not free as `failed` rather than claiming success', async () => {
    releaseClaim.mockResolvedValue(false);
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(r).toEqual({ planSlug: 'a-plan', released: [], failed: ['P-9'] });
  });

  it('fails OPEN on a claims-store error — a release must never be wedged by it', async () => {
    getClaim.mockRejectedValue(new Error('plan_item_claims pg down'));
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(r).toEqual({ planSlug: 'a-plan', released: [], failed: ['P-9'] });
  });

  it('one bad lane does not abandon the others', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-1', 'P-2'] });
    getClaim
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(liveClaim('su-A'));
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(r).toMatchObject({ released: ['P-2'], failed: ['P-1'] });
  });

  it('releases EVERY lane the owner holds on a multi-item stamp', async () => {
    resolvePlanItemStamp.mockResolvedValue({ plan_slug: 'a-plan', item_ids: ['P-1', 'P-2'] });
    const r = await releaseLinkedPlanLane(ITEM, 'su-A');
    expect(r).toMatchObject({ released: ['P-1', 'P-2'], failed: [] });
    expect(releaseClaim).toHaveBeenCalledTimes(2);
  });
});
