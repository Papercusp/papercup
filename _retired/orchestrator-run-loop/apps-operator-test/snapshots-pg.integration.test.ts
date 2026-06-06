/**
 * snapshots-pg.integration.test.ts — real-Postgres coverage for mission
 * snapshots + retention pruning (P-008, Phase 1).
 *
 * The valuable bit makeMockPg can't validate is `snapshotStatePg`'s retention
 * prune — a ROW_NUMBER() OVER (PARTITION BY … ORDER BY taken_at DESC) window
 * that deletes everything past `retention`. This runs it against real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  SNAPSHOTS_DDL,
  snapshotStatePg,
  listSnapshotsPg,
  readSnapshotPg,
  type SnapshotsPgContext,
  type SnapshotPayload,
} from '../../../libs/papercusp/packages/orchestrator/src/snapshots-pg';

let db: FreshPgDb;

const mkCtx = (): SnapshotsPgContext => ({
  pg: db.sql as unknown as SnapshotsPgContext['pg'],
  workspaceId: `ws_${randomBytes(4).toString('hex')}`,
  harnessSlug: `h_${randomBytes(4).toString('hex')}`,
});
const snap = (id: string, iteration: number, takenAt: number): SnapshotPayload => ({
  snapshotId: id,
  iteration,
  featuresJson: '{"F-001":"passed"}',
  validationMd: '# validation',
  notesMd: 'supervisor notes',
  configJson: '{"k":1}',
  takenAt,
});

beforeAll(async () => {
  db = await createFreshPgDb('snap');
  await db.sql.unsafe(SNAPSHOTS_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('snapshots-pg against real Postgres', () => {
  it('round-trips a snapshot', async () => {
    const ctx = mkCtx();
    const p = snap('s1', 1, 1000);
    await snapshotStatePg(ctx, p, 50);
    expect(await readSnapshotPg(ctx, 's1')).toEqual(p);
  });

  it('returns null for an unknown snapshot', async () => {
    expect(await readSnapshotPg(mkCtx(), 'nope')).toBeNull();
  });

  it('lists snapshots newest-first by taken_at', async () => {
    const ctx = mkCtx();
    await snapshotStatePg(ctx, snap('a', 1, 1000), 50);
    await snapshotStatePg(ctx, snap('b', 2, 2000), 50);
    expect((await listSnapshotsPg(ctx)).map((s) => s.snapshotId)).toEqual(['b', 'a']);
  });

  it('prunes to retention, keeping the newest by taken_at (ROW_NUMBER window)', async () => {
    const ctx = mkCtx();
    for (let i = 1; i <= 5; i++) {
      await snapshotStatePg(ctx, snap(`s${i}`, i, i * 1000), 2);
    }
    expect((await listSnapshotsPg(ctx)).map((s) => s.snapshotId)).toEqual(['s5', 's4']);
  });

  it('ON CONFLICT DO NOTHING keeps the first write on a duplicate snapshot_id', async () => {
    const ctx = mkCtx();
    await snapshotStatePg(ctx, snap('dup', 1, 1000), 50);
    await snapshotStatePg(ctx, snap('dup', 99, 9999), 50);
    expect((await readSnapshotPg(ctx, 'dup'))?.iteration).toBe(1);
  });

  it('isolates snapshots by harness', async () => {
    const a = mkCtx();
    const b = mkCtx();
    await snapshotStatePg(a, snap('x', 1, 1000), 50);
    expect(await listSnapshotsPg(b)).toEqual([]);
  });
});
