/**
 * claims.integration.test.ts — the plan-item claim store's lease mechanics
 * against REAL Postgres (migration 141 applied verbatim), through the public
 * authority-routed API (LocalClaimAuthority — single box, isSelf=true).
 *
 * The properties only PG can prove (clock_timestamp leases, the ON CONFLICT
 * steal guard, owner/claim_id-checked mutations):
 *
 *   • acquire: fresh → ok; same-owner re-acquire renews under a NEW claim_id;
 *     a DIFFERENT owner against a LIVE claim → {ok:false, conflict:<holder>};
 *     against a LAPSED claim → steals it (D-004 lazy reclaim).
 *   • heartbeat (D-003 asymmetric liveness): availability renews on a bare
 *     keepalive; activity does NOT (held:true, renewed:false + reason) but
 *     renews on activity/extend; wrong claim_id → held:false; a lapsed claim
 *     cannot be heartbeated back to life; ttlSecOverride clamps at MAX_TTL_SEC.
 *   • release: owner+claim_id checked (wrong owner frees nothing); correct →
 *     row gone. releaseAllClaimsForOwner sweeps a session's set.
 *   • renewOwnerActivityClaims: renews ONLY the owner's non-expired
 *     activity-mode claims — availability untouched, lapsed not resurrected.
 *   • getClaim/listClaimsForPlan derive `expired`; sweepLapsedClaims deletes
 *     only lapsed rows (honoring the harness filter).
 *
 * getOrgPg is redirected at the module seam to the throwaway test DB (same
 * pattern as work-items-lifecycle.integration.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { AcquireOpts } from './claims';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const claims = await import('./claims');

const WS = 'default';
const HARNESS = 'sheets';
const PLAN = 'test-plan-2026-06-07';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('claims');
  h.sql = db.sql;
  // The migration's GRANTs reference cluster-wide roles — ensure they exist
  // (shared testcontainer: another file may have created them already).
  await db.sql.unsafe(`
    DO $r$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
    DO $r$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
  `).simple();
  // Apply the REAL migration — we test the shipped schema, not a hand-rolled
  // copy. Strip psql meta-commands + the BEGIN/COMMIT wrapper (postgres-js
  // rejects script-level transactions on a pooled connection).
  const ddl = readFileSync(resolve(SQL_DIR, '141-plan-item-claims.sql'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');
  await db.sql.unsafe(ddl).simple();
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.plan_item_claims`;
});

/** Force a claim's lease into the past (a lapsed claim). */
async function lapse(itemId: string) {
  await db.sql`
    UPDATE harness_shared.plan_item_claims
       SET expires_ts = clock_timestamp() - interval '1 second'
     WHERE workspace_id = ${WS} AND item_id = ${itemId}
  `;
}

function acquire(over: Partial<AcquireOpts> = {}) {
  return claims.acquireClaim({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    itemId: 'P-001',
    owner: 'su-alice',
    ...over,
  });
}

describe('acquireClaim', () => {
  it('fresh acquire succeeds with the availability defaults', async () => {
    const res = await acquire();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim.owner).toBe('su-alice');
    expect(res.claim.livenessMode).toBe('availability');
    expect(res.claim.ttlSec).toBe(claims.DEFAULT_AVAILABILITY_TTL_SEC);
    expect(res.claim.expired).toBe(false);
  });

  it('activity mode gets the activity default TTL; explicit ttl is clamped at MAX_TTL_SEC', async () => {
    const a = await acquire({ itemId: 'P-002', livenessMode: 'activity' });
    expect(a.ok && a.claim.ttlSec).toBe(claims.DEFAULT_ACTIVITY_TTL_SEC);
    const b = await acquire({ itemId: 'P-003', ttlSec: 999_999 });
    expect(b.ok && b.claim.ttlSec).toBe(claims.MAX_TTL_SEC);
    const c = await acquire({ itemId: 'P-004', ttlSec: -5 });
    expect(c.ok && c.claim.ttlSec).toBe(claims.DEFAULT_AVAILABILITY_TTL_SEC);
  });

  it('same-owner re-acquire renews under a NEW claim_id', async () => {
    const first = await acquire({ intent: 'first' });
    const second = await acquire({ intent: 'second' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.claim.claimId).not.toBe(first.claim.claimId);
    expect(second.claim.intent).toBe('second');
    // still exactly one row (the PK is the mutual exclusion)
    const all = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(all).toHaveLength(1);
  });

  it('a different owner against a LIVE claim gets {ok:false} with the holder reported', async () => {
    await acquire({ intent: 'mine' });
    const res = await acquire({ owner: 'su-bob' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict.owner).toBe('su-alice');
    expect(res.conflict.intent).toBe('mine');
    expect(res.conflict.expired).toBe(false);
  });

  it('a different owner STEALS a lapsed claim (D-004 lazy reclaim)', async () => {
    await acquire();
    await lapse('P-001');
    const res = await acquire({ owner: 'su-bob' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim.owner).toBe('su-bob');
    expect(res.claim.expired).toBe(false);
  });
});

describe('heartbeatClaim — D-003 asymmetric liveness', () => {
  it('availability renews on a bare keepalive', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'keepalive');
    expect(hb).toMatchObject({ renewed: true, held: true });
    expect(hb.expiresTs).not.toBeNull();
  });

  it('activity mode is NOT renewed by a keepalive (held, with the nudge reason) but IS by activity/extend', async () => {
    const a = await acquire({ itemId: 'P-010', livenessMode: 'activity' });
    if (!a.ok) throw new Error('setup');
    const keep = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'keepalive');
    expect(keep.renewed).toBe(false);
    expect(keep.held).toBe(true);
    expect(keep.reason).toMatch(/activity\/extend/);
    const act = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'activity');
    expect(act).toMatchObject({ renewed: true, held: true });
    const ext = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'extend');
    expect(ext).toMatchObject({ renewed: true, held: true });
  });

  it('ttlSecOverride is applied and clamped at MAX_TTL_SEC', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'extend', 999_999);
    const row = await claims.getClaim(WS, HARNESS, PLAN, 'P-001');
    expect(row?.ttlSec).toBe(claims.MAX_TTL_SEC);
  });

  it('a wrong claim_id (a re-acquired claim) no longer heartbeats: held:false', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    const re = await acquire({ intent: 'renewed' }); // same owner → NEW claim_id
    if (!re.ok) throw new Error('setup');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice');
    expect(hb.held).toBe(false);
    expect(hb.reason).toMatch(/another owner or under a new claim_id/);
  });

  it('a lapsed claim cannot be heartbeated back to life', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    await lapse('P-001');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'activity');
    expect(hb).toMatchObject({ renewed: false, held: false, expiresTs: null });
    expect(hb.reason).toMatch(/lapsed|released/);
  });
});

describe('release', () => {
  it('owner+claim_id checked: the wrong owner frees nothing; the right one frees the row', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-bob')).toBe(false);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).not.toBeNull();
    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice')).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).toBeNull();
  });

  it('releaseAllClaimsForOwner sweeps exactly the owner set', async () => {
    await acquire({ itemId: 'P-001' });
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-003', owner: 'su-bob' });
    expect(await claims.releaseAllClaimsForOwner(WS, 'su-alice')).toBe(2);
    const left = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(left.map((c) => c.owner)).toEqual(['su-bob']);
  });
});

describe('renewOwnerActivityClaims — the per-turn auto-renewal', () => {
  it('renews only the owner\'s live ACTIVITY claims; availability + lapsed + other owners untouched', async () => {
    await acquire({ itemId: 'P-020', livenessMode: 'activity' });
    await acquire({ itemId: 'P-021', livenessMode: 'activity' });
    await acquire({ itemId: 'P-022' }); // availability
    await acquire({ itemId: 'P-023', livenessMode: 'activity', owner: 'su-bob' });
    await lapse('P-021'); // an already-lapsed activity claim must NOT resurrect

    // NOTE: at runtime postgres-js hands timestamptz back as Date (the
    // PlanItemClaim.expiresTs string type is aspirational) — compare epoch ms.
    const leaseMs = async () =>
      new Map(
        (await claims.listClaimsForPlan(WS, HARNESS, PLAN)).map((c) => [
          c.itemId,
          new Date(c.expiresTs).getTime(),
        ]),
      );
    const before = await leaseMs();
    await new Promise((r) => setTimeout(r, 10)); // ensure the renewed lease lands strictly later
    const renewed = await claims.renewOwnerActivityClaims(WS, 'su-alice');
    expect(renewed.sort()).toEqual(['P-020']);

    const after = await leaseMs();
    expect(after.get('P-020')!).toBeGreaterThan(before.get('P-020')!); // pushed out
    expect(after.get('P-022')).toBe(before.get('P-022')); // availability untouched
    expect(after.get('P-023')).toBe(before.get('P-023')); // other owner untouched
    const lapsed = await claims.getClaim(WS, HARNESS, PLAN, 'P-021');
    expect(lapsed?.expired).toBe(true); // not resurrected
  });
});

describe('reads + sweep', () => {
  it('getClaim/listClaimsForPlan derive `expired`; listing is item-ordered', async () => {
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-001' });
    await lapse('P-002');
    const list = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(list.map((c) => c.itemId)).toEqual(['P-001', 'P-002']);
    expect(list.map((c) => c.expired)).toEqual([false, true]);
    expect((await claims.getClaim(WS, HARNESS, PLAN, 'P-002'))?.expired).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-404')).toBeNull();
  });

  it('sweepLapsedClaims deletes only lapsed rows and honors the harness filter', async () => {
    await acquire({ itemId: 'P-001' });
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-003', harnessSlug: 'other' });
    await lapse('P-002');
    await lapse('P-003');
    // wrong harness filter → nothing swept there
    expect(await claims.sweepLapsedClaims(WS, HARNESS)).toBe(1);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).not.toBeNull();
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-002')).toBeNull();
    // unfiltered sweep catches the other harness's lapsed row
    expect(await claims.sweepLapsedClaims(WS)).toBe(1);
    expect(await claims.getClaim(WS, 'other', PLAN, 'P-003')).toBeNull();
  });
});
