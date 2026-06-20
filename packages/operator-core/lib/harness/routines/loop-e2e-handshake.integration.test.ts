/**
 * E2E loop handshake — the THREE Phase-A slices chained through their REAL functions against
 * a real migrated Postgres (testcontainer), proving the cross-slice data handshake works live:
 *
 *   B-LOOP-1  claimDueRoutine        (su-d5a84) — an armed loop → parks next_fire_at='infinity'
 *                                                 + stamps last_fired_at (the in-flight sentinel)
 *   B-LOOP-3  fireLoopWake           (su-fd5c0) — delivers the warm coord wake to target_owner_id
 *   [ the woken session runs a turn → its Stop hook writes the agent_activity 'ended' row ]
 *   B-LOOP-2  reconcileLoopRoutines  (su-15ea2) — re-arms next_fire_at = completed_at + interval
 *
 * What is exercised LIVE: every slice's actual exported function, the real routines table, the
 * real claim/park, the real fire path (gated + recordFire stubbed to keep the run hermetic; the
 * wake captured to assert it targets the right owner), and the real completion-rebase — so the
 * COLUMNS and the owner-id KEY line up end to end.
 *
 * The ONE inherently-live leg not reproducible in a testcontainer — the actual pty wake delivery
 * + a real Claude turn firing the real `Stop` hook — is stood in for by the agent_activity
 * insert, which is EXACTLY what that hook writes (`lifecycle-report.sh` →
 * `activity:report {kind:'lifecycle', summary:'■ session ended'}`), keyed by owner_id =
 * PAPERCUSP_SID = target_owner_id (the wake-executor exports PAPERCUSP_SID onto the woken
 * session, so the real hook's row carries that owner_id). The wake-capture assertion below
 * locks the identity contract that makes that true: the fire wakes the SAME owner_id the
 * rebase queries.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop-e2e-handshake.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { listDueCronRoutines } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { claimDueRoutine } from './claim';
import { fireLoopWake } from './loop-fire';
import { reconcileLoopRoutines } from './reconcile-loop-routines';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop-e2e';
const HARNESS = 'papercup';
let rtSeq = 0;

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

/** Seed an ARMED, DUE pure-loop routine (next_fire_at in the past, no cron/rrule). */
async function seedArmedLoop(owner: string, intervalSec: number): Promise<string> {
  const id = `rt-e2e-${++rtSeq}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, workspace_id, next_fire_at, reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', '{}'::jsonb, 'su',
      TRUE, ${WS}, now() - interval '1 second', ${intervalSec}, ${owner}
    )`;
  return id;
}

/** The cc/ Stop+SessionEnd hook's agent_activity row (what a real woken turn writes on end). */
async function seedLifecycleEnded(owner: string, atMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
    VALUES (${WS}, ${owner}, 'lifecycle', '■ session ended', ${new Date(atMs)})`;
}

async function readRoutine(id: string): Promise<{ parked: boolean; nextFireMs: number | null; lastFiredMs: number | null }> {
  const r = await sql<{ parked: boolean; next_fire_at: Date | null; last_fired_at: Date | null }[]>`
    SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, next_fire_at, last_fired_at
      FROM harness_shared.routines WHERE id = ${id}`;
  const row = r[0];
  return {
    parked: row.parked,
    nextFireMs: row.parked || !row.next_fire_at ? null : row.next_fire_at.getTime(),
    lastFiredMs: row.last_fired_at ? row.last_fired_at.getTime() : null,
  };
}

/** Hermetic fire deps: allow the gate, no-op the fire-history write, capture the wake target. */
function fireDeps(wakeCalls: string[][]) {
  return {
    checkFireGate: async () => ({ allow: true, consecutiveErrors: 0 }),
    recordFire: async () => {},
    wake: async (recipients: string[]) => {
      wakeCalls.push(recipients);
      return { targets: recipients, keys: [], woken: 1, staged: 0 };
    },
  } as unknown as Parameters<typeof fireLoopWake>[1];
}

describe('Phase-A loop engine — live e2e handshake (claim → fire → settle → rebase)', () => {
  it('armed loop → claim parks → fire wakes target_owner_id → turn settles → reconcile re-arms', async () => {
    const owner = 'o-e2e-a';
    const interval = 60;
    const id = await seedArmedLoop(owner, interval);

    // ── B-LOOP-1 (d5a84): the tick lists the due loop + claims it → parks at 'infinity'. ──
    const due = (await listDueCronRoutines(sql)).filter((r) => r.id === id);
    expect(due).toHaveLength(1);
    expect(due[0].rescheduleIntervalSec).toBe(interval);
    expect(due[0].targetOwnerId).toBe(owner);
    expect(await claimDueRoutine(sql, due[0])).toBe(true);

    const parked = await readRoutine(id);
    expect(parked.parked).toBe(true); // in-flight sentinel
    expect(parked.lastFiredMs).not.toBeNull();
    const lastFiredMs = parked.lastFiredMs!;

    // ── B-LOOP-3 (fd5c0): fire the warm wake — it must target the SAME owner the rebase keys on. ──
    const wakeCalls: string[][] = [];
    const fire = await fireLoopWake(
      { routineId: id, routineName: id, workspaceId: WS, installSlug: HARNESS, targetOwnerId: owner, payloadTemplate: null, sql },
      fireDeps(wakeCalls),
    );
    expect(fire.fired).toBe(true);
    expect(wakeCalls).toEqual([[owner]]); // the identity handshake: fire wakes target_owner_id

    // ── The woken session runs its turn → Stop hook writes the lifecycle 'ended' row. ──
    const completedMs = lastFiredMs + 5_000;
    await seedLifecycleEnded(owner, completedMs);

    // ── B-LOOP-2 (15ea2): the 30s reconcile re-arms off that completion. ──
    const res = await reconcileLoopRoutines({ sql, nowMs: lastFiredMs + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id, targetOwnerId: owner, via: 'lifecycle' });

    const rearmed = await readRoutine(id);
    expect(rearmed.parked).toBe(false);
    expect(rearmed.nextFireMs).toBe(completedMs + interval * 1_000);
  });

  it('the loop REPEATS — a second cycle re-arms off the SECOND turn, not the first', async () => {
    const owner = 'o-e2e-b';
    const interval = 60;
    const id = await seedArmedLoop(owner, interval);

    // ── Cycle 1: claim → fire → settle turn #1 → reconcile re-arms. ──
    const due1 = (await listDueCronRoutines(sql)).filter((r) => r.id === id);
    await claimDueRoutine(sql, due1[0]);
    const fired1 = await readRoutine(id);
    const wake1: string[][] = [];
    await fireLoopWake(
      { routineId: id, routineName: id, workspaceId: WS, installSlug: HARNESS, targetOwnerId: owner, payloadTemplate: null, sql },
      fireDeps(wake1),
    );
    const turn1Ms = fired1.lastFiredMs! + 3_000;
    await seedLifecycleEnded(owner, turn1Ms);
    await reconcileLoopRoutines({ sql, nowMs: fired1.lastFiredMs! + 8_000 });
    expect((await readRoutine(id)).nextFireMs).toBe(turn1Ms + interval * 1_000);

    // ── The interval elapses → the loop is due again. Claim re-parks with a NEW last_fired_at. ──
    await sql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second' WHERE id = ${id}`;
    const due2 = (await listDueCronRoutines(sql)).filter((r) => r.id === id);
    expect(due2).toHaveLength(1);
    await claimDueRoutine(sql, due2[0]);
    const fired2 = await readRoutine(id);
    expect(fired2.parked).toBe(true);
    expect(fired2.lastFiredMs!).toBeGreaterThanOrEqual(fired1.lastFiredMs!);

    // ── Settle turn #2 (after the new fire). The turn-#1 marker is now PRE-fire → excluded. ──
    const turn2Ms = fired2.lastFiredMs! + 4_000;
    await seedLifecycleEnded(owner, turn2Ms);
    const res2 = await reconcileLoopRoutines({ sql, nowMs: fired2.lastFiredMs! + 9_000 });
    expect(res2.rearmed).toBe(1);
    // Re-armed off the MOST-RECENT (second) turn — the loop genuinely repeats.
    expect((await readRoutine(id)).nextFireMs).toBe(turn2Ms + interval * 1_000);
  });
});
