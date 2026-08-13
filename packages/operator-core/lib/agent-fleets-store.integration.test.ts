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
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  claimFleetLaunchSlot,
  createFleetIfAbsent,
  getFleet,
  claimFleetHeadcountAttempt,
  listFleetHeadcountTargets,
  recordFleetHeadcountAttempt,
  releaseFleetLaunchSlot,
  setFleetHeadcountTarget,
  setFleetControlState,
  setFleetLaunchTransaction,
} from './agent-fleets-store';

const WS = 'ws-flguard';
const WINDOW = 60_000;

let rootSql: postgres.Sql;
let db: FreshPgDb;

async function insertFleet(slug: string): Promise<void> {
  await rootSql.unsafe(
    `INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [WS, slug, Date.now()],
  );
}

beforeAll(async () => {
  // EI-11788: use the shared Papercusp fixture, which retries transient PG
  // connects and drops only this throwaway database. The former bespoke
  // CREATE DATABASE path could wait behind concurrent green-checkpoint work
  // until Vitest's 90s suite timeout, losing the actual test verdict.
  db = await createFreshPgDb('fleet-headcount-store');
  rootSql = db.sql;
  // max > 1 (the helper's max=4) keeps the concurrency test genuine.
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
      headcount_target integer,
      headcount_config jsonb,
      headcount_next_attempt_at bigint,
      headcount_backoff_ms bigint DEFAULT 0 NOT NULL,
      headcount_last_error text,
      last_launch_transaction jsonb,
      CONSTRAINT agent_fleets_pkey PRIMARY KEY (workspace_id, fleet_slug)
    )
  `);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
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

  it('a stale reconcile snapshot cannot overwrite a newer resume', async () => {
    await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'cas-fleet', leaderOwnerId: 'su-lead' },
      rootSql,
    );
    // Make the snapshot unambiguously older than the resume write, even if both calls
    // happen within one millisecond in a fast test process.
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets SET updated_at = $3 WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'cas-fleet', 1_000_000],
    );
    const snapshot = await getFleet(WS, 'cas-fleet', rootSql);
    expect(snapshot?.updatedAt).toBe(1_000_000);

    const resumed = await setFleetControlState(
      WS,
      'cas-fleet',
      { state: 'active', reason: 'newer resume', by: 'su-lead' },
      rootSql,
    );
    expect(resumed?.updatedAt).toBeGreaterThan(snapshot!.updatedAt);

    const staleWindDown = await setFleetControlState(
      WS,
      'cas-fleet',
      { state: 'winding-down', reason: 'stale reconcile', by: 'system:fleet-control-reconcile' },
      rootSql,
      undefined,
      { state: 'active', updatedAtMs: snapshot!.updatedAt },
    );
    expect(staleWindDown).toBeNull();
    expect((await getFleet(WS, 'cas-fleet', rootSql))?.controlState).toBe('active');
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

describe('fleet launch transaction state (P-003 / mig 830)', () => {
  it('persists and reads the exact partial-recovery transaction on the fleet row', async () => {
    await insertFleet('transaction-fleet');
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-1',
      state: 'partial' as const,
      requestedAt: 1_000,
      updatedAt: 2_000,
      requestedMemberIds: ['su-a', 'su-b'],
      openedMemberIds: ['su-a'],
      verifiedMemberIds: ['su-a'],
      failed: [{ ownerId: 'su-b', phase: 'spawn' as const, reason: 'no window' }],
      waves: [{ index: 0, ownerIds: ['su-a'], state: 'verified' as const }],
      recovery: { retryOwnerIds: ['su-b'], nextAction: 'retry only the unresolved member identity' },
    };
    await setFleetLaunchTransaction({ workspaceId: WS, fleetSlug: 'transaction-fleet', transaction, sql: rootSql });
    expect((await getFleet(WS, 'transaction-fleet', rootSql))?.lastLaunchTransaction).toEqual(transaction);
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

describe('fleet headcount target (WI-2479)', () => {
  const config = { plan: 'drain', harness: 'papercusp', agent: 'claude' as const };

  it('persists a target recipe and grants only one concurrent retry lease', async () => {
    await insertFleet('headcount-fleet');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-fleet', target: 3, config, sql: rootSql });
    expect(await listFleetHeadcountTargets(WS, rootSql)).toMatchObject([{ fleetSlug: 'headcount-fleet', target: 3, config }]);
    const first = await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-fleet', now: 8_000_000, sql: rootSql });
    expect(first).toMatchObject({ fleetSlug: 'headcount-fleet', target: 3, claimedAt: 8_000_000 });
    expect(await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-fleet', now: 8_000_001, sql: rootSql })).toBeNull();
  });

  it('resets on success and doubles a failed retry delay with a cap', async () => {
    await insertFleet('headcount-backoff');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-backoff', target: 2, config, sql: rootSql });
    const readBackoffTarget = async () =>
      (await listFleetHeadcountTargets(WS, rootSql)).find((target) => target.fleetSlug === 'headcount-backoff');
    await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', now: 9_000_000, sql: rootSql });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: false, error: 'spawn failed', now: 9_100_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 60_000, lastError: 'spawn failed' });
    await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', now: 9_200_000, sql: rootSql });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: false, error: 'spawn failed again', now: 9_300_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 120_000, lastError: 'spawn failed again' });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: true, now: 9_500_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 0, nextAttemptAt: null, lastError: null });
  });
});
