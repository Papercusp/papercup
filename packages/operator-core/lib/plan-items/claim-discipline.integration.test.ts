/**
 * claim-discipline.integration.test.ts — the lane DOUBLE-PLACEMENT invariant at
 * the lease-LIVENESS boundary, driven END-TO-END through reconcileDeclaredClaims
 * (claim-discipline.ts) against a REAL Postgres (migrations 140 + 141 applied
 * verbatim, through the authority-routed claim store — LocalClaimAuthority).
 *
 * The unit suite (claim-discipline.test.ts) mocks the claim store, so the
 * live-vs-stale decision is HARDCODED in the mock — it never proves that the
 * discipline layer threads the real steal-on-lapse rule. This file pins the rule
 * that the whole coordination system rests on:
 *
 *   • A `claim_conflict` fires ONLY when the holder is a LIVE peer — the item is
 *     REPORTED in `conflicts`, the lease stays with the peer (NOT transferred).
 *     (A too-loose rule lets two live agents both claim → double-placement.)
 *   • A peer's STALE / lapsed lease is TAKEN OVER, not reported — the lease row's
 *     owner flips to the caller, no conflict. (A too-strict rule strands work on a
 *     dead agent forever.)
 *
 * We assert the `plan_item_claims` row OWNER after each reconcile — the durable
 * fact, not just the returned envelope. Assignments + work-group tables exist but
 * are empty (every item is an open POOL pull), so the boundary under test is the
 * lease liveness alone, not assignment policy.
 *
 * getOrgPg is redirected at the module seam to the throwaway test DB (the same
 * pattern as claims.integration.test.ts / stale-claims.integration.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyPlanItemClaimMigrations, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reconcileDeclaredClaims } = await import('./claim-discipline');
const claims = await import('./claims');

const WS = 'ws-claim-discipline';
const HARNESS = 'papercup';
const PLAN = 'lane-plan';
const ME = 'su-me';
const PEER = 'su-peer';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('claim-discipline');
  h.sql = db.sql;
  // The migrations' GRANTs reference cluster-wide roles — ensure they exist (the
  // role lines are stripped by readMigration, but other shared-container files may
  // reference them; harmless to create).
  await db.sql.unsafe(`
    DO $r$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
    DO $r$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
  `).simple();
  await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  // 140/141/143 — see EI-9613: shared helper instead of a hand-copied list
  // (this file's own copy is what originally missed 143 → EI-9509).
  await applyPlanItemClaimMigrations(db.sql);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
});

/** Seed a live peer claim directly via the store (the authority-routed acquire). */
async function seedPeerClaim(itemId: string, owner = PEER): Promise<string> {
  const r = await claims.acquireClaim({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    itemId,
    owner,
    ownerLabel: `su · ${owner.replace('su-', '')}`,
    intent: `peer working ${itemId}`,
  });
  if (!r.ok) throw new Error(`seed failed for ${itemId}`);
  return r.claim.claimId;
}

/** Force a claim's lease to have lapsed `secsAgo` seconds ago (a STALE holder). */
async function lapse(itemId: string, secsAgo: number): Promise<void> {
  await db.sql`UPDATE harness_shared.plan_item_claims
                  SET expires_ts = clock_timestamp() - make_interval(secs => ${secsAgo})
                WHERE workspace_id = ${WS} AND item_id = ${itemId}`;
}

/** The current OWNER of the lease row on an item (null if no row). */
async function rowOwner(itemId: string): Promise<string | null> {
  const c = await claims.getClaim(WS, HARNESS, PLAN, itemId);
  return c?.owner ?? null;
}

const reconcile = (items: string[]) =>
  reconcileDeclaredClaims({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    items,
    owner: ME,
    ownerLabel: 'su · me',
    ownerUser: 'me@example.com',
    intent: 'taking my lane',
  });

describe('reconcileDeclaredClaims — lease-liveness boundary (the DOUBLE-PLACEMENT invariant)', () => {
  it('(a) a LIVE peer holder → reported as a conflict, the lease is NOT transferred', async () => {
    await seedPeerClaim('P-002'); // peer holds it, lease still live

    const res = await reconcile(['P-001', 'P-002']);

    // The uncontested item is claimed by me; the contested one is REPORTED, not taken.
    expect(res.claimed).toEqual(['P-001']);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.item).toBe('P-002');
    expect(res.conflicts[0]!.reason).toMatch(/coordinate|claimed by/);

    // The durable fact: the lease row on P-002 still belongs to the PEER.
    expect(await rowOwner('P-002')).toBe(PEER);
    expect(await rowOwner('P-001')).toBe(ME);
  });

  it('(b) a STALE/lapsed peer holder → the lease is TAKEN OVER by the caller, no conflict', async () => {
    await seedPeerClaim('P-002');
    await lapse('P-002', 4000); // ~67 min lapsed — well past any liveness

    const res = await reconcile(['P-001', 'P-002']);

    // A dead agent's lease must not strand the item — the caller takes it over.
    expect(res.claimed.sort()).toEqual(['P-001', 'P-002']);
    expect(res.conflicts).toEqual([]);

    // The durable fact: the lease row on P-002 now belongs to ME (the steal landed).
    expect(await rowOwner('P-002')).toBe(ME);
    const taken = await claims.getClaim(WS, HARNESS, PLAN, 'P-002');
    expect(taken?.expired).toBe(false); // a fresh, live lease — not the lapsed remnant
  });

  it('the boundary is exact: a barely-live lease (1s of TTL left) is STILL a conflict, never stolen', async () => {
    await seedPeerClaim('P-007');
    // Pull the lease right up to — but NOT past — now: 1s of life remains.
    await db.sql`UPDATE harness_shared.plan_item_claims
                    SET expires_ts = clock_timestamp() + interval '1 second'
                  WHERE workspace_id = ${WS} AND item_id = 'P-007'`;

    const res = await reconcile(['P-007']);

    expect(res.claimed).toEqual([]);
    expect(res.conflicts.map((c) => c.item)).toEqual(['P-007']);
    expect(await rowOwner('P-007')).toBe(PEER); // a live lease, however thin, holds
  });

  it('mixed lane: live-held P-002 conflicts, lapsed P-003 is taken over, fresh P-001 claimed — all in one reconcile', async () => {
    await seedPeerClaim('P-002'); // live → conflict
    await seedPeerClaim('P-003'); // will be lapsed → takeover
    await lapse('P-003', 4000);

    const res = await reconcile(['P-001', 'P-002', 'P-003']);

    expect(res.claimed.sort()).toEqual(['P-001', 'P-003']);
    expect(res.conflicts.map((c) => c.item)).toEqual(['P-002']);

    expect(await rowOwner('P-001')).toBe(ME);
    expect(await rowOwner('P-002')).toBe(PEER); // live peer keeps it
    expect(await rowOwner('P-003')).toBe(ME); // dead peer's lease taken over
  });

  it('my own LIVE claim on a lane item is reported alreadyHeld, not re-stolen or conflicted', async () => {
    await seedPeerClaim('P-001', ME); // I already hold P-001 live

    const res = await reconcile(['P-001', 'P-005']);

    expect(res.alreadyHeld).toEqual(['P-001']);
    expect(res.claimed).toEqual(['P-005']);
    expect(res.conflicts).toEqual([]);
    expect(await rowOwner('P-001')).toBe(ME);
  });

  it('declaring a narrower lane releases my OWN claim outside it, but never a live PEER claim', async () => {
    await seedPeerClaim('P-001', ME); // mine, will fall outside the new lane
    await seedPeerClaim('P-009', PEER); // peer's, also outside the lane — must be untouched

    const res = await reconcile(['P-002']); // new lane is just P-002

    expect(res.claimed).toEqual(['P-002']);
    expect(res.released).toEqual(['P-001']); // my out-of-lane claim is released
    expect(await rowOwner('P-001')).toBeNull(); // released → row gone
    expect(await rowOwner('P-009')).toBe(PEER); // the peer's live claim is left alone
    expect(await rowOwner('P-002')).toBe(ME);
  });
});
