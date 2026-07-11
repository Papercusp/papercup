/**
 * agent-fleets-store.integration.test.ts — the fleet:launch-on-plan idempotency
 * guard (P-005 / migration 484), against a real Postgres (testcontainer).
 *
 * Proves the CROSS-WORKER semantics the in-process Map could not provide (the
 * 2026-07-03 ornith incident: a leader re-fired launch-on-plan 7× in 40s, each
 * call landed on a different :3070 worker with an empty map, and 6 waves / 12
 * unwanted terminals opened):
 *   - exactly ONE concurrent claim wins the window, even under a parallel race;
 *   - a claim inside the window is suppressed WITH the prior launch's at/count;
 *   - the window elapsing re-opens the slot;
 *   - releaseFleetLaunchSlot (all-spawns-failed path) clears ONLY its own claim,
 *     never a newer one.
 *
 * Mirrors autoloop-state.integration.test.ts's per-test-database setup; the
 * store fns take an explicit `sql` so no module mocking is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import {
  claimFleetLaunchSlot,
  createFleetIfAbsent,
  getFleet,
  releaseFleetLaunchSlot,
  setFleetControlState,
} from './agent-fleets-store';

const WS = 'ws-flguard';
const WINDOW = 60_000;

let rootSql: postgres.Sql;
let dbName: string;

async function insertFleet(slug: string): Promise<void> {
  await rootSql.unsafe(
    `INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [WS, slug, Date.now()],
  );
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `flg_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max > 1 so the concurrency test is a genuine multi-connection race.
  rootSql = postgres(u.toString(), { max: 6, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The agent_fleets shape: 417 baseline + the 484 launch-guard columns + the
  // 575 control-state columns (P-009 / H4).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_fleets (
      workspace_id      text NOT NULL,
      fleet_slug        text NOT NULL,
      title             text,
      description       text,
      owner             text,
      leader_owner_id   text,
      color_scheme      text,
      control_state     text DEFAULT 'active' NOT NULL,
      control_reason    text,
      control_by        text,
      control_at        bigint,
      created_at        bigint NOT NULL,
      updated_at        bigint DEFAULT 0 NOT NULL,
      last_launch_at    bigint,
      last_launch_count integer,
      CONSTRAINT agent_fleets_pkey PRIMARY KEY (workspace_id, fleet_slug)
    )
  `);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('claimFleetLaunchSlot (P-005 cross-worker idempotency)', () => {
  it('first claim wins; a re-claim inside the window is suppressed with the prior at/count', async () => {
    await insertFleet('window-fleet');
    const t0 = 1_000_000;
    const first = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'window-fleet', count: 2, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    expect(first).toEqual({ won: true, at: t0 });
    // The 2026-07-03 shape: a re-fire 40s later must NOT open another wave.
    const refire = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'window-fleet', count: 2, windowMs: WINDOW, now: t0 + 40_000, sql: rootSql,
    });
    expect(refire).toEqual({ won: false, priorAt: t0, priorCount: 2 });
  });

  it('the window elapsing re-opens the slot (a genuine second wave)', async () => {
    await insertFleet('second-wave');
    const t0 = 2_000_000;
    await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'second-wave', count: 3, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    const wave2 = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'second-wave', count: 3, windowMs: WINDOW, now: t0 + WINDOW + 1, sql: rootSql,
    });
    expect(wave2).toEqual({ won: true, at: t0 + WINDOW + 1 });
  });

  it('exactly ONE of N concurrent claims wins (the multi-worker race)', async () => {
    await insertFleet('race-fleet');
    const t0 = 3_000_000;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimFleetLaunchSlot({
          workspaceId: WS, fleetSlug: 'race-fleet', count: 2, windowMs: WINDOW, now: t0 + i, sql: rootSql,
        }),
      ),
    );
    expect(results.filter((r) => r.won)).toHaveLength(1);
  });

  it('fails OPEN (won, unrecorded) when the fleet row does not exist', async () => {
    const r = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'no-such-fleet', count: 1, windowMs: WINDOW, now: 5_000, sql: rootSql,
    });
    expect(r.won).toBe(true);
  });
});

describe('fleet control state (P-009 / mig 575) — typed wind-down round-trip', () => {
  it('a new fleet is born active; wind-down persists state+reason+by+ts; resume clears back', async () => {
    const { record } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'ctl-fleet', leaderOwnerId: 'su-lead' },
      rootSql,
    );
    expect(record.controlState).toBe('active');
    expect(record.controlReason).toBeNull();

    const wound = await setFleetControlState(
      WS, 'ctl-fleet',
      { state: 'winding-down', reason: 'release cut', by: 'su-lead' },
      rootSql,
    );
    expect(wound).toMatchObject({
      controlState: 'winding-down',
      controlReason: 'release cut',
      controlBy: 'su-lead',
    });
    expect(wound?.controlAt).toBeGreaterThan(0);

    // The read path every consumer (orient fold, fleet:status) uses.
    const read = await getFleet(WS, 'ctl-fleet', rootSql);
    expect(read?.controlState).toBe('winding-down');

    const resumed = await setFleetControlState(
      WS, 'ctl-fleet',
      { state: 'active', reason: 'incident cleared', by: 'su-lead' },
      rootSql,
    );
    expect(resumed?.controlState).toBe('active');
    expect(resumed?.controlReason).toBe('incident cleared');
  });

  it('a missing fleet returns null (no phantom control rows)', async () => {
    expect(
      await setFleetControlState(WS, 'no-such', { state: 'winding-down' }, rootSql),
    ).toBeNull();
  });

  it('a forged control_state reads back as active (defensive rowToRecord)', async () => {
    await insertFleet('forged-ctl');
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets SET control_state = 'god-mode' WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'forged-ctl'],
    );
    const read = await getFleet(WS, 'forged-ctl', rootSql);
    expect(read?.controlState).toBe('active');
  });
});

describe('releaseFleetLaunchSlot (all-spawns-failed retry path)', () => {
  it('clears its own claim so an immediate retry wins', async () => {
    await insertFleet('failed-launch');
    const t0 = 4_000_000;
    const claim = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'failed-launch', count: 2, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    expect(claim.won).toBe(true);
    await releaseFleetLaunchSlot({ workspaceId: WS, fleetSlug: 'failed-launch', at: t0, sql: rootSql });
    const retry = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'failed-launch', count: 2, windowMs: WINDOW, now: t0 + 5_000, sql: rootSql,
    });
    expect(retry).toEqual({ won: true, at: t0 + 5_000 });
  });

  it('never clears a NEWER claim (stale release is a no-op)', async () => {
    await insertFleet('stale-release');
    const t0 = 5_000_000;
    await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'stale-release', count: 1, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    // A stale release from an OLDER claim timestamp must not clear the live one.
    await releaseFleetLaunchSlot({ workspaceId: WS, fleetSlug: 'stale-release', at: t0 - 999, sql: rootSql });
    const refire = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'stale-release', count: 1, windowMs: WINDOW, now: t0 + 1_000, sql: rootSql,
    });
    expect(refire.won).toBe(false);
  });
});
