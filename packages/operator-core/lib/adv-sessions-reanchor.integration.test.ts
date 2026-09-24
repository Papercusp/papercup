/**
 * adv-sessions-reanchor.integration.test.ts — the WI-5075 respawn re-anchor SQL
 * against REAL Postgres (the shared baseline-schema DB via the coord fixture).
 *
 * This seam MUST be guarded at the real schema: the original WI-5075 ship wrote
 * `RETURNING id, owner` against a table with no `owner` column, so the whole
 * UPDATE threw 42703 into its own catch and the re-anchor silently never
 * committed for ANY cohort — unit tests (mocked sql) were green the entire time.
 * The compaction watchdog's estimate stayed pinned to each dead predecessor's
 * transcript and only the streak breaker capped the successor-kill loop
 * (2026-07-18 su-57b6247d: 3 successor cuts in 16 min). Also pins the owner-keyed
 * sibling (interactive / legacy `psu --resume` sessions may have no adv id in env)
 * and its ambiguity guard — multiple active rows must not be selected by mutable
 * `started_at` ordering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import {
  markAdvSessionEnded,
  reanchorAdvSessionNativeId,
  reanchorAdvSessionNativeIdByOwner,
  setAdvSessionPid,
  type AdvSessionExpectedBinding,
} from './adv-sessions';
import { activeWorkspaceId } from './workspace-registry';
import { resolveSessionRef } from './compaction-usage';

// Exercise the lifecycle SQL without scheduling real delayed cleanup of test rows.
vi.mock('./session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: vi.fn() }));
vi.mock('./session-archive-hook', () => ({ scheduleArchiveForAdvSession: vi.fn() }));

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'reanchor-ws';
const OWNER = 'su-reanchor-owner';
const DEAD_ID = '3b0d2505-43a8-4062-b0d5-916f6c2953db';
const FRESH_ID = 'ee4dfd9b-a23c-47f1-abd8-bf0c5990f4f9';

async function seedAdv(opts: {
  coordOwnerId: string | null;
  sessionId?: string | null;
  startedAgoSec?: number;
  ended?: boolean;
}): Promise<number> {
  const rows = await admin<{ id: number }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at)
    VALUES (
      ${WS}, 'claude', 'console', ${opts.coordOwnerId}, ${opts.sessionId ?? null},
      now() - ${`${opts.startedAgoSec ?? 60} seconds`}::interval,
      ${opts.ended ? new Date() : null}
    )
    RETURNING id
  `;
  return rows[0].id;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.adv_sessions`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.adv_sessions`;
});

describe('successor lifecycle compare-and-swap (EI-22446987530949437, real PG)', () => {
  async function predecessor(): Promise<{ id: number; binding: AdvSessionExpectedBinding }> {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await admin`UPDATE harness_shared.adv_sessions SET started_at = '2026-09-05 18:00:00.123456+00'::timestamptz WHERE id = ${id}`;
    const [row] = await admin<{ started_at: string }[]>`
      SELECT started_at::text AS started_at FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    return { id, binding: { coordOwnerId: OWNER, sessionId: DEAD_ID, startedAt: row.started_at } };
  }

  it('ends only the exact observed binding, preserving full timestamp precision and provenance', async () => {
    const { id, binding } = await predecessor();
    expect(binding.startedAt).toContain('.123456');
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(true);
    const [row] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by).toBe('reconciler');
    expect(row.exit_code).toBeNull();
  });

  it.each(['owner', 'native', 'started'])('refuses when %s changes after the predecessor was observed', async (field) => {
    const { id, binding } = await predecessor();
    if (field === 'owner') await admin`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'su-other' WHERE id = ${id}`;
    if (field === 'native') await admin`UPDATE harness_shared.adv_sessions SET session_id = ${FRESH_ID} WHERE id = ${id}`;
    if (field === 'started') await admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 microsecond' WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(false);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
  });

  it('preserves an existing terminal observation on a retry', async () => {
    const { id, binding } = await predecessor();
    await markAdvSessionEnded(id, 0, 'self', { throwOnError: true });
    const [before] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(false);
    const [after] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(after).toEqual(before);
  });

  // WI-10002854 split-brain: an end OBSERVATION vs a successor incarnation.
  it('refuses to end a row a successor reactivated AFTER the exit was observed (WI-10002854)', async () => {
    const { id } = await predecessor();
    // The killed predecessor's exit was observed a minute ago; a headless wake resume then
    // reactivated the row (started_at = now). The late/replayed report must not end it —
    // that is what let the next resume claim win against a still-running twin.
    const observedAt = new Date(Date.now() - 60_000);
    await admin`UPDATE harness_shared.adv_sessions SET started_at = now() WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, 0, 'self', { observedAt, throwOnError: true })).resolves.toBe(false);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
  });

  it('still ends the row when the observation follows the current incarnation start (WI-10002854)', async () => {
    const { id } = await predecessor();
    await admin`UPDATE harness_shared.adv_sessions SET started_at = now() - interval '5 minutes' WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, 0, 'self', { observedAt: new Date(), throwOnError: true })).resolves.toBe(true);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by).toBe('self');
  });
});

describe('reanchorAdvSessionNativeId (real PG — the 42703 RETURNING-column regression guard)', () => {
  it('re-anchors the row to the successor native id and returns the coord owner', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    const res = await reanchorAdvSessionNativeId(id, FRESH_ID);
    expect(res).toEqual({ reanchored: true, owner: OWNER });
    const [row] = await admin<{ session_id: string; ended_at: Date | null }[]>`
      SELECT session_id, ended_at FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(row.session_id).toBe(FRESH_ID);
    expect(row.ended_at).toBeNull();
  });

  it('already-anchored → reanchored:false but STILL reports the owner (WI-41555)', async () => {
    // ⚠ This expectation deliberately CHANGED, and must not be "restored".
    // It used to assert `owner: null`, which encoded the frozen-gauge defect as
    // intended behaviour: the respawn route clears the context-usage + anchor
    // caches only `if (owner)`, so a NO-OP re-anchor — the ordinary case for the
    // cold-loop recycle cohort, whose spawn path stamps the new native id onto
    // the row before the report lands — skipped both clears. The anchored gauge
    // then served the DEAD predecessor's token count forever, so a fresh
    // successor rendered ~81%, re-cut immediately, and ITS successor inherited
    // the same number: an unbounded reset loop in which no session does work.
    // `reanchored` and `owner` answer INDEPENDENT questions — "did I change the
    // row" vs "whose row is it" — and respawn hygiene keys off the second.
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID });
    const res = await reanchorAdvSessionNativeId(id, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: OWNER });
  });

  it('a missing row touches nothing and reports false', async () => {
    const res = await reanchorAdvSessionNativeId(999_999, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
  });
});

describe('reanchorAdvSessionNativeIdByOwner (the interactive/`psu --resume` cohort)', () => {
  it('re-anchors the sole active row for the owner without consulting mutable started_at', async () => {
    await seedAdv({ coordOwnerId: OWNER, sessionId: 'a1a1a1a1-0000-4000-8000-000000000001', startedAgoSec: 3600, ended: true });
    const newest = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, startedAgoSec: 60 });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: true, owner: OWNER });
    const [row] = await admin<{ session_id: string }[]>`
      SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${newest}
    `;
    expect(row.session_id).toBe(FRESH_ID);
    // The consumer the whole fix exists for: the watchdog's owner→native resolve
    // must now name the LIVE successor, not the dead predecessor.
    const ref = await resolveSessionRef(OWNER);
    expect(ref?.sessionId).toBe(FRESH_ID);
  });

  it('already-anchored → reanchored:false, still reports the owner, never touches another owner (WI-41555)', async () => {
    // Same deliberate change as the by-id sibling above: the no-op path must
    // still hand the caller an owner, or respawn gauge hygiene never runs for
    // the interactive / `psu --resume` cohort. Do not restore `owner: null`.
    const other = await seedAdv({ coordOwnerId: 'su-other', sessionId: DEAD_ID });
    await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: OWNER });
    const [row] = await admin<{ session_id: string }[]>`
      SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${other}
    `;
    expect(row.session_id).toBe(DEAD_ID);
  });

  it('refuses two active rows instead of selecting one by mutable started_at (WI-42507)', async () => {
    const first = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, startedAgoSec: 60 });
    const second = await seedAdv({
      coordOwnerId: OWNER,
      sessionId: 'a1a1a1a1-0000-4000-8000-000000000002',
      startedAgoSec: 3600,
    });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
    const rows = await admin<{ id: number; session_id: string }[]>`
      SELECT id, session_id
        FROM harness_shared.adv_sessions
       WHERE id IN (${first}, ${second})
       ORDER BY id
    `;
    expect(rows.map((row) => row.session_id)).toEqual([
      DEAD_ID,
      'a1a1a1a1-0000-4000-8000-000000000002',
    ]);
  });

  it('an unknown owner touches nothing and reports false', async () => {
    const res = await reanchorAdvSessionNativeIdByOwner('su-nobody', FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
  });
});

describe('setAdvSessionPid workspace override (WI-10002854, real PG)', () => {
  // The wake executor runs pinned to the coordination workspace, which is not the
  // workspace the row belongs to. The resumed turn's pid write therefore has to
  // name the row's workspace. The ambient scope matches zero rows and reports
  // nothing.
  it('the ambient scope misses a row in another workspace; the explicit override lands the pid', async () => {
    expect(activeWorkspaceId()).not.toBe(WS); // precondition: the two scopes really differ
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });

    await setAdvSessionPid(id, 4242);
    const [ambient] = await admin<{ pid: number | null }[]>`SELECT pid FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(ambient.pid).toBeNull();

    await setAdvSessionPid(id, 4242, undefined, WS);
    const [scoped] = await admin<{ pid: number | null; terminal_bin: string | null }[]>`
      SELECT pid, terminal_bin FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(scoped.pid).toBe(4242);
    expect(scoped.terminal_bin).toBeNull(); // an omitted terminalBin never blanks or invents one
  });

  it('keeps a terminal_bin another writer set (the headless launch-log key the roster reads)', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await admin`UPDATE harness_shared.adv_sessions SET terminal_bin = 'psu-headless:/tmp/x.log' WHERE id = ${id}`;
    await setAdvSessionPid(id, 5151, undefined, WS);
    const [row] = await admin<{ pid: number | null; terminal_bin: string | null }[]>`
      SELECT pid, terminal_bin FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(row).toEqual({ pid: 5151, terminal_bin: 'psu-headless:/tmp/x.log' });
  });
});
