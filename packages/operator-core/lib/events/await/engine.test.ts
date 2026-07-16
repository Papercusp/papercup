/**
 * engine.test.ts — emit split (wake vs notify) + pump pacing (D-002/D-007),
 * store/executor/messages mocked (await-event-primitive-2026-06-05 P-006).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwaitRow, DeliveryWork } from './types';

const h = vi.hoisted(() => ({
  store: {
    fireAwaitsForKey: vi.fn(async (): Promise<unknown[]> => []),
    insertDeliveries: vi.fn(async () => 0),
    claimDueDeliveries: vi.fn(async (): Promise<unknown[]> => []),
    markDeliveryDelivered: vi.fn(async () => {}),
    markDeliveriesCoalesced: vi.fn(async () => {}),
    lastWokenAtForSubscribers: vi.fn(async () => new Map<string, number>()),
    markDeliveryParked: vi.fn(async () => {}),
    markDeliveryDropped: vi.fn(async () => {}),
    markDeliveryFailed: vi.fn(async () => 'retrying' as const),
    reopenDeliveredAfterResumeDeath: vi.fn(async () => 'retrying' as const),
    markDeliveryDeferred: vi.fn(async () => {}),
    recoverStuckDeliveries: vi.fn(async () => 0),
    fireTimedOutAwaits: vi.fn(async (): Promise<unknown[]> => []),
    expireLapsedAwaits: vi.fn(async () => 0),
    stampAnnouncementsFired: vi.fn(async () => {}),
    cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
    listActiveAwaitsForKey: vi.fn(async (): Promise<AwaitRow[]> => []),
    cancelAwaitsByIds: vi.fn(async () => 0),
  },
  executeWake: vi.fn(
    async (
      _delivery: DeliveryWork,
      _deps: { onResumeTurnExit?: (delivery: DeliveryWork, exit: unknown) => void },
    ): Promise<unknown> => ({ kind: 'delivered', channel: 'resume' }),
  ),
  sendMessage: vi.fn(async () => ({ msg_id: 'm-1' })),
  admitSpawn: vi.fn(async (): Promise<{ admitted: boolean }> => ({ admitted: true })),
  // WI-4014 Part 2: standing event-key inject subscribers folded into the notify path.
  listEventKeySubscribers: vi.fn(async (): Promise<Array<{ subscriber_id: string; delivery_mode: string }>> => []),
}));

vi.mock('./store', () => h.store);
vi.mock('./wake-executor', () => ({ executeWake: h.executeWake }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../../agent-tools/coordination/event-subscriptions', () => ({ listEventKeySubscribers: h.listEventKeySubscribers }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));

const { emitAwaitedEvent, pumpWakeDeliveries, cancelSupersededCandidateAwaits } = await import('./engine');

function awaitRow(over: Partial<AwaitRow> = {}): AwaitRow {
  return {
    id: 1,
    workspaceId: 'ws-test',
    subscriberId: 'su-w',
    eventKey: 'k',
    policy: 'wake',
    note: null,
    wakeHandle: null,
    timeoutBehavior: 'wake',
    expiresTs: null,
    createdAt: new Date().toISOString(),
    firedAt: new Date().toISOString(),
    firedReason: 'event',
    cancelledAt: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: null,
    scopeRef: null,
    ...over,
  };
}

function workRow(over: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 10,
    workspaceId: 'ws-test',
    awaitId: 1,
    subscriberId: 'su-w',
    eventKey: 'k',
    payload: null,
    summary: null,
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    wakeHandle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 },
    note: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The engine logs wake outcomes deliberately (visible drops, D-004);
  // the suite-wide fail-on-console guard must not count those.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK;
});
afterEach(() => {
  delete process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK;
});

describe('emitAwaitedEvent', () => {
  it('wake awaits → deliveries; notify awaits + to[] → ONE coord message; woken excluded from notify', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-w', policy: 'wake' }),
      awaitRow({ id: 2, subscriberId: 'su-n', policy: 'notify' }),
    ]);
    const r = await emitAwaitedEvent({
      key: 'k',
      summary: 'done',
      to: ['su-w', 'su-extra', '@topic:locks'],
      source: 'su-emitter',
    });
    expect(r.woken).toBe(1);
    expect(h.store.insertDeliveries).toHaveBeenCalledTimes(1);
    const insertArg = (h.store.insertDeliveries.mock.calls[0] as unknown as [{ awaits: AwaitRow[] }])[0];
    expect(insertArg.awaits.map((a) => a.id)).toEqual([1]);
    // notify = notify-await subscriber + extra recipients, MINUS the woken one.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; extra: Record<string, unknown> }];
    expect(sendArgs[1].to.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
    expect(sendArgs[1].summary).toContain('k');
    expect(sendArgs[1].extra.event_key).toBe('k');
    expect(r.notified.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
    // EI-9000: waiters = total ACTIVE await registrations matched (wake + notify
    // policy), independent of the extra to[] audience — 1 wake + 1 notify = 2,
    // regardless of the 2 extra to[] names folded into the notify send above.
    expect(r.waiters).toBe(2);
  });

  it('nothing fired + no to[] → no message, no deliveries, waiters:0 (emit reached no one)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.woken).toBe(0);
    expect(r.waiters).toBe(0);
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('a notify-send failure never breaks the emit (politeness layer)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.sendMessage.mockRejectedValueOnce(new Error('coord down'));
    const r = await emitAwaitedEvent({ key: 'k', to: ['su-x'] });
    expect(r.ok).toBe(true);
    expect(r.msgId).toBeNull();
  });
});

describe('emitAwaitedEvent — EI-12457: sibling-await cancellation on fire', () => {
  it('cancelSiblingKeysFor: cancels the just-woken subscribers\' pending awaits on the named opposite-outcome keys', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' }),
      awaitRow({ id: 2, subscriberId: 'su-b', policy: 'wake' }),
    ]);
    await emitAwaitedEvent({
      key: 'release:green:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['green-checkpoint:red', 'green-checkpoint:red:papercusp'],
    });
    expect(h.store.cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledTimes(1);
    const [subscribers, keys] = h.store.cancelAwaitsForSubscribersOnKeys.mock.calls[0] as unknown as [string[], string[]];
    expect(subscribers.sort()).toEqual(['su-a', 'su-b']);
    expect(keys).toEqual(['green-checkpoint:red', 'green-checkpoint:red:papercusp']);
  });

  it('no cancelSiblingKeysFor passed → sibling cancellation is never invoked (today\'s behaviour unchanged)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    await emitAwaitedEvent({ key: 'k' });
    expect(h.store.cancelAwaitsForSubscribersOnKeys).not.toHaveBeenCalled();
  });

  it('cancelSiblingKeysFor passed but nobody was woken → no cancellation call (nothing to retire)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    await emitAwaitedEvent({ key: 'green-checkpoint:red:papercusp', cancelSiblingKeysFor: ['release:green'] });
    expect(h.store.cancelAwaitsForSubscribersOnKeys).not.toHaveBeenCalled();
  });

  it('a sibling-cancellation failure never breaks the emit (fail-soft)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    h.store.cancelAwaitsForSubscribersOnKeys.mockRejectedValueOnce(new Error('db down'));
    const r = await emitAwaitedEvent({ key: 'k', cancelSiblingKeysFor: ['k-red'] });
    expect(r.ok).toBe(true);
    expect(r.woken).toBe(1);
  });
});

describe('cancelSupersededCandidateAwaits (WI-4957: a killed run cannot leave a live-looking wait behind)', () => {
  beforeEach(() => {
    h.store.listActiveAwaitsForKey.mockReset();
    h.store.cancelAwaitsByIds.mockReset().mockResolvedValue(0);
  });

  it('cancels only rows whose payload_filter is bound to the STALE candidate — a global (unbound) wait is left alone', async () => {
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) => {
      if (key !== 'release:green:papercusp') return [];
      return [
        // Bound to the stale candidate — must be cancelled.
        awaitRow({ id: 11, subscriberId: 'su-bound-stale', payloadFilter: { sha: { startsWith: 'deadbeef' } } }),
        // Bound to a DIFFERENT candidate — must be left alone.
        awaitRow({ id: 12, subscriberId: 'su-bound-other', payloadFilter: { sha: { startsWith: 'cafef00d' } } }),
        // Unbound (global "next verdict, any candidate") — must be left alone; the fresh
        // run's verdict is exactly what it's still waiting for.
        awaitRow({ id: 13, subscriberId: 'su-global', payloadFilter: null }),
      ];
    });
    h.store.cancelAwaitsByIds.mockResolvedValueOnce(1);

    const result = await cancelSupersededCandidateAwaits({
      keys: ['release:green', 'release:green:papercusp', 'green-checkpoint:red', 'green-checkpoint:red:papercusp'],
      staleCandidateSha: 'deadbeef1234',
    });

    expect(result).toEqual({ cancelled: 1, ids: [11] });
    expect(h.store.cancelAwaitsByIds).toHaveBeenCalledTimes(1);
    expect(h.store.cancelAwaitsByIds).toHaveBeenCalledWith([11]);
  });

  it('nothing bound to the stale candidate → no cancel call at all', async () => {
    h.store.listActiveAwaitsForKey.mockResolvedValue([awaitRow({ id: 1, payloadFilter: null })]);
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green'], staleCandidateSha: 'deadbeef' });
    expect(result).toEqual({ cancelled: 0, ids: [] });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('a lookup failure on one key degrades to skipping that key, never throws', async () => {
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) => {
      if (key === 'release:green') throw new Error('db blip');
      return [awaitRow({ id: 5, payloadFilter: { sha: { startsWith: 'abc123' } } })];
    });
    h.store.cancelAwaitsByIds.mockResolvedValueOnce(1);
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green', 'release:green:papercusp'], staleCandidateSha: 'abc123456' });
    expect(result).toEqual({ cancelled: 1, ids: [5] });
  });

  it('a cancel-store failure degrades to {cancelled:0}, never throws', async () => {
    h.store.listActiveAwaitsForKey.mockResolvedValue([awaitRow({ id: 5, payloadFilter: { sha: { startsWith: 'abc123' } } })]);
    h.store.cancelAwaitsByIds.mockRejectedValueOnce(new Error('db down'));
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green'], staleCandidateSha: 'abc123456' });
    expect(result).toEqual({ cancelled: 0, ids: [] });
  });
});

describe('emitAwaitedEvent — WI-4014 Part 2: standing event-key inject subscribers', () => {
  it('folds standing event-key subscribers into the notify audience and reports eventSubscribers', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-ev-1', delivery_mode: 'full' },
      { subscriber_id: 'su-ev-2', delivery_mode: 'digest' },
    ]);
    const r = await emitAwaitedEvent({ key: 'lock:grant:t1' });
    expect(h.listEventKeySubscribers).toHaveBeenCalledWith('lock:grant:t1');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to.sort()).toEqual(['su-ev-1', 'su-ev-2']);
    expect(r.notified.sort()).toEqual(['su-ev-1', 'su-ev-2']);
    expect(r.eventSubscribers).toBe(2);
  });

  it('excludes delivery_mode:"muted" event-key subscribers from the notify send', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-live', delivery_mode: 'full' },
      { subscriber_id: 'su-muted', delivery_mode: 'muted' },
    ]);
    const r = await emitAwaitedEvent({ key: 'k' });
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to).toEqual(['su-live']);
    expect(r.notified).toEqual(['su-live']);
    // eventSubscribers counts only the ones actually folded in (muted excluded).
    expect(r.eventSubscribers).toBe(1);
  });

  it('an event-key subscriber already WOKEN (a wake-policy await on the same key) is not double-notified', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-both', policy: 'wake' }),
    ]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-both', delivery_mode: 'full' }, // also has a standing inject sub
      { subscriber_id: 'su-inject-only', delivery_mode: 'full' },
    ]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.woken).toBe(1);
    expect(r.notified).toEqual(['su-inject-only']); // su-both excluded — already woken
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to).toEqual(['su-inject-only']);
  });

  it('a subscriber lookup error is fail-soft — the emit still succeeds (wake path unaffected)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-w', policy: 'wake' }),
    ]);
    h.listEventKeySubscribers.mockRejectedValueOnce(new Error('store down'));
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.ok).toBe(true);
    expect(r.woken).toBe(1); // the wake half is untouched by a notify-side lookup failure
    expect(r.eventSubscribers).toBe(0);
  });

  it('no event-key subscribers and nothing else → eventSubscribers:0, no message', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.eventSubscribers).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('pumpWakeDeliveries — pacing (D-007)', () => {
  it('reopens ordinary event deliveries when a headless resume dies after spawn', async () => {
    const first = workRow({
      id: 90,
      subscriberId: 'su-a',
      eventKey: 'release:green:papercusp',
      source: 'green-checkpoint',
      attempts: 2,
      createdAt: new Date(1000).toISOString(),
    });
    const timeoutSibling = workRow({
      id: 91,
      subscriberId: 'su-a',
      eventKey: 'green-checkpoint:red:papercusp',
      source: null,
      attempts: 2,
      createdAt: new Date(2000).toISOString(),
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([first, timeoutSibling]);
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        // Reproduce the fast-exit race: the child dies before the pump finishes
        // writing delivered/coalesced state.
        deps.onResumeTurnExit?.(d, {
          exitCode: 1,
          signal: null,
          stdoutTail: 'API Error: 429 · Rate limited',
          stderrTail: '',
        });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    const stats = await pumpWakeDeliveries('ws-test');

    expect(stats.delivered).toBe(1);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(91, 'resume-headless', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([90], 91);
    await vi.waitFor(() => {
      expect(h.store.reopenDeliveredAfterResumeDeath).toHaveBeenCalledTimes(2);
    });
    expect(h.store.reopenDeliveredAfterResumeDeath).toHaveBeenCalledWith(
      expect.objectContaining({ id: 90, error: 'resume-turn-death:rate_limited', maxAttempts: 8 }),
    );
    expect(h.store.reopenDeliveredAfterResumeDeath).toHaveBeenCalledWith(
      expect.objectContaining({ id: 91, error: 'resume-turn-death:rate_limited', maxAttempts: 8 }),
    );
    expect(h.store.markDeliveryDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.reopenDeliveredAfterResumeDeath.mock.invocationCallOrder[0],
    );
  });

  it('does not reopen loop deliveries because their circuit handler owns retry semantics', async () => {
    const loop = workRow({ id: 92, subscriberId: 'su-loop', source: 'loop:r-1', attempts: 1 });
    h.store.claimDueDeliveries.mockResolvedValueOnce([loop]);
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        deps.onResumeTurnExit?.(d, { exitCode: 1, signal: null, stdoutTail: '', stderrTail: 'crashed' });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    await pumpWakeDeliveries('ws-test');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.store.reopenDeliveredAfterResumeDeath).not.toHaveBeenCalled();
  });

  it('per-subscriber coalesce: multiple due wakes for one agent fold into ONE wake', async () => {
    // Two events fire for su-a → ONE coalesced wake (the newest is the headline; the older
    // settles as coalesced, no second turn) — the unify-watch-primitive gap closing.
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a', eventKey: 'k1', createdAt: new Date(1000).toISOString() }),
      workRow({ id: 11, subscriberId: 'su-a', eventKey: 'k2', createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    // ONE turn for both events (not two).
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    // The headline (newest, id 11) carries the union summary listing both keys.
    const work = (h.executeWake.mock.calls[0] as unknown as [{ summary: string; coalescedCount: number }])[0];
    expect(work.summary).toContain('k1');
    expect(work.summary).toContain('k2');
    // Headline delivered with coalescedCount=2; the sibling settles as coalesced (no turn).
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(11, 'resume', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([10], 11);
    expect(h.store.markDeliveryDeferred).not.toHaveBeenCalled();
    expect(stats.delivered).toBe(1);
    expect(stats.coalesced).toBe(1);
    expect(stats.deferred).toBe(0);
  });

  it('per-subscriber min_sleep floor: a wake inside the window defers until the floor allows it', async () => {
    // su-a was woken 10s ago; a min_sleep=60 watch fires now → defer (within floor), no turn.
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 10_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 20, subscriberId: 'su-a', minSleepSec: 60 }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(20, expect.any(Number));
    expect(stats.deferred).toBe(1);
    expect(stats.delivered).toBe(0);
  });

  it('GAP 2: a co-incident floor-less one-shot does NOT nullify a standing min_sleep floor', async () => {
    // su-a woke 10s ago. Two deliveries land THIS tick for it: a standing watch
    // with min_sleep=60 AND a floor-less one-shot grant (min_sleep=0). The group
    // floor must be the standing 60s — NOT 0 — so the whole group DEFERS (still
    // inside the 60s window). The bug: `Math.min(60, 0)` → 0 disabled the floor,
    // so the coincident one-shot's tick woke the standing watch early (cost
    // discipline defeated). Neither is urgent.
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 10_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 70, subscriberId: 'su-a', minSleepSec: 60, createdAt: new Date(1000).toISOString() }),
      workRow({ id: 71, subscriberId: 'su-a', minSleepSec: 0, createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    // The standing floor holds: no turn, the whole group defers.
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(70, expect.any(Number));
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(71, expect.any(Number));
    expect(stats.deferred).toBe(2);
    expect(stats.delivered).toBe(0);
  });

  it('GAP 2: past the floor window, the standing + one-shot group wakes (coalesced, one turn)', async () => {
    // Same shape but su-a last woke 120s ago — beyond the 60s floor → it wakes,
    // and the two due deliveries coalesce into ONE turn (the fix preserves the
    // positive floor without breaking the normal wake-when-allowed path).
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 120_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 72, subscriberId: 'su-a', minSleepSec: 60, createdAt: new Date(1000).toISOString() }),
      workRow({ id: 73, subscriberId: 'su-a', minSleepSec: 0, createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
    expect(stats.deferred).toBe(0);
  });

  it('urgent bypasses the floor: an urgent wake fires even inside the min_sleep window', async () => {
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 1_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 21, subscriberId: 'su-a', minSleepSec: 60, urgent: true }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
  });

  it('resume cap: past the per-tick cap, further wakes defer to the next tick', async () => {
    process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK = '1';
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a' }),
      workRow({ id: 11, subscriberId: 'su-b' }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
    expect(stats.deferred).toBe(1);
  });

  it('fleet-governor denial defers the wake (paced re-admission, fail-open on error)', async () => {
    h.admitSpawn.mockResolvedValueOnce({ admitted: false });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10 })]);
    const denied = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(denied.deferred).toBe(1);

    // A governor-store error must never strand the wake (fail-open).
    h.admitSpawn.mockRejectedValueOnce(new Error('governor store down'));
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 11 })]);
    const open = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(open.delivered).toBe(1);
  });

  it('park → parked + ONE inbox nudge on the first attempt only', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10, attempts: 1 })]);
    await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryParked).toHaveBeenCalledWith(10, 'alive, no pty', expect.any(Number));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);

    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10, attempts: 2 })]);
    await pumpWakeDeliveries('ws-test');
    expect(h.sendMessage).toHaveBeenCalledTimes(1); // no second nudge
  });

  it('P-001: a degraded delivered/inbox outcome records channel=\'inbox\' on the delivery row, not a drop', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'inbox' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 30, subscriberId: 'su-a' })]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(30, 'inbox', 1);
    expect(h.store.markDeliveryDropped).not.toHaveBeenCalled();
    expect(stats.delivered).toBe(1);
    expect(stats.dropped).toBe(0);
  });

  it('drop and error settle visibly (dropped / failed-with-backoff)', async () => {
    h.executeWake
      .mockResolvedValueOnce({ kind: 'drop', reason: 'dead waiter' })
      .mockResolvedValueOnce({ kind: 'error', error: 'spawn failed' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a' }),
      workRow({ id: 11, subscriberId: 'su-b' }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(10, 'dead waiter');
    expect(h.store.markDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, error: 'spawn failed' }),
    );
    expect(stats.dropped).toBe(1);
    expect(stats.failed).toBe(1);
  });
});

describe('pump guard is keyed per workspace (audit P-033)', () => {
  it("workspace B pumps while A's pump is in flight; same-workspace reentry stays blocked", async () => {
    // WI-3575: claimDueDeliveries no longer takes a workspaceId (events:await is
    // single-workspace by design — see store.ts) — so this can no longer observe
    // the `pumpsInFlight` per-workspace guard by inspecting the store call's
    // workspaceId arg. The guard itself is unchanged (pumpWakeDeliveries's OWN `ws`
    // param still keys the in-memory reentrancy Set); observe it instead via CALL
    // COUNT — a guarded reentry never reaches claimDueDeliveries at all, so only a
    // genuinely-proceeding pump increments it.
    let releaseA!: (rows: unknown[]) => void;
    let claimCalls = 0;
    let parkedOnce = false;
    (h.store.claimDueDeliveries as unknown as { mockImplementation: (fn: () => Promise<unknown[]>) => void }).mockImplementation(
      async () => {
        claimCalls++;
        if (!parkedOnce) {
          parkedOnce = true; // only the FIRST (A's) claim parks; later pumps complete normally
          return new Promise<unknown[]>((res) => {
            releaseA = res;
          });
        }
        return [];
      },
    );

    const pumpA = pumpWakeDeliveries('ws-a'); // parks inside claimDueDeliveries; guard entry held
    await Promise.resolve(); // let A reach its claim call
    expect(claimCalls).toBe(1);

    // Same-workspace reentry: still guarded — returns empty WITHOUT ever claiming.
    const reentry = await pumpWakeDeliveries('ws-a');
    expect(reentry.claimed).toBe(0);
    expect(claimCalls).toBe(1);

    // Cross-workspace: B must proceed (the old module-global boolean silently
    // swallowed this kick — cross-workspace wake starvation).
    await pumpWakeDeliveries('ws-b');
    expect(claimCalls).toBe(2);

    releaseA([]);
    await pumpA;

    // A's guard entry cleared with its pump — it can pump again.
    await pumpWakeDeliveries('ws-a');
    expect(claimCalls).toBe(3);
  });
});
