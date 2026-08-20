/**
 * work_items:get — planItemBlocked field (EI-13715).
 *
 * Blockedness has TWO sources of truth for a plan-linked work-item: this item's
 * own `state` column, and its linked plan-item's `effectiveStatus`
 * (payload.plan_item back-pointer; scheduler/plan-item-lane-guard.ts — the SAME
 * check work_items:observe / claim_next / scheduler:get_next already enforce at
 * claim time). Previously `work_items:get` gave no hint the plan gate existed at
 * all (`externalBlockers: null` read as "blocked, reason unrecorded"), so a
 * reader unblocked a live plan-supervised gate believing there was nothing left
 * to check (WI-3503 incident). These pin the wiring/shape of the fix: the field
 * is present only when the linked plan lane is still effectively blocked, absent
 * for a clear lane or an item with no plan-item back-pointer, and the read never
 * fails just because the plan-lane lookup does.
 *
 * `planItemLaneBlockReason` itself is unit-pinned separately in
 * scheduler/plan-item-lane-guard.test.ts; here we only pin get.ts's wiring.
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
  state: 'blocked',
  payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-9' } },
  ...overrides,
});

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  getPresence.mockReset().mockResolvedValue(null);
  planItemLaneBlockReason.mockReset().mockResolvedValue(null);
});

describe('work_items:get — planItemBlocked field (EI-13715)', () => {
  it('starts independent enrichment reads concurrently (EI-20220772039692003)', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    let releaseCheckpoint!: (value: { checkpoint: null; updatedAtMs: null }) => void;
    getWorkItemCheckpointWithMeta.mockImplementation(
      () => new Promise((resolve) => { releaseCheckpoint = resolve; }),
    );

    const pending = one({ id: 'F-100' });
    await vi.waitFor(() => expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledOnce());

    // The plan lookup must begin while the checkpoint read is still pending. A
    // serial handler waits here and fails this assertion, recreating the additive
    // pool-queue latency that pushed staging reads past the client deadline.
    expect(planItemLaneBlockReason).toHaveBeenCalledOnce();
    releaseCheckpoint({ checkpoint: null, updatedAtMs: null });
    await expect(pending).resolves.toMatchObject({ ok: true, id: 'F-100' });
  });

  it('surfaces planItemBlocked when the linked plan-item lane is still effectively blocked', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'plan-item a-plan#P-9 is effectively blocked (blocked-by: P-8)',
      planSlug: 'a-plan',
      itemId: 'P-9',
      effectiveStatus: 'blocked',
    });
    const r = await one({ id: 'F-100' });
    expect(planItemLaneBlockReason).toHaveBeenCalledWith(expect.objectContaining({ id: 'F-100' }));
    expect(r).toMatchObject({
      ok: true,
      id: 'F-100',
      planItemBlocked: { planSlug: 'a-plan', itemId: 'P-9', effectiveStatus: 'blocked' },
    });
  });

  it('omits planItemBlocked (not even null) for a plan-linked item with a CLEAR lane', async () => {
    getWorkItem.mockResolvedValue(baseItem({ state: 'todo' }));
    planItemLaneBlockReason.mockResolvedValue(null);
    const r = await one({ id: 'F-100' });
    expect(r).toMatchObject({ ok: true, id: 'F-100' });
    expect(r.planItemBlocked).toBeUndefined();
  });

  it('omits planItemBlocked for an item with no plan-item back-pointer (never calls the guard uselessly is up to the guard; get.ts always asks)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', payload: {} });
    planItemLaneBlockReason.mockResolvedValue(null);
    const r = await one({ id: 'WI-1' });
    expect(r.planItemBlocked).toBeUndefined();
  });

  it('fail-soft: a plan-lane lookup error never fails the work_items:get read', async () => {
    getWorkItem.mockResolvedValue(baseItem());
    planItemLaneBlockReason.mockRejectedValue(new Error('plans pg down'));
    const r = await one({ id: 'F-100' });
    expect(r).toMatchObject({ ok: true, id: 'F-100' });
    expect(r.planItemBlocked).toBeUndefined();
  });

  it('surfaces on the detail path (args.detail:true) too', async () => {
    getWorkItemDetail.mockResolvedValue({ ...baseItem(), topics: [], posts: [], links: [] });
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'plan-item a-plan#P-9 needs a human decision',
      planSlug: 'a-plan',
      itemId: 'P-9',
      effectiveStatus: 'needs-human',
    });
    const r = await one({ id: 'F-100', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r.planItemBlocked).toMatchObject({ planSlug: 'a-plan', itemId: 'P-9', effectiveStatus: 'needs-human' });
  });

  it('never consults the plan-lane guard for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(planItemLaneBlockReason).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});
