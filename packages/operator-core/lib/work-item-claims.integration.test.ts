/**
 * work-item-claims.integration.test.ts — the work-item claim LEASE store against real
 * Postgres (decentralized-dispatch-scaling-2026-06-08 P-004 / D-002).
 *
 * Drives the public store API (acquireClaim/heartbeatClaim/releaseClaim — routed through
 * the default single-box LocalWorkItemClaimAuthority, so route === local) against a fresh
 * testcontainer schema carrying just migration 188's `work_item_claims` table. Proves the
 * lease mechanics: free-acquire, conflict on a live claim by another owner, own-extend,
 * heartbeat renewal, owner/claim_id-checked release, and the STEAL of a lapsed claim (the
 * work-stealing reclaim that returns a dead/idle Swarm's item to the backlog).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  acquireClaim,
  heartbeatClaim,
  releaseClaim,
  releaseAllClaimsForOwner,
  getClaim,
  listLiveClaimsForHive,
  sweepLapsedClaims,
} = await import('./work-item-claims');
const { resetWorkItemClaimAuthority } = await import('./work-item-claim-authority');

const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    pot_slug text,
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL,
    owner_label text,
    holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL,
    ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

const WS = 'default';
const HARNESS = 'h1';
const HIVE = 'hive-a';

// Generic over `T` so the literal fields the caller supplies (workItemId/owner/claimId/…)
// stay VISIBLE in the return type — a `Record<string, unknown>` param would erase them and
// make tsc think AcquireOpts/HeartbeatClaimParams's required fields are missing (su-d2b62).
function base<T extends object>(over: T) {
  return { workspaceId: WS, harnessSlug: HARNESS, hiveSlug: HIVE, ...over };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-claims');
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  resetWorkItemClaimAuthority();
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
});

describe('work-item claim lease store (real PG)', () => {
  it('acquires a free item — ok, with pot_slug + holder_pubkey persisted', async () => {
    const r = await acquireClaim(base({ workItemId: 'F-001', owner: 'su-a', holderPubkey: 'pk-a' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim).toMatchObject({ workItemId: 'F-001', owner: 'su-a', hiveSlug: HIVE, holderPubkey: 'pk-a', expired: false });
    expect(r.claim.claimId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a live claim held by ANOTHER owner — ok:false with the conflict', async () => {
    await acquireClaim(base({ workItemId: 'F-002', owner: 'su-a', holderPubkey: 'pk-a' }));
    const r = await acquireClaim(base({ workItemId: 'F-002', owner: 'su-b', holderPubkey: 'pk-b' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflict.owner).toBe('su-a');
  });

  it('the SAME owner re-acquiring extends its own claim (idempotent grip)', async () => {
    const first = await acquireClaim(base({ workItemId: 'F-003', owner: 'su-a' }));
    const again = await acquireClaim(base({ workItemId: 'F-003', owner: 'su-a' }));
    expect(first.ok && again.ok).toBe(true);
    // A fresh claim_id is minted on the re-acquire (ON CONFLICT DO UPDATE sets gen_random_uuid()).
    if (first.ok && again.ok) expect(again.claim.owner).toBe('su-a');
  });

  it('heartbeat renews the lease (expires_ts pushed out); wrong claim_id does not', async () => {
    const acq = await acquireClaim(base({ workItemId: 'F-004', owner: 'su-a', ttlSec: 60 }));
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const hb = await heartbeatClaim(base({ workItemId: 'F-004', owner: 'su-a', claimId: acq.claim.claimId, ttlSecOverride: 3600 }));
    expect(hb.renewed).toBe(true);
    expect(hb.held).toBe(true);
    const bad = await heartbeatClaim(base({ workItemId: 'F-004', owner: 'su-a', claimId: '00000000-0000-0000-0000-000000000000' }));
    expect(bad.renewed).toBe(false);
    expect(bad.held).toBe(false);
  });

  it('release frees the item only for the right owner+claim_id; then another can claim', async () => {
    const acq = await acquireClaim(base({ workItemId: 'F-005', owner: 'su-a' }));
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    // Wrong owner cannot release.
    expect(await releaseClaim(base({ workItemId: 'F-005', owner: 'su-b', claimId: acq.claim.claimId }))).toBe(false);
    // Right owner+claim_id releases.
    expect(await releaseClaim(base({ workItemId: 'F-005', owner: 'su-a', claimId: acq.claim.claimId }))).toBe(true);
    expect(await getClaim(WS, HARNESS, 'F-005')).toBeNull();
    // Now free → another owner claims it.
    const r2 = await acquireClaim(base({ workItemId: 'F-005', owner: 'su-b' }));
    expect(r2.ok).toBe(true);
  });

  it('STEALS a lapsed claim — a dead/idle Swarms item returns to the backlog (work-stealing)', async () => {
    const acq = await acquireClaim(base({ workItemId: 'F-006', owner: 'su-a', holderPubkey: 'pk-a', ttlSec: 60 }));
    expect(acq.ok).toBe(true);
    // Force the lease to lapse.
    await db.sql`UPDATE harness_shared.work_item_claims SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-006'`;
    // A different Swarm steals the lapsed item.
    const stolen = await acquireClaim(base({ workItemId: 'F-006', owner: 'su-b', holderPubkey: 'pk-b' }));
    expect(stolen.ok).toBe(true);
    if (stolen.ok) expect(stolen.claim.owner).toBe('su-b');
    const held = await getClaim(WS, HARNESS, 'F-006');
    expect(held?.owner).toBe('su-b');
    expect(held?.expired).toBe(false);
  });

  it('listLiveClaimsForHive returns live claims for the hive, excluding lapsed', async () => {
    await acquireClaim(base({ workItemId: 'F-007', owner: 'su-a' }));
    await acquireClaim(base({ workItemId: 'F-008', owner: 'su-b', ttlSec: 60 }));
    await db.sql`UPDATE harness_shared.work_item_claims SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-008'`;
    const live = await listLiveClaimsForHive(WS, HIVE);
    expect(live.map((c) => c.workItemId)).toEqual(['F-007']);
  });

  it('releaseAllClaimsForOwner clears a session; sweepLapsedClaims GCs expired rows', async () => {
    await acquireClaim(base({ workItemId: 'F-009', owner: 'su-a' }));
    await acquireClaim(base({ workItemId: 'F-010', owner: 'su-a' }));
    expect(await releaseAllClaimsForOwner(WS, 'su-a')).toBe(2);

    await acquireClaim(base({ workItemId: 'F-011', owner: 'su-c', ttlSec: 60 }));
    await db.sql`UPDATE harness_shared.work_item_claims SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-011'`;
    expect(await sweepLapsedClaims(WS)).toBe(1);
  });
});
