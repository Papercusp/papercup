/**
 * work-items-events.test.ts — settled-item event resolution, pure (injected
 * deps) (await-event-primitive-2026-06-05 P-012/P-013, D-006 #4/#5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitWorkItemSettledEvents, isSettledWorkItem, workItemIdFromRef } from './work-items-events';
import type { WorkItem } from './work-items';

const wi = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  kind: 'task',
  family: 'issue',
  harness: null,
  title: 'the work',
  summary: '',
  state: 'resolved',
  assignee: 'su-child',
  assignedBy: 'su-parent',
  severity: null,
  parent: null,
  payload: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const edge = (srcId: string, dstId: string) => ({
  src: { kind: 'issue', ref: srcId },
  dst: { kind: 'issue', ref: dstId },
  rel: 'blocks',
});

describe('helpers', () => {
  it('isSettledWorkItem matches the per-family terminal sets', () => {
    expect(isSettledWorkItem({ family: 'issue', state: 'resolved' })).toBe(true);
    expect(isSettledWorkItem({ family: 'issue', state: 'open' })).toBe(false);
    expect(isSettledWorkItem({ family: 'feature', state: 'passed' })).toBe(true);
    expect(isSettledWorkItem({ family: 'feature', state: 'validating' })).toBe(false);
  });

  it('workItemIdFromRef inverts both ref shapes', () => {
    expect(workItemIdFromRef({ kind: 'issue', ref: 'WI-9' })).toEqual({ id: 'WI-9' });
    expect(workItemIdFromRef({ kind: 'feature', ref: 'myharness#F-012' })).toEqual({ id: 'F-012', harness: 'myharness' });
    expect(workItemIdFromRef({ kind: 'topic', ref: 'x' })).toBeNull();
  });
});

describe('emitWorkItemSettledEvents', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('emits work-item:done to the delegator + parent claimant (deduped, never the item agent itself)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null }));
    const parent = wi({ id: 'WI-PARENT', assignee: 'su-grand' });
    await emitWorkItemSettledEvents(wi({ parent: 'WI-PARENT' }), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-PARENT' ? parent : null)) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = (emit.mock.calls[0] as unknown as [{ key: string; to: string[] }])[0];
    expect(arg.key).toBe('work-item:done:WI-1');
    expect(arg.to.sort()).toEqual(['su-grand', 'su-parent']);
  });

  it('fires work-item:unblocked for a dependent whose LAST blocker settled, targeted at its claimant', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listOut: vi.fn(async () => [edge('WI-1', 'WI-DEP')]) as never,
      listIn: vi.fn(async () => [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')]) as never,
    });
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-1');
    expect(keys).toContain('work-item:unblocked:WI-DEP');
    const unblocked = (emit.mock.calls.find((c) => (c as unknown as [{ key: string }])[0].key.startsWith('work-item:unblocked')) as unknown as [{ to: string[]; payload: { clearedBy: string } }])[0];
    expect(unblocked.to).toEqual(['su-claimant']);
    expect(unblocked.payload.clearedBy).toBe('WI-1');
  });

  it('does NOT fire unblocked while another blocker is still live, nor for an already-settled dependent', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    const settledDep = wi({ id: 'WI-DONE-DEP', state: 'resolved' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? liveBlocker : id === 'WI-DONE-DEP' ? settledDep : null,
      ) as never,
      listOut: vi.fn(async () => [edge('WI-1', 'WI-DEP'), edge('WI-1', 'WI-DONE-DEP')]) as never,
      listIn: vi.fn(async () => [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')]) as never,
    });
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toEqual(['work-item:done:WI-1']); // no unblocked fires
  });

  it('an emit failure is swallowed (a state write must never break)', async () => {
    await expect(
      emitWorkItemSettledEvents(wi(), {
        emit: vi.fn(async () => {
          throw new Error('engine down');
        }) as never,
        getItem: vi.fn(async () => null) as never,
        listOut: vi.fn(async () => []) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBeUndefined();
  });
});

type EmitOpts = import('./events/await/engine').EmitAwaitedEventOpts;
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null }));

describe('emitWorkItemClaimedEvent', () => {
  it('fires work-item:claimed:<id> with the assignee in payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    emitWorkItemClaimedEvent(wi({ id: 'WI-7', title: 'claim me' }), 'su-claimant', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:claimed:WI-7',
      source: 'work-items',
      payload: expect.objectContaining({ id: 'WI-7', assignee: 'su-claimant' }),
    });
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw new Error('pg down'); });
    expect(() => emitWorkItemClaimedEvent(wi(), 'su-x', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claimed-event'));
    warn.mockRestore();
  });
});

describe('emitWorkItemBlockedEvent', () => {
  it('fires work-item:blocked:<id> notifying the delegator', async () => {
    const emit = typedEmit();
    const { emitWorkItemBlockedEvent } = await import('./work-items-events');
    emitWorkItemBlockedEvent(wi({ id: 'WI-8', state: 'blocked' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:blocked:WI-8',
      to: ['su-parent'],
    });
  });

  it('self-delegated items notify nobody', async () => {
    const emit = typedEmit();
    const { emitWorkItemBlockedEvent } = await import('./work-items-events');
    emitWorkItemBlockedEvent(wi({ assignedBy: 'su-child', assignee: 'su-child' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0]).toMatchObject({ to: [] });
  });
});
