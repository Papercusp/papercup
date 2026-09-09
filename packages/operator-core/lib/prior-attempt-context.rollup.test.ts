import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainmentTree } from './containment-tree';
import type { WorkItem } from './work-items';
import type { GoalHistoryEntry, GoalHistoryRead } from '@papercusp/agent-mcp/goal-history';

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
  buildBoundedPriorAttemptBrief,
  collectPriorAttempts,
  compilePriorAttempts,
  getContainmentRollupBrief,
  readGoalHistoryContext,
  readPlanHistoryContext,
  resolvePriorAttemptRefs,
} from './prior-attempt-context';

describe('current authority scenario matrix', () => {
  it('serializes current spec, decision, correction, completion and ownership before stale carry', () => {
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        {
          scope: 'goal-wide',
          authority: 'checkpoint',
          rawRef: 'goal-history#stale-carry',
          text: 'STALE CARRY: use the obsolete stop condition and prior owner.',
        },
        {
          scope: 'goal-wide',
          authority: 'lifecycle',
          rawRef: 'WI-1#lifecycle:ownership',
          text: 'CURRENT OWNERSHIP: transferred to su-current.',
        },
        {
          scope: 'goal-wide',
          authority: 'verified-completion',
          rawRef: 'WI-1#completion',
          text: 'CURRENT COMPLETION: the obsolete attempt is finished.',
        },
        {
          scope: 'goal-wide',
          authority: 'retraction',
          rawRef: 'goal:goal-history#comment:correction',
          text: 'CORRECTION: retract the obsolete premise.',
        },
        {
          scope: 'plan-wide',
          authority: 'plan-decision',
          rawRef: 'plan-history#D-002',
          text: 'CURRENT DECISION: preserve the corrected route.',
        },
        {
          scope: 'same-spec',
          authority: 'current-spec',
          rawRef: 'plan-history#SPEC-001@2',
          text: 'CURRENT SPEC: stale carry never overrides canonical state.',
        },
      ]),
    );
    expect(brief).not.toBeNull();
    const serialized = JSON.stringify(brief);
    const assertCurrentBeforeCarry = (output: string) => {
      const stale = output.indexOf('STALE CARRY');
      expect(stale).toBeGreaterThanOrEqual(0);
      for (const current of [
        'CURRENT SPEC',
        'CURRENT DECISION',
        'CORRECTION',
        'CURRENT COMPLETION',
        'CURRENT OWNERSHIP',
      ]) {
        expect(output.indexOf(current), current).toBeGreaterThanOrEqual(0);
        expect(output.indexOf(current), current).toBeLessThan(stale);
      }
    };
    assertCurrentBeforeCarry(serialized);
    // Permanent negative control: the same oracle must reject a final sink
    // that prepends stale carry ahead of every current authority record.
    expect(() => assertCurrentBeforeCarry(`STALE CARRY precedes authority\n${serialized}`)).toThrow();
  });
});

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
    goalHistory: vi.fn(
      async (_input: { workspaceId: string; goalId: string; limit?: number }): Promise<GoalHistoryRead> => ({
        entries: [],
        truncated: false,
        limit: 100,
        omittedEntryIds: [],
        omittedEntryIdsTruncated: false,
      }),
    ),
    goalHistoryByIds: vi.fn(
      async (_input: {
        workspaceId: string;
        goalId: string;
        ids: readonly string[];
      }): Promise<GoalHistoryEntry[]> => [],
    ),
  };
}
beforeEach(() => {
  reads.tree.mockReset().mockResolvedValue(tree());
  reads.thread.mockReset().mockResolvedValue([
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
  it.each(['plan', 'goal', 'child-plan'] as const)('keeps failed %s learned-history reads unknown and recovers through the same reader', async (kind) => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    if (kind !== 'plan') {
      reads.tree.mockResolvedValue({
        ...tree(0),
        root: { ...goalTarget, depth: 0 },
        descendants: kind === 'child-plan'
          ? [{ kind: 'plan', ref: 'plan-child', harness: 'papercusp', depth: 1 }]
          : [],
      });
    } else reads.tree.mockResolvedValue(tree(0));
    const deps = dependencies();
    const failedRef = kind === 'plan' ? target.ref : kind === 'goal' ? goalTarget.ref : 'plan-child';
    reads.thread.mockImplementation(async (ref: { ref: string }) => {
      if (ref.ref === failedRef) throw new Error('stored effort history unavailable');
      return [];
    });
    const read = () => kind === 'plan'
      ? readPlanHistoryContext(target.ref, target.harness, opts => getContainmentRollupBrief(opts, deps as never))
      : readGoalHistoryContext(goalTarget.ref, opts => getContainmentRollupBrief(opts, deps as never));
    const failed = await read();
    expect(failed.status).toBe('unknown');
    expect(failed.brief?.degradedSources).toContain(
      kind === 'child-plan' ? 'plan-thread:plan-child' : `${kind}-thread`,
    );
    expect(failed.recovery).toEqual(kind === 'plan'
      ? { tool: 'plans:get', args: { slug: target.ref, harness: target.harness, heading: 'History' } }
      : { tool: 'goals:get', args: { id: goalTarget.ref, detail: 'full' } });

    reads.thread.mockResolvedValue([{
      id: 'recovered-note',
      body: 'False premise: history was empty. Root cause: the thread read failed. Residue: verify the next depth.',
      created_ts: '2026-09-07T00:00:00Z',
      author_id: 'su-test',
    }]);
    const recovered = await read();
    expect(recovered.status).toBe('available');
    expect(recovered.brief?.degradedSources).toEqual([]);
    expect(JSON.stringify(recovered)).toContain('history was empty');
    expect(JSON.stringify(recovered)).toContain(`#comment:recovered-note`);
    expect(recovered.recovery).toEqual(failed.recovery);
  });

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

describe('goal history production projection', () => {
  it('delivers goal-owned audit history plus bounded plan/item descendants with goal recovery', async () => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    reads.tree.mockResolvedValue({
      root: { ...goalTarget, depth: 0 },
      ancestors: [],
      descendants: [
        { kind: 'plan', ref: 'plan-child', harness: 'papercusp', depth: 1 },
        { kind: 'work_item', ref: 'WI-1', harness: 'papercusp', depth: 2 },
      ],
      omittedDescendants: [{ kind: 'work_item', ref: 'WI-25', harness: 'papercusp' }],
      omittedDescendantsTruncated: false,
      fanOut: { admitted: 2, total: 25, cap: 24, truncated: true },
      descended: true,
    });
    const deps = dependencies();
    deps.goalHistory.mockResolvedValue({
      entries: [
        {
          id: 'goal-history-1',
          kind: 'amendment',
          author: 'su-goal',
          at: '2026-09-07T00:00:00Z',
          reason: 'new evidence corrected the stop condition',
          reasonSource: 'caller',
          changes: [{ field: 'killCriterion', before: 'old', after: 'current' }],
        },
      ],
      truncated: false,
      limit: 100,
      omittedEntryIds: [],
      omittedEntryIdsTruncated: false,
    });

    const history = await readGoalHistoryContext(goalTarget.ref, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    expect(serialized).toContain('new evidence corrected the stop condition');
    expect(serialized).toContain('Keep the current correction');
    expect(serialized).toContain('preserve the plan lesson');
    expect(serialized).toContain('WI-1 repaired the original defect');
    expect(history.brief?.fanOut).toMatchObject({ total: 25, truncated: true });
    expect(reads.tree).toHaveBeenCalledWith(
      goalTarget,
      expect.objectContaining({ direction: 'down', maxDescendants: 24 }),
    );
    expect(history.recovery).toEqual({ tool: 'goals:get', args: { id: goalTarget.ref, detail: 'full' } });
  });

  it('discloses and recovers goal-history rows beyond the 25-row inline collector page', async () => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    reads.tree.mockResolvedValue({
      root: { ...goalTarget, depth: 0 },
      ancestors: [],
      descendants: [],
      omittedDescendants: [],
      omittedDescendantsTruncated: false,
      fanOut: { admitted: 0, total: 0, cap: 24, truncated: false },
      descended: true,
    });
    const entries = Array.from(
      { length: 27 },
      (_, i): GoalHistoryEntry => ({
        id: `goal-row-${i + 1}`,
        kind: 'evidence',
        author: 'su-goal',
        at: new Date(Date.UTC(2026, 8, 7, 0, 0, 27 - i)).toISOString(),
        summary: `goal evidence ${i + 1}`,
      }),
    );
    const deps = dependencies();
    deps.goalHistory.mockImplementation(async ({ limit = 25 }: { limit?: number }) => ({
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
      limit,
      omittedEntryIds: entries.slice(limit).map((entry) => entry.id),
      omittedEntryIdsTruncated: false,
    }));
    deps.goalHistoryByIds.mockImplementation(async ({ ids }: { ids: readonly string[] }) =>
      entries.filter((entry) => ids.includes(entry.id)),
    );

    const history = await readGoalHistoryContext(goalTarget.ref, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    expect(history.brief?.goalHistory).toMatchObject({
      admitted: 25,
      limit: 25,
      truncated: true,
      omittedRecordsLowerBound: 2,
      omittedRefsTruncated: false,
    });
    expect(history.brief?.omission.omittedRefs.map((entry) => entry.rawRef)).toEqual(
      expect.arrayContaining(['goal:goal-history#history:goal-row-26', 'goal:goal-history#history:goal-row-27']),
    );

    const recovered = await resolvePriorAttemptRefs(
      {
        target: goalTarget,
        rawRefs: ['goal:goal-history#history:goal-row-20', 'goal:goal-history#history:goal-row-27'],
      },
      deps as never,
    );
    expect(recovered?.records.map((record) => record.rawRef)).toEqual([
      'goal:goal-history#history:goal-row-20',
      'goal:goal-history#history:goal-row-27',
    ]);
    expect(recovered?.unresolved).toEqual([]);
  });
});
