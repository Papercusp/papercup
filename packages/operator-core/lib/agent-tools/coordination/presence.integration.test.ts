/**
 * presence.integration.test.ts — the presence GC mutator against REAL Postgres
 * (the shared baseline-schema DB via inject('baselineSchemaDsn')).
 *
 * BRIEF-test-coverage-fu-coordination-federation-area target #3: only the
 * `deriveLiveness` boundary was tested; `sweepStalePresence` (the DELETE-by-age
 * mutator that keeps the roster from accumulating hundreds of long-ended rows)
 * was unguarded. This drives the `presence.ts` operator adapter export end-to-end
 * — through the module's OWN getOrgPg() handle — so the host-seam wiring + the
 * underlying PgPresenceStore.sweepStale query are exercised together.
 *
 * ⚠ presence-reconcile is su-584a8's federation surface; this touches NEITHER the
 * source nor the reconcile path — it only adds coverage for the existing GC
 * mutator. Seeds explicit heartbeat_at timestamps (admin/bypass) so the age
 * boundary is deterministic; TRUNCATEs coord_presence per test for isolation
 * (no other baseline-DSN suite uses it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { sweepStalePresence, listPresence } from './presence';
import { fetchWakeability } from './presence-wakeability';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

/** Seed a presence row with an explicit heartbeat age (seconds in the past). */
async function seed(ownerId: string, ageSeconds: number, workspaceId = 'default'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${workspaceId}, 'static-client',
            now() - ${`${ageSeconds} seconds`}::interval)
  `;
}

async function ownerIds(): Promise<string[]> {
  const rows = await admin<{ owner_id: string }[]>`
    SELECT owner_id FROM harness_shared.coord_presence ORDER BY owner_id`;
  return rows.map((r) => r.owner_id);
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`;
});

describe('sweepStalePresence (real PG)', () => {
  it('deletes only rows older than maxAgeMs and returns the count; fresh rows survive', async () => {
    await seed('stale-1hr', 3600);
    await seed('stale-30m', 1800);
    await seed('fresh-now', 0);
    await seed('fresh-2m', 120);

    // 10-minute threshold: the two >10m rows go, the two recent ones stay.
    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['fresh-2m', 'fresh-now']);
  });

  it('returns 0 and deletes nothing when every row is fresh', async () => {
    await seed('a', 1);
    await seed('b', 5);
    const removed = await sweepStalePresence(60 * 60 * 1000); // 1h threshold
    expect(removed).toBe(0);
    expect(await ownerIds()).toEqual(['a', 'b']);
  });

  it('returns 0 on an empty roster', async () => {
    expect(await sweepStalePresence(1000)).toBe(0);
  });

  it('sweeps across workspaces (the GC is not workspace-scoped)', async () => {
    await seed('ws-default-stale', 3600, 'default');
    await seed('ws-other-stale', 3600, 'harness:papercup');
    await seed('ws-other-fresh', 0, 'harness:papercup');

    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['ws-other-fresh']);
  });

  it('clamps a sub-second maxAgeMs to a 1s floor (still removes a clearly-old row)', async () => {
    await seed('ancient', 3600);
    await seed('just-now', 0);
    // maxAgeMs=0 → floor of 1s: the hour-old row goes, the just-now row stays.
    const removed = await sweepStalePresence(0);
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual(['just-now']);
  });

  it('the surviving rows are visible through the listPresence read path', async () => {
    await seed('gone', 3600);
    await seed('kept', 0);
    await sweepStalePresence(10 * 60 * 1000);
    const live = await listPresence();
    expect(live.map((r) => r.ownerId)).toContain('kept');
    expect(live.map((r) => r.ownerId)).not.toContain('gone');
  });
});
