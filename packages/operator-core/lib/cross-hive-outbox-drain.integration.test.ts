/**
 * cross-hive-outbox-drain.integration.test.ts — the P-001 drain proof against
 * real PG (hive-network-surface-2026-06-11, brief B-01): envelopes queued while
 * a peer is offline are delivered when it returns; an offline peer is dialed
 * once per pass with the attempt durably noted (attempt_count/last_attempt_at
 * in the mig-196 table), and an immediate re-drain backs off instead of
 * hot-looping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import { drainCrossHiveOutboxOnce, DRAIN_BACKOFF_BASE_MS } from './cross-hive-outbox-drain';
import type { CrossHiveTransport, CrossHiveWireEnvelope } from './cross-hive-transport';

const WS = 'default';
const HIVE = 'hive-a';
const PEER = 'B-pubkey';

// Mirrors migration 196 (minus psql directives + role grants the test DB lacks).
const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cross_hive_outbox (
    workspace_id text NOT NULL, hive_slug text NOT NULL, id text NOT NULL,
    from_hive_pubkey text NOT NULL, to_hive_pubkey text NOT NULL, kind text NOT NULL,
    subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
    correlation_id text, sig text NOT NULL,
    created_at bigint NOT NULL DEFAULT 0, attempt_count integer NOT NULL DEFAULT 0,
    last_attempt_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, hive_slug, id),
    CONSTRAINT cross_hive_outbox_kind_check CHECK (kind IN ('ask','work-request','answer','decline')))`;

let db: FreshPgDb;

const wire = (id: string, to = PEER): CrossHiveWireEnvelope => ({
  id,
  fromHivePubkey: 'A-pubkey',
  toHivePubkey: to,
  kind: 'ask',
  subject: `subj-${id}`,
  body: `body-${id}`,
  sig: `sig-${id}`,
});

/** A transport whose deliverability is toggled; records every dial. */
function togglingTransport() {
  const sent: CrossHiveWireEnvelope[] = [];
  let dials = 0;
  let up = false;
  return {
    sent,
    get dials() {
      return dials;
    },
    setUp: (v: boolean) => {
      up = v;
    },
    transport: {
      async send(_to: string, env: CrossHiveWireEnvelope) {
        dials += 1;
        if (!up) throw new Error('peer offline');
        sent.push(env);
      },
      subscribe() {},
    } as CrossHiveTransport,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('xhive-drain');
  await db.sql.unsafe(OUTBOX_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.cross_hive_outbox`;
});

describe('drain over the real PG outbox — queued → delivered on peer return, no hot-loop', () => {
  it('notes ONE durable attempt for an offline peer, backs off on re-drain, then delivers all in order on return', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE, db.sql);
    const t = togglingTransport();
    await ob.enqueue(wire('m1'));
    await ob.enqueue(wire('m2'));

    // Pass 1 — peer offline: one dial for the whole queue, attempt durably noted.
    const now1 = Date.now();
    const out1 = await drainCrossHiveOutboxOnce({ outbox: ob, transport: t.transport, nowMs: now1 });
    expect(out1).toMatchObject({ delivered: 0, failedPeers: [PEER], pending: 2 });
    expect(t.dials).toBe(1); // no hot-loop within the pass
    const detailed1 = await ob.pendingDetailed();
    expect(detailed1.map((r) => [r.env.id, r.attemptCount])).toEqual([
      ['m1', 1], // the failed head carries the noted attempt
      ['m2', 0],
    ]);
    expect(detailed1[0].lastAttemptAt).toBeGreaterThan(0);

    // Pass 2 — immediately after: the peer is inside its backoff window → ZERO dials.
    const out2 = await drainCrossHiveOutboxOnce({ outbox: ob, transport: t.transport, nowMs: now1 + 1 });
    expect(out2).toMatchObject({ delivered: 0, backedOffPeers: [PEER], pending: 2 });
    expect(t.dials).toBe(1); // unchanged — no hot-loop across passes either

    // Pass 3 — the peer returns and the window has elapsed (anchor on the DURABLE
    // last_attempt_at — noteAttempt stamps its own clock): both deliver,
    // oldest-first, and the durable queue is empty.
    t.setUp(true);
    const out3 = await drainCrossHiveOutboxOnce({
      outbox: ob,
      transport: t.transport,
      nowMs: detailed1[0].lastAttemptAt + DRAIN_BACKOFF_BASE_MS + 1,
    });
    expect(out3).toMatchObject({ delivered: 2, failedPeers: [], pending: 0 });
    expect(t.sent.map((e) => e.id)).toEqual(['m1', 'm2']);
    expect(await ob.pending()).toEqual([]);
  });

  it('the reconnect trigger (forcePeers) delivers a backed-off peer without waiting out the window', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE, db.sql);
    const t = togglingTransport();
    await ob.enqueue(wire('m1'));

    const now = Date.now();
    await drainCrossHiveOutboxOnce({ outbox: ob, transport: t.transport, nowMs: now }); // fails → window opens
    t.setUp(true); // the peer reconnects (its HELLO would fire this in production)
    const out = await drainCrossHiveOutboxOnce({
      outbox: ob,
      transport: t.transport,
      nowMs: now + 1,
      forcePeers: [PEER],
    });
    expect(out).toMatchObject({ delivered: 1, pending: 0 });
    expect(await ob.pending()).toEqual([]);
  });

  it('per-peer isolation: one offline peer never blocks another peer’s delivery', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE, db.sql);
    await ob.enqueue(wire('m1', 'down-peer'));
    await ob.enqueue(wire('n1', 'up-peer'));
    const sent: string[] = [];
    const transport = {
      async send(to: string, env: CrossHiveWireEnvelope) {
        if (to === 'down-peer') throw new Error('offline');
        sent.push(env.id);
      },
      subscribe() {},
    } as CrossHiveTransport;
    const out = await drainCrossHiveOutboxOnce({ outbox: ob, transport, nowMs: Date.now() });
    expect(out).toMatchObject({ delivered: 1, failedPeers: ['down-peer'], pending: 1 });
    expect(sent).toEqual(['n1']);
    expect((await ob.pending()).map((e) => e.id)).toEqual(['m1']);
  });
});
