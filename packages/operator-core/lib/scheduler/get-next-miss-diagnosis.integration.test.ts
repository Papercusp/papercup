/**
 * WI-4413 (DB-backed) — a floored claim-spec tranche must NAME its floors.
 *
 * Regression guard for the live incident that motivated the work (bug-drain-nonp2p, 2026-07-12):
 * a fleet leader fed THREE consecutive claim-spec tranches that every READ surface reported as
 * claimable and `scheduler:get_next` silently refused with a static, floor-blind string. Members
 * idled; three agents independently reverse-engineered the floors by hand from raw payload reads.
 *
 * The unit sibling (get-next-miss-diagnosis.test.ts) pins the pure logic + the anti-drift guard.
 * THIS test owns what only a real database can prove: that `explainIssueClaimFloors` — which
 * evaluates the SAME exported predicates the claim path ANDs in, as boolean columns instead of
 * WHERE clauses — actually attributes the right floor to the right row, for each floor that bit us.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { explainIssueClaimFloors } = await import('../work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed an ISSUE-family row (bug/change/task) with an arbitrary payload. */
async function seedIssue(id: string, payload: Record<string, unknown> | null, status = 'open') {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, title, payload)
    VALUES (${H}, ${id}, 'change', ${status}, NULL, ${WS}, 0, 0, ${'t ' + id},
            ${payload ? db.sql.json(payload) : null})`;
}

/**
 * Seed a plan. The plan-lane floor is deliberately STATE-SENSITIVE, not merely payload-shaped:
 * a `plan_item` back-pointer reserves the row ONLY while its plan is genuinely `active`
 * (reservedPlanLaneExclusionSql). A payload stamp pointing at a draft/paused/absent plan does
 * NOT floor the row — the floor fails open. Seeding the plan is therefore part of the contract
 * under test, not scaffolding: it is what distinguishes "reserved right now" from "stamped".
 */
async function seedPlan(slug: string, status: 'active' | 'paused') {
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
    VALUES (${WS}, ${H}, ${slug}, ${status})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('get-next-miss-diagnosis');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  // EI-10533: guard the teardown. When beforeAll fails (e.g. the SHARED native PG is briefly in
  // recovery mode — it happened while writing this test), `db` is never assigned, and a bare
  // `db.cleanup()` throws a TypeError that MASKS the real error: the run then reports a broken
  // TEST when the truth is broken INFRA. An agent trusting that surfaced error debugs the wrong
  // layer — I nearly did. Never let teardown outshout the actual failure.
  await db?.cleanup?.();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('WI-4413 — explainIssueClaimFloors names the floor that actually refused each row', () => {
  it('attributes the correct floor for every row shape a leader tranche can contain', async () => {
    // The control. If a clean row does not read admissible, this test is measuring the wrong
    // thing and every assertion below it is worthless.
    await seedPlan('live-plan', 'active');
    await seedPlan('paused-plan', 'paused');

    await seedIssue('WI-9001', null);
    // The three floors from the live incident:
    await seedIssue('WI-9002', { lane: 'observation', origin: 'checkpoint-harvest' });
    await seedIssue('WI-9003', { plan_item: { plan_slug: 'live-plan', item_id: 'P-001' } });
    await seedIssue('WI-9004', { _claimHold: true, held_open_by: 'su-other', held_open_reason: 'blocked' });
    await seedIssue('WI-9005', { needsHuman: true });
    // A terminal row named in a STALE tranche — the other everyday way a leader's spec goes empty.
    await seedIssue('WI-9006', null, 'resolved');
    // Stamped with a plan_item, but the plan is NOT active ⇒ NOT reserved. The floor is
    // state-sensitive, and a diagnosis that reported this as "plan-lane-reserved" would be
    // lying in the opposite direction — telling a leader to drop an item that is claimable.
    await seedIssue('WI-9007', { plan_item: { plan_slug: 'paused-plan', item_id: 'P-002' } });

    const out = await explainIssueClaimFloors(H, [
      'WI-9001',
      'WI-9002',
      'WI-9003',
      'WI-9004',
      'WI-9005',
      'WI-9006',
      'WI-9007',
      'WI-9999', // never inserted — a leader typo
    ]);
    const by = new Map(out.map((o) => [o.id, o]));

    expect(by.get('WI-9001')).toMatchObject({ admissible: true, refusedBy: null });
    expect(by.get('WI-9002')).toMatchObject({ admissible: false, refusedBy: 'observation-lane' });
    expect(by.get('WI-9003')).toMatchObject({ admissible: false, refusedBy: 'plan-lane-reserved' });
    expect(by.get('WI-9004')).toMatchObject({ admissible: false, refusedBy: 'claim-hold' });
    expect(by.get('WI-9005')).toMatchObject({ admissible: false, refusedBy: 'needs-human' });
    expect(by.get('WI-9006')).toMatchObject({ admissible: false, refusedBy: 'not-claimable-status' });
    expect(by.get('WI-9007')).toMatchObject({ admissible: true, refusedBy: null });
    // A typo'd id is the single most likely way to author a dead tranche, and the old static
    // message said nothing about it whatsoever.
    expect(by.get('WI-9999')).toMatchObject({ admissible: false, refusedBy: 'not-found' });

    // A bare slug is only half a diagnosis — every refusal carries an operator-facing detail.
    for (const row of out) {
      if (!row.admissible) expect(row.detail, `${row.id} needs a human-readable detail`).toBeTruthy();
    }
  });

  it('reproduces the incident: a tranche where EVERY named id is floored, by a DIFFERENT floor', async () => {
    await seedPlan('design-simplification', 'active');
    await seedIssue('WI-9101', { lane: 'observation' });
    await seedIssue('WI-9102', { plan_item: { plan_slug: 'design-simplification', item_id: 'P-016' } });
    await seedIssue('WI-9103', { _claimHold: true });

    const out = await explainIssueClaimFloors(H, ['WI-9101', 'WI-9102', 'WI-9103']);

    expect(out.every((o) => !o.admissible)).toBe(true);
    expect(out.map((o) => o.refusedBy).sort()).toEqual(['claim-hold', 'observation-lane', 'plan-lane-reserved']);
    // Three ids, three DISTINCT floors — the leader reading this learns there is no single
    // thing to fix and that the TRANCHE was the mistake. That realisation took me ~1h and
    // three separate member investigations to reach by hand.
    expect(new Set(out.map((o) => o.refusedBy)).size).toBe(3);
  });

  it('preserves caller id order and returns one row per requested id (never a silent drop)', async () => {
    await seedIssue('WI-9201', null);
    const out = await explainIssueClaimFloors(H, ['WI-9999', 'WI-9201', 'WI-9998']);
    expect(out.map((o) => o.id)).toEqual(['WI-9999', 'WI-9201', 'WI-9998']);
  });

  it('an empty id list is a no-op — a broad kind-only spec must not pay for a pointless query', async () => {
    expect(await explainIssueClaimFloors(H, [])).toEqual([]);
  });
});
