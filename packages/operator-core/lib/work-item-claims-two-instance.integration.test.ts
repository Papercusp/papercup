/**
 * Two-instance WORK-ITEM-CLAIM serialization (decentralized-dispatch-scaling-2026-06-08
 * P-013 core, authority-logic layer) — the work-item-claim analog of
 * `authority/__tests__/two-instance-hive-authority.integration.test.ts`.
 *
 * Two client "Swarms" of ONE shared Hive route a contended work-item CLAIM to the
 * single Hive authority (`argmin(device_pubkey)` over the Hive's live Swarms,
 * `lockAuthorityForHive`) over the real `HttpPeerRpcTransport`, and the authority's
 * single REAL store (acquireClaimLocal against its PG) serializes them. This proves the
 * purpose of re-homing the claim onto the per-Hive authority (D-002): cross-Swarm
 * exactly-once for the dispatch backlog — only one Swarm wins each item.
 *
 * ## What this PROVES
 * The full cross-Swarm path for MY lease: routeToAuthorityForHive elects the Hive
 * authority, RPCs the `work-item.claim.acquire` op there, and the authority's
 * work_item_claims store (PK on (workspace,harness,work_item_id)) grants exactly one
 * holder. Reuses my registerWorkItemClaimAuthorityOps (default coordinator =
 * acquireClaimLocal) so the PRODUCTION receiving handler is exercised.
 *
 * ## What it INTENTIONALLY does NOT prove (the layer above)
 * Presence is INJECTED (fetchHivePresenceRows = a fixed Hive roster) — the
 * authority/routing/serialization layer in isolation, exactly like the federation
 * harness. The LIVE cross-machine presence federation (the presence-announce publisher
 * over the real peer-log) is the separate cross-machine E2E. Don't over-read it.
 *
 * One authority PG (the serialization point) + two in-process client Swarms over
 * loopback — same shape as the federation test, but real store (not a fake), since the
 * point is to prove the work_item_claims store serializes when fronted by the authority.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type postgres from 'postgres';
import { routeToAuthorityForHive, type LockAuthorityDeps } from './authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from './authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from './authority/http-peer-rpc-transport';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from './authority/authority-op-registry';
import { __resetRemotePeersCacheForTests } from './authority/remote-peers-cache';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type { AcquireResult, AcquireOpts } from './work-item-claims';

const NOW = 1_700_000_000_000;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { registerWorkItemClaimAuthorityOps } = await import('./work-item-claim-authority-ops');
const { WORK_ITEM_CLAIM_OP_KINDS, getClaim, acquireClaimLocal } = await import('./work-item-claims');

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

// The shared Hive's SWARM roster; authority = argmin = 'auth-aaa' (the http server).
const HIVE_ROSTER = [
  { device_pubkey: 'auth-aaa', github_user_id: 1, machine_label: 'authority-swarm', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'swarm-mmm', github_user_id: 2, machine_label: 'laptop-swarm', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'swarm-zzz', github_user_id: 3, machine_label: 'cloud-swarm', last_seen_ms: NOW - 1000 },
];

function hiveDeps(selfPubkey: string): LockAuthorityDeps {
  return {
    now: () => NOW,
    resolveSelf: async () => ({ githubUserId: 9, devicePubkey: selfPubkey }),
    fetchHivePresenceRows: async () => HIVE_ROSTER,
  };
}

let db: FreshPgDb;
let server: Server;
let port: number;

beforeAll(async () => {
  db = await createFreshPgDb('wi-claims-two-instance');
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
  // The AUTHORITY Swarm runs received claim ops against ITS single real store
  // (acquireClaimLocal via the default coordinator) — the one serialization point.
  __resetAuthorityOpsForTests();
  registerWorkItemClaimAuthorityOps();
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
});

afterAll(async () => {
  server?.close();
  __resetPeerRpcTransportForTests();
  __resetAuthorityOpsForTests();
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
  __resetRemotePeersCacheForTests();
});

/** A client Swarm claims `workItemId` for `owner` by routing to the Hive authority. */
async function swarmClaim(selfPubkey: string, owner: string, workItemId: string) {
  const payload: AcquireOpts = {
    workspaceId: 'default',
    harnessSlug: 'h1',
    workItemId,
    hiveSlug: 'my-hive',
    owner,
    holderPubkey: selfPubkey,
  };
  return routeToAuthorityForHive<AcquireResult>(
    'my-hive',
    {
      // local runs ONLY when self is the Hive authority (the argmin case); for the
      // remote-authority Swarms it never executes (the RPC result is authoritative).
      local: (): Promise<AcquireResult> => acquireClaimLocal(payload),
      remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload, decode: (raw): AcquireResult => raw as AcquireResult },
    },
    hiveDeps(selfPubkey),
  );
}

describe('two-instance work-item-claim serialization over loopback (real store)', () => {
  it('two Swarms of one Hive contend for one item → the Hive authority grants exactly one', async () => {
    const a = await swarmClaim('swarm-mmm', 'laptop', 'F-001');
    const c = await swarmClaim('swarm-zzz', 'cloud', 'F-001');

    // Both routed through the REMOTE Hive authority (not the local fallback).
    expect(a.via).toBe('remote-authority');
    expect(c.via).toBe('remote-authority');
    // Exactly one wins — the authority's single store serialized two DIFFERENT Swarms.
    expect(a.value.ok).toBe(true);
    expect(c.value.ok).toBe(false);
    if (a.value.ok) expect(a.value.claim.owner).toBe('laptop');
    // The authority's store records the winner.
    const held = await getClaim('default', 'h1', 'F-001');
    expect(held?.owner).toBe('laptop');
  });

  it('different items from different Swarms both grant (no false contention)', async () => {
    const a = await swarmClaim('swarm-mmm', 'laptop', 'F-002');
    const c = await swarmClaim('swarm-zzz', 'cloud', 'F-003');
    expect(a.value.ok).toBe(true);
    expect(c.value.ok).toBe(true);
  });

  it('the authority Swarm itself (self === argmin) runs locally, no self-RPC', async () => {
    const r = await swarmClaim('auth-aaa', 'authority-swarm', 'F-004');
    expect(r.via).toBe('local-authority');
    expect(r.value.ok).toBe(true);
    const held = await getClaim('default', 'h1', 'F-004');
    expect(held?.owner).toBe('authority-swarm');
  });
});
