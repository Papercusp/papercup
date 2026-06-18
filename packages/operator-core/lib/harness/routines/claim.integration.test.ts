/**
 * claim.integration.test.ts — claimDueRoutine, the atomic routine-claim primitive,
 * against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - a recurring (cron/rrule) routine is claimed ONLY when active + due
 *    (next_fire_at IS NULL OR <= now()); the claim advances next_fire_at, so a
 *    second racing claim sees not-due and loses;
 *  - a ONE-SHOT (no recurrence) claim DEACTIVATES the routine (active=FALSE), not
 *    just nulls next_fire_at (which would refire forever);
 *  - EI-1371: claiming a `plan-schedule-<slug>` one-shot ALSO un-arms the owning
 *    plan (harness_plans.schedule_active=FALSE) — the two-write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual };
});

const { claimDueRoutine } = await import('./claim');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `claim_${randomBytes(5).toString('hex')}`;
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
      updated_at timestamptz DEFAULT now() NOT NULL, workspace_id text NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      schedule_active boolean NOT NULL DEFAULT false, updated_at timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines, harness_shared.harness_plans`;
});

async function insertRoutine(o: { id: string; name?: string; targetRole?: string; cfg: object; active?: boolean; nextFireAt?: Date | null }) {
  const name = o.name ?? o.id;
  await rootSql`
    INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, workspace_id)
    VALUES (${o.id}, 'web', ${name}, 'schedule', ${rootSql.json(o.cfg)}, ${o.targetRole ?? 'worker'},
            ${o.active ?? true}, ${o.nextFireAt ?? null}, 'ws1')`;
  return { id: o.id, workspaceId: 'ws1', installSlug: 'web', name, targetRole: o.targetRole ?? 'worker', triggerConfig: o.cfg } as never;
}
const activeOf = async (id: string) => (await rootSql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines WHERE id=${id}`)[0]?.active;
const nextFireOf = async (id: string) => (await rootSql<{ next_fire_at: Date | null }[]>`SELECT next_fire_at FROM harness_shared.routines WHERE id=${id}`)[0]?.next_fire_at;

describe('claimDueRoutine — recurring', () => {
  it('claims a due cron routine and advances next_fire_at; a second claim then loses', async () => {
    const r = await insertRoutine({ id: 'r1', cfg: { cron: '0 0 * * *' }, nextFireAt: null }); // null = due
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await nextFireOf('r1')).toBeInstanceOf(Date); // advanced to the next cron time (future)
    expect(await activeOf('r1')).toBe(true); // recurring stays active
    expect(await claimDueRoutine(rootSql, r)).toBe(false); // not due anymore → loser
  });

  it('does NOT claim a not-yet-due routine', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const r = await insertRoutine({ id: 'r2', cfg: { cron: '0 0 * * *' }, nextFireAt: future });
    expect(await claimDueRoutine(rootSql, r)).toBe(false);
  });

  it('does NOT claim an inactive routine', async () => {
    const r = await insertRoutine({ id: 'r3', cfg: { cron: '0 0 * * *' }, active: false, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(false);
  });
});

describe('claimDueRoutine — one-shot', () => {
  it('claims a one-shot (no recurrence) and DEACTIVATES it', async () => {
    const r = await insertRoutine({ id: 'os1', cfg: {}, nextFireAt: null }); // no cron/rrule
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('os1')).toBe(false); // deactivated — won't refire
  });

  it('EI-1371: claiming a plan-schedule one-shot ALSO un-arms the owning plan', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active)
                  VALUES ('ws1', 'web', 'myplan', true)`;
    const r = await insertRoutine({ id: 'ps1', name: 'plan-schedule-myplan', targetRole: 'system:plan-run', cfg: {}, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('ps1')).toBe(false); // routine deactivated
    const plan = (await rootSql<{ schedule_active: boolean }[]>`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='myplan'`)[0]!;
    expect(plan.schedule_active).toBe(false); // plan un-armed too (the two-write)
  });
});
