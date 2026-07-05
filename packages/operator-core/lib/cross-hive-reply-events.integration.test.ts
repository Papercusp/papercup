/**
 * cross-hive-reply-events.integration.test.ts — brief B-03's required proof
 * (hive-network-surface-2026-06-11 P-002): an inbound cross-Hive ANSWER, received
 * through the full wiring, (1) persists the C-1 transition (ask → answered),
 * (2) fires the REAL await-event engine on the C-4 key, and (3) queues a durable
 * wake delivery for the events:await-ing Queen — the path that re-invokes a
 * sleeping asker (replacing the ephemeral onReply as the production path).
 *
 * Real PG (migrated org schema: event_awaits + event_wake_deliveries) + the real
 * emitAwaitedEvent; the C-1 store is the in-memory reference ledger until B-02's
 * PG store lands (the receive side only sees the CrossHiveAskLedger port either
 * way). Follows the org-fixture mock pattern (test/_org-test-db.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-xhive-reply' }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const store = await import('./events/await/store');
const {
  InMemoryCrossHiveAskLedger,
  InMemoryCrossHiveOutbox,
  crossHiveReplyEventKey,
} = await import('./cross-hive-transport');
const { wireCrossHiveBoundary } = await import('./cross-hive-wiring');
const { PgCrossHiveAsks } = await import('./cross-hive-asks-pg');

type Transport = import('./cross-hive-transport').CrossHiveTransport;
type WireEnvelope = import('./cross-hive-transport').CrossHiveWireEnvelope;
type AskRow = import('./cross-hive-transport').CrossHiveAskRow;

const WS = h.ws;
const QUEEN = 'su-queen-asker';

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

function hiveIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: rawPubkeyBase64(publicKey),
    signer: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

function makeTransportMesh() {
  const subs = new Map<string, (env: WireEnvelope) => void | Promise<unknown>>();
  return (selfPubkey: string): Transport => ({
    subscribe(handler) {
      subs.set(selfPubkey, handler);
    },
    async send(toHivePubkey, env) {
      const fn = subs.get(toHivePubkey);
      if (!fn) throw new Error(`mesh: no peer ${toHivePubkey}`);
      await fn(env);
    },
  });
}

function outAsk(correlationId: string, peerPubkey: string): AskRow {
  const now = new Date().toISOString();
  return {
    workspaceId: WS,
    hiveSlug: 'hive-a',
    id: `uuid-${correlationId}`,
    peerPubkey,
    direction: 'out',
    kind: 'ask',
    subject: 'can you take WI-9?',
    body: 'details…',
    correlationId,
    state: 'sent',
    replyBody: null,
    replyTs: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('cross-Hive reply → ledger transition + C-4 event + queued wake (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  // The REAL emit kicks the wake pump (setImmediate), whose executor rightly warns
  // "dead waiter" for our fake Queen subscriber — expected background noise, async
  // enough to land inside any test. vitest-fail-on-console re-patches console.warn
  // per test, so the spy must be re-installed AFTER its patch — beforeEach, not
  // beforeAll (a beforeAll spy gets wrapped and the warn still counts as a failure).
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(async () => {
    await db?.cleanup();
    vi.restoreAllMocks();
  });

  const ports = { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } };

  function twoHives(ledger?: InstanceType<typeof InMemoryCrossHiveAskLedger>) {
    const A = hiveIdentity();
    const B = hiveIdentity();
    const mesh = makeTransportMesh();
    wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: 'hive-a', hivePubkey: A.pubkey,
      transport: mesh(A.pubkey), signer: A.signer, requestPorts: ports,
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
      // No ledger passed = the PRODUCTION default (pgCrossHiveAskLedger over the
      // mocked org pool). REAL emitAwaitedEvent either way — no emitEvent injection.
      ...(ledger ? { askLedger: ledger } : {}),
    });
    const bWiring = wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: 'hive-b', hivePubkey: B.pubkey,
      transport: mesh(B.pubkey), signer: B.signer, requestPorts: ports,
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
    });
    return { A, B, mesh, bWiring };
  }

  it('answer: row answered, the await fires, a wake delivery is queued for the Queen', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    const t = twoHives(ledger);
    ledger.seed(outAsk('ask-1', t.B.pubkey));

    // The asking Queen registers the documented chain's await on the C-4 key.
    const key = crossHiveReplyEventKey('answer', 'ask-1');
    await store.registerAwait({ subscriberId: QUEEN, eventKey: key, workspaceId: WS });

    // The peer Hive answers — through the wire, signature-verified, into the receive path.
    const r = await t.bWiring.reply(t.A.pubkey, {
      kind: 'answer', subject: 're: WI-9', body: 'yes — queued it', correlationId: 'ask-1',
    });
    expect(r.delivered).toBe(true);

    // (1) C-1 transition persisted.
    expect(ledger.get('ask-1')!.state).toBe('answered');
    expect(ledger.get('ask-1')!.replyBody).toBe('yes — queued it');

    // (2) The await fired — one-shot consumed by the emit.
    const active = await store.listActiveAwaitsForKey(key, WS);
    expect(active).toHaveLength(0);

    // (3) A durable wake delivery exists for the Queen on the C-4 key, carrying the
    // ledger row as payload. (The pump may already be attempting delivery — any
    // status proves the wake was queued; rows are never deleted. No workspace_id
    // predicate: the await store pins all rows to DEFAULT_COORD_WORKSPACE — events
    // are coord-plane — regardless of the caller's workspaceId.)
    const deliveries = (await db.adminSql`
      SELECT subscriber_id, event_key, payload
        FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id = ${QUEEN} AND event_key = ${key}
    `) as unknown as { subscriber_id: string; event_key: string; payload: unknown }[];
    expect(deliveries).toHaveLength(1);
    const payload = typeof deliveries[0].payload === 'string' ? JSON.parse(deliveries[0].payload) : deliveries[0].payload;
    expect(payload).toMatchObject({ correlationId: 'ask-1', state: 'answered', replyBody: 'yes — queued it' });
  });

  it('decline: the declined C-4 key wakes its awaiter', async () => {
    const ledger = new InMemoryCrossHiveAskLedger();
    const t = twoHives(ledger);
    ledger.seed(outAsk('ask-2', t.B.pubkey));

    const key = crossHiveReplyEventKey('decline', 'ask-2');
    await store.registerAwait({ subscriberId: QUEEN, eventKey: key, workspaceId: WS });

    await t.bWiring.reply(t.A.pubkey, { kind: 'decline', subject: 're', body: 'at capacity', correlationId: 'ask-2' });

    expect(ledger.get('ask-2')!.state).toBe('declined');
    const deliveries = (await db.adminSql`
      SELECT id FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id = ${QUEEN} AND event_key = ${key}
    `) as unknown as { id: number }[];
    expect(deliveries).toHaveLength(1);
  });

  it('PRODUCTION DEFAULT: the real cross_hive_asks row (migration 231) transitions and the wake queues', async () => {
    const t = twoHives(); // no askLedger injected — the wiring's PG default
    const pgStore = new PgCrossHiveAsks(WS, 'hive-a');

    // What pot:ask's enqueue does: queued row → sent after the wire delivery.
    const ask = await pgStore.insert({ peerPubkey: t.B.pubkey, kind: 'ask', correlationId: 'ask-3', subject: 'real ledger?', body: '…' });
    await pgStore.markSent(ask.id);

    const key = crossHiveReplyEventKey('answer', 'ask-3');
    await store.registerAwait({ subscriberId: QUEEN, eventKey: key, workspaceId: WS });

    await t.bWiring.reply(t.A.pubkey, { kind: 'answer', subject: 're', body: 'for real', correlationId: 'ask-3' });

    const settled = await pgStore.getByCorrelationId('ask-3');
    expect(settled!.state).toBe('answered');
    expect(settled!.replyBody).toBe('for real');
    const deliveries = (await db.adminSql`
      SELECT payload FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id = ${QUEEN} AND event_key = ${key}
    `) as unknown as { payload: unknown }[];
    expect(deliveries).toHaveLength(1);
    const payload = typeof deliveries[0].payload === 'string' ? JSON.parse(deliveries[0].payload) : deliveries[0].payload;
    expect(payload).toMatchObject({ correlationId: 'ask-3', state: 'answered' });
  });

  it('SPOOF GUARD: a third Hive replying to someone else\'s ask neither settles the row nor wakes anyone', async () => {
    const t = twoHives();
    const pgStore = new PgCrossHiveAsks(WS, 'hive-a');
    const ask = await pgStore.insert({ peerPubkey: t.B.pubkey, kind: 'ask', correlationId: 'ask-4', subject: 's', body: 'b' });
    await pgStore.markSent(ask.id);

    const key = crossHiveReplyEventKey('answer', 'ask-4');
    await store.registerAwait({ subscriberId: QUEEN, eventKey: key, workspaceId: WS });

    // Hive C — validly signed, but NOT the peer hive-a asked.
    const C = hiveIdentity();
    const cWiring = wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: 'hive-c', hivePubkey: C.pubkey,
      transport: t.mesh(C.pubkey), signer: C.signer, requestPorts: ports,
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
    });
    const r = await cWiring.reply(t.A.pubkey, { kind: 'answer', subject: 'forged', body: 'gotcha', correlationId: 'ask-4' });
    expect(r.delivered).toBe(true); // it crossed the wire with a valid signature…

    expect((await pgStore.getByCorrelationId('ask-4'))!.state).toBe('sent'); // …but settled nothing
    const deliveries = (await db.adminSql`
      SELECT id FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id = ${QUEEN} AND event_key = ${key}
    `) as unknown as { id: number }[];
    expect(deliveries).toHaveLength(0); // and woke no one
  });
});
