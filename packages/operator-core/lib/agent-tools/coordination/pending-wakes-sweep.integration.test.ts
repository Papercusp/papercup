/**
 * pending-wakes-sweep.integration.test.ts — the EI-314 dead-owner GC against REAL
 * Postgres (baseline-schema DB), mirroring presence.integration.test.ts.
 *
 * `sweepDeadOwnerPendingWakes` is the wake-queue analog of `sweepStalePresence`:
 * a manual-mode staged wake is only ever released by the owner reviewing it, so a
 * wake staged for an ENDED session (no live presence heartbeat) accumulates forever
 * and trips the wake-queue invariant as pure debris. This drives the real two-table
 * DELETE (pending_wakes ⋈ coord_presence) so the NOT-EXISTS join + the grace
 * boundary are exercised end-to-end through the module's own getOrgPg() handle.
 *
 * Seeds explicit created_at / heartbeat_at ages (admin) so the boundary is
 * deterministic; TRUNCATEs both tables per test for isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { sweepDeadOwnerPendingWakes, listAllPendingWakes } from './pending-wakes';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

/** Seed a staged wake with an explicit age (minutes in the past). */
async function seedWake(ownerId: string, ageMin: number, source = 'system:wake-brain'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.pending_wakes (owner_id, summary, source, workspace_id, created_at, last_seen_at)
    VALUES (${ownerId}, ${`wake for ${ownerId}`}, ${source}, 'default',
            now() - ${`${ageMin} minutes`}::interval, now() - ${`${ageMin} minutes`}::interval)`;
}

/** Seed a presence heartbeat with an explicit age (minutes in the past). */
async function seedPresence(ownerId: string, heartbeatAgeMin: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, 'default', 'static-client', now() - ${`${heartbeatAgeMin} minutes`}::interval)`;
}

async function remainingOwners(): Promise<string[]> {
  return (await listAllPendingWakes()).map((w) => w.ownerId).sort();
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.pending_wakes, harness_shared.coord_presence`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.pending_wakes, harness_shared.coord_presence`;
});

describe('sweepDeadOwnerPendingWakes (EI-314)', () => {
  it('sweeps an OLD wake for a GONE owner (no presence at all)', async () => {
    await seedWake('su-ended', 180); // 3h old, no presence row
    const swept = await sweepDeadOwnerPendingWakes({ liveGraceMin: 60 });
    expect(swept).toBe(1);
    expect(await remainingOwners()).toEqual([]);
  });

  it('KEEPS a wake for a LIVE owner (fresh presence heartbeat) — a paused agent still heartbeats', async () => {
    await seedWake('su-paused', 180);
    await seedPresence('su-paused', 2); // heartbeat 2 min ago → alive
    const swept = await sweepDeadOwnerPendingWakes({ liveGraceMin: 60 });
    expect(swept).toBe(0);
    expect(await remainingOwners()).toEqual(['su-paused']);
  });

  it('sweeps a wake for an owner whose presence is STALE past the grace (ended, heartbeat gone cold)', async () => {
    await seedWake('su-stale', 180);
    await seedPresence('su-stale', 120); // heartbeat 2h ago → past the 60m grace → dead
    const swept = await sweepDeadOwnerPendingWakes({ liveGraceMin: 60 });
    expect(swept).toBe(1);
    expect(await remainingOwners()).toEqual([]);
  });

  it('KEEPS a RECENT wake even for a gone owner (grace protects a just-staged wake)', async () => {
    await seedWake('su-justnow', 10); // 10 min old, < 60m grace
    const swept = await sweepDeadOwnerPendingWakes({ liveGraceMin: 60 });
    expect(swept).toBe(0);
    expect(await remainingOwners()).toEqual(['su-justnow']);
  });

  it('mixed fleet: sweeps only the dead-owner old wakes, returns the count', async () => {
    await seedWake('su-ended-1', 200);
    await seedWake('su-ended-2', 200);
    await seedWake('su-live', 200);
    await seedPresence('su-live', 1);
    await seedWake('su-recent', 5); // grace-protected
    const swept = await sweepDeadOwnerPendingWakes({ liveGraceMin: 60 });
    expect(swept).toBe(2);
    expect(await remainingOwners()).toEqual(['su-live', 'su-recent']);
  });
});
