/**
 * cross-hive-wiring.integration.test.ts — the FULL cross-Hive boundary WIRING
 * (cross-hive-boundary-2026-06-08 P-006 composition + the strengthened P-005
 * in-process proof). Two SEPARATE Hives, each a wireCrossHiveBoundary; Hive B's
 * admission grants live in REAL PG (loadCrossHiveGrants over hive_settings). Hive A
 * addresses Hive B; B admits per its PG grant and routes the admitted request to
 * its (recording) ports; an UNGRANTED kind is rejected (sovereignty); then B
 * replies and A's onReply fires.
 *
 * The transport here is an in-process paired mesh (deterministic) — the LIVE
 * Hyperswarm transport is proven separately in cross-hive-two-hive.test.ts (a real
 * envelope crossing two real swarms). This test owns the COMPOSITION: signer →
 * sign → send → receive → verify → grant-load (PG) → admit → translate, plus the
 * durable PG-or-memory outbox and the reply path. Only the two physical machines
 * (P-005's owner/cloud-gated bit) are absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { InMemoryCrossHiveOutbox, type CrossHiveTransport, type CrossHiveWireEnvelope } from './cross-hive-transport';
import { setCrossHiveGrant, loadCrossHiveGrants } from './cross-hive-grants';
import { wireCrossHiveBoundary, type CrossHiveInboundReply } from './cross-hive-wiring';
import type { CrossHiveBoundaryPorts, CrossHiveEnvelope } from './cross-hive-boundary';

const WS = 'default';
const A_SLUG = 'hive-a';
const B_SLUG = 'hive-b';

const HIVES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hives (
    workspace_id text NOT NULL, home_slug text NOT NULL, public_key bytea NOT NULL,
    keychain_id text NOT NULL, title text, description text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, home_slug))`;
const HIVE_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hive_settings (
    workspace_id text NOT NULL, harness_slug text NOT NULL, setting_key text NOT NULL,
    value text, author_pubkey text, origin text NOT NULL DEFAULT 'local', fed_ts bigint,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, harness_slug, setting_key))`;

let db: FreshPgDb;

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

/** A Hive identity: a real Ed25519 keypair + a signer that signs with it. */
function hiveIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: rawPubkeyBase64(publicKey),
    signer: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

/**
 * An in-process paired transport mesh: each transport registers its subscriber
 * under its own Hive pubkey; send routes the wire envelope to the addressed
 * peer's subscriber. This is the deterministic stand-in for the Hyperswarm
 * transport (proven live in cross-hive-two-hive.test.ts) — it carries the EXACT
 * CrossHiveWireEnvelope so signing + verification + admission are all real.
 */
function makeTransportMesh() {
  const subs = new Map<string, (env: CrossHiveWireEnvelope) => void | Promise<unknown>>();
  return (selfPubkey: string): CrossHiveTransport => ({
    subscribe(handler) {
      subs.set(selfPubkey, handler);
    },
    async send(toHivePubkey, env) {
      const h = subs.get(toHivePubkey);
      if (!h) throw new Error(`mesh: no peer ${toHivePubkey}`);
      await h(env);
    },
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('xhive-wiring');
  await db.sql.unsafe(HIVES_DDL);
  await db.sql.unsafe(HIVE_SETTINGS_DDL);
  await db.sql`
    INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${B_SLUG}, ${Buffer.alloc(32)}, 'kc-b', 0)`;
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.hive_settings`; });

describe('cross-Hive boundary wiring — composition + PG-grant admission (P-006 / P-005 proxy)', () => {
  it('B admits A per its PG grant, rejects an ungranted kind, and the reply reaches A', async () => {
    const A = hiveIdentity();
    const B = hiveIdentity();

    // B's owner grants Hive A only the 'ask' kind — persisted in REAL PG.
    await setCrossHiveGrant(WS, B_SLUG, A.pubkey, ['ask'], db.sql);

    const mesh = makeTransportMesh();

    // B's recording ports — what an admitted request became.
    const admitted = { asks: [] as CrossHiveEnvelope[], workRequests: [] as CrossHiveEnvelope[] };
    const recordingPorts: CrossHiveBoundaryPorts = {
      async openAsk(env) { admitted.asks.push(env); return { ref: `conv-${admitted.asks.length}` }; },
      async createWorkRequest(env) { admitted.workRequests.push(env); return { ref: `wi-${admitted.workRequests.length}` }; },
    };

    const aReplies: CrossHiveInboundReply[] = [];
    const aWiring = wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: A_SLUG, hivePubkey: A.pubkey,
      transport: mesh(A.pubkey), signer: A.signer,
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      loadGrants: async () => [],
      outbox: new InMemoryCrossHiveOutbox(),
      onReply: (r) => aReplies.push(r),
    });
    const bWiring = wireCrossHiveBoundary({
      workspaceId: WS, hiveSlug: B_SLUG, hivePubkey: B.pubkey,
      transport: mesh(B.pubkey), signer: B.signer,
      requestPorts: recordingPorts,
      loadGrants: () => loadCrossHiveGrants(WS, B_SLUG, db.sql), // REAL PG grants drive admission
      outbox: new InMemoryCrossHiveOutbox(),
    });

    // 1. A sends a GRANTED ask → B verifies A's sig → loads its PG grant → admits → routes to a conversation.
    const r1 = await aWiring.send(B.pubkey, { id: 'ask-1', kind: 'ask', subject: 'can you help', body: 'with X?' });
    expect(r1.delivered).toBe(true);
    expect(admitted.asks).toHaveLength(1);
    expect(admitted.asks[0]).toMatchObject({ fromHivePubkey: A.pubkey, kind: 'ask', subject: 'can you help' });

    // 2. A sends an UNGRANTED work-request → B rejects at admission (sovereignty) → never routed.
    const r2 = await aWiring.send(B.pubkey, { id: 'wr-1', kind: 'work-request', subject: 'do this', body: 'task' });
    expect(r2.delivered).toBe(true); // delivered on the wire…
    expect(admitted.workRequests).toHaveLength(0); // …but not admitted (no grant for the kind)

    // 3. After the owner WIDENS the grant to include work-request, the next one IS admitted.
    await setCrossHiveGrant(WS, B_SLUG, A.pubkey, ['ask', 'work-request'], db.sql);
    await aWiring.send(B.pubkey, { id: 'wr-2', kind: 'work-request', subject: 'do this now', body: 'task2' });
    expect(admitted.workRequests).toHaveLength(1);
    expect(admitted.workRequests[0]).toMatchObject({ fromHivePubkey: A.pubkey, kind: 'work-request' });

    // 4. After REVOKE, a further ask is rejected — admission re-reads the live grant each time.
    await setCrossHiveGrant(WS, B_SLUG, A.pubkey, [], db.sql); // empty kinds = revoke
    await aWiring.send(B.pubkey, { id: 'ask-2', kind: 'ask', subject: 'again?', body: '...' });
    expect(admitted.asks).toHaveLength(1); // still just the first — the revoked ask is dropped

    // 5. B replies (answer) correlated to the original ask → A's onReply fires (replies are not grant-gated).
    const r5 = await bWiring.reply(A.pubkey, { kind: 'answer', subject: 're: help', body: 'yes', correlationId: 'ask-1' });
    expect(r5.delivered).toBe(true);
    expect(aReplies).toHaveLength(1);
    expect(aReplies[0]).toMatchObject({ replyKind: 'answer', correlationId: 'ask-1', body: 'yes' });
  });
});
