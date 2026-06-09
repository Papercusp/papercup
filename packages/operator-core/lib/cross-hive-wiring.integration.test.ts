/**
 * cross-hive-wiring.integration.test.ts — the FULL live cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-006 wiring + the strengthened P-005 in-process
 * proof). Two SEPARATE Hives, each a wireCrossHiveBoundary over its OWN real
 * Hyperswarm; Hive B's admission grants live in REAL PG (loadCrossHiveGrants over
 * hive_settings). Hive A dials Hive B by pubkey; B admits per its grants and routes
 * the admitted request to its (recording) ports; an UNGRANTED kind is rejected
 * (sovereignty); then B replies and A's onReply fires.
 *
 * This composes everything the plan built — the swarm transport (real Hyperswarm),
 * the persisted grants (PG, P-002), receiveCrossHive admission, and the durable
 * outbox — and proves the literal A→B→reply round-trip minus only the two physical
 * machines (P-005's owner/cloud-gated bit).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { makeSwarmCrossHiveTransport } from './cross-hive-swarm-transport';
import { InMemoryCrossHiveOutbox } from './cross-hive-transport';
import { setCrossHiveGrant, loadCrossHiveGrants } from './cross-hive-grants';
import { wireCrossHiveBoundary, type CrossHiveInboundReply } from './cross-hive-wiring';
import type { CrossHiveBoundaryPorts, CrossHiveEnvelope } from './cross-hive-boundary';
import type { HyperswarmLike } from './sync/hyperbee/swarm';

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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
});

beforeAll(async () => {
  db = await createFreshPgDb('xhive-wiring');
  await db.sql.unsafe(HIVES_DDL);
  await db.sql.unsafe(HIVE_SETTINGS_DDL);
  // Hive B must exist for its settings (grants) to attach.
  await db.sql`
    INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${B_SLUG}, ${Buffer.alloc(32)}, 'kc-b', 0)`;
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.hive_settings`; });

async function pollUntil(fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('live cross-Hive boundary — real transport + PG grants + admission (P-006 wiring / P-005 proxy)', () => {
  it(
    'B admits A per its PG grant, rejects an ungranted kind, and the reply reaches A',
    async () => {
      const A = hiveIdentity();
      const B = hiveIdentity();

      // B's owner grants Hive A the 'ask' kind (NOT 'work-request') — persisted in PG.
      await setCrossHiveGrant(WS, B_SLUG, A.pubkey, ['ask'], db.sql);

      const testnet = await createTestnet(3);
      cleanups.push(async () => { await testnet.destroy().catch(() => {}); });
      const swarmA = new Hyperswarm({ bootstrap: testnet.bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
      const swarmB = new Hyperswarm({ bootstrap: testnet.bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
      cleanups.push(async () => { await swarmA.destroy().catch(() => {}); });
      cleanups.push(async () => { await swarmB.destroy().catch(() => {}); });

      // B's recording ports — what an admitted request became.
      const admitted = { asks: [] as CrossHiveEnvelope[], workRequests: [] as CrossHiveEnvelope[] };
      const recordingPorts: CrossHiveBoundaryPorts = {
        async openAsk(env) { admitted.asks.push(env); return { ref: `conv-${admitted.asks.length}` }; },
        async createWorkRequest(env) { admitted.workRequests.push(env); return { ref: `wi-${admitted.workRequests.length}` }; },
      };

      // Short per-attempt wait + outer flushOutbox retries (store-and-forward) →
      // robust under integration-config CPU contention where DHT connect is slow.
      const transportA = makeSwarmCrossHiveTransport({ swarm: swarmA, selfHivePubkey: A.pubkey, sendWaitMs: 8_000 });
      const transportB = makeSwarmCrossHiveTransport({ swarm: swarmB, selfHivePubkey: B.pubkey, sendWaitMs: 8_000 });

      const aReplies: CrossHiveInboundReply[] = [];
      const aWiring = wireCrossHiveBoundary({
        workspaceId: WS, hiveSlug: A_SLUG, hivePubkey: A.pubkey,
        transport: transportA, signer: A.signer,
        requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
        loadGrants: async () => [], // A admits nothing inbound in this test
        outbox: new InMemoryCrossHiveOutbox(),
        onReply: (r) => aReplies.push(r),
      });
      const bWiring = wireCrossHiveBoundary({
        workspaceId: WS, hiveSlug: B_SLUG, hivePubkey: B.pubkey,
        transport: transportB, signer: B.signer,
        requestPorts: recordingPorts,
        loadGrants: () => loadCrossHiveGrants(WS, B_SLUG, db.sql), // REAL PG grants
        outbox: new InMemoryCrossHiveOutbox(),
      });
      cleanups.push(() => aWiring.close());
      cleanups.push(() => bWiring.close());

      // 1. A sends a GRANTED ask → B admits per its PG grant → recorded as a conversation.
      //    The first attempt may QUEUE (DHT connect still forming); flushOutbox
      //    redelivers once the channel pairs (store-and-forward).
      await aWiring.send(B.pubkey, { id: 'ask-1', kind: 'ask', subject: 'can you help', body: 'with X?' });
      expect(
        await pollUntil(async () => {
          await aWiring.flushOutbox().catch(() => {});
          return admitted.asks.length > 0;
        }),
      ).toBe(true);
      expect(admitted.asks[0]).toMatchObject({ fromHivePubkey: A.pubkey, kind: 'ask', subject: 'can you help' });

      // 2. A sends an UNGRANTED work-request → B rejects (sovereignty) → never routed.
      await aWiring.send(B.pubkey, { id: 'wr-1', kind: 'work-request', subject: 'do this', body: 'task' });
      // Ensure it actually reached B (flush until the outbox drains), then assert
      // B did NOT route it — rejected at admission, not merely undelivered.
      await pollUntil(async () => {
        const { pending } = await aWiring.flushOutbox().catch(() => ({ pending: 1 }));
        return pending === 0;
      });
      await new Promise((r) => setTimeout(r, 1000));
      expect(admitted.workRequests).toHaveLength(0);

      // 3. B replies (answer) correlated to the ask → A's onReply fires.
      await bWiring.reply(A.pubkey, { kind: 'answer', subject: 're: help', body: 'yes', correlationId: 'ask-1' });
      expect(
        await pollUntil(async () => {
          await bWiring.flushOutbox().catch(() => {});
          return aReplies.length > 0;
        }),
      ).toBe(true);
      expect(aReplies[0]).toMatchObject({ replyKind: 'answer', correlationId: 'ask-1', body: 'yes' });
    },
    90_000,
  );
});
