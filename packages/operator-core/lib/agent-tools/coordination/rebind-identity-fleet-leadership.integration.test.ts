/**
 * rebindIdentity — fleet-leadership surface, against a REAL Postgres (WI-5386,
 * coord-rebind-fleet-leadership-column-fix-2026-07-19).
 *
 * WHY a real DB and not the existing fakeSql unit test (rebind-identity.test.ts):
 * that unit test's `fakeSql` fake matches on `UPDATE harness_shared.agent_fleets`
 * and hands back rows shaped `{ slug }` — it only ever asserts `moved: N` (a row
 * COUNT), so a query that actually names the WRONG column in `RETURNING` (e.g.
 * `RETURNING slug` when the real table's column is `fleet_slug`) still passes
 * the unit test: the mock never validates the SQL against a real schema. That
 * is exactly the shape of the live incident this test guards against — hit
 * 2026-07-18 16:04Z, a relaunched leader's `coord:rebind-identity` reported
 * `surfaces[fleet-leadership] = { moved: 0, error: "column \"slug\" does not
 * exist" }` while every other surface migrated cleanly, leaving the fleet
 * record's `leader_owner_id` pointed at the dead predecessor sid.
 *
 * This test creates `harness_shared.agent_fleets` with the column shape a real
 * migration produces (mig 417 — `fleet_slug`, not `slug`), seeds a fleet led by
 * the dead FROM sid, calls `rebindIdentity` against the real engine, and
 * asserts the leader field actually moved to the live TO sid with no error —
 * a mismatched column name in the query fails LOUDLY here (a real
 * "column ... does not exist" from Postgres), not silently in a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { rebindIdentity } from './rebind-identity';

const WS = 'fleet-leadership-ws';
const FLEET = 'fleet-leadership-test-fleet';
const FROM = 'su-dead-leader-aaaa';
const TO = 'su-live-leader-bbbb';

describe('rebindIdentity — fleet-leadership surface (real Postgres)', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('rebind-fleet-leadership');
    sql = db.sql;

    // Column-for-column faithful to the real `agent_fleets` table (mig 417 +
    // later additions) for the columns rebindIdentity's fleet-leadership query
    // touches: `fleet_slug` (NOT a bare `slug`) is the load-bearing name.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.agent_fleets (
        workspace_id    text NOT NULL,
        fleet_slug      text NOT NULL,
        leader_owner_id text,
        PRIMARY KEY (workspace_id, fleet_slug)
      );
    `);
  });

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('moves a fleet leader field from a dead sid to the live sid, with no per-surface error', async () => {
    await sql`
      INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, leader_owner_id)
      VALUES (${WS}, ${FLEET}, ${FROM})
    `;

    const res = await rebindIdentity(FROM, TO, { sql });

    const fleet = await sql`
      SELECT leader_owner_id FROM harness_shared.agent_fleets
       WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}
    `;
    expect(fleet[0]?.leader_owner_id).toBe(TO);

    const surface = res.surfaces.find((s) => s.surface === 'fleet-leadership');
    expect(surface, 'fleet-leadership surface missing').toBeTruthy();
    expect(surface!.error, `fleet-leadership surface errored: ${surface!.error}`).toBeUndefined();
    expect(surface!.moved).toBe(1);
  });

  it('is idempotent — re-running after the leader already moved reports moved:0, no error', async () => {
    const res = await rebindIdentity(FROM, TO, { sql });
    const surface = res.surfaces.find((s) => s.surface === 'fleet-leadership');
    expect(surface!.error).toBeUndefined();
    expect(surface!.moved).toBe(0);
  });
});
