/**
 * deliver-and-wake.test.ts — Phase 4 of local-hive-orchestration-2026-06-06.
 *
 * Covers P-040 (coord:send / coord:message-agent {wake:true} ENQUEUE the inbox
 * message AND fire the recipient's inbox-wake key), P-042 (single-target: one
 * emit per addressed recipient, on that recipient's OWN key — NEVER a broadcast
 * key, never '*'/'human'), and P-041 (coord:await-inbox arms a standing wake
 * watch on the caller's own inbox-wake key).
 *
 * The await-event engine is mocked at the module seam (we assert WHAT keys are
 * fired, not the live pump — the pump itself is unify-watch's tested substrate).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';

// ── Mock the wake pump seam: capture every emit key, do not run the real pump. ──
const emitAwaitedEvent = vi.fn(async ({ key }: { key: string }) => ({
  ok: true as const,
  key,
  woken: 1,
  notified: [] as string[],
  msgId: null,
}));
// coord:await-inbox composes the registration internals directly — stub them so
// the unit test needs no PG / no real sweeper.
const registerAwait = vi.fn(async (input: { eventKey: string; once?: boolean; minSleepSec?: number | null }) => ({
  id: 77,
  eventKey: input.eventKey,
  once: input.once ?? false,
  minSleepSec: input.minSleepSec ?? null,
  workspaceId: 'ws',
  subscriberId: 'su-self',
  policy: 'wake' as const,
  note: null,
  wakeHandle: null,
  timeoutBehavior: 'wake' as const,
  expiresTs: null,
  createdAt: new Date().toISOString(),
  firedAt: null,
  firedReason: null,
  cancelledAt: null,
}));
// coord:await-inbox is now an annotation over the always-armed watch (D-005):
// it routes through armInboxWake → upsertInboxWakeAwait (NOT registerAwait), so
// the store mock must export the upsert seam that arm path actually calls.
const upsertInboxWakeAwait = vi.fn(
  async (input: { eventKey: string; minSleepSec?: number | null; note?: string | null }) => ({
    id: 77,
    eventKey: input.eventKey,
    once: false,
    minSleepSec: input.minSleepSec ?? null,
    workspaceId: 'ws',
    subscriberId: 'su-self',
    policy: 'wake' as const,
    note: input.note ?? null,
    wakeHandle: null,
    timeoutBehavior: 'expire' as const,
    expiresTs: null,
    createdAt: new Date().toISOString(),
    firedAt: null,
    firedReason: null,
    cancelledAt: null,
  }),
);
const cancelInboxWakeAwaits = vi.fn(async () => 0);
const startAwaitSweeper = vi.fn();
const captureWakeHandleForOwner = vi.fn(async () => ({ handle: null, note: 'no tracked session — inbox-degraded' }));

vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: (args: { key: string }) => emitAwaitedEvent(args),
  startAwaitSweeper: () => startAwaitSweeper(),
}));
vi.mock('../../../events/await/store', () => ({
  registerAwait: (input: { eventKey: string }) => registerAwait(input),
  upsertInboxWakeAwait: (input: { eventKey: string }) => upsertInboxWakeAwait(input),
  cancelInboxWakeAwaits: () => cancelInboxWakeAwaits(),
}));
vi.mock('../../../events/await/handle', () => ({
  captureWakeHandleForOwner: () => captureWakeHandleForOwner(),
}));
// coord:message-agent opens a PG-backed conversation before the wake half — stub
// just that one un-caught await so the unit test exercises the wake path without a
// database. The subscribe + ping steps are already best-effort try/catch in the
// tool (their getOrgPg()/PgEntitySubscriptionStore calls throw → caught → no-op).
vi.mock('../conversations', () => ({
  openConversation: vi.fn(async () => ({
    conversation: { id: 'conv-1' },
    thread_id: 'thread-1',
  })),
}));
// The wake-MODE gate + staging leg also reach live PG, and their failure mode is
// NOT a throw: on a dev box with a reachable org PG, a `manual` resolution (e.g.
// a hive:pause global default, or another suite's wake-mode rows) routes the
// wake into stagePendingWake — which WROTE this suite's synthetic owners into
// the PRODUCTION harness_shared.pending_wakes table (caught live by the
// coord-invariant-monitor as EI-275, 21 debris rows). Unit tests must never
// depend on the box's live wake-mode state: pin mode to `auto` and make staging
// a spy.
vi.mock('../wake-mode', () => ({
  resolveWakeMode: vi.fn(async () => 'auto'),
}));
vi.mock('../pending-wakes', () => ({
  stagePendingWake: vi.fn(async () => ({ id: 1 })),
}));

import coordSend from './send';
import messageAgent from './message-agent';
import awaitInbox from './await-inbox';
import { COORD_INBOX_WAKE_PREFIX, inboxWakeKey, ownerFromInboxWakeKey } from '../inbox-wake';

const ctx = { uiClientId: 'su-self', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = <T>(tool: { args: { parse: (x: unknown) => unknown } }, x: unknown): T =>
  tool.args.parse(x) as T;
const out = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

describe('inboxWakeKey helper', () => {
  it('round-trips an ownerId through the inbox-wake key', () => {
    const k = inboxWakeKey('su-bee-1');
    expect(k).toBe(`${COORD_INBOX_WAKE_PREFIX}su-bee-1`);
    expect(ownerFromInboxWakeKey(k)).toBe('su-bee-1');
    expect(ownerFromInboxWakeKey('lock:grant:x')).toBeNull();
  });
});

describe('coord:send', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    emitAwaitedEvent.mockClear();
  });
  afterEach(() => resetCoordLog());

  it('default (wake omitted) ENQUEUES the message and fires NO wake (P-040 cheap inject)', async () => {
    const res = await coordSend.handler(parse(coordSend, { to: ['su-bee-1'], summary: 'fyi' }), ctx);
    const lines = await log.readLines('messages');
    expect(lines).toHaveLength(1); // enqueued to the inbox
    expect(lines[0].to).toEqual(['su-bee-1']);
    expect(emitAwaitedEvent).not.toHaveBeenCalled(); // no wake fired
    expect(out(res).wake).toBeUndefined();
  });

  it('wake:true ENQUEUES the message AND fires exactly the recipient keys (P-040)', async () => {
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1', 'su-bee-2'], summary: 'go', wake: true }),
      ctx,
    );
    // enqueue half (durable inbox) still happened
    const lines = await log.readLines('messages');
    expect(lines).toHaveLength(1);
    expect(lines[0].to).toEqual(['su-bee-1', 'su-bee-2']);
    // wake half: ONE emit per recipient, each on that recipient's OWN key.
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1'), inboxWakeKey('su-bee-2')]);
    expect(out(res).wake).toMatchObject({ targets: ['su-bee-1', 'su-bee-2'], woken: 2 });
  });

  it('NEVER fires a broadcast key — "*" and "human" are not wakeable (P-042)', async () => {
    await coordSend.handler(
      parse(coordSend, { to: ['*', 'human', 'su-bee-3'], summary: 'mixed', wake: true }),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    // only the concrete agent is woken; '*'/'human' are skipped
    expect(keys).toEqual([inboxWakeKey('su-bee-3')]);
    expect(keys).not.toContain('*');
    expect(keys.some((k) => k.includes('*'))).toBe(false);
  });

  it('a send to ONLY "*" fires no wake at all (P-042 — no thunder-herd)', async () => {
    const res = await coordSend.handler(
      parse(coordSend, { to: ['*'], summary: 'broadcast', wake: true }),
      ctx,
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(out(res).wake).toMatchObject({ targets: [], woken: 0 });
    // No live targets ⇒ NOT a wake-into-the-void: the warning is gated on
    // targets.length > 0 (a broadcast that wakes no one is by design, not a gap).
    expect(out(res).wake.warning).toBeUndefined();
    // the broadcast message is still in the inbox (delivery is unaffected)
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it('wake:true to a live target that wakes NO ONE returns the woken:0 warning (P-007/D-010)', async () => {
    // The addressee is a concrete agent (a real target), but nothing is
    // listening on its inbox-wake key — emitAwaitedEvent fires and resolves
    // woken:0. This is the exact su-d96e6 gap: the wake degraded to a plain
    // inbox inject and used to return a silent ok:true. P-007 surfaces it.
    emitAwaitedEvent.mockResolvedValueOnce({
      ok: true as const,
      key: inboxWakeKey('su-bee-1'),
      woken: 0,
      notified: [] as string[],
      msgId: null,
    });
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1'], summary: 'go', wake: true }),
      ctx,
    );
    // the wake was attempted on the right key…
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1')]);
    const { wake } = out(res);
    // …but woke no one, so the result is a target with woken:0 AND a warning.
    expect(wake.targets).toEqual(['su-bee-1']);
    expect(wake.woken).toBe(0);
    expect(typeof wake.warning).toBe('string');
    expect(wake.warning).toMatch(/no live wake-watch|no session was re-invoked/i);
    // the message is still durably in the inbox (the wake is the only no-op).
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it('wake:true that DOES wake an await returns NO warning (woken>0 control, P-007/D-010)', async () => {
    // default mock returns woken:1 per emit → two targets ⇒ woken:2, no warning.
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1', 'su-bee-2'], summary: 'go', wake: true }),
      ctx,
    );
    const { wake } = out(res);
    expect(wake).toMatchObject({ targets: ['su-bee-1', 'su-bee-2'], woken: 2 });
    expect(wake.warning).toBeUndefined();
  });
});

describe('coord:message-agent', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    emitAwaitedEvent.mockClear();
  });
  afterEach(() => resetCoordLog());

  it('wake:true wakes exactly the single named owner (P-040/P-042)', async () => {
    // openConversation/subscribe touch PG; they best-effort try/catch, so the
    // tool still returns and the wake half (our assertion target) runs.
    const res = await messageAgent.handler(
      parse(messageAgent, { to: 'su-owner', body: 'pick this up', wake: true }),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-owner')]);
    expect(out(res).to).toBe('su-owner');
  }, 15_000);

  it('without wake, fires no wake key', async () => {
    await messageAgent.handler(parse(messageAgent, { to: 'su-owner', body: 'fyi' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  }, 15_000);
});

describe('coord:await-inbox (D-005 idle annotation over the always-armed watch)', () => {
  beforeEach(() => {
    upsertInboxWakeAwait.mockClear();
    startAwaitSweeper.mockClear();
  });

  it('refreshes the STANDING wake watch on the caller\'s OWN inbox-wake key (via the always-arm upsert)', async () => {
    const res = await awaitInbox.handler(parse(awaitInbox, { note: 'drained' }), ctx);
    expect(startAwaitSweeper).toHaveBeenCalled();
    // D-005: routes through armInboxWake → upsertInboxWakeAwait (the idempotent
    // standing-row upsert), NOT the old registerAwait insert.
    expect(upsertInboxWakeAwait).toHaveBeenCalledTimes(1);
    const input = upsertInboxWakeAwait.mock.calls[0][0];
    expect(input.eventKey).toBe(inboxWakeKey('su-self')); // own key — the rendezvous
    expect(input.minSleepSec).toBeGreaterThan(0); // floored against burst sends
    const body = out(res);
    expect(body.ok).toBe(true);
    expect(body.inbox_wake_key).toBe(inboxWakeKey('su-self'));
    expect(body.watch).toMatchObject({ wake: true, once: false }); // standing — survives idle→woken→idle
  });

  it('honours an explicit min_sleep_sec floor', async () => {
    await awaitInbox.handler(parse(awaitInbox, { min_sleep_sec: 5 }), ctx);
    expect(upsertInboxWakeAwait.mock.calls[0][0].minSleepSec).toBe(5);
  });
});
