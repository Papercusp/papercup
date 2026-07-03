/**
 * loop-cycle-composition.integration.test.ts — the END-TO-END loop CYCLE across the three
 * Phase-A pieces, proven against a REAL migrated Postgres (testcontainer; migration 323's
 * reschedule_interval_sec + target_owner_id present).
 *
 * Why this exists (the gap the per-piece tests leave): claim.integration.test.ts asserts
 * claimDueRoutine PARKS a loop at next_fire_at='infinity', and reconcile-loop-routines.
 * integration.test.ts SEEDS parked loops at 'infinity' and asserts the rebase — but BOTH
 * hardcode the 'infinity' + reschedule_interval_sec contract on their own side. Nothing
 * proves the REAL claimDueRoutine output is exactly what the REAL reconcileLoopRoutines
 * selector consumes. This drives the actual functions in sequence —
 *   claimDueRoutine (B-LOOP-1, park) → reconcileLoopRoutines (B-LOOP-2, rebase) →
 *   claimDueRoutine (re-fire)
 * — through listDueCronRoutines/rowToRoutine (B-LOOP-1, which must normalize 'infinity'),
 * so a drift between claim's park representation and reconcile's selector would FAIL here.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop-cycle-composition.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (Phase A composition).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { listDueCronRoutines, type RoutineRow } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { claimDueRoutine } from './claim';
import { reconcileLoopRoutines } from './reconcile-loop-routines';

/** HERMETIC wrapper — the default recordFire/readFireState bind the LIVE dev DB via
 *  getOrgPg(), not the testcontainer `sql` (the EI-7006 time-bomb flake in
 *  reconcile-loop-routines.integration.test.ts, 2026-07-03). Stub both. */
const reconcile = (o: NonNullable<Parameters<typeof reconcileLoopRoutines>[0]>) =>
  reconcileLoopRoutines({ recordFire: async () => {}, readFireState: async () => null, ...o });

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop-cycle';
const HARNESS = 'papercup';
const OWNER = 'su-loop-cycle-owner';
const INTERVAL_SEC = 60;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS}`;
});

/** Insert a DUE pure loop (interval set, NO cron/rrule; next_fire_at far in the past). */
async function insertDueLoop(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, workspace_id, next_fire_at, reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', '{}'::jsonb, 'su',
      TRUE, ${WS}, '2000-01-01T00:00:00Z'::timestamptz, ${INTERVAL_SEC}, ${OWNER}
    )`;
}

/** Read parked-ness (SQL boolean — postgres-js parses 'infinity' to an Invalid JS Date) +
 *  the real last_fired_at and the armed next_fire_at (null when parked). */
async function readState(id: string): Promise<{ parked: boolean; firedAtMs: number | null; nextFireMs: number | null }> {
  const r = await sql<{ parked: boolean; last_fired_at: Date | null; next_fire_at: Date | null }[]>`
    SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, last_fired_at, next_fire_at
      FROM harness_shared.routines WHERE id = ${id}`;
  const row = r[0]!;
  return {
    parked: row.parked,
    firedAtMs: row.last_fired_at ? row.last_fired_at.getTime() : null,
    nextFireMs: row.parked || !row.next_fire_at ? null : row.next_fire_at.getTime(),
  };
}

/** The Stop/SessionEnd-hook lifecycle 'ended' marker reconcile consumes (summary ILIKE '%end%'). */
async function seedSettle(atMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
    VALUES (${WS}, ${OWNER}, 'lifecycle', '■ session ended', ${new Date(atMs)})`;
}

/** Re-read the loop as a real RoutineRow via listDueCronRoutines (exercises rowToRoutine). */
async function dueLoop(id: string): Promise<RoutineRow | undefined> {
  return (await listDueCronRoutines(sql)).find((r) => r.id === id);
}

describe('loop cycle — claimDueRoutine ↔ reconcileLoopRoutines compose through the real functions', () => {
  it('park → rebase → re-fire: the loop the REAL claim parks is exactly what the REAL reconcile re-arms', async () => {
    const id = 'rt-cycle-1';
    await insertDueLoop(id);

    // 1. The due loop surfaces via listDueCronRoutines (B-LOOP-1 rowToRoutine carries the
    //    loop fields). Claim it through the REAL claimDueRoutine.
    const loop1 = await dueLoop(id);
    expect(loop1).toBeDefined();
    expect(loop1!.rescheduleIntervalSec).toBe(INTERVAL_SEC); // the loop interval round-tripped
    expect(loop1!.targetOwnerId).toBe(OWNER);
    expect(await claimDueRoutine(sql, loop1!)).toBe(true);

    // 2. The real claim PARKED it at 'infinity' (active, in-flight) — and a parked loop is
    //    skipped by listDueCronRoutines (real skip-if-in-flight, infinity not-due).
    const parked = await readState(id);
    expect(parked.parked).toBe(true);
    expect(parked.firedAtMs).not.toBeNull();
    expect(await dueLoop(id)).toBeUndefined(); // not re-listed while parked

    // 3. A turn settles AFTER the fire. The REAL reconcileLoopRoutines must FIND the loop the
    //    real claim parked (the contract pin: claim's 'infinity' park == reconcile's selector)
    //    and rebase it to completed_at + interval.
    const firedAtMs = parked.firedAtMs!;
    const settledAtMs = firedAtMs + 5_000;
    await seedSettle(settledAtMs);
    const res = await reconcile({ sql, nowMs: settledAtMs + 5_000 });
    expect(res.rearmed).toBe(1); // ← would be 0 if claim's park didn't match reconcile's selector
    expect(res.loops[0]).toMatchObject({ id, via: 'lifecycle' });

    // 4. The loop is now armed to a REAL finite time (not infinity), exactly completed+interval.
    const rearmed = await readState(id);
    expect(rearmed.parked).toBe(false);
    expect(rearmed.nextFireMs).toBe(settledAtMs + INTERVAL_SEC * 1_000);

    // 5. When that armed time arrives (simulate the interval elapsing), the REAL claim re-fires
    //    — the loop CYCLES: park → rebase → re-fire → park again.
    await sql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second' WHERE id = ${id}`;
    const loop2 = await dueLoop(id);
    expect(loop2).toBeDefined(); // due again
    expect(await claimDueRoutine(sql, loop2!)).toBe(true);
    expect((await readState(id)).parked).toBe(true); // re-parked in-flight — the cycle repeats
  });

  it('a parked loop with NO settle stays parked across a reconcile + is never re-fired', async () => {
    const id = 'rt-cycle-2';
    await insertDueLoop(id);
    const loop = await dueLoop(id);
    expect(await claimDueRoutine(sql, loop!)).toBe(true); // park

    // No lifecycle 'ended' marker after the fire → reconcile must leave it parked (in-flight),
    // and a parked loop is never due, so a re-claim attempt also loses.
    const firedAtMs = (await readState(id)).firedAtMs!;
    const res = await reconcile({ sql, nowMs: firedAtMs + 5_000 });
    expect(res.rearmed).toBe(0);
    expect((await readState(id)).parked).toBe(true);
    expect(await dueLoop(id)).toBeUndefined(); // still parked → not claimable
  });
});
