/**
 * Loop cost-cap auto-pause against a REAL migrated Postgres (B-LOOP-3 / P-004, D-006): the
 * load-bearing SQL — checkLoopCostCap reads the routine's created_at (arm anchor) and, on a
 * breach, autoPauseLoopRoutine flips active=FALSE + stamps metadata.loop_paused_reason. The
 * spend READ is injected here (it is the documented fail-open best-effort seam — see
 * loop-cost-cap.ts); this test pins the routine-table WRITES the cost-cap performs.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop-cost-cap.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (B-LOOP-3, on su-d5a84's mig 323 schema).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { checkLoopCostCap, autoPauseLoopRoutine } from './loop-cost-cap';
import { readStalePausedRoutines } from '../../system-health/compute';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop-cap';
const HARNESS = 'papercusp';
const OWNER = 'su-pinned-cap';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

/** Seed a loop routine row (su-d5a84's B-LOOP-1 shape: trigger_kind='cron', no cron/rrule,
 *  interval set, bound owner) and return its id. */
async function seedLoopRoutine(opts: { costCapCents?: number } = {}): Promise<string> {
  const id = `rt_${HARNESS}_loop_${OWNER}`;
  const payload = JSON.stringify(opts.costCapCents != null ? { costCapCents: opts.costCapCents } : {});
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
       workspace_id, reschedule_interval_sec, target_owner_id, next_fire_at, active)
    VALUES (${id}, ${HARNESS}, ${'loop-' + OWNER}, 'cron', '{}'::jsonb, 'loop',
            ${payload}::text::jsonb, ${WS}, 300, ${OWNER}, 'infinity'::timestamptz, TRUE)
  `;
  return id;
}

async function readRoutine(id: string) {
  const rows = await sql<Array<{ active: boolean; metadata: Record<string, unknown> | null }>>`
    SELECT active, metadata FROM harness_shared.routines WHERE id = ${id}`;
  return rows[0];
}

describe('checkLoopCostCap — real-DB auto-pause (B-LOOP-3)', () => {
  it('spend OVER cap → breach, routine flipped active=FALSE with a stamped reason', async () => {
    const id = await seedLoopRoutine({ costCapCents: 100 });
    const readSpend = vi.fn(async (..._args: unknown[]) => 250); // injected: the flagged best-effort seam

    const out = await checkLoopCostCap({ sql, routineId: id, targetOwnerId: OWNER, capCents: 100 }, { readSpend });

    expect(out).toMatchObject({ breach: true, spendCents: 250, capCents: 100 });
    // The arm anchor (the routine's created_at, ~now) was threaded to the spend read as sinceMs.
    const sinceMs = (readSpend.mock.calls[0][0] as { sinceMs: number }).sinceMs;
    expect(sinceMs).toBeGreaterThan(Date.now() - 60_000);
    // Real write: the loop is paused + the reason recorded.
    const row = await readRoutine(id);
    expect(row.active).toBe(false);
    expect(String(row.metadata?.loop_paused_reason)).toContain('cost-cap breached');
    expect(row.metadata?.loop_paused_at).toBeTruthy();
    // EI-19406534159939583: the pause must PRESERVE the prior next_fire_at rather than only
    // nulling the column. The seed parks at 'infinity' — claim.ts's IN-FLIGHT sentinel — and
    // that is exactly the value distinguishing "healthy agent whose re-arm broke" from
    // "comatose agent that never answered a fire". Nulling it without recording it made five
    // real disarms undiagnosable on 2026-08-03.
    expect(row.metadata?.loop_paused_next_fire_at).toBe('infinity');
  });

  it('pause preserves a REAL next_fire_at too, while still clearing the column (EI-19406534159939583)', async () => {
    const id = await seedLoopRoutine({ costCapCents: 100 });
    // Not the in-flight sentinel: a loop that was genuinely SCHEDULED. Post-pause this and
    // the 'infinity' case both leave the column NULL, so the metadata key is the only thing
    // that can still tell an investigator which of the two happened.
    await sql`UPDATE harness_shared.routines SET next_fire_at = '2026-08-03T03:21:01Z'::timestamptz WHERE id = ${id}`;

    await checkLoopCostCap(
      { sql, routineId: id, targetOwnerId: OWNER, capCents: 100 },
      { readSpend: vi.fn(async () => 250) },
    );

    const row = await readRoutine(id);
    expect(row.active).toBe(false);
    const preserved = row.metadata?.loop_paused_next_fire_at;
    expect(typeof preserved).toBe('string');
    // The discriminator actually discriminates — a scheduled loop must not read as in-flight.
    expect(preserved).not.toBe('infinity');
    expect(String(preserved)).toContain('2026-08-0');

    // The column itself is still cleared: this fix records the evidence, it does not change
    // the pause semantics an inactive routine relies on.
    const after = await sql<Array<{ next_fire_at: Date | null }>>`
      SELECT next_fire_at FROM harness_shared.routines WHERE id = ${id}`;
    expect(after[0].next_fire_at).toBeNull();
  });

  it('spend UNDER cap → no breach, routine stays active (no write)', async () => {
    const id = await seedLoopRoutine({ costCapCents: 100 });
    const out = await checkLoopCostCap(
      { sql, routineId: id, targetOwnerId: OWNER, capCents: 100 },
      { readSpend: vi.fn(async () => 40) },
    );
    expect(out).toMatchObject({ breach: false, spendCents: 40 });
    const row = await readRoutine(id);
    expect(row.active).toBe(true);
    expect(row.metadata?.loop_paused_reason).toBeUndefined();
  });

  it('no cap configured → zero reads, routine untouched', async () => {
    const id = await seedLoopRoutine();
    const readSpend = vi.fn(async () => 999);
    const out = await checkLoopCostCap({ sql, routineId: id, targetOwnerId: OWNER, capCents: null }, { readSpend });
    expect(out).toEqual({ breach: false, spendCents: 0, capCents: null });
    expect(readSpend).not.toHaveBeenCalled();
    expect((await readRoutine(id)).active).toBe(true);
  });

  it('autoPauseLoopRoutine flips active + merges metadata without clobbering existing keys', async () => {
    const id = await seedLoopRoutine();
    await sql`UPDATE harness_shared.routines SET metadata = '{"keep":"me"}'::jsonb WHERE id = ${id}`;
    await autoPauseLoopRoutine(sql, id, 'manual test reason');
    const row = await readRoutine(id);
    expect(row.active).toBe(false);
    expect(row.metadata?.keep).toBe('me'); // pre-existing metadata preserved
    expect(row.metadata?.loop_paused_reason).toBe('manual test reason');
  });
});

describe('EI-19479519679704136 — the pause WRITER and the stale-paused READER must agree on the key', () => {
  // The guard is deliberately END-TO-END: the real writer, a real PG row, and the real
  // reader (readStalePausedRoutines, imported from the detector — NOT a re-statement of
  // its extraction here). Mirroring the reader's key handling in the test would let the
  // two drift apart again and still pass, which is the exact failure being fixed.
  it('a loop paused by autoPauseLoopRoutine is NOT reported as an unexplained stale pause', async () => {
    const id = await seedLoopRoutine();
    await autoPauseLoopRoutine(sql, id, 'stalled-loops-guard: turns-stalled');

    const flagged = await readStalePausedRoutines(sql, HARNESS, WS);
    const mine = flagged.find((r) => r.name === 'loop-' + OWNER);
    // Pre-fix this row came back with reasonMissing:true and was flagged REGARDLESS of age
    // ("an unattributed pause is exactly the bug class"), because the writer stamped
    // `loop_paused_reason` while the reader only ever reads `metadata.pause.reason`.
    // Measured 2026-08-04: 50 of 63 flagged routines were explained pauses, invisible this way.
    expect(mine?.reasonMissing ?? false).toBe(false);
    // A freshly-paused row WITH a reason is below the general age threshold, so the
    // detector should not surface it at all.
    expect(mine).toBeUndefined();
  });

  it('CALIBRATION: a pause written WITHOUT the helper is still flagged as unattributed', async () => {
    // The load-bearing control. Without it the assertion above would also pass if the
    // detector had simply stopped flagging anything — which would silently destroy the
    // true-positive path (a release routine silently paused for days: the WI-5839 incident).
    const id = await seedLoopRoutine();
    await sql`UPDATE harness_shared.routines SET active = FALSE WHERE id = ${id}`;

    const flagged = await readStalePausedRoutines(sql, HARNESS, WS);
    const mine = flagged.find((r) => r.name === 'loop-' + OWNER);
    expect(mine).toBeDefined();
    expect(mine?.reasonMissing).toBe(true);
  });
});
