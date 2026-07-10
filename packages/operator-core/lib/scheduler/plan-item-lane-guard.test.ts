/**
 * plan-item-lane-guard.test.ts — pins planItemLaneBlockReason (WI-3667): a
 * plan-linked work-item whose linked PLAN ITEM is effectively blocked (stored
 * 'blocked' token, an unresolved blocked-by dep, or a needs-human derivation)
 * must be reported as blocked; anything else (no plan_item payload, plan/item
 * not found, a lookup throw) must fail OPEN (null) — the guard is a courtesy,
 * never a hard floor that can wedge the shared claim path.
 *
 * getPlanRow + the plan-parser resolver are mocked so this is a pure unit test
 * (no PG). Run: cd packages/operator-core && npx vitest run lib/scheduler/plan-item-lane-guard.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getPlanRowMock = vi.fn();
const planItemsForRowMock = vi.fn((row: unknown) => (row as { items: unknown[] }).items);

vi.mock('../agent-tools/plans/source', () => ({
  getPlanRow: (...args: unknown[]) => getPlanRowMock(...args),
  planItemsForRow: (...args: unknown[]) => planItemsForRowMock(...args),
}));

// Use the REAL resolver — resolveEffectiveStatusForItems is pure and cheap, and
// exercising it end-to-end is the point (the blocked-by graph logic itself is
// pinned by plan-parser's own tests; we only need it wired correctly here).
vi.mock('@papercusp/plan-parser', async (orig) => orig<typeof import('@papercusp/plan-parser')>());

import { planItemLaneBlockReason } from './plan-item-lane-guard';

function planItem(overrides: Partial<{ id: string; storedStatus: string; blockedBy: string[] }> = {}) {
  return {
    id: 'P-001',
    text: 'an item',
    storedStatus: 'todo',
    importance: 'normal',
    blockedBy: [],
    decisionRefs: [],
    phase: null,
    ...overrides,
  };
}

describe('planItemLaneBlockReason', () => {
  beforeEach(() => {
    getPlanRowMock.mockReset();
    planItemsForRowMock.mockReset();
    planItemsForRowMock.mockImplementation((row: unknown) => (row as { items: unknown[] }).items);
  });

  it('returns null when the work-item carries no plan_item payload', async () => {
    const got = await planItemLaneBlockReason({ payload: {}, harness: 'papercusp' });
    expect(got).toBeNull();
    expect(getPlanRowMock).not.toHaveBeenCalled();
  });

  it('returns null when payload is not an object / plan_item is malformed', async () => {
    expect(await planItemLaneBlockReason({ payload: null, harness: 'papercusp' })).toBeNull();
    expect(
      await planItemLaneBlockReason({ payload: { plan_item: { plan_slug: 'p' } }, harness: 'papercusp' }),
    ).toBeNull();
  });

  it('returns null when the linked plan cannot be found (fail open)', async () => {
    getPlanRowMock.mockResolvedValue(null);
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'missing-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });

  it('returns null when the plan exists but the item id is not found (fail open)', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-002' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });

  it('reports blocked for an item carrying the stored blocked token', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-503', storedStatus: 'blocked' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-503' } },
      harness: 'papercusp',
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.planSlug).toBe('p2p-git-live-activation-2026-07-09');
    expect(got?.itemId).toBe('P-503');
    expect(got?.reason).toMatch(/effectively blocked/);
  });

  it('reports blocked for an item blocked-by an unresolved dependency', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-001', storedStatus: 'todo' }), // the unresolved blocker
        planItem({ id: 'P-002', storedStatus: 'todo', blockedBy: ['P-001'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
      harness: 'papercusp',
    });
    expect(got?.reason).toMatch(/blocked-by: P-001/);
  });

  it('returns null once the blocker resolves (done)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-001', storedStatus: 'done' }),
        planItem({ id: 'P-002', storedStatus: 'todo', blockedBy: ['P-001'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });

  it('reports needs-human for an item carrying the stored needs-human token', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-009', storedStatus: 'needs-human' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-009' } },
      harness: 'papercusp',
    });
    expect(got?.reason).toMatch(/needs a human decision/);
  });

  it('fails open when the plan lookup throws', async () => {
    getPlanRowMock.mockRejectedValue(new Error('pg unavailable'));
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });

  it('returns null for a clear (todo, unblocked) item', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'todo' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });
});
