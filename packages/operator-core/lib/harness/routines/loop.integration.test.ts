/**
 * loop — the loop surface (B-LOOP-5) proven against a REAL migrated Postgres
 * (testcontainer): materializeLoop writes a routine row the B-LOOP-3 fire consumes,
 * getLoopStatus reads it (incl. the 'infinity' parked sentinel) and deactivateLoop
 * stops it. Exercises the raw SQL the mocked unit test (loop.test.ts) cannot.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  materializeLoop,
  getLoopStatus,
  deactivateLoop,
  loopRoutineName,
  LOOP_WAKE_ACTION,
} from './loop';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop';
const HARNESS = 'papercusp';
const OWNER = 'su-pinned-test';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql; // RLS-bypass; the loop helpers take sql as a seam
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
});

async function rawRow(ownerId: string) {
  const rows = await sql<
    Array<{
      trigger_kind: string;
      trigger_config: Record<string, unknown>;
      target_role: string;
      payload_template: Record<string, unknown> | null;
      active: boolean;
      reschedule_interval_sec: number | null;
      target_owner_id: string | null;
      next_fire_at: Date | null;
    }>
  >`
    SELECT trigger_kind, trigger_config, target_role, payload_template, active,
           reschedule_interval_sec, target_owner_id, next_fire_at
      FROM harness_shared.routines
     WHERE name = ${loopRoutineName(ownerId)}
  `;
  return rows[0] ?? null;
}

describe('loop surface round-trip (real PG)', () => {
  it('materializeLoop writes a PURE loop row the B-LOOP-3 fire consumes', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 120,
      kickoff: 'work the plan',
      costCapCents: 500,
      now,
      sql,
    });

    const r = await rawRow(OWNER);
    expect(r).not.toBeNull();
    expect(r!.trigger_kind).toBe('cron'); // rides listDueCronRoutines + the 30s tick
    expect(r!.trigger_config).toEqual({}); // pure loop ⇒ claim parks at 'infinity'
    expect(r!.target_role).toBe(LOOP_WAKE_ACTION);
    expect(Number(r!.reschedule_interval_sec)).toBe(120);
    expect(r!.target_owner_id).toBe(OWNER);
    expect(r!.active).toBe(true);
    // fire reads kickoff + cost-cap from here
    expect(r!.payload_template).toMatchObject({ kickoff: 'work the plan', costCapCents: 500 });
    // first fire one interval out (finite — the existing claim path fires it)
    expect(r!.next_fire_at?.getTime()).toBe(now.getTime() + 120_000);
  });

  it('getLoopStatus reads an armed loop, and null for an unknown owner', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 300,
      kickoff: 'k',
      costCapCents: 1000,
      now,
      sql,
    });

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      name: loopRoutineName(OWNER),
      ownerId: OWNER,
      harnessSlug: HARNESS,
      active: true,
      intervalSec: 300,
      parked: false,
      costCapCents: 1000,
      carry: 'warm', // default lifecycle (su-cold-auto P-008)
      fireCount: 0, // never fired
    });
    expect(status!.nextFireAt).toBe(new Date(now.getTime() + 300_000).toISOString());

    expect(await getLoopStatus('su-nobody', { sql })).toBeNull();
  });

  it('getLoopStatus surfaces carry:"cold" for a cold-armed loop (su-cold-auto P-008 observability)', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      carry: 'cold',
      sql,
    });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ carry: 'cold', fireCount: 0 });
  });

  it("getLoopStatus reports parked=true (and nextFireAt=null) when the loop is in-flight ('infinity')", async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    // Simulate claim.ts parking the loop while its turn runs.
    await sql`
      UPDATE harness_shared.routines
         SET next_fire_at = 'infinity'::timestamptz
       WHERE name = ${loopRoutineName(OWNER)}
    `;

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status!.parked).toBe(true);
    expect(status!.nextFireAt).toBeNull(); // never hand a NaN-Date out
    expect(status!.active).toBe(true); // a parked loop is still armed
  });

  it('deactivateLoop stops the loop (idempotent on the active guard)', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });

    expect(await deactivateLoop(OWNER, { sql })).toBe(true);
    const after = await getLoopStatus(OWNER, { sql });
    expect(after!.active).toBe(false);

    // Already inactive ⇒ no row matches the active=TRUE guard ⇒ false (no double-stop).
    expect(await deactivateLoop(OWNER, { sql })).toBe(false);

    // Unknown owner ⇒ false.
    expect(await deactivateLoop('su-nobody', { sql })).toBe(false);
  });

  it('EI-3748: deactivateLoop clears a stale last_error stamp — the routine can no longer fire, so a residual error is moot', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    // Simulate what dbos-executor-reaper.ts stamps on a stuck-fire auto-requeue.
    await sql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'last_error', 'DBOS routineFire produced no DBOS operation output',
               'last_error_at', now()::text,
               'last_error_source', 'dbos-executor-reaper'
             )
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    const before = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}`;
    expect(before[0]!.metadata.last_error).toBeTruthy();

    expect(await deactivateLoop(OWNER, { sql })).toBe(true);

    const after = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}`;
    expect(after[0]!.metadata.last_error).toBeUndefined();
    expect(after[0]!.metadata.last_error_at).toBeUndefined();
    expect(after[0]!.metadata.last_error_source).toBeUndefined();
  });

  it('omits costCapCents from payload_template (and status) when no cap given', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toEqual({ kickoff: 'k' });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.costCapCents).toBeNull();
  });

  it('re-arming the same owner upserts the ONE row (new interval + kickoff)', async () => {
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'first', sql });
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 600, kickoff: 'second', sql });

    const rows = await sql<Array<{ n: string }>>`
      SELECT name AS n FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}
    `;
    expect(rows.length).toBe(1); // upsert, not a second row
    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.intervalSec).toBe(600);
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toMatchObject({ kickoff: 'second' });
  });
});
