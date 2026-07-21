/**
 * stalled-claim-collector.integration.test.ts — bug-drain-200k live find
 * (2026-07-21, WI-3669 recurrence).
 *
 * `collectStalledClaimSignals` (the "claim held by a live agent, no progress"
 * watchdog) must NOT re-flag a work-item the holder has deliberately parked via
 * `payload._claimHold: true` (WI-2797 "held open" — the same floor that already
 * excludes the row from claim_next/scheduler:get_next self-select). Before this
 * fix the collector only checked holder-liveness + last_progress_at age against
 * `harness_shared.fleet_assignment`, with no awareness of `_claimHold` — so a
 * considered "nothing more to do right now, needs a live rig / owner decision"
 * disposition kept re-surfacing as a fresh "stalled claim" bug forever (it never
 * gets a checkpoint/state update again by design), burning a full
 * investigate-and-rediscover cycle on every sweep (confirmed live on WI-3669,
 * held+blocked ~20h earlier, resurfaced verbatim under bug-drain-200k).
 *
 * Uses the full baseline-schema fixture (real `fleet_assignment` view +
 * `coord_presence` + `work_items`), same wiring as fleet/assignments.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { collectStalledClaimSignals } from './watchdog';

let fx: BaselineCoordFixture;
const WS = 'default';
const H = 'papercup';

async function truncateAll(): Promise<void> {
  await fx.admin`TRUNCATE harness_shared.coord_presence`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE feature_id LIKE 'SCT-TEST-%'`;
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE scope LIKE 'workitem:%SCT-TEST-%'`;
}

async function seedPresence(ownerId: string): Promise<void> {
  await fx.admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, intent, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${WS}, 'test', '', now())`;
}

/** Seed an issue-family (bug) work_items row, claimed a while ago with a stale
 *  last_progress_at — the "holder alive, no item-scoped progress" stalled shape. */
async function seedBug(
  featureId: string,
  takenBy: string,
  takenAgoMin: number,
  opts: { claimHold?: boolean; status?: string } = {},
): Promise<void> {
  const payload = opts.claimHold ? { _claimHold: true, held_open_by: takenBy, held_open_reason: 'blocked' } : {};
  await fx.admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, taken_at,
       last_progress_at, payload, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'bug', ${featureId}, ${opts.status ?? 'blocked'}, ${takenBy},
       now() - make_interval(mins => ${takenAgoMin}),
       now() - make_interval(mins => ${takenAgoMin}),
       ${JSON.stringify(payload)}::jsonb, ${Date.now()}, ${Date.now()})`;
}

const collect = () => collectStalledClaimSignals(fx.admin, WS, { stalledClaimMinutes: 5 });

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
}, 120_000);

afterAll(async () => {
  await fx?.dispose();
});

beforeEach(async () => {
  await truncateAll();
});

describe('collectStalledClaimSignals — claim-hold exclusion (WI-3669 recurrence)', () => {
  it('flags a genuinely stalled claim (alive holder, stale progress, NOT claim-held)', async () => {
    await seedPresence('su-stalled-holder');
    await seedBug('SCT-TEST-001', 'su-stalled-holder', 60);
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.source).toBe('stalled-claim');
    expect(sigs[0]!.body).toContain('SCT-TEST-001');
  });

  it('does NOT flag a deliberately claim-held item (payload._claimHold: true)', async () => {
    await seedPresence('su-held-holder');
    await seedBug('SCT-TEST-002', 'su-held-holder', 60, { claimHold: true });
    expect(await collect()).toEqual([]);
  });

  it('a mixed set flags only the non-held stalled claim', async () => {
    await seedPresence('su-stalled-holder');
    await seedPresence('su-held-holder');
    await seedBug('SCT-TEST-003', 'su-stalled-holder', 60);
    await seedBug('SCT-TEST-004', 'su-held-holder', 60, { claimHold: true });
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.body).toContain('SCT-TEST-003');
    expect(sigs[0]!.body).not.toContain('SCT-TEST-004');
  });
});
