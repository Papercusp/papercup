/**
 * plan-item-claim-two-instance.integration.test.ts —
 * Phase-4 legs (b) + (c) of plan-item-assignment-claim-liveness-2026-06-04, the
 * VM-rig substitute for CLAIM serialization (the federation leg (a) is the
 * assignment side; claims never federate — they are authority-mediated).
 *
 * Two in-process "peers" route a contended plan-item CLAIM to ONE elected authority
 * peer (a real http server wrapping handleAuthorityRpc) over the REAL
 * HttpPeerRpcTransport, and the authority's single REAL Postgres claim store (its PK
 * on (workspace, harness, plan, item)) serializes them. This is the end-to-end proof
 * that the plan's claim half — riding su-584a8's authority-op-registry +
 * routeToAuthority{local,remote} (distributed-coordination-shared-harness-2026-06-04
 * Track B) — gives cross-machine mutual exclusion + survives an authority failover.
 *
 * It mirrors lib/authority/__tests__/two-instance-authority.integration.test.ts (the
 * file-lock equivalent) but is strictly stronger on the store axis: the authority
 * runs the REAL acquireClaimLocal SQL against a throwaway PG (createFreshPgDb), not a
 * fake in-memory store — matching the rigor su-119ce put into leg (a)'s real
 * two-peer federation. The only stand-in vs two physical VMs is the OS/network
 * boundary (loopback HTTP instead of the mesh); the routing + handler + payload
 * round-trip + the store's serialization are all real.
 *
 *  (b) two client peers contend for the same unclaimed item → the authority grants
 *      exactly one (via 'remote-authority'); the loser gets the holder as conflict.
 *  (c) the authority peer ages out → the next-lowest peer becomes authority and
 *      STILL serializes a contended claim (the new authority runs it locally; a peer
 *      routing to the new authority sees the same single store).
 *  + the D-004 fail-open safety property: with no transport, a remote authority is
 *      unreachable → the claim is taken locally (advisory) rather than blocking.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type postgres from 'postgres';
import { createFreshPgDb, applyPlanItemClaimMigrations, type FreshPgDb } from '../../test/_pg-helpers';
import { routeToAuthority, type LockAuthorityDeps } from '../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../authority/http-peer-rpc-transport';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../authority/authority-op-registry';
import { __resetRemotePeersCacheForTests } from '../authority/remote-peers-cache';
import { registerPlanItemClaimAuthorityOps } from './plan-item-claim-authority-ops';
import { acquireClaimLocal, acquireClaim, PLAN_ITEM_CLAIM_OP_KINDS, type AcquireResult, type AcquireOpts } from './claims';
import { SwarmClaimAuthority } from './claim-authority-swarm';
import { setClaimAuthority, resetClaimAuthority } from './claim-authority';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const WS = 'ws-claim-2i';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';
const NOW = 1_700_000_000_000;

// The harness's swarm roster each peer's lockAuthorityFor sees. argmin(device_pubkey)
// = 'auth-aaa' (the http-server peer) is the authority while all are fresh.
const ROSTER = [
  { device_pubkey: 'auth-aaa', github_user_id: 1, machine_label: 'authority-box', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'cli-mmm', github_user_id: 2, machine_label: 'client-1', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'cli-zzz', github_user_id: 3, machine_label: 'client-2', last_seen_ms: NOW - 1000 },
];
function depsFor(selfPubkey: string, roster = ROSTER, staleMs?: number): LockAuthorityDeps {
  return {
    now: () => NOW,
    ...(staleMs != null ? { staleMs } : {}),
    resolveSelf: async () => ({ githubUserId: 9, devicePubkey: selfPubkey }),
    fetchPresenceRows: async () => roster,
  };
}
function opts(owner: string, itemId: string): AcquireOpts {
  return { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId, owner, ownerName: owner };
}

let db: FreshPgDb;
let server: Server;
let port: number;
let rpcCount = 0;

beforeAll(async () => {
  db = await createFreshPgDb('plan-item-claim-2i');
  h.sql = db.sql;
  // 140/141/143 — see EI-9613: shared helper instead of a hand-copied list
  // (this file's own copy is what originally missed 143 → EI-9513).
  await applyPlanItemClaimMigrations(db.sql);

  // The authority peer's receiving side: register the REAL plan-item claim handlers
  // (default coordinator → acquireClaimLocal SQL against THIS test PG) + an http
  // server wrapping handleAuthorityRpc. This is the single serialization point.
  registerPlanItemClaimAuthorityOps();
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      rpcCount += 1;
      const env = JSON.parse(raw) as AuthorityRpcEnvelope;
      const result = await handleAuthorityRpc(env); // no verifyIsAuthority: the server IS the elected authority in-test
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
}, 90_000);

afterAll(async () => {
  server.close();
  __resetPeerRpcTransportForTests();
  __resetAuthorityOpsForTests();
  resetClaimAuthority();
  await db.cleanup();
});

beforeEach(async () => {
  rpcCount = 0;
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
  __resetRemotePeersCacheForTests();
});
afterEach(() => {
  resetClaimAuthority();
});

/** A client peer routes a claim acquire to the authority (direct routeToAuthority,
 *  so the caller can inspect `via`). The local fallback runs acquireClaimLocal too,
 *  but should NOT be what wins when the authority is remote + reachable. */
async function routeAcquire(selfPubkey: string, owner: string, itemId: string, deps = depsFor(selfPubkey)) {
  return routeToAuthority<AcquireResult>(
    HARNESS,
    {
      local: () => acquireClaimLocal(opts(owner, itemId)),
      remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.acquire, payload: opts(owner, itemId), decode: (raw) => raw as AcquireResult },
    },
    deps,
  );
}

/** A client peer takes a claim through the PUBLIC acquireClaim (the production entry
 *  point), with the swarm authority installed for that client's self-identity. */
async function publicAcquire(selfPubkey: string, owner: string, itemId: string, deps = depsFor(selfPubkey)) {
  setClaimAuthority(new SwarmClaimAuthority(deps));
  return acquireClaim(opts(owner, itemId));
}

describe('Phase-4 (b): two-peer plan-item claim contention serializes at the authority', () => {
  it('two client peers contend for one item → the authority grants exactly one (via remote-authority)', async () => {
    const a = await routeAcquire('cli-mmm', 'client-1', 'P-001');
    const b = await routeAcquire('cli-zzz', 'client-2', 'P-001');

    // Both went through the REMOTE authority (not the local fallback).
    expect(a.via).toBe('remote-authority');
    expect(b.via).toBe('remote-authority');
    // Exactly one holds it — the authority's single PG store serialized them.
    expect(a.value.ok).toBe(true);
    expect(b.value.ok).toBe(false);
    if (a.value.ok) expect(a.value.claim.owner).toBe('client-1');
    if (!b.value.ok) expect(b.value.conflict.owner).toBe('client-1');

    // The authority PG has exactly one live claim for P-001, owned by the winner.
    const rows = await db.sql<{ owner: string }[]>`
      SELECT owner FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN} AND item_id = 'P-001'`;
    expect(rows.map((r) => r.owner)).toEqual(['client-1']);
  });

  it('the PUBLIC acquireClaim path serializes cross-peer (and really hit the remote authority, not fail-open)', async () => {
    const a = await publicAcquire('cli-mmm', 'client-1', 'P-002');
    const b = await publicAcquire('cli-zzz', 'client-2', 'P-002');

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.conflict.owner).toBe('client-1');
    // Both acquires were RPCs to the authority server (proves remote, not a local
    // fail-open advisory grant that would have let BOTH win).
    expect(rpcCount).toBeGreaterThanOrEqual(2);
  });

  it('different items from different peers both grant (no false contention)', async () => {
    const a = await routeAcquire('cli-mmm', 'client-1', 'P-010');
    const b = await routeAcquire('cli-zzz', 'client-2', 'P-011');
    expect(a.value.ok).toBe(true);
    expect(b.value.ok).toBe(true);
    expect(a.via).toBe('remote-authority');
    expect(b.via).toBe('remote-authority');
  });

  it('the authority itself (self === argmin) runs locally, no self-RPC', async () => {
    const rpcBefore = rpcCount;
    const r = await routeAcquire('auth-aaa', 'authority-box', 'P-003', depsFor('auth-aaa'));
    expect(r.via).toBe('local-authority');
    expect(r.value.ok).toBe(true);
    expect(rpcCount).toBe(rpcBefore); // no HTTP round-trip when we are the authority
  });
});

describe('Phase-4 (c): authority failover still serializes claims', () => {
  // 'auth-aaa' ages out → roster authority = argmin of the live set = 'cli-mmm'.
  const staleRoster = [{ ...ROSTER[0], last_seen_ms: NOW - 200_000 }, ROSTER[1], ROSTER[2]];
  const STALE_MS = 90_000;

  it('re-elects the next-lowest peer: it runs locally; a peer routing to it sees the same store', async () => {
    // From cli-mmm's view it is now the authority → local. From cli-zzz's view the
    // authority is cli-mmm (still remote → the server, which represents the new authority).
    const onMmm = await routeAcquire('cli-mmm', 'client-1', 'Q-001', depsFor('cli-mmm', staleRoster, STALE_MS));
    expect(onMmm.via).toBe('local-authority');
    expect(onMmm.value.ok).toBe(true);

    const onZzz = await routeAcquire('cli-zzz', 'client-2', 'Q-001', depsFor('cli-zzz', staleRoster, STALE_MS));
    expect(onZzz.via).toBe('remote-authority');
    expect(onZzz.value.ok).toBe(false); // serialized against cli-mmm's grant
    if (!onZzz.value.ok) expect(onZzz.value.conflict.owner).toBe('client-1');

    // Exactly one holder for Q-001 post-failover.
    const rows = await db.sql<{ owner: string }[]>`
      SELECT owner FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN} AND item_id = 'Q-001'`;
    expect(rows.map((r) => r.owner)).toEqual(['client-1']);
  });

  it('the new authority enforces mutual exclusion locally (two local contenders → one wins)', async () => {
    const a = await routeAcquire('cli-mmm', 'client-1', 'Q-002', depsFor('cli-mmm', staleRoster, STALE_MS));
    const b = await routeAcquire('cli-mmm', 'client-2', 'Q-002', depsFor('cli-mmm', staleRoster, STALE_MS));
    expect(a.via).toBe('local-authority');
    expect(b.via).toBe('local-authority');
    expect(a.value.ok).toBe(true);
    expect(b.value.ok).toBe(false);
    if (!b.value.ok) expect(b.value.conflict.owner).toBe('client-1');
  });
});

describe('D-004 fail-open safety: a remote authority that is unreachable does not block', () => {
  it('no transport → a client takes the claim locally (advisory) rather than blocking', async () => {
    // Drop the transport: the authority (auth-aaa) is remote but has no wire leg.
    __resetPeerRpcTransportForTests();
    __resetRemotePeersCacheForTests();
    try {
      const r = await routeAcquire('cli-mmm', 'client-1', 'P-099');
      expect(r.via).toBe('fail-open');
      expect(r.warning).toMatch(/remote peer/i);
      expect(r.value.ok).toBe(true); // taken locally — git-merge is the backstop
    } finally {
      // Restore the transport for any later test ordering.
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
    }
  });
});
