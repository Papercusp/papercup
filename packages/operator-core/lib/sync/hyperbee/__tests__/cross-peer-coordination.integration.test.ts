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
 *   5. FAILOVER: the elected authority Swarm departs; its federated presence row
 *      ages past `staleMs` while the survivor keeps heartbeating → the survivor's
 *      election over its OWN federated roster names ITSELF (failover by definition,
 *      D-005 — no election round-trip), and a new claim grants locally.
 *   6. PARTITION (D-004): the authority stays in the fresh roster but its RPC leg is
 *      unreachable → the non-authority Swarm FAILS OPEN (local-advisory grant in its
 *      OWN store, loud warning), the documented optimistic split-brain window is
 *      real (both stores can hold the same item until git-merge), and on heal the
 *      claim path routes `remote-authority` again.
 *   7. THREE-PEER failover consistency + rejoin: with three Swarms federated, the
 *      authority departs → BOTH survivors independently elect the SAME successor
 *      (post-failover no-split-brain — inexpressible in a two-peer rig), a contended
 *      claim between the survivors grants exactly one, and when the departed Swarm
 *      REJOINS (fresh boot, same identity) all three re-converge on the original
 *      argmin authority.
 *   8. LEASE LIFECYCLE across peers: acquire (remote) → contention refused → release
 *      (remote) → the other Swarm re-acquires — the full claim lease serializes at
 *      the federated-elected authority over the real RPC wire.
 *   9. FILE-LOCK routing over the federated roster: the production `routeFileLockOp`
 *      (the locks:acquire/release cutover seam) resolves its Hive scope and routes
 *      lock.acquire/release to the federated-presence-elected authority over the real
 *      RPC wire — grant, cross-wire busy contention (holder faithfully named), and
 *      cross-wire release. STOOD-IN here: the lock store behind the coordinator (the
 *      real-PG store leg is file-lock-authority-e2e's proof).
 *  10. WAKE DELIVERY over the real wire: a coord-message op with `body.wake` appended
 *      on A federates over the actual Hyperswarm wire; B's REAL coord-message
 *      projection applies it origin='remote' and fires the deliver-and-wake fan
 *      EXACTLY ONCE (A's own local apply never fans) — the end-to-end the
 *      coord-message-federation suite chains by hand.
 *  11. SCALE: a FIVE-Swarm cascade — the sitting authority departs round after round
 *      (5→4→3→2→1), and at every width EVERY survivor independently elects the SAME
 *      successor (unanimous, no split-brain at any epoch), with a contended claim
 *      serializing at each epoch's authority over the wire.
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
import type { AcquireResult, AcquireOpts, ReleaseClaimParams } from '../../../work-item-claims';
import { routeFileLockOp, type FileLockRoutingDeps } from '../../../authority/file-lock-routing';
import {
  registerFileLockAuthorityOps,
  FILE_LOCK_OP_KINDS,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
  type FileLockCoordinator,
  type FileLockReleaseParams,
} from '../../../authority/file-lock-authority-ops';
import { buildCoordMessageProjection, type CoordMessageRow } from '../projections/coord-message';

// EI-279: the coord-message projection's deliver-and-wake fan dynamically imports
// wakeRecipients — mock it so the real-wire wake test asserts the fan contract
// without the real await-event pump (same stand-in as coord-message-federation).
vi.mock('../../../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async (recipients: readonly string[]) => ({
    targets: [...recipients],
    keys: [],
    woken: 1,
    staged: 0,
  })),
}));
import { wakeRecipients } from '../../../agent-tools/coordination/inbox-wake';

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
const { WORK_ITEM_CLAIM_OP_KINDS, getClaim, acquireClaimLocal, releaseClaimLocal } = await import('../../../work-item-claims');

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
// The 000-baseline coord_event_log + the migration-150 federation columns/index,
// exactly as the coord-message-federation suite stands them up.
const COORD_EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default', surface text NOT NULL,
    writer_key text, msg_id text NOT NULL, body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now(),
    harness_slug text, origin text NOT NULL DEFAULT 'local', author_pubkey text,
    fed_ts bigint);
  CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_fed_uq ON harness_shared.coord_event_log (workspace_id, msg_id)
    WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL`;
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

/** A per-peer apply that routes federated ops through the REAL projections bound to
 *  THIS peer's `sql`: `presence` (the roster) and `coord-messages` (the
 *  wake-carrying rail) — each peer projects into its OWN throwaway PG. */
function buildPeerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const projections = [
    buildPresenceProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }) as TableProjection<unknown>,
    buildCoordMessageProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }) as TableProjection<unknown>,
  ];
  const scoped = new Map<string, TableProjection<unknown>>(projections.map((p) => [p.tableTag, p]));
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
      apply ??= buildPeerApply(opts.sql, handle!.ownLog.keyHex);
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

/** Election deps that read THIS peer's federated `shared_presence` (not an injected roster).
 *  `nowFn` is injectable so the failover test can move the clock past `staleMs` without
 *  sleeping — the roster itself stays the REAL federated one. */
function electionDeps(
  sql: postgres.Sql,
  self: { githubUserId: number; devicePubkey: string },
  nowFn: () => number = () => Date.now(),
): LockAuthorityDeps {
  return {
    now: nowFn,
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
  await dbA.sql.unsafe(COORD_EVENT_LOG_DDL);
  await dbB.sql.unsafe(COORD_EVENT_LOG_DDL);

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

/** Spin an in-process authority RPC endpoint over `handleAuthorityRpc`, returning a
 *  handle the partition test can sever (close) and heal (relisten on a new port). */
async function startAuthorityRpcServer(): Promise<{ addr: () => string; sever: () => Promise<void>; heal: () => Promise<void> }> {
  let server: Server | undefined;
  let port = 0;
  const listen = async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const env = JSON.parse(raw) as AuthorityRpcEnvelope;
        const result = await handleAuthorityRpc(env);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    port = (server!.address() as { port: number }).port;
  };
  const sever = async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  };
  await listen();
  cleanups.push(async () => {
    if (server) await sever();
  });
  // The address keeps resolving after sever — the point: the peer is KNOWN but
  // unreachable (a partition), so the transport maps the refusal to
  // PeerUnreachableError and routing fails open per D-004.
  return { addr: () => `http://127.0.0.1:${port}`, sever, heal: listen };
}

function claimVia(
  sql: postgres.Sql,
  self: { githubUserId: number; devicePubkey: string },
  owner: string,
  workItemId: string,
  nowFn?: () => number,
) {
  const payload: AcquireOpts = {
    workspaceId: 'default',
    harnessSlug: HARNESS_SLUG,
    workItemId,
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
    electionDeps(sql, self, nowFn),
  );
}

describe('cross-peer coordination on a shared Hive — authority departure (failover by staleness, D-005)', () => {
  it(
    'the elected authority Swarm departs → its federated presence ages out and the SURVIVOR elects itself; a new claim grants locally',
    async () => {
      const { dbA, dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const departed = authorityIsA ? { peer: peerA, id: idA } : { peer: peerB, id: idB };
      const survivor = authorityIsA
        ? { peer: peerB, id: idB, db: dbB, machine: 'machine-B' as const }
        : { peer: peerA, id: idA, db: dbA, machine: 'machine-A' as const };

      // The authority Swarm genuinely goes away (stops announcing + merging).
      await departed.peer.handle.close();

      // HYSTERESIS: socket death alone does NOT depose the authority — within the
      // staleness window the survivor still names the departed Swarm (this is the
      // designed anti-flap window, not a bug).
      const selfSurvivor = { githubUserId: survivor.id.userId, devicePubkey: survivor.id.devicePubkey };
      const preStale = await lockAuthorityForHive(HIVE_SLUG, electionDeps(survivor.db.sql, selfSurvivor));
      expect(preStale.isSelf).toBe(false);
      expect(preStale.peer?.devicePubkey).toBe(departed.id.devicePubkey);

      // The survivor keeps heartbeating: re-announce its presence at VIRTUAL_NOW
      // (a fresh last_seen_at on its own peer-log → its own projected roster). The
      // departed Swarm's row keeps its old last_seen_at and ages out.
      const VIRTUAL_NOW = Date.now() + 601_000;
      await survivor.peer.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${survivor.id.userId}/${survivor.machine}`,
        value: { ...presenceValue(survivor.id.userId, survivor.machine, survivor.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
        ts: 2000,
        schema_version: 1,
        writerPubkey: survivor.id.devicePubkey,
      });
      const heartbeatLanded = await pollUntil(
        async () => {
          await survivor.peer.handle.mergeNow();
          const rows = await queryPresenceRowsForHive(survivor.db.sql as never, HIVE_SLUG);
          return rows.some((r) => r.device_pubkey === survivor.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW) || undefined;
        },
        { timeoutMs: 15_000, intervalMs: 200 },
      );
      expect(heartbeatLanded, "the survivor's fresh heartbeat never landed in its own roster").toBeTruthy();

      // FAILOVER BY DEFINITION (D-005): at VIRTUAL_NOW the departed Swarm's row is
      // past staleMs; the survivor — over the SAME federated roster — now IS the
      // authority, with the dead Swarm out of the live set. No election round-trip.
      const postStale = await lockAuthorityForHive(HIVE_SLUG, electionDeps(survivor.db.sql, selfSurvivor, () => VIRTUAL_NOW + 1));
      expect(postStale.isSelf, 'the survivor must elect ITSELF once the departed authority is stale').toBe(true);
      expect(postStale.liveCount).toBe(1);

      // Claims continue: the survivor hosts the claim store and grants locally.
      await survivor.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      h.sql = survivor.db.sql;
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      cleanups.push(() => __resetAuthorityOpsForTests());

      const r = await claimVia(survivor.db.sql, selfSurvivor, 'survivor', 'F-XPEER-FAILOVER-1', () => VIRTUAL_NOW + 1);
      expect(r.via).toBe('local-authority');
      expect(r.value.ok).toBe(true);
      const held = await getClaim('default', HARNESS_SLUG, 'F-XPEER-FAILOVER-1');
      expect(held?.owner).toBe('survivor');
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — partition fail-open + heal (D-004)', () => {
  it(
    'a partitioned non-authority Swarm FAILS OPEN (loud warning, local-advisory grant in its OWN store); on heal it routes remote again',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA, owner: 'authority-swarm' } : { id: idB, db: dbB, owner: 'authority-swarm' };
      const client = authorityIsA ? { id: idB, db: dbB, owner: 'client-swarm' } : { id: idA, db: dbA, owner: 'client-swarm' };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };

      // Per-machine stores, like real embedded-pg: each Swarm has its OWN claim table.
      await authority.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      await client.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);

      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      // Pre-partition sanity: the wire works — the client's claim lands at the
      // authority over RPC. (getOrgPg → h.sql models each machine's OWN embedded
      // store; the RPC handler runs in the authority's "machine", so bind it there.)
      h.sql = authority.db.sql;
      const r0 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-0');
      expect(r0.via).toBe('remote-authority');
      expect(r0.value.ok).toBe(true);

      // ── PARTITION: presence stays FRESH (the authority is still in the client's
      // federated roster — this is a network split, not a departure), but the RPC
      // leg is severed.
      await rpc.sever();

      h.sql = client.db.sql; // the claimant's own machine-local store
      const r1 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-1');
      // D-004: fail open, loudly — never block on an unreachable peer.
      expect(r1.via).toBe('fail-open');
      expect(r1.value.ok).toBe(true);
      expect(r1.warning, 'fail-open must surface a loud warning').toMatch(/unreachable/);
      const clientHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-1');
      expect(clientHeld?.owner).toBe(client.owner);

      // The documented optimistic window IS real: during the split the authority can
      // grant the SAME item in its own store — two grants exist until git-merge
      // reconciles. Asserted deliberately: this is the D-004 trade, not a bug.
      h.sql = authority.db.sql;
      const r2 = await claimVia(authority.db.sql, selfAuthority, authority.owner, 'F-XPEER-PART-1');
      expect(r2.via).toBe('local-authority');
      expect(r2.value.ok).toBe(true);
      const authorityHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-1');
      expect(authorityHeld?.owner).toBe(authority.owner);
      expect(clientHeld?.owner).not.toBe(authorityHeld?.owner);

      // ── HEAL: the RPC leg returns → the client's next claim routes to the
      // authority again (serialized at one point; no lingering fail-open).
      await rpc.heal();
      const r3 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-2');
      expect(r3.via).toBe('remote-authority');
      expect(r3.value.ok).toBe(true);
      const healedHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-2');
      expect(healedHeld?.owner).toBe(client.owner);
    },
    60_000,
  );
});

interface PeerNode {
  id: ReturnType<typeof makeIdentity>;
  db: FreshPgDb;
  peer: PresencePeer;
  machine: string;
  self: { githubUserId: number; devicePubkey: string };
}

/** N Swarms of one Hive federated over the real wire — every peer's roster holds ALL
 *  N devices. The fixture for the multi-peer consistency assertions a two-peer rig
 *  cannot express. Returns nodes + the testnet bootstrap (for rejoin/scale legs). */
async function federatePeerSet(count: number) {
  const seeds = Array.from({ length: count }, (_, i) => ({
    login: `peer${i + 1}`,
    userId: 100 + i,
    kc: `kc-peer${i + 1}`,
    machine: `machine-${i + 1}`,
    ts: 1000 + i,
  }));
  const testnet = await makeTestnet();
  const nodes: PeerNode[] = [];
  for (const s of seeds) {
    const db = await createFreshPgDb(`xpeer3-${s.login}`);
    cleanups.push(() => db.cleanup());
    await db.sql.unsafe(SHARED_PRESENCE_DDL);
    const id = makeIdentity(s.login, s.userId, s.kc);
    nodes.push({ id, db, machine: s.machine, peer: undefined as never, self: { githubUserId: s.userId, devicePubkey: id.devicePubkey } });
  }
  const admitted = new Set(seeds.map((s) => s.userId));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].peer = await bootPresencePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: `xpeer3-${seeds[i].login}-`,
      identity: nodes[i].id,
      sql: nodes[i].db.sql,
      verify: (uid) => (admitted.has(uid) ? 'verified' : 'fail'),
    });
  }
  for (let i = 0; i < nodes.length; i++) {
    await nodes[i].peer.handle.append({
      type: 'put',
      table: 'presence',
      hbKey: `${seeds[i].userId}/${seeds[i].machine}`,
      value: presenceValue(seeds[i].userId, seeds[i].machine, nodes[i].id.devicePubkey),
      ts: seeds[i].ts,
      schema_version: 1,
      writerPubkey: nodes[i].id.devicePubkey,
    });
  }
  const allPubkeys = new Set(nodes.map((n) => n.id.devicePubkey));
  let lastMissing = '';
  const federated = await pollUntil(
    async () => {
      const missing: string[] = [];
      for (const n of nodes) await n.peer.handle.mergeNow();
      for (let i = 0; i < nodes.length; i++) {
        const devs = await devicePubkeysFor(nodes[i].db.sql);
        for (const m of nodes) {
          if (!devs.has(m.id.devicePubkey)) missing.push(`${seeds[i].login}⊉${seeds[nodes.indexOf(m)].login}`);
        }
      }
      lastMissing = missing.join(' ');
      return missing.length === 0 || undefined;
    },
    { timeoutMs: 30_000, intervalMs: 250 },
  );
  if (!federated) console.error(`[federatePeerSet] STALLED — missing roster entries: ${lastMissing}`);
  return { nodes, seeds, testnet, admitted, federated };
}

describe('cross-peer coordination on a shared Hive — THREE-peer failover consistency + rejoin (D-005)', () => {
  it(
    'authority departs → BOTH survivors elect the SAME successor (no split-brain), a contended claim grants exactly one; the departed Swarm rejoins → all three reconverge',
    async () => {
      const trio = await federatePeerSet(3);
      expect(trio.federated, 'three-way presence federation did not complete within the window').toBeTruthy();

      const sorted = [...trio.nodes].sort((a, b) => (a.id.devicePubkey < b.id.devicePubkey ? -1 : 1));
      const [orig, successor, third] = sorted;
      const survivors = [successor, third];

      // Stage 1 — fully connected: all THREE rosters elect the same argmin authority.
      for (const n of trio.nodes) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(orig.id.devicePubkey);
        expect(a.liveCount).toBe(3);
      }

      // Stage 2 — the authority Swarm departs.
      await orig.peer.handle.close();

      // Stage 3 — the survivors keep heartbeating at VIRTUAL_NOW; each fresh
      // heartbeat must FEDERATE to the other survivor (their rosters, not ours).
      const VIRTUAL_NOW = Date.now() + 601_000;
      for (const s of survivors) {
        const seed = trio.seeds.find((x) => x.userId === s.self.githubUserId)!;
        await s.peer.handle.append({
          type: 'put',
          table: 'presence',
          hbKey: `${seed.userId}/${seed.machine}`,
          value: { ...presenceValue(seed.userId, seed.machine, s.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
          ts: 2000 + seed.userId,
          schema_version: 1,
          writerPubkey: s.id.devicePubkey,
        });
      }
      const survivorsFresh = await pollUntil(
        async () => {
          for (const s of survivors) await s.peer.handle.mergeNow();
          for (const s of survivors) {
            const rows = await queryPresenceRowsForHive(s.db.sql as never, HIVE_SLUG);
            for (const other of survivors) {
              if (!rows.some((r) => r.device_pubkey === other.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW)) return undefined;
            }
          }
          return true;
        },
        { timeoutMs: 20_000, intervalMs: 200 },
      );
      expect(survivorsFresh, "the survivors' fresh heartbeats never mutually federated").toBeTruthy();

      // Stage 4 — POST-FAILOVER CONSISTENCY: both survivors independently elect the
      // SAME successor (the second-lowest pubkey) over their OWN federated rosters.
      const elections = await Promise.all(
        survivors.map((s) => lockAuthorityForHive(HIVE_SLUG, electionDeps(s.db.sql, s.self, () => VIRTUAL_NOW + 1))),
      );
      for (const e of elections) expect(e.liveCount).toBe(2);
      const seenBySuccessor = elections[0].isSelf ? successor.id.devicePubkey : elections[0].peer!.devicePubkey;
      const seenByThird = elections[1].isSelf ? third.id.devicePubkey : elections[1].peer!.devicePubkey;
      expect(seenBySuccessor).toBe(successor.id.devicePubkey);
      expect(seenByThird).toBe(successor.id.devicePubkey);
      expect([elections[0].isSelf, elections[1].isSelf].filter(Boolean)).toHaveLength(1);

      // Stage 5 — claims continue under the successor: both survivors contend for
      // one item; the successor's store grants EXACTLY ONE.
      await successor.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      h.sql = successor.db.sql;
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });
      const nowFn = () => VIRTUAL_NOW + 1;
      const [rS, rT] = await Promise.all([
        claimVia(successor.db.sql, successor.self, 'successor-swarm', 'F-XPEER3-1', nowFn),
        claimVia(third.db.sql, third.self, 'third-swarm', 'F-XPEER3-1', nowFn),
      ]);
      expect([rS, rT].filter((r) => r.value.ok)).toHaveLength(1);
      expect(rS.via).toBe('local-authority');
      expect(rT.via).toBe('remote-authority');

      // Stage 6 — REJOIN: the departed Swarm comes back (fresh boot, SAME identity)
      // and heartbeats at VIRTUAL_NOW. Same-identity re-admission must hold.
      const origSeed = trio.seeds.find((x) => x.userId === orig.self.githubUserId)!;
      const rejoined = await bootPresencePeer({
        testnetBootstrap: trio.testnet.bootstrap,
        rootPrefix: `xpeer3-rejoin-${origSeed.login}-`,
        identity: orig.id,
        sql: orig.db.sql,
        verify: (uid) => (trio.admitted.has(uid) ? 'verified' : 'fail'),
      });
      await rejoined.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${origSeed.userId}/${origSeed.machine}`,
        value: { ...presenceValue(origSeed.userId, origSeed.machine, orig.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
        ts: 3000,
        schema_version: 1,
        writerPubkey: orig.id.devicePubkey,
      });
      const everyone = [{ ...orig, peer: rejoined }, ...survivors];
      const reconverged = await pollUntil(
        async () => {
          for (const n of everyone) await n.peer.handle.mergeNow();
          for (const n of everyone) {
            const rows = await queryPresenceRowsForHive(n.db.sql as never, HIVE_SLUG);
            for (const m of everyone) {
              if (!rows.some((r) => r.device_pubkey === m.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW)) return undefined;
            }
          }
          return true;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(reconverged, "the rejoined Swarm's heartbeat never federated to all peers").toBeTruthy();

      // Stage 7 — all three independently re-elect the ORIGINAL argmin authority.
      for (const n of everyone) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self, () => VIRTUAL_NOW + 1));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(orig.id.devicePubkey);
        expect(a.liveCount).toBe(3);
      }
    },
    90_000,
  );
});

describe('cross-peer coordination on a shared Hive — claim lease lifecycle across peers', () => {
  it(
    'acquire (remote) → contention refused → release (remote) → the other Swarm re-acquires',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA } : { id: idB, db: dbB };
      const client = authorityIsA ? { id: idB, db: dbB } : { id: idA, db: dbA };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };

      await authority.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      h.sql = authority.db.sql; // every routed op serializes at the authority's store
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const ITEM = 'F-XPEER-LEASE-1';
      // 1. The non-authority Swarm acquires over the real RPC wire.
      const r1 = await claimVia(client.db.sql, selfClient, 'client-swarm', ITEM);
      expect(r1.via).toBe('remote-authority');
      expect(r1.value.ok).toBe(true);
      const claimId = r1.value.ok ? r1.value.claim.claimId : '';

      // 2. The authority Swarm contends while the lease is live → refused, and the
      //    conflict faithfully names the cross-peer holder.
      const r2 = await claimVia(authority.db.sql, selfAuthority, 'authority-swarm', ITEM);
      expect(r2.via).toBe('local-authority');
      expect(r2.value.ok).toBe(false);
      if (!r2.value.ok) expect(r2.value.conflict.owner).toBe('client-swarm');

      // 3. The holder RELEASES over the same routed authority leg.
      const releasePayload: ReleaseClaimParams = {
        workspaceId: 'default',
        harnessSlug: HARNESS_SLUG,
        workItemId: ITEM,
        hiveSlug: HIVE_SLUG,
        claimId,
        owner: 'client-swarm',
      };
      const r3 = await routeToAuthorityForHive<boolean>(
        HIVE_SLUG,
        {
          local: () => releaseClaimLocal(releasePayload),
          remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.release, payload: releasePayload, decode: (raw): boolean => raw as boolean },
        },
        electionDeps(client.db.sql, selfClient),
      );
      expect(r3.via).toBe('remote-authority');
      expect(r3.value).toBe(true);

      // 4. The lease is gone → the previously-refused Swarm now acquires.
      const r4 = await claimVia(authority.db.sql, selfAuthority, 'authority-swarm', ITEM);
      expect(r4.value.ok).toBe(true);
      const held = await getClaim('default', HARNESS_SLUG, ITEM);
      expect(held?.owner).toBe('authority-swarm');
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — file-lock ops route over the federated roster (P-009)', () => {
  it(
    "a non-authority Swarm's lock.acquire routes to the federated-elected HIVE authority over the wire: grant → cross-wire busy → cross-wire release",
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA } : { id: idB, db: dbB };
      const client = authorityIsA ? { id: idB, db: dbB } : { id: idA, db: dbA };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };

      // The authority "machine" hosts a minimal in-memory FileLockCoordinator behind
      // the REAL registered handlers (the FileLockCoordinator seam is the documented
      // test-injection point; the real-PG store leg is file-lock-authority-e2e's proof).
      const heldLocks = new Map<string, { owner: string; lockId: string }>();
      const coordinator: FileLockCoordinator = {
        acquire: async (p) => {
          const busy = p.paths
            .filter((path) => heldLocks.has(path) && heldLocks.get(path)!.owner !== p.owner)
            .map((path) => ({ path, owner: heldLocks.get(path)!.owner }));
          if (busy.length) return { ok: false, busy };
          const lockId = `lock-${p.owner}`;
          for (const path of p.paths) heldLocks.set(path, { owner: p.owner, lockId });
          return { ok: true, lockId, expiresTs: new Date(Date.now() + p.ttlSec * 1000).toISOString() };
        },
        release: async (p) => {
          const released: string[] = [];
          for (const [path, l] of heldLocks) {
            if (l.owner === p.owner && (!p.lockId || l.lockId === p.lockId)) {
              heldLocks.delete(path);
              released.push(path);
            }
          }
          return { ok: true, released };
        },
        queue: async () => [],
      };
      __resetAuthorityOpsForTests();
      registerFileLockAuthorityOps(coordinator);
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const DOMAIN = '/repo/xpeer-shared-checkout';
      const PATH = 'libs/contended.ts';
      // The PRODUCTION routing entry (the locks:acquire/release cutover seam), with its
      // domain→harness→Hive resolution injected and the election reading the caller's
      // OWN federated roster. skipRemotePeersFastPath forces the full authority path
      // (the cache layer has its own suite).
      const routingDeps = (sql: postgres.Sql, self: { githubUserId: number; devicePubkey: string }): FileLockRoutingDeps => ({
        ...electionDeps(sql, self),
        domainToHarnessSlug: () => HARNESS_SLUG,
        harnessToHiveSlug: () => HIVE_SLUG,
        skipRemotePeersFastPath: true,
      });
      const lockAcquire = (who: { sql: postgres.Sql; self: { githubUserId: number; devicePubkey: string } }, owner: string) => {
        const payload: FileLockAcquireParams = {
          owner,
          paths: [PATH],
          intent: `xpeer file-lock test (${owner})`,
          ttlSec: 600,
          coordinationDomain: DOMAIN,
        };
        return routeFileLockOp<FileLockAcquireResult>(
          DOMAIN,
          {
            local: () => coordinator.acquire(payload),
            remote: { kind: FILE_LOCK_OP_KINDS.acquire, payload, decode: (raw): FileLockAcquireResult => raw as FileLockAcquireResult },
          },
          routingDeps(who.sql, who.self),
        );
      };

      // 1. The non-authority Swarm acquires → routed over the REAL wire, granted.
      const g1 = await lockAcquire({ sql: client.db.sql, self: selfClient }, 'client-agent');
      expect(g1.via).toBe('remote-authority');
      expect(g1.value.ok).toBe(true);
      const grantedLockId = g1.value.lockId!;

      // 2. The authority Swarm contends for the SAME path → busy, with the cross-peer
      //    holder faithfully named (the per-edit hook's "who holds this" answer).
      const g2 = await lockAcquire({ sql: authority.db.sql, self: selfAuthority }, 'authority-agent');
      expect(g2.via).toBe('local-authority');
      expect(g2.value.ok).toBe(false);
      expect(g2.value.busy).toEqual([{ path: PATH, owner: 'client-agent' }]);

      // 3. The holder releases over the same routed leg → the path frees.
      const releasePayload: FileLockReleaseParams = { owner: 'client-agent', lockId: grantedLockId, coordinationDomain: DOMAIN };
      const rel = await routeFileLockOp<{ ok: boolean; released?: string[] }>(
        DOMAIN,
        {
          local: () => coordinator.release(releasePayload),
          remote: {
            kind: FILE_LOCK_OP_KINDS.release,
            payload: releasePayload,
            decode: (raw): { ok: boolean; released?: string[] } => raw as { ok: boolean; released?: string[] },
          },
        },
        routingDeps(client.db.sql, selfClient),
      );
      expect(rel.via).toBe('remote-authority');
      expect(rel.value.ok).toBe(true);
      expect(rel.value.released).toEqual([PATH]);

      // 4. The previously-busy Swarm now acquires.
      const g3 = await lockAcquire({ sql: authority.db.sql, self: selfAuthority }, 'authority-agent');
      expect(g3.value.ok).toBe(true);
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — deliver-and-wake over the real wire (EI-279)', () => {
  it(
    "a coord-message with body.wake federates A→B over the actual swarm; B's projection applies it origin='remote' and fires the wake fan EXACTLY once",
    async () => {
      const { dbA, dbB, idA, peerA, peerB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();
      vi.mocked(wakeRecipients).mockClear();

      // A "sends" a deliver-and-wake message — both legs of the production send:
      // (1) the local PG write coord:send performs (origin='local'), then (2) the
      // op the substrate-outbox capture→reshape chain appends on A's OWN peer-log.
      const MSG_ID = 'wake-e2e-1';
      const row: CoordMessageRow = {
        harness_slug: HARNESS_SLUG,
        msg_id: MSG_ID,
        surface: 'messages',
        writer_key: 'su-A',
        body: {
          ts: '2026-06-11T00:00:00Z',
          msg_id: MSG_ID,
          from: 'su-A',
          to: ['su-B'],
          kind: 'message',
          summary: 'cross-peer wake ping',
          wake: true,
        },
        ts: 1_700_000_000_000,
      };
      await dbA.sql`
        INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
        VALUES (${WORKSPACE_ID}, 'messages', 'su-A', ${MSG_ID}, ${dbA.sql.json(row.body)}, ${HARNESS_SLUG}, 'local')
      `;
      await peerA.handle.append({
        type: 'put',
        table: 'coord-messages',
        hbKey: MSG_ID,
        value: row,
        ts: 5000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // The op crosses the REAL wire and B's REAL projection lands it origin='remote'.
      const onB = await pollUntil(
        async () => {
          await peerA.handle.mergeNow(); // A applies its own op (origin='local')
          await peerB.handle.mergeNow(); // B merges A's log → the remote apply under test
          const rows = await dbB.sql<Array<{ origin: string; summary: string }>>`
            SELECT origin, body->>'summary' AS summary FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
          `;
          return rows.length ? rows[0] : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onB, 'the wake message never federated to peer B').toBeTruthy();
      expect(onB!.origin).toBe('remote');
      expect(onB!.summary).toBe('cross-peer wake ping');

      // The deliver-and-wake fan fired on B EXACTLY once, for the envelope's
      // recipients — and A's own (origin='local') apply never fanned, so the
      // TOTAL across both peers is one.
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
      expect(vi.mocked(wakeRecipients).mock.calls[0][0]).toEqual(['su-B']);

      // A's own store holds exactly ONE copy, still origin='local': the EI-117 echo
      // breaker (skipOwnOps) must NOT re-apply A's own log op over its original write
      // — a broken breaker would flip it to 'remote' (and double-fan, caught above).
      const onARows = await dbA.sql<Array<{ origin: string }>>`
        SELECT origin FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
      `;
      expect(onARows).toHaveLength(1);
      expect(onARows[0].origin).toBe('local');
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — FIVE-Swarm cascading failover (scale)', () => {
  it(
    'each authority departure is followed by UNANIMOUS re-election among all survivors, and claims serialize at every epoch, down to a single Swarm',
    async () => {
      const fleet = await federatePeerSet(5);
      expect(fleet.federated, 'five-way presence federation did not complete within the window').toBeTruthy();

      // Ascending pubkey = the deterministic succession order (argmin elects index 0).
      let alive = [...fleet.nodes].sort((a, b) => (a.id.devicePubkey < b.id.devicePubkey ? -1 : 1));

      // Round 0 — fully connected: all FIVE rosters elect the same authority.
      for (const n of fleet.nodes) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(alive[0].id.devicePubkey);
        expect(a.liveCount).toBe(5);
      }

      // One claim store per Swarm (the per-machine embedded-pg model) + one RPC
      // endpoint that always fronts the CURRENT epoch's authority store (h.sql
      // rebound each round).
      for (const n of fleet.nodes) await n.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      // The cascade: kill the sitting authority; survivors heartbeat one staleness
      // window later; EVERY survivor must independently elect the SAME successor.
      // Round-k clock = now + k*601s, so each prior round's rows (including the
      // freshly-departed authority's last heartbeat) age out exactly one window.
      for (let round = 1; alive.length > 1; round++) {
        await alive[0].peer.handle.close();
        alive = alive.slice(1);
        const VN = Date.now() + round * 601_000;

        for (const s of alive) {
          const seed = fleet.seeds.find((x) => x.userId === s.self.githubUserId)!;
          await s.peer.handle.append({
            type: 'put',
            table: 'presence',
            hbKey: `${seed.userId}/${seed.machine}`,
            value: { ...presenceValue(seed.userId, seed.machine, s.id.devicePubkey), last_seen_at: VN },
            ts: 10_000 * round + seed.userId,
            schema_version: 1,
            writerPubkey: s.id.devicePubkey,
          });
        }
        const fresh = await pollUntil(
          async () => {
            for (const s of alive) await s.peer.handle.mergeNow();
            for (const s of alive) {
              const rows = await queryPresenceRowsForHive(s.db.sql as never, HIVE_SLUG);
              for (const other of alive) {
                if (!rows.some((r) => r.device_pubkey === other.id.devicePubkey && r.last_seen_ms >= VN)) return undefined;
              }
            }
            return true;
          },
          { timeoutMs: 20_000, intervalMs: 200 },
        );
        expect(fresh, `round ${round}: survivor heartbeats never mutually federated`).toBeTruthy();

        const clock = () => VN + 1;
        const elections = await Promise.all(
          alive.map((s) => lockAuthorityForHive(HIVE_SLUG, electionDeps(s.db.sql, s.self, clock))),
        );
        elections.forEach((e, i) => {
          const seen = e.isSelf ? alive[i].id.devicePubkey : e.peer!.devicePubkey;
          expect(seen, `round ${round}: survivor ${i} disagreed on the successor`).toBe(alive[0].id.devicePubkey);
          expect(e.liveCount).toBe(alive.length);
        });
        expect(elections.filter((e) => e.isSelf)).toHaveLength(1);

        // Claims serialize at THIS epoch's authority.
        h.sql = alive[0].db.sql;
        const clockedClaim = (n: PeerNode, owner: string) => claimVia(n.db.sql, n.self, owner, `F-CASCADE-${round}`, clock);
        if (alive.length >= 2) {
          const [rAuth, rPeer] = await Promise.all([
            clockedClaim(alive[0], `auth-r${round}`),
            clockedClaim(alive[1], `peer-r${round}`),
          ]);
          expect([rAuth, rPeer].filter((r) => r.value.ok)).toHaveLength(1);
          expect(rAuth.via).toBe('local-authority');
          expect(rPeer.via).toBe('remote-authority');
        } else {
          const r = await clockedClaim(alive[0], 'last-swarm');
          expect(r.via).toBe('local-authority');
          expect(r.value.ok).toBe(true);
        }
      }
      expect(alive).toHaveLength(1);
    },
    150_000,
  );
});
