import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainmentTree } from './containment-tree';
import type { WorkItem } from './work-items';

const reads = vi.hoisted(() => ({ tree: vi.fn(), thread: vi.fn() }));
vi.mock('./containment-tree', async (original) => ({
  ...(await original<typeof import('./containment-tree')>()),
  resolveContainmentTree: reads.tree,
}));
vi.mock('./effort-thread', async (original) => ({
  ...(await original<typeof import('./effort-thread')>()),
  readEffortThread: reads.thread,
}));

import {
  collectPriorAttempts,
  getContainmentRollupBrief,
  readPlanHistoryContext,
  resolvePriorAttemptRefs,
} from './prior-attempt-context';

const target = { kind: 'plan' as const, ref: 'plan-history', harness: 'papercusp' };
function tree(count = 2): ContainmentTree {
  return {
    root: { ...target, depth: 0 },
    ancestors: [],
    descendants: Array.from({ length: count }, (_, i) => ({
      kind: 'work_item' as const,
      ref: `WI-${i + 1}`,
      harness: 'papercusp',
      depth: 1,
    })),
    omittedDescendants: [],
    omittedDescendantsTruncated: false,
    fanOut: { admitted: count, total: count, cap: 24, truncated: false },
    descended: true,
  };
}
function dependencies() {
  return {
    getPlan: vi.fn(async () => ({
      content:
        '## Decisions\n\n### D-001 — Keep the current correction\nDate: 2026-09-07\nDo not repeat the obsolete approach.',
    })),
    specs: vi.fn(async () => []),
    edges: vi.fn(async () => []),
    evidence: vi.fn(async () => []),
    item: vi.fn(
      async (id: string) =>
        ({
          id,
          family: 'feature',
          harness: 'papercusp',
          payload: {},
          sourcePlanSlug: 'plan-history',
          sourcePlanItemIds: [],
          updatedAt: '2026-09-07T00:00:00Z',
        }) as unknown as WorkItem,
    ),
    items: vi.fn(async () => [{ id: 'WI-unrelated' } as WorkItem]),
    checkpoint: vi.fn(async ({ workItemId }: { workItemId: string }) => ({
      checkpoint: `Outcome: ${workItemId} repaired the original defect. Root cause: cursor advanced before delivery. Residue: verify shipment.`,
      updatedAtMs: Date.parse('2026-09-07T00:00:00Z'),
    })),
    thread: vi.fn(async () => null),
    lifecycle: vi.fn(async () => null),
    priorWork: vi.fn(async () => null),
  };
}
beforeEach(() => {
  reads.tree.mockReset().mockResolvedValue(tree());
  reads.thread
    .mockReset()
    .mockResolvedValue([
      {
        id: 'own-1',
        body: 'Outcome: preserve the plan lesson.',
        created_ts: '2026-09-07T00:00:00Z',
        author_id: 'su-test',
      },
    ]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('plan history production projection', () => {
  it('delivers the plan and child lessons from one bounded tree read', async () => {
    const deps = dependencies();
    const history = await readPlanHistoryContext(target.ref, target.harness, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    expect(serialized).toContain('preserve the plan lesson');
    expect(serialized).toContain('WI-1 repaired the original defect');
    expect(serialized).toContain('cursor advanced before delivery');
    expect(serialized).toContain('verify shipment');
    expect(serialized).not.toContain('WI-unrelated');
    expect(reads.tree).toHaveBeenCalledTimes(1);
    expect(reads.tree).toHaveBeenCalledWith(target, expect.objectContaining({ direction: 'down', maxDescendants: 24 }));
    expect(deps.items).not.toHaveBeenCalled();
    expect(deps.thread).not.toHaveBeenCalled();
    expect(deps.checkpoint).toHaveBeenCalledTimes(2);
    expect(history.recovery).toEqual({
      tool: 'plans:get',
      args: { slug: target.ref, harness: target.harness, heading: 'History' },
    });
  });

  it('distinguishes successful empty history from unreadable relationships and sources', async () => {
    const deps = dependencies();
    deps.getPlan.mockResolvedValue({ content: '## Now\nNo prior attempts.' });
    reads.tree.mockResolvedValue(tree(0));
    reads.thread.mockResolvedValue([]);
    const empty = await getContainmentRollupBrief({ target }, deps as never);
    expect(empty?.status).toBe('empty');
    reads.tree.mockResolvedValue({ ...tree(0), unavailable: 'read-failed' });
    expect((await getContainmentRollupBrief({ target }, deps as never))?.status).toBe('unknown');
    reads.tree.mockResolvedValue(tree(0));
    deps.getPlan.mockRejectedValue(new Error('plan unavailable'));
    const failed = await getContainmentRollupBrief({ target }, deps as never);
    expect(failed?.status).toBe('unknown');
    expect(failed?.degradedSources).toContain('plan');
  });

  it('includes containment resolution inside the deadline and clears the timer', async () => {
    vi.useFakeTimers();
    reads.tree.mockImplementation(() => new Promise(() => {}));
    const pending = getContainmentRollupBrief({ target, timeoutMs: 100 }, dependencies() as never);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a large history and recovers a child record at full resolution', async () => {
    const deps = dependencies();
    reads.tree.mockResolvedValue({
      ...tree(24),
      fanOut: { admitted: 24, total: 100, cap: 24, truncated: true },
      omittedDescendants: [{ kind: 'work_item', ref: 'WI-25', harness: 'papercusp' }],
    });
    deps.checkpoint.mockImplementation(async ({ workItemId }) => ({
      checkpoint: `Outcome: ${workItemId} fixed. Root cause: ${'long cause '.repeat(200)}. Residue: final retained obligation.`,
      updatedAtMs: 1,
    }));
    const brief = await getContainmentRollupBrief(
      { target, budget: { maxChars: 6000, maxTextChars: 100 } },
      deps as never,
    );
    expect(JSON.stringify(brief).length).toBeLessThan(8000);
    expect(brief?.omission.truncated).toBe(true);
    expect(brief?.fanOut.truncated).toBe(true);
    const recovered = await resolvePriorAttemptRefs(
      { target, harness: 'papercusp', rawRefs: ['WI-1#checkpoint', 'WI-unrelated#checkpoint'] },
      deps as never,
    );
    expect(recovered?.records[0]?.text).toContain('final retained obligation');
    expect(recovered?.records[0]?.text.length).toBeGreaterThan(2000);
    expect(recovered?.unresolved).toEqual(['WI-unrelated#checkpoint']);
  });

  it('keeps ordinary member history ancestor-only', async () => {
    const deps = dependencies();
    reads.tree.mockResolvedValue({ ...tree(0), root: { kind: 'work_item', ref: 'WI-1', depth: 0 }, descended: false });
    await collectPriorAttempts({ workItemId: 'WI-1', harnessSlug: 'papercusp' }, deps as never);
    expect(reads.tree).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'work_item' }),
      expect.objectContaining({ direction: 'up' }),
    );
    expect(deps.checkpoint).toHaveBeenCalledTimes(1);
  });
});
