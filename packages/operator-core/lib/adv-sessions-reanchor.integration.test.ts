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
 * sibling (interactive / `psu --resume` sessions have no adv id in env) and its
 * consistency with resolveSessionRef — both must resolve the SAME row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { reanchorAdvSessionNativeId, reanchorAdvSessionNativeIdByOwner } from './adv-sessions';
import { resolveSessionRef } from './compaction-usage';

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
  it('re-anchors the NEWEST row for the owner — the same row resolveSessionRef reads', async () => {
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

  it('an unknown owner touches nothing and reports false', async () => {
    const res = await reanchorAdvSessionNativeIdByOwner('su-nobody', FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
  });
});
