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

  // EI-9108: regression, mirroring the REAL 2026-07-10 incident shape (p2p-git-live-
  // activation-2026-07-09, P-401/WI-3503) — a 7-deep blockedBy chain
  // (P-401→P-308→{P-302..P-307}→P-301→{P-205,P-101}→P-101→P-003), where P-003 (the true
  // root cause) is still `wip`. work_item.state alone (plain 'todo') would surface P-401
  // as scheduler-claimable; this pins that the guard correctly walks the FULL chain depth
  // (not just a direct one-hop blockedBy) and reports it blocked.
  it('reports blocked through a deep multi-level blockedBy chain (EI-9108, real P-401 shape)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-003', storedStatus: 'wip' }), // true root cause: still in-flight
        planItem({ id: 'P-101', storedStatus: 'todo', blockedBy: ['P-003'] }),
        planItem({ id: 'P-205', storedStatus: 'done' }),
        planItem({ id: 'P-301', storedStatus: 'done', blockedBy: ['P-205', 'P-101'] }),
        planItem({ id: 'P-302', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-303', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-304', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-305', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-306', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-307', storedStatus: 'done', blockedBy: ['P-301'] }),
        planItem({
          id: 'P-308',
          storedStatus: 'todo',
          blockedBy: ['P-302', 'P-303', 'P-304', 'P-305', 'P-306', 'P-307'],
        }),
        planItem({ id: 'P-401', storedStatus: 'todo', blockedBy: ['P-308'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-401' } },
      harness: 'papercusp',
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.itemId).toBe('P-401');
    // The IMMEDIATE unresolved blocker is P-308 (this level's own blockedBy) — the chain
    // walk resolves recursively, but the reported reason names the direct dependency, not
    // the transitive root (P-003). That's fine: the guard's job is "don't hand this out",
    // not "explain the whole chain" — plans:get-item/plans:items are where an agent
    // traces the full unresolvedBlockers path back to the true root cause.
    expect(got?.reason).toMatch(/blocked-by: P-308/);
  });

  // EI-9107: the TWIN incident — the same 2026-07-10 plan (p2p-git-live-activation-
  // 2026-07-09), but the item scheduler:get_next actually handed out was P-308 itself
  // (WI-3502), one level DOWN the chain from EI-9108's P-401. P-308's work_item.state was
  // plain 'todo' (rank 0, set by the mug) so the coarse SQL floors surfaced it as
  // claimable, while its plan-item is blocked-by an UNRESOLVED multi-blocker set
  // (P-302..P-306, each still todo pending P-301←P-101←P-003). This pins that the guard
  // reports P-308 blocked and names the full unresolved-blocker set — not just the deep
  // P-401 case the EI-9108 test above covers.
  it('reports blocked for P-308 with its full unresolved-blocker set (EI-9107, real WI-3502 shape)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-003', storedStatus: 'wip' }), // true root cause: still in-flight
        planItem({ id: 'P-101', storedStatus: 'todo', blockedBy: ['P-003'] }),
        planItem({ id: 'P-205', storedStatus: 'done' }),
        planItem({ id: 'P-301', storedStatus: 'done', blockedBy: ['P-205', 'P-101'] }),
        planItem({ id: 'P-302', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-303', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-304', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-305', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-306', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-307', storedStatus: 'done', blockedBy: ['P-301'] }),
        planItem({
          id: 'P-308',
          storedStatus: 'todo', // the live work-item state that made it scheduler-claimable
          blockedBy: ['P-302', 'P-303', 'P-304', 'P-305', 'P-306', 'P-307'],
        }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-308' } },
      harness: 'papercusp',
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.itemId).toBe('P-308');
    // P-307 is done, so it drops out of the unresolved set; the reason names exactly the
    // still-open blockers the incident reported (P-302..P-306).
    expect(got?.reason).toMatch(/blocked-by: P-302, P-303, P-304, P-305, P-306/);
  });
});
