/**
 * su-session-client-lease.integration.test.ts: the durable PUI client lease
 * (pui-chat-first-ux-2026-09-28 P-009) against the REAL adv_sessions schema.
 *
 * WI-10004247 class C: a PUI chat restored after its operator exited streamed
 * part of its reply ("RESUMED:PU") and then ended with "Ended because no client
 * was attached" while its client was attached. The attached resume starts its
 * engine and grants the engine's lease BEFORE finalizeAdvSessionResume reopens
 * the row (finalize runs in beforeReady). The store's grant and renew only
 * touched rows WHERE ended_at IS NULL, so both were no-ops on the still-ended
 * row, and the row kept the previous run's LAPSED su_client_lease_until. The
 * owner's sweep then judged the new engine on that stale lease and ended it.
 *
 * su-session-client-lease.test.ts cannot see this: its in-memory store has no
 * ended_at at all. These cases run the SQL in the order the resume runs it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { acquireAdvSessionResume, finalizeAdvSessionResume } from './adv-sessions';
import { pgSuClientLeaseStore } from './su-session-client-lease';

// Exercise the lifecycle SQL without scheduling real delayed cleanup of test rows.
vi.mock('./session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: vi.fn() }));
vi.mock('./session-archive-hook', () => ({ scheduleArchiveForAdvSession: vi.fn() }));

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'su-client-lease-ws';

/** A PUI session row whose engine already ran and ended: its last lease lapsed
 * `lapsedSec` ago, exactly what the previous operator's run leaves behind. */
async function seedEndedWithLapsedLease(lapsedSec = 600): Promise<number> {
  const [row] = await admin<{ id: number }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, ended_by,
       su_client_lease_until)
    VALUES (${WS}, 'claude', 'console',${`su-lease-${Math.random().toString(36).slice(2)}`},
            ${crypto.randomUUID()}, now() - interval '1 hour', now() - interval '5 minutes', 'cleanup',
            now() - make_interval(secs => ${lapsedSec}))
    RETURNING id`;
  return Number(row.id);
}

async function leaseRow(id: number) {
  const [row] = await admin<{ ended: boolean; remaining_ms: number | null; detached: boolean }[]>`
    SELECT ended_at IS NOT NULL AS ended,
           round(extract(epoch FROM (su_client_lease_until - now())) * 1000)::int AS remaining_ms,
           su_client_detached_at IS NOT NULL AS detached
      FROM harness_shared.adv_sessions WHERE id = ${id}`;
  return row;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.dispose();
});

describe('pgSuClientLeaseStore on a resumed session (WI-10004247)', () => {
  it('positive control: a lapsed lease on an attended, undetached row is expired', async () => {
    const id = await seedEndedWithLapsedLease();
    expect(await pgSuClientLeaseStore.expired([id])).toEqual([id]);
  });

  it('the engine grant made before finalize survives into the resumed run', async () => {
    const id = await seedEndedWithLapsedLease();
    const key = `pui-resume:${crypto.randomUUID()}`;
    // The attached resume's order: reserve, start the engine and grant its
    // lease (superviseAttendance), then finalize once the native process runs.
    const reservation = await acquireAdvSessionResume(id, key, 300);
    expect(reservation.acquired).toBe(true);
    await pgSuClientLeaseStore.grant(id, 60_000);
    expect((await leaseRow(id)).ended, 'the grant runs while the row is still ended').toBe(true);
    expect(await finalizeAdvSessionResume(id, key)).toBe(true);
    const row = await leaseRow(id);
    expect(row.ended).toBe(false);
    expect(row.remaining_ms, 'the resumed engine carries its own lease, not the lapsed one').toBeGreaterThan(50_000);
    expect(await pgSuClientLeaseStore.expired([id]), 'the sweep must not end a just-resumed engine').toEqual([]);
  });

  it('a client stream renewing across a slow resume start keeps the lease current', async () => {
    const id = await seedEndedWithLapsedLease();
    // A client attached before finalize: its attach grant and a later renew
    // both land before the row reopens.
    await pgSuClientLeaseStore.grant(id, 1_000);
    await pgSuClientLeaseStore.renew([id], 30_000);
    const row = await leaseRow(id);
    expect(row.ended).toBe(true);
    expect(row.remaining_ms).toBeGreaterThan(25_000);
    expect(await pgSuClientLeaseStore.expired([id])).toEqual([]);
  });

  it('an attach clears an earlier detach even on a row that is still ended', async () => {
    const id = await seedEndedWithLapsedLease();
    await admin`UPDATE harness_shared.adv_sessions SET su_client_detached_at = now() WHERE id = ${id}`;
    await pgSuClientLeaseStore.grant(id, 30_000);
    expect((await leaseRow(id)).detached).toBe(false);
  });
});
