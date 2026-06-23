/**
 * stale-assignments.integration.test.ts — EI-2535 dead-holder ASSIGNMENT GC.
 *
 * Exercises `reclaimStaleDeadHolderPlanItemAssignments` against a real Postgres:
 * an assignment reserved past grace whose holder is gone (a one-shot session-id
 * assignee) is soft-released (released_ts); a within-grace reservation, a holder
 * still alive directly (fresh coord_presence / running nursery alias), a holder
 * alive THROUGH an adopting session (agent_name_sessions → fresh presence — the
 * proper stable-name case), and an already-released row are all left untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reclaimStaleDeadHolderPlanItemAssignments } = await import('./stale-claims');

const WS = 'ws-stale-plan-assignments';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';
const GRACE = 60 * 60 * 1000; // 60 min (the assignment default)
const STALE_SECS = 2 * 60 * 60; // 2h reserved — well past grace
const FRESH_SECS = 60; // 1 min reserved — within grace

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('stale-plan-assignments');
  h.sql = db.sql;
  await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  // The tables under test (assignments + the adoption binding), real schema.
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  // Minimal stubs for the liveness join — only the columns the live_alias CTE reads.
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text NOT NULL,
    heartbeat_at timestamptz DEFAULT now() NOT NULL )`;
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text, session_owner text, run_id text, status text, heartbeat_at timestamptz )`;
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_assignments`;
  await db.sql`TRUNCATE harness_shared.agent_name_sessions`;
  await db.sql`TRUNCATE harness_shared.coord_presence`;
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
});

/** Insert an active assignment whose assigned_ts is `agoSecs` in the past. */
async function assign(itemId: string, name: string, agoSecs: number): Promise<void> {
  await db.sql`INSERT INTO harness_shared.plan_item_assignments
    (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user, assigned_ts, released_ts)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, ${itemId}, ${name}, ${name},
            now() - make_interval(secs => ${agoSecs}), NULL)`;
}
/** Is the assignment still ACTIVE (released_ts IS NULL)? */
async function active(itemId: string): Promise<boolean> {
  const r = await db.sql`SELECT 1 FROM harness_shared.plan_item_assignments
                          WHERE item_id = ${itemId} AND released_ts IS NULL`;
  return r.length > 0;
}

describe('reclaimStaleDeadHolderPlanItemAssignments (EI-2535 assignment GC)', () => {
  it('soft-releases a stale assignment whose session-id holder has no live presence', async () => {
    await assign('P-001', 'su-dead-sess', STALE_SECS);
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-001']);
    expect(r.released[0]!.former_assignee).toBe('su-dead-sess');
    expect(r.released[0]!.reserved_secs).toBeGreaterThan(GRACE / 1000);
    expect(await active('P-001')).toBe(false);
  });

  it('does NOT reap an assignment reserved within the grace window', async () => {
    await assign('P-002', 'su-recent', FRESH_SECS);
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await active('P-002')).toBe(true);
  });

  it('does NOT reap when the name itself has FRESH coord_presence (session-id-as-name alive)', async () => {
    await assign('P-003', 'su-busy', STALE_SECS);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('su-busy', now())`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await active('P-003')).toBe(true);
  });

  it('does NOT reap a stable NAME whose ADOPTING session is alive (the durable-resume case)', async () => {
    await assign('P-004', 'builder-1', STALE_SECS);
    // A fresh session adopted the name → the name is alive via the binding.
    await db.sql`INSERT INTO harness_shared.agent_name_sessions
      (workspace_id, session_owner_id, agent_name, owner_user)
      VALUES (${WS}, 'su-new-sess', 'builder-1', 'su-new-sess')`;
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('su-new-sess', now())`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await active('P-004')).toBe(true);
  });

  it('does NOT reap when the name matches a RUNNING nursery alias', async () => {
    await assign('P-005', 'spawn-xyz', STALE_SECS);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-xyz', 'sess-owner', 'run-1', 'running', now())`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await active('P-005')).toBe(true);
  });

  it('DOES reap a stable name whose adopting session is DEAD (stale presence)', async () => {
    await assign('P-006', 'builder-2', STALE_SECS);
    await db.sql`INSERT INTO harness_shared.agent_name_sessions
      (workspace_id, session_owner_id, agent_name, owner_user)
      VALUES (${WS}, 'su-old-sess', 'builder-2', 'su-old-sess')`;
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
                 VALUES ('su-old-sess', now() - interval '2 hours')`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-006']);
    expect(await active('P-006')).toBe(false);
  });

  it('does NOT reap an already-released assignment', async () => {
    await assign('P-007', 'su-gone', STALE_SECS);
    await db.sql`UPDATE harness_shared.plan_item_assignments SET released_ts = now() WHERE item_id = 'P-007'`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
  });

  it('reaps several dead-holder assignments in one sweep, leaving the live one', async () => {
    for (const id of ['P-010', 'P-011', 'P-012']) await assign(id, `su-dead-${id}`, STALE_SECS);
    await assign('P-013', 'su-alive', STALE_SECS);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('su-alive', now())`;
    const r = await reclaimStaleDeadHolderPlanItemAssignments(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id).sort()).toEqual(['P-010', 'P-011', 'P-012']);
    expect(await active('P-013')).toBe(true);
  });
});
