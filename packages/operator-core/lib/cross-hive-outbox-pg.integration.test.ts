/**
 * cross-hive-outbox-pg.integration.test.ts — the durable PG store-and-forward
 * outbox for the cross-Hive boundary (cross-hive-boundary-2026-06-08 P-006),
 * against real PG. Proves the full wire envelope round-trips, dedup on id,
 * markDelivered removes, per-Hive scoping isolates, and the durable outbox drives
 * the real sendCrossHive / flushCrossHiveOutbox store-and-forward (enqueue → fail
 * → queued → reconnect → redelivered).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import {
  sendCrossHive,
  flushCrossHiveOutbox,
  type CrossHiveTransport,
  type CrossHiveWireEnvelope,
} from './cross-hive-transport';

const WS = 'default';
const HIVE_A = 'hive-a';
const HIVE_B = 'hive-b';

// Mirrors migration 196 (minus the psql directives + role grants the test DB lacks).
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

const wire = (id: string, over: Partial<CrossHiveWireEnvelope> = {}): CrossHiveWireEnvelope => ({
  id,
  fromHivePubkey: 'A-pubkey',
  toHivePubkey: 'B-pubkey',
  kind: 'ask',
  subject: `subj-${id}`,
  body: `body-${id}`,
  sig: `sig-${id}`,
  ...over,
});

/** A transport whose deliverability is toggled — to drive store-and-forward. */
function togglingTransport() {
  const sent: CrossHiveWireEnvelope[] = [];
  let up = false;
  return {
    sent,
    setUp: (v: boolean) => { up = v; },
    transport: {
      async send(_to: string, env: CrossHiveWireEnvelope) {
        if (!up) throw new Error('peer offline');
        sent.push(env);
      },
      subscribe() {},
    } as CrossHiveTransport,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('xhive-outbox');
  await db.sql.unsafe(OUTBOX_DDL);
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.cross_hive_outbox`; });

describe('PgCrossHiveOutbox round-trip', () => {
  it('starts empty', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    expect(await ob.pending()).toEqual([]);
  });

  it('enqueue → pending reconstructs the full wire envelope (incl. correlationId)', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    await ob.enqueue(wire('e1'));
    await ob.enqueue(wire('e2', { kind: 'answer', correlationId: 'req-1' }));
    const pending = await ob.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toEqual(wire('e1')); // oldest-first; no correlationId key when absent
    expect(pending[1]).toEqual(wire('e2', { kind: 'answer', correlationId: 'req-1' }));
  });

  it('enqueue is idempotent on envelope id (no duplicate)', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    await ob.enqueue(wire('dup'));
    await ob.enqueue(wire('dup', { body: 'changed' })); // same id → ignored
    const pending = await ob.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('body-dup');
  });

  it('markDelivered removes (idempotent)', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    await ob.enqueue(wire('x'));
    await ob.markDelivered('x');
    await ob.markDelivered('x'); // second call is a no-op
    expect(await ob.pending()).toEqual([]);
  });

  it('scopes per sending Hive — A and B outboxes are isolated', async () => {
    const a = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    const b = new PgCrossHiveOutbox(WS, HIVE_B, db.sql);
    await a.enqueue(wire('a1'));
    await b.enqueue(wire('b1'));
    expect((await a.pending()).map((e) => e.id)).toEqual(['a1']);
    expect((await b.pending()).map((e) => e.id)).toEqual(['b1']);
  });
});

describe('durable store-and-forward over the real send/flush', () => {
  it('enqueues durably, queues on a down peer, then redelivers on reconnect', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    const t = togglingTransport();

    // Peer offline: send fails → stays queued, durably in PG.
    const r1 = await sendCrossHive(wire('m1'), { transport: t.transport, outbox: ob });
    expect(r1).toEqual({ delivered: false, queued: true });
    expect(t.sent).toHaveLength(0);
    expect((await ob.pending()).map((e) => e.id)).toEqual(['m1']);

    // A second message also queues.
    await sendCrossHive(wire('m2'), { transport: t.transport, outbox: ob });
    expect((await ob.pending()).map((e) => e.id)).toEqual(['m1', 'm2']);

    // Peer reconnects → flush redelivers both and clears the durable queue.
    t.setUp(true);
    const flushed = await flushCrossHiveOutbox({ transport: t.transport, outbox: ob });
    expect(flushed).toEqual({ delivered: 2, pending: 0 });
    expect(t.sent.map((e) => e.id)).toEqual(['m1', 'm2']);
    expect(await ob.pending()).toEqual([]);
  });

  it('delivers immediately when the peer is up (marked delivered, nothing left queued)', async () => {
    const ob = new PgCrossHiveOutbox(WS, HIVE_A, db.sql);
    const t = togglingTransport();
    t.setUp(true);
    const r = await sendCrossHive(wire('m3'), { transport: t.transport, outbox: ob });
    expect(r).toEqual({ delivered: true, queued: false });
    expect(t.sent.map((e) => e.id)).toEqual(['m3']);
    expect(await ob.pending()).toEqual([]);
  });
});
