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
    markDeliveryParked: vi.fn(async () => {}),
    markDeliveryDropped: vi.fn(async () => {}),
    markDeliveryFailed: vi.fn(async () => 'retrying' as const),
    markDeliveryDeferred: vi.fn(async () => {}),
    recoverStuckDeliveries: vi.fn(async () => 0),
    fireTimedOutAwaits: vi.fn(async (): Promise<unknown[]> => []),
    expireLapsedAwaits: vi.fn(async () => 0),
  },
  executeWake: vi.fn(async (): Promise<unknown> => ({ kind: 'delivered', channel: 'resume' })),
  sendMessage: vi.fn(async () => ({ msg_id: 'm-1' })),
  admitSpawn: vi.fn(async (): Promise<{ admitted: boolean }> => ({ admitted: true })),
}));

vi.mock('./store', () => h.store);
vi.mock('./wake-executor', () => ({ executeWake: h.executeWake }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));

const { emitAwaitedEvent, pumpWakeDeliveries } = await import('./engine');

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
    expect((h.store.insertDeliveries.mock.calls[0][0] as { awaits: AwaitRow[] }).awaits.map((a) => a.id)).toEqual([1]);
    // notify = notify-await subscriber + extra recipients, MINUS the woken one.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; extra: Record<string, unknown> }];
    expect(sendArgs[1].to.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
    expect(sendArgs[1].summary).toContain('k');
    expect(sendArgs[1].extra.event_key).toBe('k');
    expect(r.notified.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
  });

  it('nothing fired + no to[] → no message, no deliveries', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.woken).toBe(0);
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

describe('pumpWakeDeliveries — pacing (D-007)', () => {
  it('per-subscriber single-flight: the second claimed row for one agent defers', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a' }),
      workRow({ id: 11, subscriberId: 'su-a' }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(11, expect.any(Number));
    expect(stats.delivered).toBe(1);
    expect(stats.deferred).toBe(1);
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
