/**
 * dead-routines.integration.test.ts — `readDeadRoutines` (the workFeed
 * engine-starvation detector) against a real Postgres.
 *
 * EI-11797 regression: the dead-routine detector must count only routines whose
 * overdue `next_fire_at` genuinely means the routinesTick is NOT firing them —
 * i.e. CRON/rrule routines (incl. cron+loop). A PURE LOOP (reschedule_interval_sec
 * set, no cron/rrule) has period (turn-duration + interval): a busy owner (an
 * actively-running fleet loop) or the transient completion-rebase→next-claim window
 * legitimately leaves it briefly overdue, which is NOT engine starvation. Counting
 * it mis-fired the workFeed CRIT + a fleet-wide "routine engine is starved" blocker
 * "while the active fleet loop is running" (the dead-routines flap, 2026-07-11/12).
 *
 * Behaviors a fake-sql unit test can't prove (the exclusion lives in SQL):
 *  - an overdue CRON routine IS reported (a genuine engine-starvation signal);
 *  - an overdue PURE LOOP is NOT reported (the false positive this fixes);
 *  - a PARKED loop (next_fire_at='infinity') is NOT reported (never < now());
 *  - an overdue cron+loop IS reported (a recurrence the engine advances → real);
 *  - a not-yet-due / inactive routine is NOT reported.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const { readDeadRoutines } = await import('./compute');

const OVERDUE_MS = 10 * 60_000;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `deadroutines_${randomBytes(5).toString('hex')}`;
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
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines`;
});

/** next_fire_at 15min in the past — comfortably past the 10min overdue window. */
const overduePast = () => new Date(Date.now() - 15 * 60_000);
/** next_fire_at 1h in the future — never overdue. */
const future = () => new Date(Date.now() + 60 * 60_000);

async function insertRoutine(o: {
  id: string;
  cfg: Record<string, unknown>;
  active?: boolean;
  nextFireAt?: Date | 'infinity' | null;
  rescheduleIntervalSec?: number | null;
}) {
  const nf = o.nextFireAt === 'infinity' ? null : (o.nextFireAt ?? null);
  await rootSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, workspace_id, reschedule_interval_sec)
    VALUES (${o.id}, 'web', ${o.id}, 'schedule', ${JSON.stringify(o.cfg)}::text::jsonb, 'system:loop-wake',
            ${o.active ?? true}, ${nf}, 'ws1', ${o.rescheduleIntervalSec ?? null})`;
  // 'infinity' can't bind as a Date param — set it via SQL after insert (mirrors a parked loop).
  if (o.nextFireAt === 'infinity') {
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = 'infinity'::timestamptz WHERE id = ${o.id}`;
  }
}

describe('readDeadRoutines — engine-starvation detector (EI-11797)', () => {
  it('reports an overdue CRON routine (a genuine engine-starvation signal)', async () => {
    await insertRoutine({ id: 'cron-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: overduePast() });
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual(['cron-dead']);
  });

  it('does NOT report an overdue PURE LOOP (busy fleet loop, not engine starvation)', async () => {
    // A pure loop: interval set, NO cron/rrule. Its next_fire_at is 'completed_at +
    // interval' — 15min past here (the owner is running a long turn) — yet the engine
    // is fine. This is the exact false positive EI-11797 fixes.
    await insertRoutine({ id: 'loop-overdue', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual([]);
  });

  it('does NOT report a PARKED loop (next_fire_at=infinity, actively running)', async () => {
    await insertRoutine({ id: 'loop-parked', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: 'infinity' });
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual([]);
  });

  it('STILL reports an overdue cron+loop (a recurrence the engine should be advancing)', async () => {
    // cron+loop has an interval AND a cron → claimDueRoutine advances it to cron-next
    // every tick (never parks it), so an overdue one genuinely means the engine is stuck.
    await insertRoutine({ id: 'cronloop-dead', cfg: { cron: '*/30 * * * * *' }, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual(['cronloop-dead']);
  });

  it('does NOT report a not-yet-due cron routine, nor an inactive one', async () => {
    await insertRoutine({ id: 'cron-future', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    await insertRoutine({ id: 'cron-inactive', cfg: { cron: '*/30 * * * * *' }, active: false, nextFireAt: overduePast() });
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual([]);
  });

  it('mixes them: only genuine engine-starvation rows surface, loops excluded', async () => {
    await insertRoutine({ id: 'cron-dead', cfg: { cron: '*/30 * * * * *' }, nextFireAt: new Date(Date.now() - 20 * 60_000) });
    await insertRoutine({ id: 'cronloop-dead', cfg: { rrule: 'FREQ=MINUTELY' }, rescheduleIntervalSec: 60, nextFireAt: new Date(Date.now() - 15 * 60_000) });
    await insertRoutine({ id: 'loop-overdue', cfg: {}, rescheduleIntervalSec: 60, nextFireAt: overduePast() });
    await insertRoutine({ id: 'loop-parked', cfg: {}, rescheduleIntervalSec: 1800, nextFireAt: 'infinity' });
    await insertRoutine({ id: 'cron-future', cfg: { cron: '*/30 * * * * *' }, nextFireAt: future() });
    // Ordered by next_fire_at ASC → cron-dead (20m) before cronloop-dead (15m).
    expect(await readDeadRoutines(rootSql, OVERDUE_MS)).toEqual(['cron-dead', 'cronloop-dead']);
  });
});
