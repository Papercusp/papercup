/**
 * cross-peer-coordination.integration.test.ts — the cross-peer COORDINATION test
 * that closes the gap the authority/claim suites left open.
 *
 * `work-item-claims-two-instance` and `two-instance-hive-authority` prove authority
 * routing + claim/lock serialization, but they INJECT the Hive presence roster (a
 * fixed `fetchHivePresenceRows` array — see their own "Presence is INJECTED" notes).
 * So nothing proved that the roster the authority election runs over actually
 * FEDERATES across peers. This wires the REAL pieces end-to-end over the SAME
 * two-peer testnet-DHT harness the federation suite uses:
 *
 *   1. Two Swarms (alice/bob) each ANNOUNCE their own presence as a `table:'presence'`
 *      op on their OWN peer-log; the REAL `buildPresenceProjection` writes it to each
 *      peer's OWN throwaway `shared_presence` PG.
 *   2. Over the real Hyperswarm wire each Swarm's presence FEDERATES to the other —
 *      so each peer's `shared_presence` ends up holding the OTHER Swarm (mutual
 *      presence federation; the assertion the injected-roster tests can't make).
 *   3. The REAL Hive authority election (`lockAuthorityForHive` over the production
 *      `queryPresenceRowsForHive`) run on EACH peer's FEDERATED roster elects the
 *      SAME Swarm (argmin device_pubkey) — no split-brain.
 *   4. Both Swarms then contend for one work-item, routing the claim to that
 *      federated-presence-elected authority over the real `HttpPeerRpcTransport` →
 *      the authority's single real store grants EXACTLY ONE (cross-peer exactly-once).
 *
 * Proof boundary: REAL corestores/logs, REAL Hyperswarm/Noise over a local testnet
 * DHT, REAL announce signature verification, REAL presence projection → PG, REAL
 * `lockAuthorityForHive` election, REAL claim store + RPC. STOOD-IN (offline-
 * deterministic, exactly as every sibling): the channel-2 GitHub-binding fetch
 * (`verifyBindingOverride`).
 */
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildPresenceProjection } from '../projections/presence';
import {
  lockAuthorityForHive,
  queryPresenceRowsForHive,
  routeToAuthorityForHive,
  type LockAuthorityDeps,
} from '../../../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../../authority/http-peer-rpc-transport';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../../../authority/authority-op-registry';
import { __resetRemotePeersCacheForTests } from '../../../authority/remote-peers-cache';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import type { AcquireResult, AcquireOpts } from '../../../work-item-claims';

// ── getOrgPg → the AUTHORITY's PG (the claim store's single serialization point).
//    Only `acquireClaimLocal` (run on the authority) reads it; the presence
//    projection + election queries are passed an explicit `sql`, so this mock does
//    not touch them. Rebound per-test once the federated election names the authority.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
const { registerWorkItemClaimAuthorityOps } = await import('../../../work-item-claim-authority-ops');
const { WORK_ITEM_CLAIM_OP_KINDS, getClaim, acquireClaimLocal } = await import('../../../work-item-claims');

const WORKSPACE_ID = 'ws-xpeer-coord';
const HARNESS_SLUG = 'xpeer-coord';
const HIVE_SLUG = 'shared-hive';
const BINDING = { kind: 'local' as const, workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG };

const SHARED_PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
    workspace_id   text DEFAULT ''::text NOT NULL,
    harness_slug   text NOT NULL,
    github_user_id bigint NOT NULL,
    machine_label  text NOT NULL,
    device_pubkey  text NOT NULL,
    intent         text,
    current_view   text,
    last_seen_at   timestamptz DEFAULT now() NOT NULL,
    schema_version bigint DEFAULT 1 NOT NULL,
    hive_slug      text,
    fed_ts         bigint,
    PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
  )`;
const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    hive_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

// ── async resource teardown (newest-first). ──
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* a thrown assertion must never leak a swarm/dir/db/DHT node */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
  __resetRemotePeersCacheForTests();
});

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

function makeIdentity(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function makeTestnet() {
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });
  return testnet;
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A per-peer apply that routes `table:'presence'` ops through the REAL presence
 *  projection bound to THIS peer's `sql` (writes its federated `shared_presence`). */
function buildPresenceApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const proj = buildPresenceProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }) as TableProjection<unknown>;
  const scoped = new Map<string, TableProjection<unknown>>([[proj.tableTag, proj]]);
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

interface PresencePeer {
  handle: BootedHarnessHandle;
}

async function bootPresencePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentity>;
  sql: postgres.Sql;
  /** Conclusive admission predicate over the announcing peer's userId. */
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
}): Promise<PresencePeer> {
  const root = makeWorkspaceRoot(opts.rootPrefix);
  let handle: BootedHarnessHandle | undefined;
  let apply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
  handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    swarmBinding: BINDING,
    swarmOverride: makeSwarm(opts.testnetBootstrap),
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    applyOverride: (op) => {
      apply ??= buildPresenceApply(opts.sql, handle!.ownLog.keyHex);
      return apply(op);
    },
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: opts.identity.override,
  });
  cleanups.push(async () => {
    await handle?.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
  });
  return { handle };
}

function presenceValue(userId: number, machine: string, pubkey: string) {
  return {
    harness_slug: HARNESS_SLUG,
    github_user_id: userId,
    machine_label: machine,
    device_pubkey: pubkey,
    intent: null,
    current_view: null,
    last_seen_at: Date.now(),
    schema_version: 1,
    hive_slug: HIVE_SLUG,
  };
}

async function devicePubkeysFor(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<Array<{ device_pubkey: string }>>`
    SELECT device_pubkey FROM harness_shared.shared_presence
     WHERE harness_slug = ${HARNESS_SLUG} AND device_pubkey <> ''
  `;
  return new Set(rows.map((r) => r.device_pubkey));
}

/** Election deps that read THIS peer's federated `shared_presence` (not an injected roster). */
function electionDeps(sql: postgres.Sql, self: { githubUserId: number; devicePubkey: string }): LockAuthorityDeps {
  return {
    now: () => Date.now(),
    staleMs: 600_000,
    resolveSelf: async () => self,
    fetchHivePresenceRows: (hiveSlug: string) => queryPresenceRowsForHive(sql as never, hiveSlug),
  };
}

/**
 * Stand up two Swarms of one Hive, federate their presence over the real wire, and
 * return both peers' handles + DBs once each peer's `shared_presence` holds the
 * OTHER Swarm (federation complete). The shared fixture for every test below.
 */
async function federateTwoPeerPresence() {
  const dbA: FreshPgDb = await createFreshPgDb('xpeerA');
  cleanups.push(() => dbA.cleanup());
  const dbB: FreshPgDb = await createFreshPgDb('xpeerB');
  cleanups.push(() => dbB.cleanup());
  await dbA.sql.unsafe(SHARED_PRESENCE_DDL);
  await dbB.sql.unsafe(SHARED_PRESENCE_DDL);

  const testnet = await makeTestnet();
  const idA = makeIdentity('alice', 42, 'kc-alice');
  const idB = makeIdentity('bob', 7, 'kc-bob');

  // Each Swarm admits the OTHER's userId (mutual admission).
  const peerB = await bootPresencePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'xpeer-B-',
    identity: idB,
    sql: dbB.sql,
    verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
  });
  const peerA = await bootPresencePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'xpeer-A-',
    identity: idA,
    sql: dbA.sql,
    verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
  });

  expect(peerA.handle.swarm).not.toBeNull();
  expect(peerB.handle.swarm).not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  // Each Swarm announces its OWN presence on its OWN peer-log.
  await peerA.handle.append({
    type: 'put',
    table: 'presence',
    hbKey: `${idA.userId}/machine-A`,
    value: presenceValue(idA.userId, 'machine-A', idA.devicePubkey),
    ts: 1000,
    schema_version: 1,
    writerPubkey: idA.devicePubkey,
  });
  await peerB.handle.append({
    type: 'put',
    table: 'presence',
    hbKey: `${idB.userId}/machine-B`,
    value: presenceValue(idB.userId, 'machine-B', idB.devicePubkey),
    ts: 1001,
    schema_version: 1,
    writerPubkey: idB.devicePubkey,
  });

  // Federation is complete when each peer's PG holds the OTHER Swarm's device.
  const federated = await pollUntil(
    async () => {
      await peerA.handle.mergeNow();
      await peerB.handle.mergeNow();
      const devsA = await devicePubkeysFor(dbA.sql);
      const devsB = await devicePubkeysFor(dbB.sql);
      return devsA.has(idB.devicePubkey) && devsB.has(idA.devicePubkey) ? { devsA, devsB } : undefined;
    },
    { timeoutMs: 25_000, intervalMs: 250 },
  );

  return { dbA, dbB, idA, idB, peerA, peerB, federated };
}

describe('cross-peer coordination on a shared Hive — presence federation → authority election', () => {
  it(
    'each Swarm announces presence and it FEDERATES to the other peer (both rosters hold both Swarms)',
    async () => {
      const { idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated, "presence did not federate between the two peers within the window").toBeTruthy();
      // B's roster received A's presence over the real wire (and A's received B's).
      expect(federated!.devsB.has(idA.devicePubkey), "A's presence never federated to peer B").toBe(true);
      expect(federated!.devsA.has(idB.devicePubkey), "B's presence never federated to peer A").toBe(true);
    },
    40_000,
  );

  it(
    'the federated roster drives a CONSISTENT Hive authority election on both peers (no split-brain)',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      // Each peer runs the REAL election over ITS OWN federated shared_presence.
      const authA = await lockAuthorityForHive(HIVE_SLUG, electionDeps(dbA.sql, { githubUserId: idA.userId, devicePubkey: idA.devicePubkey }));
      const authB = await lockAuthorityForHive(HIVE_SLUG, electionDeps(dbB.sql, { githubUserId: idB.userId, devicePubkey: idB.devicePubkey }));

      // Deterministic argmin(device_pubkey) — both peers must name the SAME authority.
      const expectedAuthority = idA.devicePubkey < idB.devicePubkey ? idA.devicePubkey : idB.devicePubkey;
      const authoritySeenByA = authA.isSelf ? idA.devicePubkey : authA.peer!.devicePubkey;
      const authoritySeenByB = authB.isSelf ? idB.devicePubkey : authB.peer!.devicePubkey;

      expect(authoritySeenByA).toBe(expectedAuthority);
      expect(authoritySeenByB).toBe(expectedAuthority);
      // Exactly ONE peer considers itself the authority — the other routes to it.
      expect([authA.isSelf, authB.isSelf].filter(Boolean)).toHaveLength(1);
      // Both saw a 2-Swarm live roster (real federation, not a lone self).
      expect(authA.liveCount).toBe(2);
      expect(authB.liveCount).toBe(2);
    },
    40_000,
  );
});

describe('cross-peer coordination on a shared Hive — claim arbitration over the federated-elected authority', () => {
  it(
    'both Swarms contend for one work-item → the federated-presence-elected authority grants EXACTLY ONE',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      // The authority is argmin(device_pubkey) over the FEDERATED roster — host its
      // single claim store + the RPC endpoint on that peer's DB.
      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authorityDb = authorityIsA ? dbA : dbB;
      await authorityDb.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      h.sql = authorityDb.sql; // getOrgPg() → the authority's store (what acquireClaimLocal serializes)

      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const server: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          const env = JSON.parse(raw) as AuthorityRpcEnvelope;
          const result = await handleAuthorityRpc(env);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
      cleanups.push(() => {
        server.close();
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const claim = (sql: postgres.Sql, self: { githubUserId: number; devicePubkey: string }, owner: string) => {
        const payload: AcquireOpts = {
          workspaceId: 'default',
          harnessSlug: HARNESS_SLUG,
          workItemId: 'F-XPEER-1',
          hiveSlug: HIVE_SLUG,
          owner,
          holderPubkey: self.devicePubkey,
        };
        return routeToAuthorityForHive<AcquireResult>(
          HIVE_SLUG,
          {
            local: (): Promise<AcquireResult> => acquireClaimLocal(payload),
            remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload, decode: (raw): AcquireResult => raw as AcquireResult },
          },
          electionDeps(sql, self),
        );
      };

      const selfA = { githubUserId: idA.userId, devicePubkey: idA.devicePubkey };
      const selfB = { githubUserId: idB.userId, devicePubkey: idB.devicePubkey };
      // Both Swarms claim the SAME item concurrently — routed to the one authority.
      const [rA, rB] = await Promise.all([claim(dbA.sql, selfA, 'alice'), claim(dbB.sql, selfB, 'bob')]);

      // Exactly ONE Swarm wins the contended item (cross-peer exactly-once).
      const winners = [rA, rB].filter((r) => r.value.ok);
      expect(winners, 'exactly one Swarm must win the contended work-item').toHaveLength(1);
      // The authority's single store records exactly that winner.
      const winningOwner = rA.value.ok ? 'alice' : 'bob';
      const held = await getClaim('default', HARNESS_SLUG, 'F-XPEER-1');
      expect(held?.owner).toBe(winningOwner);
      // The authority Swarm ran locally; the other reached it over the real RPC wire.
      const authorityResult = authorityIsA ? rA : rB;
      const clientResult = authorityIsA ? rB : rA;
      expect(authorityResult.via).toBe('local-authority');
      expect(clientResult.via).toBe('remote-authority');
    },
    45_000,
  );
});
