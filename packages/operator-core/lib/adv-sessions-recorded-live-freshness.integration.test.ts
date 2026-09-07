/**
 * adv-sessions-recorded-live-freshness.integration.test.ts — WI-42466.
 *
 * `recordedLiveOwnerIds` is the read-side twin of coord:presence's `recorded`
 * state, and its whole justification is a session inside its BOOTSTRAP window:
 * already running, not yet coord-dispatchable. Its `live_adv` leg was bounded
 * only by `ended_at IS NULL` — and `ended_at` is written by a session-end hook
 * that SIGKILL, a crash and an OOM all bypass. So an orphaned row vouched for a
 * dead process forever, and every consumer of the oracle believed it.
 *
 * That is not a theoretical hole. Goal `work-on-everything-070565` lost its
 * holder (su-a2e93ef3, pid 2911661: `kill -0` → ESRCH, `ended_at` still NULL,
 * presence row reaped). The oracle answered `recorded`; `holderCountsAsAlive`
 * counts `recorded` as working; the goal folded to `held`; so its liveness
 * alarm returned null AND the owner-armed GOAL_HOLDER_RESPAWN respawner hit
 * `continue` on every one of its 113 ticks. A goal with no living steward was
 * reported as actively held, indefinitely, by two independent watchdogs.
 *
 * The pid probe that exists to catch exactly this (EI-21572355077403526) cannot
 * reach it: `probeProcessLiveness` refuses to guess across machines and returns
 * `null` unless handed a host equal to this one, `adv_sessions` records no host
 * column, and the presence row that would carry pid+host is reaped on a SHORTER
 * schedule than these rows survive. Precisely when the rescue matters, its
 * falsifier is gone. Hence a freshness bound, mirroring the `live_spawn` leg's
 * long-standing 10-minute heartbeat requirement.
 *
 * Guarded at REAL Postgres because the bound lives in SQL: a mocked `sql` tag
 * would assert nothing about whether the predicate is actually in the query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import {
  RECORDED_ADV_SESSION_FRESH_SEC,
  listRecordedLiveSessions,
  recordedLiveOwnerIds,
} from './adv-sessions';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'recorded-freshness-ws';
const BOOTING = 'su-recorded-booting';
const ORPHANED = 'su-recorded-orphaned';
const ENDED = 'su-recorded-ended';

async function seedAdv(opts: {
  coordOwnerId: string;
  startedAgoSec: number;
  ended?: boolean;
}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, started_at, ended_at)
    VALUES (
      ${WS}, 'claude', 'console', ${opts.coordOwnerId},
      now() - ${`${opts.startedAgoSec} seconds`}::interval,
      ${opts.ended ? new Date() : null}
    )
  `;
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

describe('recordedLiveOwnerIds — the live_adv leg is freshness-bounded (WI-42466)', () => {
  it('still rescues a session inside its bootstrap window', async () => {
    await seedAdv({ coordOwnerId: BOOTING, startedAgoSec: 60 });
    const live = await recordedLiveOwnerIds([BOOTING]);
    expect(live.has(BOOTING)).toBe(true);
  });

  it('keeps the roster reader in parity with the recorded-live rescue cohort', async () => {
    await seedAdv({ coordOwnerId: BOOTING, startedAgoSec: 60 });
    await seedAdv({
      coordOwnerId: ORPHANED,
      startedAgoSec: RECORDED_ADV_SESSION_FRESH_SEC + 3600,
    });

    const [roster, rescue] = await Promise.all([
      listRecordedLiveSessions({ workspaceId: WS }),
      recordedLiveOwnerIds([BOOTING, ORPHANED]),
    ]);

    expect(roster.map((row) => row.coordOwnerId)).toEqual([BOOTING]);
    expect([...rescue].sort()).toEqual([BOOTING]);
  });

  it('does NOT vouch for an un-ended row whose session-end hook never ran', async () => {
    // The SIGKILL/crash/OOM shape: ended_at is NULL not because the process is
    // alive but because nothing got the chance to write it. Before the bound,
    // this returned true forever — the defect this file exists for.
    await seedAdv({ coordOwnerId: ORPHANED, startedAgoSec: RECORDED_ADV_SESSION_FRESH_SEC + 3600 });
    const live = await recordedLiveOwnerIds([ORPHANED]);
    expect(live.has(ORPHANED)).toBe(false);
  });

  it('never vouches for a cleanly ended session, fresh or not', async () => {
    await seedAdv({ coordOwnerId: ENDED, startedAgoSec: 60, ended: true });
    const live = await recordedLiveOwnerIds([ENDED]);
    expect(live.has(ENDED)).toBe(false);
  });

  it('does not let an older fresh session outvote a newer ended session', async () => {
    // A resumed owner can have an older session row whose end hook never ran,
    // followed by a newer row that ended cleanly. The live enrichment must
    // agree with endedRecordedOwnerIds on the newest row; otherwise the oracle
    // receives both sets and prefers the stale `recorded` rescue.
    const restarted = 'su-recorded-restarted-ended';
    await seedAdv({ coordOwnerId: restarted, startedAgoSec: 60 });
    await seedAdv({ coordOwnerId: restarted, startedAgoSec: 5, ended: true });
    const live = await recordedLiveOwnerIds([restarted]);
    expect(live.has(restarted)).toBe(false);
  });

  it('separates the cohorts in ONE batch — the shape every caller actually uses', async () => {
    // A batch read is the real call site (the oracle hydrates many owners at
    // once). Asserting the three cases individually would not catch a predicate
    // that accidentally applies to the whole result set rather than per row.
    await seedAdv({ coordOwnerId: BOOTING, startedAgoSec: 60 });
    await seedAdv({ coordOwnerId: ORPHANED, startedAgoSec: RECORDED_ADV_SESSION_FRESH_SEC + 3600 });
    await seedAdv({ coordOwnerId: ENDED, startedAgoSec: 60, ended: true });
    const live = await recordedLiveOwnerIds([BOOTING, ORPHANED, ENDED]);
    expect([...live].sort()).toEqual([BOOTING]);
  });

  it('bounds the window in minutes, not hours — the docstring promises a bootstrap window', async () => {
    // A calibration case: if someone widens the constant to something that is
    // no longer a boot window, the premise in the docstring stops being true
    // and this fails rather than silently drifting back toward "forever".
    expect(RECORDED_ADV_SESSION_FRESH_SEC).toBeGreaterThanOrEqual(60);
    expect(RECORDED_ADV_SESSION_FRESH_SEC).toBeLessThanOrEqual(30 * 60);
  });
});
