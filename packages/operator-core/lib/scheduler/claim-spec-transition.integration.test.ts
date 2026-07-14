/**
 * WI-4770 recurrence guard: membership transitions must not widen a self-puller
 * into DEFAULT_CLAIM_SPEC while a replacement fleet lane is being rebound.
 *
 * Run with:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-transition.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import type { ClaimSpec } from './claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const migration = (file: string) =>
  readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/i.test(line))
    .join('\n');

const { getNextForBee, getClaimSpecRecord, setClaimSpec, fleetSpecBeeKey } = await import('./claim-spec-store');
const { appendFleetMembershipEvent } = await import('../fleet-membership-store');
const { DEFAULT_CLAIM_SPEC, validateClaimSpec } = await import('./claim-spec');

const H = 'papercup';
const WS = 'default';
const BEE = 'su-wi4770-switch';
const LEAVE_BEE = 'su-wi4770-leave';
const PARENT = 'reliability-parent';
const CHILD = 'reliability-child';
let db: FreshPgDb;

function laneSpec(specId: string, id: string): ClaimSpec {
  const spec = {
    specVersion: '1.0',
    specId,
    revision: 4,
    view: { filter: { field: 'id', op: 'in', value: [id] } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  } as ClaimSpec;
  const parsed = validateClaimSpec(spec);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return spec;
}

async function seedFeature(id: string, title: string) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, workspace_id, title, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'todo', ${WS}, ${title}, 1, 1)`;
}

async function membership(ownerId: string, fleetSlug: string | null, fleetRole: string | null) {
  await appendFleetMembershipEvent({ workspaceId: WS, ownerId, fleetSlug, fleetRole }, db.sql);
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-spec-transition');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic'`);

  // This test needs only the claim-spec table, not the federation triggers.
  // Keep the fixture small and create the durable membership ledger directly.
  await db.sql.unsafe(migration('372-bee-claim-specs.sql'));
  await db.sql.unsafe(migration('389-bee-claim-spec-id-only.sql'));
  await db.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs');
  await db.sql.unsafe('ALTER TABLE harness_shared.cup_claim_specs ADD COLUMN IF NOT EXISTS harness_slug text');
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.fleet_membership_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id text NOT NULL,
      owner_label text,
      fleet_slug text,
      fleet_role text,
      event text NOT NULL DEFAULT 'join',
      at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.cup_claim_specs, harness_shared.fleet_membership_events RESTART IDENTITY`;
});

afterAll(async () => {
  await db?.cleanup?.();
});

describe('WI-4770 fleet membership transition guard', () => {
  it('fails closed across a fleet switch until the new lane is explicitly rebound', async () => {
    const outside = 'WI-3488';
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: laneSpec('parent-lane', 'WI-in-scope') }, db.sql);
    await membership(BEE, PARENT, 'member');

    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'fleet',
      fleetSlug: PARENT,
    });

    // The observed failure path: a member changes fleet/role before the child
    // sentinel is installed. DEFAULT_CLAIM_SPEC would otherwise take WI-3488.
    await membership(BEE, CHILD, 'leader');
    await seedFeature(outside, 'p2p transport item');

    const guarded = await getNextForBee({ cupId: BEE, workspaceId: WS, harness: H });
    expect(guarded).toBeNull();
    expect(await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id=${outside}`).toEqual([{ taken_by: null }]);
    expect(await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'default',
      fleetSlug: CHILD,
    });

    // A deliberate per-bee rebind is the only way to reopen the pull path.
    await setClaimSpec({ cupId: BEE, spec: laneSpec('child-rebound', outside), updatedBy: 'leader' }, db.sql);
    const reboundRecord = await getClaimSpecRecord({ cupId: BEE, workspaceId: WS }, db.sql);
    expect(reboundRecord).toMatchObject({ source: 'cup', spec: { specId: 'child-rebound' } });
    expect(await db.sql`SELECT item_kind, status, taken_by FROM harness_shared.work_items WHERE feature_id=${outside}`).toEqual([
      { item_kind: 'feature', status: 'todo', taken_by: null },
    ]);
    // The rebind removes the transition marker; subsequent claim eligibility is
    // governed by the ordinary scheduler floors, not by this guard.
    expect(reboundRecord.fleetSlug).toBeUndefined();
  });

  it('fails closed after an explicit leave until the old lane is rebound', async () => {
    const outside = 'WI-4770-leave-outside';
    await setClaimSpec({ cupId: fleetSpecBeeKey(PARENT), spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await membership(LEAVE_BEE, PARENT, 'member');
    await membership(LEAVE_BEE, null, null);
    await seedFeature(outside, 'generic backlog item');

    expect(await getNextForBee({ cupId: LEAVE_BEE, workspaceId: WS, harness: H })).toBeNull();
    expect(await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id=${outside}`).toEqual([{ taken_by: null }]);
    expect(await getClaimSpecRecord({ cupId: LEAVE_BEE, workspaceId: WS }, db.sql)).toMatchObject({
      source: 'default',
      fleetSlug: PARENT,
    });
  });
});
