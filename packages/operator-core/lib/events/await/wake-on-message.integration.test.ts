// @vitest-environment node
/**
 * wake-on-message.integration.test.ts — the wake-on-message rung
 * (coord-system-e2e-testing-2026-06-10 P-009, socket-inject path).
 *
 * deliver-and-wake.test.ts proves coord:send {wake:true} fires the right
 * inbox-wake KEYS — with the engine MOCKED. wake-pump-isolation proves the
 * pump delivers a hand-fired key via the real socket. THIS suite closes the
 * remaining composition cell with NOTHING mocked between the verb and the
 * socket: the REAL coord:send tool → real `emitAwaitedEvent` → real await
 * store (PG) → real pump → real `findLiveHost`/`injectIntoHost` against the
 * keystone testbed's isolated psu-pty dir → the idle session's live control
 * socket receives the injected turn, and the message itself is durably in
 * the recipient's inbox (what the woken session's [coord+N] injection
 * renders). EI-152's lesson: it's exactly these unmocked compositions that
 * ship bugs past 27 green unit tests.
 *
 * The RESUME path of P-009 (real claude CLI in the EI-155 isolated config
 * dir) stays in the gated live smoke `apps/operator/scripts/resume-spawn-live.ts`
 * — credentials-gated, never CI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { MultiSessionTestbed } from '../../../test/_multi-session-testbed';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-wake-msg' }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const store = await import('./store');
const engine = await import('./engine');
const { armInboxWake } = await import('./inbox-wake-arm');
const { configureCoordLog, resetCoordLog } = await import('../../agent-tools/coordination/log');
const coordSend = (await import('../../agent-tools/coordination/tools/send')).default;
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const parse = <T>(tool: { args: { parse: (x: unknown) => unknown } }, x: unknown): T =>
  tool.args.parse(x) as T;
// coord:send is bulk (P-006): the handler returns the canonical { data: envelope }.
const out = (res: unknown) => (res as { data: any }).data;

describe('coord:send {wake:true} → real engine → real pump → real socket (P-009)', () => {
  let db: OrgTestDb;
  let tb: MultiSessionTestbed;
  let log: InMemoryCoordLog;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    // The pump narrates deliveries via console.warn — expected noise.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    tb = MultiSessionTestbed.create();
  });

  afterEach(async () => {
    resetCoordLog();
    if (tb) await tb.destroy();
  });

  const uid = (tag: string) => `su-${tag}-${Math.random().toString(36).slice(2, 10)}`;

  it('a directed send wakes EXACTLY the idle addressee through its live socket; the message is in its inbox', async () => {
    const sender = uid('a');
    const idleB = uid('b');
    const bystanderC = uid('c');

    // Idle sessions: always-armed inbox watch + a live psu control socket.
    await armInboxWake({ ownerId: idleB, workspaceId: h.ws });
    await armInboxWake({ ownerId: bystanderC, workspaceId: h.ws });
    const hostB = await tb.spawnSocketHost(idleB);
    const hostC = await tb.spawnSocketHost(bystanderC);

    // The REAL verb, exactly as the sender's session calls it.
    const res = out(await coordSend.handler(
      parse(coordSend, {
        to: [idleB],
        summary: `wake-rung ping for ${idleB}`,
        body: 'P-009: directed deliver-and-wake — please read your inbox.',
        wake: true,
      }),
      { uiClientId: sender, isSuperuser: true, workspaceId: h.ws } as never,
    ));
    // coord:send is bulk (P-006): the single send is n=1 — the per-message
    // fields (msg_id / wake) live on results[0]; the envelope carries ok/counts.
    expect(res.ok).toBe(true);
    const one = res.results[0];
    expect(typeof one.msg_id).toBe('string');
    expect(one.wake?.woken).toBe(1); // a {wake:true} that woke nobody would be 0

    // Drain the real pump with host discovery pointed at the isolated dir.
    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });

    // Delivered over B's LIVE socket; C (also idle + armed) untouched.
    const bDeliveries = await store.listRecentDeliveries(idleB);
    expect(bDeliveries[0]).toMatchObject({ status: 'delivered', channel: 'psu-socket-inject' });
    expect(hostB.received).toHaveLength(1);
    expect(hostB.received[0]).toMatchObject({ v: 1, mode: 'turn' });
    expect(hostC.received).toHaveLength(0);
    expect(await store.listRecentDeliveries(bystanderC)).toHaveLength(0);

    // The injected turn points the woken session at its wake (the standing
    // inbox watch), and the MESSAGE itself is durably in B's inbox — the
    // content its [coord+N] injection renders on the woken turn.
    const envelope = JSON.stringify(hostB.received[0]);
    expect(envelope).toContain(idleB); // the wake is B's own, never a broadcast
    const lines = await log.readLines('messages');
    const mine = lines.filter(
      (e) => (e as { msg_id?: string }).msg_id === one.msg_id
        || (e as { msgId?: string }).msgId === one.msg_id,
    );
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0])).toContain(`wake-rung ping for ${idleB}`);
  });

  it('remains wakeable AFTER the first wake — a second directed send still delivers (EI-313 regression)', async () => {
    // The always-armed watch is once=false (standing): firing it must NOT
    // consume it, so an idle agent woken once stays wakeable. This is the exact
    // symptom EI-313 reported ("unwakeable after first wake"); pinning it
    // end-to-end (real verb → engine → pump → socket) would catch any future
    // regression that consumes/cancels the watch on first delivery. Arm with a
    // zero floor so the two sends don't COALESCE (the 60s floor coalescing is
    // correct behavior, separately covered — here we isolate watch survival).
    const sender = uid('a3');
    const idleB = uid('b3');
    await armInboxWake({ ownerId: idleB, workspaceId: h.ws, minSleepSec: 0 });
    const hostB = await tb.spawnSocketHost(idleB);

    const send = async (n: number) =>
      out(await coordSend.handler(
        parse(coordSend, { to: [idleB], summary: `wake #${n} for ${idleB}`, body: `ping ${n}`, wake: true }),
        { uiClientId: sender, isSuperuser: true, workspaceId: h.ws } as never,
      ));

    // First wake → delivered. (bulk n=1 → per-message fields on results[0].)
    const r1 = await send(1);
    expect(r1.results[0].wake?.woken).toBe(1);
    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });
    expect(hostB.received).toHaveLength(1);

    // Second wake to the SAME agent → still woken, still delivered. A consumed
    // or cancelled watch would return woken:0 and never reach the socket.
    const r2 = await send(2);
    expect(r2.results[0].wake?.woken).toBe(1);
    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });
    expect(hostB.received).toHaveLength(2);

    // Both deliveries are durable + delivered over B's own socket.
    const deliveries = await store.listRecentDeliveries(idleB);
    expect(deliveries.filter((d) => d.status === 'delivered')).toHaveLength(2);
    expect(hostB.received.every((m) => JSON.stringify(m).includes(idleB))).toBe(true);
  });

  it('wake:false (plain inject) enqueues the message but never touches the socket', async () => {
    const sender = uid('a2');
    const idleB = uid('b2');
    await armInboxWake({ ownerId: idleB, workspaceId: h.ws });
    const hostB = await tb.spawnSocketHost(idleB);

    const res = out(await coordSend.handler(
      parse(coordSend, {
        to: [idleB],
        summary: 'ambient note — no wake',
        wake: false,
      }),
      { uiClientId: sender, isSuperuser: true, workspaceId: h.ws } as never,
    ));
    expect(res.ok).toBe(true);

    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });

    expect(hostB.received).toHaveLength(0); // inject is cheap: inbox only
    expect(await store.listRecentDeliveries(idleB)).toHaveLength(0);
    // Standing watch still armed — an inject must never consume it.
    const { inboxWakeKey } = await import('../../agent-tools/coordination/inbox-wake');
    const active = (await store.listActiveAwaits(idleB)).filter((a) => a.eventKey === inboxWakeKey(idleB));
    expect(active).toHaveLength(1);
  });
});
