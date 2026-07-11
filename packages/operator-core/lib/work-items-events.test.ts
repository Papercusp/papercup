/**
 * work-items-events.test.ts — settled-item event resolution, pure (injected
 * deps) (await-event-primitive-2026-06-05 P-012/P-013, D-006 #4/#5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitUnblockedOnEdgeRemoved, emitWorkItemSettledEvents, isSettledWorkItem, liveBlockedState, workItemIdFromRef } from './work-items-events';
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
  takenAt: null,
  lastProgressAt: null,
  assignedBy: 'su-parent',
  // work-item-completion-integrity-2026-07-01 WI-1403: required on WorkItem.
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
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

const edgeRel = (srcId: string, dstId: string, rel: string) => ({
  src: { kind: 'issue', ref: srcId },
  dst: { kind: 'issue', ref: dstId },
  rel,
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
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
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
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [])) as never,
      listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')] : [])) as never,
    });
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-1');
    expect(keys).toContain('work-item:unblocked:WI-DEP');
    const unblocked = (emit.mock.calls.find((c) => (c as unknown as [{ key: string }])[0].key.startsWith('work-item:unblocked')) as unknown as [{ to: string[]; payload: { clearedBy: string } }])[0];
    expect(unblocked.to).toEqual(['su-claimant']);
    expect(unblocked.payload.clearedBy).toBe('WI-1');
  });

  it('does NOT fire unblocked while another blocker is still live, nor for an already-settled dependent', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    const settledDep = wi({ id: 'WI-DONE-DEP', state: 'resolved' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? liveBlocker : id === 'WI-DONE-DEP' ? settledDep : null,
      ) as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-1', 'WI-DONE-DEP')] : [])) as never,
      listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')] : [])) as never,
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

  // P-008 (linking-notify-family-hardening) recurrence guard: the done-emit and
  // the unblocked loop are INDEPENDENT fail-soft scopes. A single shared try
  // used to drop the unblocked emits the moment the done-emit threw — so pin
  // that a throwing work-item:done STILL lets work-item:unblocked fire.
  it('a throwing work-item:done still lets the unblocked loop fire (independent fail-soft scopes)', async () => {
    const emit = vi.fn(async (opts: { key: string }) => {
      if (opts.key.startsWith('work-item:done')) throw new Error('done-emit engine down');
      return { ok: true as const, key: opts.key, woken: 0, notified: [] as string[], msgId: null, waiters: 0 };
    });
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    await expect(
      emitWorkItemSettledEvents(wi(), {
        emit: emit as never,
        getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? dependent : null)) as never,
        listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [])) as never,
        listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) => (o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [])) as never,
      }),
    ).resolves.toBeUndefined();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-1'); // the done-emit was attempted and threw…
    expect(keys).toContain('work-item:unblocked:WI-DEP'); // …yet the freed dependent was still woken
    const unblocked = (emit.mock.calls.find((c) => (c as unknown as [{ key: string }])[0].key.startsWith('work-item:unblocked')) as unknown as [{ to: string[] }])[0];
    expect(unblocked.to).toEqual(['su-claimant']);
  });
});

// WI-4034 DEFECT 1 (the unlink gap): unlinkWorkItem never re-checked whether
// the edge it just removed was the dependent's LAST live blocker, so
// work-item:unblocked never fired on an UNLINK — only on the blocker settling.
describe('emitUnblockedOnEdgeRemoved (WI-4034)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fires work-item:unblocked when the removed edge was the LAST live blocker', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    // the edge to the just-removed blocker is ALREADY gone from the store by
    // the time this runs — listIn returns only the (settled) other blocker.
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listIn: vi.fn(async () => [edge('WI-B2', 'WI-DEP')]) as never,
    });
    expect(emit).toHaveBeenCalledOnce();
    const arg = (emit.mock.calls[0] as unknown as [{ key: string; to: string[]; payload: { clearedBy: string } }])[0];
    expect(arg.key).toBe('work-item:unblocked:WI-DEP');
    expect(arg.to).toEqual(['su-claimant']);
    expect(arg.payload.clearedBy).toBe('WI-1');
  });

  it('does NOT fire while another blocker is still live', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? dependent : id === 'WI-B2' ? liveBlocker : null)) as never,
      listIn: vi.fn(async () => [edge('WI-B2', 'WI-DEP')]) as never,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT fire for an already-settled dependent', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const settledDependent = wi({ id: 'WI-DEP', state: 'resolved' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async () => settledDependent) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fires when there were never any other blockers at all (listIn empty)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async () => dependent) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).toHaveBeenCalledOnce();
  });

  it('an emit failure is swallowed (never throws)', async () => {
    await expect(
      emitUnblockedOnEdgeRemoved(
        { kind: 'issue', ref: 'WI-DEP' },
        'WI-1',
        {
          emit: vi.fn(async () => {
            throw new Error('engine down');
          }) as never,
          getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'open' })) as never,
          listIn: vi.fn(async () => []) as never,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

type EmitOpts = import('./events/await/engine').EmitAwaitedEventOpts;
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

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

  // EI-6788: a fire-and-forget emit whose query outlives the Postgres pool it
  // ran on (a rig/test tearing down mid-emit) rejects with postgres.js
  // CONNECTION_ENDED — expected teardown noise, NOT a warn (else it flakes any
  // rig-based integration test via vitest-fail-on-console). Same for the partial
  // test schema ("… does not exist"). failSoft must swallow both silently.
  it.each([
    ['CONNECTION_ENDED by code', Object.assign(new Error('write CONNECTION_ENDED localhost:36195'), { code: 'CONNECTION_ENDED' })],
    ['CONNECTION_ENDED by message only', new Error('write CONNECTION_ENDED 127.0.0.1:5432')],
    ['CONNECTION_DESTROYED by code', Object.assign(new Error('boom'), { code: 'CONNECTION_DESTROYED' })],
    ['partial-schema does not exist', new Error('relation "harness_shared.work_items" does not exist')],
  ])('swallows expected fire-and-forget teardown noise WITHOUT warning: %s', async (_label, thrown) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw thrown; });
    expect(() => emitWorkItemClaimedEvent(wi(), 'su-x', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('emitClaimReleasedEvent (P-105)', () => {
  it('fires claim:released:<id>, awaiter-only (no `to`), with the id in payload', async () => {
    const emit = typedEmit();
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-9', title: 'free me' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'claim:released:WI-9',
      source: 'work-items',
      payload: expect.objectContaining({ id: 'WI-9' }),
    });
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw new Error('pg down'); });
    expect(() => emitClaimReleasedEvent(wi(), { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claim-released-event'));
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

describe('emitWorkItemCreatedEvent (EI-8296)', () => {
  it('fires the GLOBAL work-item:created key with id/kind/severity/harness/title in payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    emitWorkItemCreatedEvent(wi({ id: 'WI-20', kind: 'bug', severity: null, harness: 'papercusp', title: 'new bug' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:created',
      source: 'work-items',
      payload: expect.objectContaining({ id: 'WI-20', kind: 'bug', severity: null, harness: 'papercusp', title: 'new bug' }),
    });
  });

  it('ALSO fires the severity-scoped key when the item carries a severity (dual-emit, mirrors release:deployed)', async () => {
    const emit = typedEmit();
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    emitWorkItemCreatedEvent(wi({ id: 'WI-21', kind: 'bug', severity: 'critical', title: 'a critical bug' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['work-item:created', 'work-item:created:critical']);
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw new Error('pg down'); });
    expect(() => emitWorkItemCreatedEvent(wi(), { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created-event'));
    warn.mockRestore();
  });
});

describe('emitWorkItemStatusEvent (P-101 — the general per-transition key)', () => {
  it('fires work-item:status:<id> carrying prevState → state on the payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    emitWorkItemStatusEvent(wi({ id: 'WI-9', state: 'wip', title: 'the work' }), 'todo', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:status:WI-9',
      source: 'work-items',
      summary: 'WI-9 todo → wip: the work',
      payload: expect.objectContaining({ id: 'WI-9', state: 'wip', prevState: 'todo' }),
    });
  });

  it('is an awaiter-only key — no `to` push (the audience is whoever awaited it)', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    // assignedBy set, but a general status change must NOT spam the delegator —
    // only the specific done/blocked keys target the delegator.
    emitWorkItemStatusEvent(wi({ id: 'WI-10', assignedBy: 'su-parent', assignee: 'su-child' }), 'wip', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; a state write must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw new Error('engine down'); });
    expect(() => emitWorkItemStatusEvent(wi(), 'todo', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('status-event'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => { throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' }); });
    expect(() => emitWorkItemStatusEvent(wi(), 'todo', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// P-005 (linking-notify-family-hardening): a fan-out settle reads every
// dependent's in-edges in ONE listInMany call (was: per-dst listIn +
// per-blocker getItem — N+1), and the emitter reads edges through the
// work-item-blocking seam instead of instantiating its own PgLinkStore.
describe('batched unblocked core (P-005)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a fan-out settle makes exactly ONE listInMany call, fetches each distinct item once, and emits only for genuinely-unblocked dependents', async () => {
    const emit = typedEmit();
    const dep1 = wi({ id: 'WI-D1', state: 'open', assignee: 'su-a' });
    const dep2 = wi({ id: 'WI-D2', state: 'open', assignee: 'su-b' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    const listInMany = vi.fn(async () => [
      edge('WI-1', 'WI-D1'), // D1: only the just-settled blocker → unblocked
      edge('WI-1', 'WI-D2'),
      edge('WI-B2', 'WI-D2'), // D2: WI-B2 still live → stays blocked
    ]);
    const getItem = vi.fn(async (id: string) =>
      id === 'WI-D1' ? dep1 : id === 'WI-D2' ? dep2 : id === 'WI-B2' ? liveBlocker : null,
    );
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: getItem as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-D1'), edge('WI-1', 'WI-D2')] : [],
      ) as never,
      listIn: vi.fn(async () => []) as never,
      listInMany: listInMany as never,
    });
    // THE batch pin: one query for both dependents' in-edges, never per-dst.
    expect(listInMany).toHaveBeenCalledTimes(1);
    expect(listInMany.mock.calls[0]).toEqual([
      [{ kind: 'issue', ref: 'WI-D1' }, { kind: 'issue', ref: 'WI-D2' }],
      { rel: 'blocks' },
    ]);
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('work-item:unblocked:WI-D1');
    expect(keys).not.toContain('work-item:unblocked:WI-D2');
    // Dedup pin: each involved item fetched once; the cleared blocker never is.
    expect(getItem.mock.calls.map((c) => c[0]).sort()).toEqual(['WI-B2', 'WI-D1', 'WI-D2']);
  });

  it('the emitter reads edges through the seam, never its own store (source pin)', () => {
    const src = readFileSync(fileURLToPath(new URL('./work-items-events.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/new PgLinkStore/);
    expect(src).toMatch(/blockingEdgeReader/);
  });
});

// P-006 (linking-notify-family-hardening): the events:await registration latch
// for work-item:unblocked:<id> keys probes the LIVE blocked state — an
// already-unblocked (or settled) target is told so at registration instead of
// stranding into a timeout-only wait. 'unknown' must never block registration.
describe('liveBlockedState (P-006 latch probe)', () => {
  it("returns 'blocked' while any live blocker edge remains", async () => {
    const item = wi({ id: 'WI-DEP', state: 'open' });
    const liveBlocker = wi({ id: 'WI-B1', state: 'open' });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? item : id === 'WI-B1' ? liveBlocker : null)) as never,
        listIn: vi.fn(async () => [edge('WI-B1', 'WI-DEP')]) as never,
      }),
    ).resolves.toBe('blocked');
  });

  it("returns 'unblocked' when every blocker is settled (or none exist)", async () => {
    const item = wi({ id: 'WI-DEP', state: 'open' });
    const settledBlocker = wi({ id: 'WI-B1', state: 'closed' });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? item : id === 'WI-B1' ? settledBlocker : null)) as never,
        listIn: vi.fn(async () => [edge('WI-B1', 'WI-DEP')]) as never,
      }),
    ).resolves.toBe('unblocked');
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => item) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBe('unblocked');
  });

  it("returns 'settled' for a target already in a terminal state (the key can never fire)", async () => {
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'resolved' })) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBe('settled');
  });

  it("returns 'unknown' (never throws) when the item is unreadable — registration must proceed", async () => {
    await expect(
      liveBlockedState('WI-GONE', {
        getItem: vi.fn(async () => null) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBe('unknown');
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'open' })) as never,
        listIn: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    ).resolves.toBe('unknown');
  });
});

// P-010 (linking-notify-family-hardening, WI-4014 Part 3 owner-fork → Option A):
// on settle, notify across fixes/duplicates edges (inject-only) — the fixed
// target's subscribers (fixes) and each duplicate-holder's assignee (duplicates).
// Option B (subscribe{followBlockers}) deliberately NOT built (hot-path, D-003).
describe('fix/duplicate settle-notify (P-010)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const okEmit = () => vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));

  it('fixes: notifies the fixed target subscribers (isResolution, inject-only) when the fixer settles', async () => {
    const notifySubscribers = vi.fn(async () => 1);
    const target = wi({ id: 'WI-BUG', state: 'open' });
    await emitWorkItemSettledEvents(wi({ id: 'WI-FIX', assignee: 'su-fixer' }), {
      emit: okEmit() as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-BUG' ? target : null)) as never,
      listOut: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
        opts?.rel === 'fixes' ? [edgeRel('WI-FIX', 'WI-BUG', 'fixes')] : [],
      ) as never,
      listIn: vi.fn(async () => []) as never,
      notifySubscribers: notifySubscribers as never,
    });
    expect(notifySubscribers).toHaveBeenCalledOnce();
    const [obj, ev] = notifySubscribers.mock.calls[0] as unknown as [{ kind: string; ref: string }, { notify_kind: string; isResolution: boolean; summary: string }];
    expect(obj).toEqual({ kind: 'issue', ref: 'WI-BUG' }); // the TARGET's ref, not the fixer's
    expect(ev.notify_kind).toBe('work_item_fix_settled');
    expect(ev.isResolution).toBe(true); // mention-mode followers still receive the resolution
    expect(ev.summary).toContain('WI-FIX');
  });

  it('duplicates: notifies each distinct duplicate-holder assignee when the canonical settles', async () => {
    const emit = okEmit();
    const dup1 = wi({ id: 'WI-DUP1', state: 'open', assignee: 'su-a' });
    const dup2 = wi({ id: 'WI-DUP2', state: 'open', assignee: 'su-b' });
    await emitWorkItemSettledEvents(wi({ id: 'WI-CANON', assignee: 'su-canon' }), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-DUP1' ? dup1 : id === 'WI-DUP2' ? dup2 : null)) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
        opts?.rel === 'duplicates' ? [edgeRel('WI-DUP1', 'WI-CANON', 'duplicates'), edgeRel('WI-DUP2', 'WI-CANON', 'duplicates')] : [],
      ) as never,
      notifySubscribers: vi.fn(async () => 0) as never,
    });
    const dupCall = emit.mock.calls.find((c) => (c as unknown as [{ key: string }])[0].key.startsWith('work-item:duplicate-settled'));
    expect(dupCall).toBeDefined();
    const arg = (dupCall as unknown as [{ key: string; to: string[] }])[0];
    expect(arg.key).toBe('work-item:duplicate-settled:WI-CANON');
    expect([...arg.to].sort()).toEqual(['su-a', 'su-b']);
  });

  it('no fixes/duplicates edges → only work-item:done fires (no spurious notify)', async () => {
    const emit = okEmit();
    const notifySubscribers = vi.fn(async () => 0);
    await emitWorkItemSettledEvents(wi({ id: 'WI-1' }), {
      emit: emit as never,
      getItem: vi.fn(async () => null) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
      notifySubscribers: notifySubscribers as never,
    });
    expect(notifySubscribers).not.toHaveBeenCalled();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toEqual(['work-item:done:WI-1']);
  });

  it('a throwing fix/dup notify is swallowed and does NOT drop the done emit (independent fail-soft scope, P-008)', async () => {
    const emit = okEmit();
    await expect(
      emitWorkItemSettledEvents(wi({ id: 'WI-FIX' }), {
        emit: emit as never,
        getItem: vi.fn(async () => wi({ id: 'WI-BUG', state: 'open' })) as never,
        listOut: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
          opts?.rel === 'fixes' ? [edgeRel('WI-FIX', 'WI-BUG', 'fixes')] : [],
        ) as never,
        listIn: vi.fn(async () => []) as never,
        notifySubscribers: vi.fn(async () => {
          throw new Error('fanout down');
        }) as never,
      }),
    ).resolves.toBeUndefined();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-FIX'); // done still fired despite fix-notify throwing
  });
});
