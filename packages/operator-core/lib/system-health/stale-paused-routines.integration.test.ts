/**
 * stale-paused-routines.integration.test.ts — `readStalePausedRoutines` against a
 * real Postgres (EI-18718973731535914).
 *
 * Two root causes fixed at the SQL layer — invisible to a fake-sql unit test, since
 * the exclusion logic lives in the query itself, not in `computeStalePausedRoutines`:
 *
 *  1. NO WORKSPACE SCOPING: the original query had no `workspace_id` predicate at
 *     all, so it read stale-paused rows across EVERY tenant in the database — the
 *     same bare-filter multi-tenant trap `dev:pg_query`'s own advisory warns about.
 *  2. NO ACTIVE-SIBLING CHECK: an inactive row was reported as a "stale pause" purely
 *     because it existed, even when a healthy ACTIVE row for the very same
 *     (workspace, install_slug, name) was firing normally right alongside it — one
 *     orphaned/duplicate dead row could outvote 13 healthy ones (the exact repro:
 *     "green-checkpoint: ONE row active=false … sitting alongside 13 healthy active
 *     ones").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';

const { readStalePausedRoutines } = await import('./compute');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `stalepaused_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, install_slug text NOT NULL, name text NOT NULL,
      trigger_kind text NOT NULL, trigger_config jsonb NOT NULL, target_role text NOT NULL,
      active boolean DEFAULT true NOT NULL, last_fired_at timestamptz, next_fire_at timestamptz,
      updated_at timestamptz DEFAULT now() NOT NULL, workspace_id text NOT NULL,
      metadata jsonb
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines`;
});

async function insertRoutine(o: {
  id: string;
  name: string;
  installSlug: string;
  workspaceId: string;
  active: boolean;
  updatedAt?: Date;
  metadata?: Record<string, unknown> | null;
}) {
  await rootSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, updated_at, workspace_id, metadata)
    VALUES (${o.id}, ${o.installSlug}, ${o.name}, 'schedule', '{}'::jsonb, 'system:loop-wake',
            ${o.active}, ${o.updatedAt ?? new Date()}, ${o.workspaceId}, ${o.metadata ? JSON.stringify(o.metadata) : null}::jsonb)`;
}

const oldPause = () => new Date(Date.now() - 11.5 * 60 * 60_000); // 11.5h ago — past the 4h critical threshold

describe('readStalePausedRoutines — SQL-level scoping (EI-18718973731535914)', () => {
  it('excludes an inactive row belonging to a DIFFERENT workspace (no cross-tenant leak)', async () => {
    await insertRoutine({ id: 'other-ws-dead', name: 'scout-cycle', installSlug: 'some-hive', workspaceId: 'ws-other', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r).toEqual([]);
  });

  it('reports an inactive row scoped to the CURRENT workspace', async () => {
    await insertRoutine({ id: 'this-ws-dead', name: 'scout-cycle', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['scout-cycle']);
  });

  it('excludes an inactive row when a HEALTHY ACTIVE sibling exists for the same (workspace, install, name) — the "13 healthy outvoted by 1 dead row" repro', async () => {
    // The orphaned/duplicate dead row (e.g. left behind by a reseed).
    await insertRoutine({ id: 'gc-orphan', name: 'green-checkpoint', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    // The healthy, currently-firing row for the SAME workspace/install/name.
    await insertRoutine({ id: 'gc-live', name: 'green-checkpoint', installSlug: 'papercusp', workspaceId: 'ws1', active: true });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r).toEqual([]);
  });

  it('still reports an inactive row when NO active sibling exists for it (a genuine stale pause)', async () => {
    await insertRoutine({ id: 'rt-dead', name: 'release-trigger', installSlug: 'papercusp', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    const r = await readStalePausedRoutines(rootSql, 'papercusp', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['release-trigger']);
    expect(r[0].critical).toBe(true);
  });

  it('a same-named active sibling on a DIFFERENT install does NOT suppress the dead row (siblings must match install_slug too)', async () => {
    await insertRoutine({ id: 'gc-dead-a', name: 'green-checkpoint', installSlug: 'install-a', workspaceId: 'ws1', active: false, updatedAt: oldPause() });
    await insertRoutine({ id: 'gc-live-b', name: 'green-checkpoint', installSlug: 'install-b', workspaceId: 'ws1', active: true });
    const r = await readStalePausedRoutines(rootSql, 'install-a', 'ws1');
    expect(r.map((x) => x.name)).toEqual(['green-checkpoint']);
    expect(r[0].critical).toBe(true);
  });
});
