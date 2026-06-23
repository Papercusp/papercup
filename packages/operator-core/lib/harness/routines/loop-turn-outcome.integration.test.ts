/**
 * loop-turn-outcome handler — proven against a REAL migrated Postgres (testcontainer), so the
 * handler's actual SQL (getLoopRoutineRef SELECT + the rearmLoopAfterDeath UPDATE with its
 * 'infinity' guard) runs against the real routines schema. recordFire is injected as a spy here
 * (it uses drizzle/getOrgPg, mocked elsewhere); this test validates the raw-sql legs the unit
 * test (loop-turn-outcome.test.ts) mocked. loop-wake-rate-limit-robustness-2026-06-23 P0b/P1a.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop-turn-outcome.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { handleLoopResumeTurnExit } from './loop-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';
import type { ResumeTurnExitRaw } from '../../events/await/resume-turn-outcome';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop-outcome';
const HARNESS = 'papercup';
const OWNER = 'su-outcome-owner';
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
});

async function seedParkedLoop(opts: { intervalSec: number; lastFiredAtMs: number }): Promise<string> {
  const id = `rt-outcome-${++rtSeq}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, workspace_id, last_fired_at, next_fire_at, reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', '{}'::jsonb, 'system:loop-wake',
      TRUE, ${WS}, ${new Date(opts.lastFiredAtMs)}, 'infinity'::timestamptz, ${opts.intervalSec}, ${OWNER}
    )`;
  return id;
}

async function readFire(id: string): Promise<{ parked: boolean; nextFireMs: number | null }> {
  const r = await sql<{ parked: boolean; next_fire_at: Date | null }[]>`
    SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, next_fire_at
      FROM harness_shared.routines WHERE id = ${id}`;
  const row = r[0];
  return { parked: row.parked, nextFireMs: row.parked || !row.next_fire_at ? null : row.next_fire_at.getTime() };
}

const loopDelivery = (routineId: string, over: Partial<DeliveryWork> = {}): DeliveryWork =>
  ({
    id: 1, workspaceId: 'coord', awaitId: 1, subscriberId: OWNER,
    eventKey: `coord:inbox-wake:${OWNER}`, payload: null, summary: null,
    status: 'delivered', channel: 'resume-headless', attempts: 1, lastError: null,
    nextAttemptAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(),
    deliveredAt: null, urgent: false, minSleepSec: null, coalescedCount: 1,
    source: `loop:${routineId}`, wakeHandle: null, note: null, ...over,
  }) as DeliveryWork;

const death429: ResumeTurnExitRaw = { exitCode: 1, signal: null, stdoutTail: 'API Error: 429 · Rate limited', stderrTail: '' };

describe('handleLoopResumeTurnExit — real-PG raw-sql legs (P0b/P1a integration)', () => {
  it('a 429 death feeds recordFire + re-arms the PARKED loop off infinity (real UPDATE)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the handler logs the observed death (expected)
    const now = 2_000_000_000_000;
    const id = await seedParkedLoop({ intervalSec: 120, lastFiredAtMs: now - 60_000 });
    const recordFire = vi.fn(async () => {});

    const res = await handleLoopResumeTurnExit(loopDelivery(id), death429, { sql, recordFire, now });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('rate_limited');
    // recordFire got the loop's EXACT fire-gate key (install_slug + name) + 'error'.
    expect(recordFire).toHaveBeenCalledWith(HARNESS, id, expect.stringContaining('rate_limited'), 'error');
    // The real UPDATE moved it off 'infinity' to ~now + interval (no retry-after in the msg → interval floor).
    const fire = await readFire(id);
    expect(fire.parked).toBe(false);
    expect(fire.nextFireMs).toBe(now + 120_000);
  });

  it("the 'infinity' guard is idempotent: a second exit does NOT re-arm an already-advanced loop", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the handler logs the observed death (expected)
    const now = 2_000_000_000_000;
    const id = await seedParkedLoop({ intervalSec: 120, lastFiredAtMs: now - 60_000 });
    const recordFire = vi.fn(async () => {});
    await handleLoopResumeTurnExit(loopDelivery(id), death429, { sql, recordFire, now });
    const firstFire = (await readFire(id)).nextFireMs;
    // Second handler pass (e.g. a duplicate/late exit) — the loop is no longer parked at infinity.
    await handleLoopResumeTurnExit(loopDelivery(id), death429, { sql, recordFire, now: now + 999_999 });
    const secondFire = (await readFire(id)).nextFireMs;
    expect(secondFire).toBe(firstFire); // unchanged — never re-armed a non-parked row
  });

  it('a SURVIVED turn (clean exit) touches nothing — loop stays parked, no recordFire', async () => {
    const now = 2_000_000_000_000;
    const id = await seedParkedLoop({ intervalSec: 120, lastFiredAtMs: now - 60_000 });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(id),
      { exitCode: 0, signal: null, stdoutTail: 'ok', stderrTail: '' },
      { sql, recordFire, now },
    );
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect((await readFire(id)).parked).toBe(true); // still parked (reconcile owns success re-arm)
  });

  it('a non-loop wake death is ignored (no routine touched)', async () => {
    const now = 2_000_000_000_000;
    const id = await seedParkedLoop({ intervalSec: 120, lastFiredAtMs: now - 60_000 });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(id, { source: 'lock:grant:t1' }), death429, { sql, recordFire, now });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect((await readFire(id)).parked).toBe(true);
  });
});
