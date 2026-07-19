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
  autoArmFleetMemberLoop,
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
      mode: 'work', // default (WI-5345 observability)
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

  it("WI-5345: getLoopStatus surfaces mode:'monitor' for a monitor-armed loop (leader-brief observability)", async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      mode: 'monitor',
      sql,
    });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ mode: 'monitor', fireCount: 0 });
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

  it('EI-16202: armedAt advances on every re-arm even while fireCount/lastFiredAt/parked legitimately stay unchanged (distinguishes a real re-arm from a no-op)', async () => {
    const t0 = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k', now: t0, sql });

    const first = await getLoopStatus(OWNER, { sql });
    expect(first!.armedAt).not.toBeNull();
    expect(first!.fireCount).toBe(0);
    expect(first!.lastFiredAt).toBeNull();

    // Simulate the exact repro: the loop's turn is in flight (parked at 'infinity',
    // the claim.ts sentinel) — e.g. a re-arm called from WITHIN the loop's own
    // in-flight turn, or a re-arm racing a stuck/never-completion-rebased park.
    await sql`
      UPDATE harness_shared.routines
         SET next_fire_at = 'infinity'::timestamptz
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    const parked = await getLoopStatus(OWNER, { sql });
    expect(parked!.parked).toBe(true);

    // Re-arm while parked (materializeLoop's CASE deliberately preserves 'infinity'
    // here — EI-6878 — so parked/fireCount/lastFiredAt are UNCHANGED, which is the
    // exact observation the bug report couldn't distinguish from "the arm no-op'd").
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k2', now: t1, sql });

    const second = await getLoopStatus(OWNER, { sql });
    expect(second!.parked).toBe(true); // legitimately unchanged (EI-6878)
    expect(second!.fireCount).toBe(0); // legitimately unchanged — no fire happened
    expect(second!.lastFiredAt).toBeNull(); // legitimately unchanged
    // ...but armedAt DOES move — proof the re-arm actually touched the row.
    expect(second!.armedAt).not.toBeNull();
    expect(new Date(second!.armedAt!).getTime()).toBeGreaterThan(new Date(first!.armedAt!).getTime());
    expect(new Date(second!.armedAt!).getTime()).toBe(t1.getTime());
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
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ n: string }>>`
      SELECT name AS n FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}
    `;
    expect(rows.length).toBe(1); // upsert, not a second row
    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.intervalSec).toBe(600);
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toMatchObject({ kickoff: 'second' });
  });

  it('WI-3179: re-arming the same owner under a different harness updates the one logical loop row', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: '*',
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ install_slug: string; active: boolean }>>`
      SELECT install_slug, active
        FROM harness_shared.routines
       WHERE name = ${loopRoutineName(OWNER)}
       ORDER BY updated_at DESC
    `;
    expect(rows).toEqual([{ install_slug: '*', active: true }]);

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ harnessSlug: '*', intervalSec: 600, active: true });
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toMatchObject({ kickoff: 'second' });
  });

  it('WI-3179: re-arm coalesces pre-existing active shadow rows for the same owner loop', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, next_fire_at, workspace_id,
         reschedule_interval_sec, target_owner_id)
      VALUES (
        'rt_shadow_loop',
        '*',
        ${loopRoutineName(OWNER)},
        'cron',
        '{}'::jsonb,
        ${LOOP_WAKE_ACTION},
        '{"kickoff":"shadow"}'::jsonb,
        'skip',
        'skip-old',
        true,
        now(),
        ${WS},
        120,
        ${OWNER}
      )
    `;

    await materializeLoop({
      workspaceId: WS,
      harnessSlug: '*',
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ install_slug: string; active: boolean; payload_template: Record<string, unknown> }>>`
      SELECT install_slug, active, payload_template
        FROM harness_shared.routines
       WHERE name = ${loopRoutineName(OWNER)}
       ORDER BY active DESC, install_slug
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ install_slug: '*', active: true, payload_template: { kickoff: 'second' } });
    expect(rows[1]).toMatchObject({ install_slug: HARNESS, active: false });
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({ harnessSlug: '*', intervalSec: 600, active: true });
  });
});

describe('autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001, real PG)', () => {
  const MEMBER_OWNER = 'su-fleet-member-test';
  const PLAN_SLUG = 'backlog-drain-2026-07-16';
  const FLEET_SLUG = 'backlog-drain';

  it('arms a fresh member/plan-bound member: a real routine row lands and getLoopStatus reads it back active', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res.armed).toBe(true);
    expect(res.reason).toBe('armed');
    expect(res.loopName).toBe(loopRoutineName(MEMBER_OWNER));

    const status = await getLoopStatus(MEMBER_OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      name: loopRoutineName(MEMBER_OWNER),
      ownerId: MEMBER_OWNER,
      active: true,
      intervalSec: 60, // LOOP_INTERVAL_FLOOR_SEC — the AUTO-mode standing default
    });
    const r = await rawRow(MEMBER_OWNER);
    expect(r!.payload_template!.kickoff).toContain(PLAN_SLUG);
    expect(r!.payload_template!.kickoff).toContain(FLEET_SLUG);
  });

  it('is idempotent: calling it again against the now-active loop reports already-armed and does NOT mutate the row', async () => {
    await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    const before = await rawRow(MEMBER_OWNER);

    const second = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      // A different plan/fleet on the second call — proves the existing armed
      // loop is left COMPLETELY untouched (never re-derives a new goal/kickoff),
      // not merely that a second call is a same-input no-op.
      planSlug: 'some-other-plan',
      fleetSlug: 'some-other-fleet',
      fleetRole: 'member',
      sql,
    });
    expect(second).toEqual({ armed: false, reason: 'already-armed', loopName: loopRoutineName(MEMBER_OWNER) });

    const after = await rawRow(MEMBER_OWNER);
    expect(after).toEqual(before); // byte-identical — never clobbered
  });

  it('never arms a fleet LEADER, and never touches the routines table for one', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: 'su-fleet-leader-test',
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'leader',
      sql,
    });
    expect(res).toEqual({ armed: false, reason: 'not-a-member' });
    expect(await getLoopStatus('su-fleet-leader-test', { sql })).toBeNull();
  });

  it('never arms an unplanned member (no plan to derive a goal from)', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: 'su-unplanned-member-test',
      harnessSlug: HARNESS,
      planSlug: null,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res).toEqual({ armed: false, reason: 'no-plan-bound' });
    expect(await getLoopStatus('su-unplanned-member-test', { sql })).toBeNull();
  });

  it("re-arming a DIFFERENT member's own existing loop after loop:end (inactive) re-activates it, not merely already-armed", async () => {
    // First arm normally, then end it (mirrors a member self-retuning: loop:end + re-arm) —
    // autoArmFleetMemberLoop should treat an INACTIVE existing loop as armable, not as a
    // live clobber target (only an ACTIVE loop short-circuits).
    const OTHER = 'su-fleet-member-reended-test';
    await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: OTHER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(await deactivateLoop(OTHER, { sql })).toBe(true);
    expect((await getLoopStatus(OTHER, { sql }))!.active).toBe(false);

    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: OTHER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res.armed).toBe(true);
    expect((await getLoopStatus(OTHER, { sql }))!.active).toBe(true);
  });
});
