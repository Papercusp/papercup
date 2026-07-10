/**
 * Compaction-survival test class (EI-8999, fleet-reliability-verification-2026-07-10
 * P-002) — a "harness test simulating a sid rebind mid-hold" against a REAL
 * Postgres (createFreshPgDb, an isolated testcontainer), exercising `rebindIdentity`
 * exactly the way a live compaction rebind does: seed every named family under a
 * dead FROM sid, call `rebindIdentity(FROM, TO, { sql })` once, assert every family
 * followed the live TO sid.
 *
 * WHY a real DB and not the existing fakeSql unit test (rebind-identity.test.ts):
 * the unit test proves each surface emits the SQL its comment claims; this test
 * proves that SQL actually does the re-key against a real engine, in the SAME
 * "several families held at once, one rebind call" shape a live mid-hold rebind
 * takes — the shape WI-3642 broke in (one family's surface silently missed a
 * held claim while the others succeeded).
 *
 * Families covered here, matched 1:1 against the plan item's list:
 *   - work-item claims, BOTH the FEATURE family (item_kind='feature') and the
 *     ISSUE family (item_kind='task') — WI-3642 regressed exactly the ISSUE
 *     family (only the engineer_issues compat view was re-keyed; work_items.taken_by
 *     itself, which the FEATURE family — and every item_kind — actually lives in,
 *     was not). This test seeds both kinds in ONE `work_items` table and asserts
 *     the 'held-work-items' surface (rebind-identity.ts step 11b, the WI-3642 fix)
 *     re-keys both, so a future edit that re-narrows it to one kind fails loudly.
 *   - plan-item claims (plan_item_claims.owner).
 *   - loop registrations (routines.target_owner_id + payload_template + the
 *     routine id/name, which embed the sid textually).
 *   - events:await registrations (event_awaits.subscriber_id + the sid embedded
 *     in an event_key, e.g. an inbox-wake key) — "watch subscriptions" in the
 *     plan text names the same underlying primitive (watch:create's presets are
 *     events:await + topics:subscribe; there is no separate DB-backed "watch"
 *     table to seed here).
 *
 * File locks are NOT exercised here — they live in `@papercusp/locks`'s own
 * side-database (papercusp_su), a different Postgres connection this fixture
 * doesn't stand up. That family is covered by rebind-owner.test.ts (unit) in the
 * locks package plus the coord:rebind-identity tool wiring; see rebind-identity.ts's
 * `rebindLockOwner` option doc for why it is a separate seam.
 *
 * Only the columns rebindIdentity's own queries reference are created — this is
 * a deliberately minimal schema, not a schema-parity fixture. Every OTHER surface
 * rebindIdentity attempts (carry-note, presence, fleet-membership, claim-spec,
 * watermarks, held-items, owner-facts, read-cursors, pending-wakes) has no table
 * here and will show up as a per-surface `error` (missing relation) — expected
 * and asserted away from, not a false pass: this test only asserts the surfaces
 * it deliberately seeded, exactly the families named in the plan item.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { rebindIdentity } from './rebind-identity';
import { loopRoutineId, loopRoutineName } from '../../harness/routines/loop';

const WS = 'mid-hold-ws';
const HARNESS = 'mid-hold-harness';
const FROM = 'su-dead-predecessor-aaaa';
const TO = 'su-live-successor-bbbb';

describe('rebindIdentity — mid-hold compaction survival (real Postgres)', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('rebind-mid-hold');
    sql = db.sql;

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.work_items (
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        feature_id   text NOT NULL,
        item_kind    text NOT NULL DEFAULT 'feature',
        status       text,
        taken_by     text,
        PRIMARY KEY (workspace_id, harness_slug, feature_id)
      );

      CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        plan_slug    text NOT NULL,
        item_id      text NOT NULL,
        owner        text NOT NULL,
        PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
      );

      CREATE TABLE IF NOT EXISTS harness_shared.routines (
        id                      text PRIMARY KEY,
        install_slug            text NOT NULL,
        name                    text NOT NULL,
        target_owner_id         text,
        reschedule_interval_sec integer,
        payload_template        jsonb,
        updated_at              timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS harness_shared.event_awaits (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        workspace_id  text NOT NULL DEFAULT 'default',
        subscriber_id text NOT NULL,
        event_key     text NOT NULL,
        fired_at      timestamptz,
        cancelled_at  timestamptz
      );
    `);
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it('re-keys work-item claims (FEATURE + ISSUE families), plan-item claims, a loop registration, and an events:await registration in one rebind pass', async () => {
    // ── Seed every family under the dead FROM sid, as if it were mid-hold ──

    // Work-item claims: one FEATURE-family row, one ISSUE-family row (item_kind
    // 'task' — the family WI-3642 actually regressed). Both must move: the
    // 'held-work-items' surface (step 11b) has no item_kind filter by design.
    await sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, taken_by)
      VALUES
        (${WS}, ${HARNESS}, 'WI-FEAT-1', 'feature', 'wip', ${FROM}),
        (${WS}, ${HARNESS}, 'WI-TASK-1', 'task',    'wip', ${FROM}),
        (${WS}, ${HARNESS}, 'WI-DONE-1', 'feature', 'done', ${FROM})
    `;

    // Plan-item claim.
    await sql`
      INSERT INTO harness_shared.plan_item_claims (workspace_id, harness_slug, plan_slug, item_id, owner)
      VALUES (${WS}, ${HARNESS}, 'mid-hold-plan', 'P-001', ${FROM})
    `;

    // Loop registration — id/name derive from the ownerId (matching loop.ts's
    // convention), payload_template embeds the sid textually.
    const loopId = loopRoutineId(HARNESS, FROM);
    await sql`
      INSERT INTO harness_shared.routines (id, install_slug, name, target_owner_id, reschedule_interval_sec, payload_template)
      VALUES (${loopId}, ${HARNESS}, ${loopRoutineName(FROM)}, ${FROM}, 1200,
              ${sql.json({ kickoff: `wake ${FROM} and continue` })})
    `;

    // events:await registration ("watch subscriptions" in the plan text — the
    // same underlying primitive), with the sid embedded in the event key too
    // (the shape an inbox-wake await actually takes).
    await sql`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      VALUES (${WS}, ${FROM}, ${'coord:inbox-wake:' + FROM})
    `;

    // ── The mid-hold rebind — one call, exactly what the SessionStart
    //    recovery hook / coord:rebind-identity fires. ──
    const res = await rebindIdentity(FROM, TO, { sql });

    // ── Assert every seeded family followed the live TO sid. ──

    const workItems = await sql`
      SELECT feature_id, item_kind, taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} ORDER BY feature_id
    `;
    expect(workItems).toEqual([
      { feature_id: 'WI-DONE-1', item_kind: 'feature', taken_by: FROM }, // terminal — history keeps its author, by design
      { feature_id: 'WI-FEAT-1', item_kind: 'feature', taken_by: TO },
      { feature_id: 'WI-TASK-1', item_kind: 'task', taken_by: TO },
    ]);

    const planClaim = await sql`
      SELECT owner FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'mid-hold-plan' AND item_id = 'P-001'
    `;
    expect(planClaim[0]?.owner).toBe(TO);

    const routine = await sql`SELECT id, name, target_owner_id, payload_template FROM harness_shared.routines`;
    expect(routine).toHaveLength(1);
    expect(routine[0].id).toBe(loopRoutineId(HARNESS, TO));
    expect(routine[0].name).toBe(loopRoutineName(TO));
    expect(routine[0].target_owner_id).toBe(TO);
    expect(JSON.stringify(routine[0].payload_template)).toContain(TO);
    expect(JSON.stringify(routine[0].payload_template)).not.toContain(FROM);

    const awaits = await sql`
      SELECT subscriber_id, event_key FROM harness_shared.event_awaits WHERE workspace_id = ${WS}
    `;
    expect(awaits).toHaveLength(1);
    expect(awaits[0].subscriber_id).toBe(TO);
    expect(awaits[0].event_key).toBe('coord:inbox-wake:' + TO);

    // The seeded surfaces themselves report ok (moved > 0); unseeded surfaces
    // (carry-note, presence, fleet-*, claim-spec, watermarks, held-items,
    // owner-facts, read-cursors, pending-wakes) hit a missing relation and are
    // expected to error in this deliberately minimal fixture — not asserted on.
    const seeded = ['held-work-items', 'plan-claims', 'loop-routine', 'awaits'];
    for (const name of seeded) {
      const surface = res.surfaces.find((s) => s.surface === name);
      expect(surface, `surface ${name} missing`).toBeTruthy();
      expect(surface!.error, `surface ${name} errored: ${surface!.error}`).toBeUndefined();
      expect(surface!.moved, `surface ${name} moved nothing`).toBeGreaterThan(0);
    }
  });
});
