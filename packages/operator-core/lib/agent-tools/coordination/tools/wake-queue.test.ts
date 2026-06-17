/**
 * wake-queue.test.ts — the staged-wake review tool (hive-agent-tabs P-009) and
 * its EI-312 drain semantics: release_all folds the WHOLE queue into ONE
 * inbox-wake (one turn for N staged wakes — the manual-queue mirror of the live
 * pump's coalesceDeliveries), skip_all discards everything, and a single
 * release surfaces the coalesced fire count (×N) in the delivered summary.
 *
 * The pending-wakes store and the await-event engine are mocked at the module
 * seam — we assert WHAT is emitted/cleared, not the live pump.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingWake } from '../pending-wakes';

const listPendingWakes = vi.fn<(ownerId: string) => Promise<PendingWake[]>>();
const listAllPendingWakes = vi.fn<() => Promise<PendingWake[]>>();
const releasePendingWake = vi.fn(async () => undefined);
const clearPendingWakes = vi.fn(async () => 0);
const emitAwaitedEvent = vi.fn(async ({ key }: { key: string }) => ({
  ok: true as const,
  key,
  woken: 1,
  notified: [] as string[],
  msgId: null,
}));

vi.mock('../pending-wakes', () => ({
  listPendingWakes: (ownerId: string) => listPendingWakes(ownerId),
  listAllPendingWakes: () => listAllPendingWakes(),
  releasePendingWake: (id: number) => releasePendingWake(id),
  clearPendingWakes: (ownerId: string) => clearPendingWakes(ownerId),
}));
vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: (args: { key: string }) => emitAwaitedEvent(args),
}));

import wakeQueue from './wake-queue';
import { inboxWakeKey } from '../inbox-wake';

const ctx = { uiClientId: 'su-self', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = (x: unknown) => wakeQueue.args.parse(x) as never;
const out = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

function pw(over: Partial<PendingWake>): PendingWake {
  return {
    id: 1,
    ownerId: 'su-q',
    summary: null,
    payload: null,
    source: null,
    workspaceId: 'ws',
    createdAt: '2026-06-11T02:00:00Z',
    count: 1,
    lastSeenAt: '2026-06-11T02:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  listPendingWakes.mockResolvedValue([]);
  listAllPendingWakes.mockResolvedValue([]);
  clearPendingWakes.mockResolvedValue(0);
});
afterEach(() => vi.clearAllMocks());

describe('coord:wake-queue agent-less list (the fleet-wide wake board)', () => {
  it('lists EVERY agent\'s staged wakes when agent is omitted', async () => {
    listAllPendingWakes.mockResolvedValue([
      pw({ id: 1, ownerId: 'su-a', summary: 'a' }),
      pw({ id: 2, ownerId: 'su-b', summary: 'b' }),
    ]);
    const res = await wakeQueue.handler(parse({ action: 'list' }), ctx);
    expect(listAllPendingWakes).toHaveBeenCalledTimes(1);
    expect(listPendingWakes).not.toHaveBeenCalled();
    expect(out(res).pending.map((p: { ownerId: string }) => p.ownerId)).toEqual(['su-a', 'su-b']);
  });

  it('non-list actions REQUIRE an agent', async () => {
    for (const action of ['release', 'skip', 'release_all', 'skip_all']) {
      const res = await wakeQueue.handler(parse({ action, id: 1 }), ctx);
      expect(out(res)).toMatchObject({ ok: false, reason: 'agent-required', action });
    }
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(clearPendingWakes).not.toHaveBeenCalled();
  });
});

describe('coord:wake-queue release_all (EI-312 one-wake drain)', () => {
  it('drains the whole queue as ONE coalesced emit, then clears it', async () => {
    listPendingWakes.mockResolvedValue([
      pw({ id: 27, summary: 'Watchdog wake (boot)', source: 'hive-watchdog:boot', count: 11 }),
      pw({ id: 41, summary: 'cadence tick', source: 'wake-brain', count: 4 }),
      pw({ id: 53, summary: 'placement: WI-99 is your lane', source: 'queen', payload: { wi: 99 } }),
    ]);
    clearPendingWakes.mockResolvedValue(3);

    const res = await wakeQueue.handler(parse({ agent: 'su-q', action: 'release_all' }), ctx);

    // ONE emit on the agent's own inbox-wake key — never one per staged row.
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.key).toBe(inboxWakeKey('su-q'));
    // The union summary names every staged wake with its coalesced fire count.
    expect(emitted.summary).toContain('3 staged wake(s)');
    expect(emitted.summary).toContain('Watchdog wake (boot) (×11)');
    expect(emitted.summary).toContain('cadence tick (×4)');
    expect(emitted.summary).toContain('placement: WI-99 is your lane');
    // The payload carries the full union, newest as the headline.
    const payload = emitted.payload as { coalesced: boolean; count: number; wakes: unknown[]; latest: { payload: unknown } };
    expect(payload.coalesced).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.wakes).toHaveLength(3);
    expect(payload.latest.payload).toEqual({ wi: 99 });
    // The queue is cleared AFTER the emit succeeded.
    expect(clearPendingWakes).toHaveBeenCalledWith('su-q');
    expect(out(res)).toMatchObject({ ok: true, released: 3, woken: 1 });
  });

  it('an empty queue is a no-op (no emit, no clear)', async () => {
    const res = await wakeQueue.handler(parse({ agent: 'su-q', action: 'release_all' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(clearPendingWakes).not.toHaveBeenCalled();
    expect(out(res)).toMatchObject({ ok: true, released: 0, woken: 0 });
  });

  it('a single staged wake releases verbatim (no union framing)', async () => {
    listPendingWakes.mockResolvedValue([pw({ id: 9, summary: 'only one', payload: { a: 1 } })]);
    clearPendingWakes.mockResolvedValue(1);
    await wakeQueue.handler(parse({ agent: 'su-q', action: 'release_all' }), ctx);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.summary).toBe('only one');
    expect(emitted.payload).toEqual({ a: 1 });
  });

  it('honours edited content as the delivered summary', async () => {
    listPendingWakes.mockResolvedValue([pw({ id: 1, summary: 'a' }), pw({ id: 2, summary: 'b' })]);
    await wakeQueue.handler(
      parse({ agent: 'su-q', action: 'release_all', edited: 'resume: just take WI-99' }),
      ctx,
    );
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.summary).toBe('resume: just take WI-99');
  });
});

describe('coord:wake-queue skip_all', () => {
  it('discards everything without delivering', async () => {
    clearPendingWakes.mockResolvedValue(22);
    const res = await wakeQueue.handler(parse({ agent: 'su-q', action: 'skip_all' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(clearPendingWakes).toHaveBeenCalledWith('su-q');
    expect(out(res)).toMatchObject({ ok: true, skipped: 22 });
  });
});

describe('coord:wake-queue single release with a coalesced row', () => {
  it('surfaces the fire count (×N) in the delivered summary', async () => {
    listPendingWakes.mockResolvedValue([
      pw({ id: 27, summary: 'Watchdog wake (boot)', source: 'hive-watchdog:boot', count: 11 }),
    ]);
    await wakeQueue.handler(parse({ agent: 'su-q', action: 'release', id: 27 }), ctx);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.summary).toBe('Watchdog wake (boot) (×11)');
    expect(releasePendingWake).toHaveBeenCalledWith(27);
  });

  it('an un-coalesced row keeps its plain summary', async () => {
    listPendingWakes.mockResolvedValue([pw({ id: 5, summary: 'plain', count: 1 })]);
    await wakeQueue.handler(parse({ agent: 'su-q', action: 'release', id: 5 }), ctx);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.summary).toBe('plain');
  });
});

describe('coord:wake-queue cross-agent isolation (C6) — release + skip are scoped to the agent\'s own queue', () => {
  // release ALREADY scopes via listPendingWakes(agent).find — an id absent from
  // THIS agent's queue is not-found, never an emit, never a releasePendingWake.
  it('release of an id NOT in the agent\'s queue is not-found (no emit, no delete)', async () => {
    // su-q owns id 1; the caller asks to release id 99 (another agent's wake).
    listPendingWakes.mockResolvedValue([pw({ id: 1, ownerId: 'su-q', summary: 'mine' })]);
    const res = await wakeQueue.handler(parse({ agent: 'su-q', action: 'release', id: 99 }), ctx);
    expect(out(res)).toMatchObject({ ok: false, reason: 'not-found', id: 99 });
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(releasePendingWake).not.toHaveBeenCalled();
    // The membership read was scoped to the asking agent.
    expect(listPendingWakes).toHaveBeenCalledWith('su-q');
  });

  // skip USED to delete by bare id with NO membership check — a caller could skip
  // another agent's staged wake by raw id (cross-agent isolation gap). The fix
  // mirrors release: an id absent from the agent's own queue is not-found, never
  // a raw releasePendingWake. This is the teeth on that fix.
  it('skip of an id NOT in the agent\'s queue is not-found — never deletes a foreign wake', async () => {
    // su-a's queue holds only id 1; the caller (acting on su-a) asks to skip id 7,
    // which belongs to su-b. The membership check must reject it untouched.
    listPendingWakes.mockResolvedValue([pw({ id: 1, ownerId: 'su-a', summary: 'su-a only' })]);
    const res = await wakeQueue.handler(parse({ agent: 'su-a', action: 'skip', id: 7 }), ctx);
    expect(out(res)).toMatchObject({ ok: false, reason: 'not-found', id: 7 });
    // The bare-id delete is NEVER reached for a foreign id.
    expect(releasePendingWake).not.toHaveBeenCalled();
    expect(listPendingWakes).toHaveBeenCalledWith('su-a');
  });

  it('skip of an id IN the agent\'s own queue deletes exactly that row', async () => {
    listPendingWakes.mockResolvedValue([
      pw({ id: 3, ownerId: 'su-a', summary: 'a' }),
      pw({ id: 4, ownerId: 'su-a', summary: 'b' }),
    ]);
    const res = await wakeQueue.handler(parse({ agent: 'su-a', action: 'skip', id: 4 }), ctx);
    expect(out(res)).toMatchObject({ ok: true, skipped: 4 });
    expect(releasePendingWake).toHaveBeenCalledTimes(1);
    expect(releasePendingWake).toHaveBeenCalledWith(4);
    // skip never delivers.
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });
});

describe('coord:wake-queue release_all — a string payload survives the coalesce union (C6c)', () => {
  it('keeps a single staged string payload verbatim', async () => {
    // A lone staged wake whose payload is a bare string must pass through the
    // single-item fast path untouched (not be coerced into the union envelope).
    listPendingWakes.mockResolvedValue([pw({ id: 1, summary: 'note', payload: 'just a string' })]);
    clearPendingWakes.mockResolvedValue(1);
    await wakeQueue.handler(parse({ agent: 'su-q', action: 'release_all' }), ctx);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.payload).toBe('just a string');
  });

  it('carries a string payload through the multi-wake union (latest.payload + per-wake)', async () => {
    listPendingWakes.mockResolvedValue([
      pw({ id: 1, summary: 'first', payload: { a: 1 } }),
      pw({ id: 2, summary: 'second', payload: 'tail string' }),
    ]);
    clearPendingWakes.mockResolvedValue(2);
    await wakeQueue.handler(parse({ agent: 'su-q', action: 'release_all' }), ctx);
    const emitted = emitAwaitedEvent.mock.calls[0][0] as Record<string, unknown>;
    const payload = emitted.payload as {
      coalesced: boolean;
      latest: { payload: unknown };
      wakes: Array<{ payload: unknown }>;
    };
    expect(payload.coalesced).toBe(true);
    // Newest row (the string) is the headline.
    expect(payload.latest.payload).toBe('tail string');
    // Both payloads (object + string) survive in the per-wake union.
    expect(payload.wakes.map((w) => w.payload)).toEqual([{ a: 1 }, 'tail string']);
  });
});
