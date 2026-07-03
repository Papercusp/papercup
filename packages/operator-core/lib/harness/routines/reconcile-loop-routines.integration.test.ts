/**
 * reconcileLoopRoutines — the loop completion-rebase (B-LOOP-2 / P-002), proven against a
 * REAL migrated Postgres (testcontainer, so migration 323's reschedule_interval_sec +
 * target_owner_id columns are present).
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/reconcile-loop-routines.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (B-LOOP-2). Covers: re-arms N sec
 * after a turn settles (lifecycle signal); idempotent; never moves next_fire_at backwards
 * (a pre-fire turn is excluded); stays parked while in flight; the dropped-report presence
 * fallback; the cron+loop "take the sooner" fold; the stuck-park backstop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { reconcileLoopRoutines } from './reconcile-loop-routines';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop';
const HARNESS = 'papercup';
/** A fixed clock so every rebase computation is deterministic. */
const T0 = 1_780_000_000_000;
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
  await sql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
});

/**
 * Seed a loop routine. `parked` → next_fire_at='infinity' (a pure loop mid-turn);
 * otherwise `nextFireAtMs` is the armed time (a cron+loop's cron-next). `cron` makes it a
 * cron+loop. Returns the routine id + the target owner id.
 */
async function seedLoop(opts: {
  ownerId: string;
  intervalSec: number;
  lastFiredAtMs: number;
  parked?: boolean;
  nextFireAtMs?: number;
  cron?: string;
}): Promise<{ id: string; ownerId: string }> {
  const id = `rt-loop-${++rtSeq}`;
  const triggerConfig = opts.cron ? { cron: opts.cron } : {};
  const nextFire = opts.parked
    ? sql`'infinity'::timestamptz`
    : sql`${new Date(opts.nextFireAtMs ?? opts.lastFiredAtMs)}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, workspace_id, last_fired_at, next_fire_at,
       reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb, 'su',
      TRUE, ${WS}, ${new Date(opts.lastFiredAtMs)}, ${nextFire},
      ${opts.intervalSec}, ${opts.ownerId}
    )`;
  return { id, ownerId: opts.ownerId };
}

/** Seed a turn-lifecycle marker (the cc/ Stop+SessionEnd hook's agent_activity row). */
async function seedLifecycle(ownerId: string, summary: string, atMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity
      (workspace_id, owner_id, kind, summary, created_at)
    VALUES (${WS}, ${ownerId}, 'lifecycle', ${summary}, ${new Date(atMs)})`;
}

/** Seed/refresh the session's genuine-activity timestamp (presence-v2 last_active_at). */
async function seedPresence(ownerId: string, lastActiveMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, last_active_at)
    VALUES (${ownerId}, ${WS}, ${new Date(lastActiveMs)})`;
}

/** Read a routine's parked-ness + next_fire_at. Parked-ness is a SQL boolean because
 *  postgres-js parses 'infinity'::timestamptz to an INVALID JS Date. */
async function readFire(id: string): Promise<{ parked: boolean; nextFireMs: number | null }> {
  const r = await sql<{ parked: boolean; next_fire_at: Date | null }[]>`
    SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, next_fire_at
      FROM harness_shared.routines WHERE id = ${id}`;
  const row = r[0];
  return {
    parked: row.parked,
    nextFireMs: row.parked || !row.next_fire_at ? null : row.next_fire_at.getTime(),
  };
}

describe('reconcileLoopRoutines — pure loop completion-rebase', () => {
  it('re-arms a parked loop N sec after the turn settles (lifecycle signal)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-1', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000); // turn ended 5s after the fire
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id, via: 'lifecycle' });
    const fire = await readFire(id);
    expect(fire.parked).toBe(false);
    expect(fire.nextFireMs).toBe(T0 + 5_000 + 60_000); // completed_at + interval
  });

  it('is idempotent — a second pass does not move an already-rebased loop', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-2', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    const first = await readFire(id);
    const res2 = await reconcileLoopRoutines({ sql, nowMs: T0 + 20_000 });
    expect(res2.rearmed).toBe(0);
    expect((await readFire(id)).nextFireMs).toBe(first.nextFireMs);
  });

  it('NEVER rebases off a pre-fire turn (never backwards) — stays parked', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-3', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // A turn that ended BEFORE this fire must not re-arm the loop.
    await seedLifecycle(ownerId, '■ session ended', T0 - 10_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('leaves a loop parked while its turn is still in flight (no settle, recent activity)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-4', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // No lifecycle 'ended'; activity is RECENT (within the fallback quiet window) → mid-turn.
    await seedPresence(ownerId, T0 + 9_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('takes the MOST-RECENT settled turn when several ended after the fire', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-5', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 3_000);
    await seedLifecycle(ownerId, '■ session ended', T0 + 8_000); // most recent
    await reconcileLoopRoutines({ sql, nowMs: T0 + 12_000 });
    expect((await readFire(id)).nextFireMs).toBe(T0 + 8_000 + 60_000);
  });

  it('ignores the "▶ session started" lifecycle marker (only end settles)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-6', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '▶ session started', T0 + 2_000); // the wake start, NOT a settle
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });
});

describe('reconcileLoopRoutines — robustness layers', () => {
  it('FALLBACK: recovers a dropped lifecycle report via presence quiescence', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-7', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // No lifecycle 'ended' (the detached report was lost), but the session did work after
    // the fire and has since been quiet ≥ 60s.
    await seedPresence(ownerId, T0 + 4_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 70_000 }); // 66s quiet since last_active
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
    expect((await readFire(id)).nextFireMs).toBe(T0 + 4_000 + 60_000);
  });

  it('FALLBACK does NOT fire while the session is still recently active', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-8', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedPresence(ownerId, T0 + 50_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 80_000 }); // only 30s quiet (<60s)
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('BACKSTOP: re-arms a loop parked long past the fire with no signal at all', async () => {
    // The backstop logs a warning (intended visibility for a wedged loop) — mock + assert it.
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => process.stderr.write('[DBG-WARN] ' + a.join(' ') + '\n'));
    const interval = 60;
    // No lifecycle, no presence — a dead/undelivered fire.
    const { id } = await seedLoop({ ownerId: 'o-9', intervalSec: interval, lastFiredAtMs: T0, parked: true });
    const longAfter = T0 + 31 * 60_000; // > the 30m default stuck-park floor
    const res = await reconcileLoopRoutines({ sql, nowMs: longAfter });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
    expect((await readFire(id)).nextFireMs).toBe(T0 + interval * 1_000); // last_fired + interval (a retry)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-armed to retry'));
    warn.mockRestore();
  });

  it('BACKSTOP does NOT fire for a legitimately long turn (recent activity present)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-10', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // A long turn that is STILL working: activity well after the fire, recent vs now.
    await seedPresence(ownerId, T0 + 31 * 60_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 31 * 60_000 + 1_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });
});

describe('reconcileLoopRoutines — cron+loop composition (take the sooner)', () => {
  it('lowers a cron+loop next_fire_at to completed+interval when the loop fires sooner', async () => {
    const cronNext = T0 + 3_600_000; // cron-next an hour out
    const { id, ownerId } = await seedLoop({
      ownerId: 'o-11', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: cronNext, cron: '0 * * * *',
    });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect((await readFire(id)).nextFireMs).toBe(T0 + 5_000 + 60_000); // the sooner loop re-arm
  });

  it('leaves a cron+loop alone when the cron fires sooner than the loop re-arm', async () => {
    const cronNext = T0 + 30_000; // cron in 30s — sooner than completed(5s)+interval(60s)=65s
    const { id, ownerId } = await seedLoop({
      ownerId: 'o-12', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: cronNext, cron: '* * * * *',
    });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).nextFireMs).toBe(cronNext); // cron-next preserved
  });
});
