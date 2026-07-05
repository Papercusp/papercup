/**
 * fleet-bee-count.integration.test.ts — the per-fleet nursery bee counts against REAL
 * Postgres (WI-1813 / WI-1764 #4 follow-up). Proves countRunningFleetBees +
 * liveFleetBeeCountsFromNursery attribute a running bee to the fleet its spawn row is
 * STAMPED with (mig 475 fleet_slug) — reliable + presence-independent — and that
 * non-bee / terminal / other-fleet / other-workspace / NULL-fleet rows are excluded; and
 * that countRunningWorkspaceBees stays the workspace-wide belt-and-suspenders total that
 * still counts ungrouped bees the per-fleet counts miss. getOrgPg is pointed at a
 * throwaway DB.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/fleet/fleet-bee-count.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { countRunningFleetBees, liveFleetBeeCountsFromNursery, countRunningWorkspaceBees } =
  await import('./fleet-roster');

let db: FreshPgDb;
const WS = 'ws-a';

beforeAll(async () => {
  db = await createFreshPgDb('fleet-bee-count');
  h.sql = db.sql;
  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  // Minimal spawned_agents carrying the mig-475 fleet_slug column (the throwaway DB does
  // not run the migration set) — just the columns these count queries read.
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
      spawn_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      child_role text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      fleet_slug text,
      started_at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
});

async function seed(
  spawnId: string,
  over: { workspaceId?: string; childRole?: string; status?: string; fleetSlug?: string | null } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.spawned_agents (spawn_id, workspace_id, child_role, status, fleet_slug)
    VALUES (
      ${spawnId}, ${over.workspaceId ?? WS}, ${over.childRole ?? 'cup'},
      ${over.status ?? 'running'}, ${over.fleetSlug ?? null}
    )`;
}

describe('countRunningFleetBees (WI-1813 — reliable per-fleet bee count)', () => {
  it('counts running/restarting bees stamped with the fleet, excluding everything else', async () => {
    await seed('b1', { fleetSlug: 'rocket' });
    await seed('b2', { fleetSlug: 'rocket', status: 'restarting' });
    await seed('b3', { fleetSlug: 'rocket', status: 'done' }); // terminal → excluded
    await seed('b4', { fleetSlug: 'other' }); // other fleet → excluded
    await seed('b5', { fleetSlug: null }); // ungrouped → excluded
    await seed('m1', { fleetSlug: 'rocket', childRole: 'su' }); // not a bee → excluded
    await seed('b6', { fleetSlug: 'rocket', workspaceId: 'ws-other' }); // other workspace → excluded
    expect(await countRunningFleetBees('rocket', WS)).toBe(2);
    expect(await countRunningFleetBees('other', WS)).toBe(1);
    expect(await countRunningFleetBees('empty', WS)).toBe(0);
  });
});

describe('liveFleetBeeCountsFromNursery (WI-1813 — grouped per-fleet map)', () => {
  it('groups running bees by fleet_slug, excluding non-bees / terminal / null-fleet', async () => {
    await seed('b1', { fleetSlug: 'rocket' });
    await seed('b2', { fleetSlug: 'rocket' });
    await seed('b3', { fleetSlug: 'moss' });
    await seed('b4', { fleetSlug: 'moss', status: 'failed' }); // terminal → excluded
    await seed('b5', { fleetSlug: null }); // ungrouped → not a key
    await seed('m1', { fleetSlug: 'rocket', childRole: 'su' }); // not a bee → excluded
    const map = await liveFleetBeeCountsFromNursery(WS);
    expect(map.get('rocket')).toBe(2);
    expect(map.get('moss')).toBe(1);
    expect(map.has('empty')).toBe(false);
    expect([...map.keys()].sort()).toEqual(['moss', 'rocket']);
  });
});

describe('countRunningWorkspaceBees stays workspace-wide (the belt-and-suspenders total)', () => {
  it('counts every running bee including ungrouped / NULL-fleet rows the per-fleet counts miss', async () => {
    await seed('b1', { fleetSlug: 'rocket' });
    await seed('b2', { fleetSlug: null }); // ungrouped — counted here, not per-fleet
    await seed('b3', { fleetSlug: null, status: 'done' }); // terminal → excluded
    await seed('m1', { childRole: 'su', fleetSlug: 'rocket' }); // not a bee → excluded
    expect(await countRunningWorkspaceBees(WS)).toBe(2); // b1 + b2 (ungrouped still counts)
    expect(await countRunningFleetBees('rocket', WS)).toBe(1); // only the stamped bee
  });
});
