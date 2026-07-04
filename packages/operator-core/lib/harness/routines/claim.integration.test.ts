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
      updated_at timestamptz DEFAULT now() NOT NULL, workspace_id text NOT NULL,
      -- migration 323 (B-LOOP-1): the loop recurrence kind.
      reschedule_interval_sec integer, target_owner_id text
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

async function insertRoutine(o: { id: string; name?: string; targetRole?: string; cfg: Record<string, unknown>; active?: boolean; nextFireAt?: Date | null; rescheduleIntervalSec?: number | null }) {
  const name = o.name ?? o.id;
  const intervalSec = o.rescheduleIntervalSec ?? null;
  await rootSql`
    INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, workspace_id, reschedule_interval_sec)
    VALUES (${o.id}, 'web', ${name}, 'schedule', ${JSON.stringify(o.cfg)}::text::jsonb, ${o.targetRole ?? 'worker'},
            ${o.active ?? true}, ${o.nextFireAt ?? null}, 'ws1', ${intervalSec})`;
  // The stub MUST carry rescheduleIntervalSec — claimDueRoutine reads it to detect a loop.
  return { id: o.id, workspaceId: 'ws1', installSlug: 'web', name, targetRole: o.targetRole ?? 'worker', triggerConfig: o.cfg, rescheduleIntervalSec: intervalSec } as never;
}
const activeOf = async (id: string) => (await rootSql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines WHERE id=${id}`)[0]?.active;
const nextFireOf = async (id: string) => (await rootSql<{ next_fire_at: Date | null }[]>`SELECT next_fire_at FROM harness_shared.routines WHERE id=${id}`)[0]?.next_fire_at;
// A parked loop's next_fire_at is 'infinity' (postgres-js parses it to an Invalid Date,
// so compare in SQL, not JS): true iff next_fire_at = 'infinity'::timestamptz.
const parkedOf = async (id: string) =>
  (await rootSql<{ parked: boolean }[]>`SELECT next_fire_at = 'infinity'::timestamptz AS parked FROM harness_shared.routines WHERE id=${id}`)[0]?.parked;
// Simulate B-LOOP-2's completion-rebase: re-arm a parked loop to a DUE time.
const rearmDue = async (id: string) =>
  rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second' WHERE id=${id}`;

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

// loop-routines-interval-recurrence-2026-06-20 P-003 (B-LOOP-1) — the THIRD recurrence kind.
describe('claimDueRoutine — loop (P-003)', () => {
  it('a PURE loop stays active + PARKS at infinity on claim (not deactivated, not NULL)', async () => {
    const r = await insertRoutine({ id: 'lp1', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null }); // due, no cron/rrule
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('lp1')).toBe(true); // NOT deactivated (the one-shot trap)
    expect(await parkedOf('lp1')).toBe(true); // next_fire_at='infinity', NOT NULL (the refire trap)
  });

  it('never refires while parked: a second claim on a parked loop LOSES', async () => {
    const r = await insertRoutine({ id: 'lp2', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true); // claim → park
    expect(await parkedOf('lp2')).toBe(true);
    expect(await claimDueRoutine(rootSql, r)).toBe(false); // 'infinity' <= now() is false → not due → no re-claim
    expect(await activeOf('lp2')).toBe(true); // still alive, still parked
  });

  it('re-fires after the completion-rebase re-arms it (survives MANY claims, never deactivates)', async () => {
    const r = await insertRoutine({ id: 'lp3', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null });
    for (let i = 0; i < 5; i++) {
      expect(await claimDueRoutine(rootSql, r)).toBe(true); // claim
      expect(await parkedOf('lp3')).toBe(true); // parked in-flight
      expect(await activeOf('lp3')).toBe(true); // P-003 regression: a pure loop NEVER deactivates
      await rearmDue('lp3'); // B-LOOP-2 re-arm after the turn settles
    }
    expect(await activeOf('lp3')).toBe(true);
  });

  it('a pure loop NEVER touches harness_plans, even when named plan-schedule-*', async () => {
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, schedule_active)
                  VALUES ('ws1', 'web', 'looplan', true)`;
    // A loop branch returns BEFORE the one-shot plan-unarm — the loop must not disarm the plan.
    const r = await insertRoutine({ id: 'lp4', name: 'plan-schedule-looplan', targetRole: 'system:plan-run', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await parkedOf('lp4')).toBe(true); // parked, not deactivated
    expect(await activeOf('lp4')).toBe(true);
    const plan = (await rootSql<{ schedule_active: boolean }[]>`SELECT schedule_active FROM harness_shared.harness_plans WHERE plan_slug='looplan'`)[0]!;
    expect(plan.schedule_active).toBe(true); // plan STILL armed — the loop never disarmed it
  });

  it('cron+loop is recurrence: advances to cron-next (does NOT park), stays active', async () => {
    // hasRecurrence (cron present) → the recurrence branch; the loop re-arm is folded in later by B-LOOP-2.
    const r = await insertRoutine({ id: 'cl1', cfg: { cron: '0 0 * * *' }, rescheduleIntervalSec: 60, nextFireAt: null });
    expect(await claimDueRoutine(rootSql, r)).toBe(true);
    expect(await activeOf('cl1')).toBe(true);
    expect(await parkedOf('cl1')).toBe(false); // NOT parked at infinity
    const nf = await nextFireOf('cl1');
    expect(nf).toBeInstanceOf(Date); // advanced to a real cron-next time
    expect(nf!.getTime()).toBeGreaterThan(Date.now()); // a finite future time, not infinity
  });
});
