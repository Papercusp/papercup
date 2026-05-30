/**
 * checkpoints-pg.integration.test.ts — real-Postgres coverage for the
 * orchestrator's checkpoint signalling state machine (P-008, Phase 1).
 *
 * Checkpoints drive the human-in-the-loop gates: fire (pending) → grant
 * (granted) → clear (consumed). The lifecycle is pure SQL — INSERT ON CONFLICT
 * DO NOTHING, conditional UPDATEs guarded on (granted, consumed), and a
 * consumed-row-excluding SELECT — none of which makeMockPg can validate. This
 * runs the real functions against a throwaway testcontainer Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  CHECKPOINTS_DDL,
  fireCheckpointPg,
  listCheckpointsPg,
  grantCheckpointPg,
  clearGrantedCheckpointsPg,
  type CheckpointsPgContext,
} from '../../../libs/papercusp/packages/orchestrator/src/checkpoints-pg';

let db: FreshPgDb;

// PK is (harness_slug, name) — give each test a unique harness so they're independent.
const mkCtx = (): CheckpointsPgContext => ({
  pg: db.sql as unknown as CheckpointsPgContext['pg'],
  workspaceId: `ws_${randomBytes(4).toString('hex')}`,
  harnessSlug: `h_${randomBytes(4).toString('hex')}`,
});

beforeAll(async () => {
  db = await createFreshPgDb('cp');
  await db.sql.unsafe(CHECKPOINTS_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('checkpoints-pg against real Postgres', () => {
  it('fire returns true once, false on a duplicate (ON CONFLICT DO NOTHING)', async () => {
    const ctx = mkCtx();
    expect(await fireCheckpointPg(ctx, 'review', 'please review')).toBe(true);
    expect(await fireCheckpointPg(ctx, 'review', 'again')).toBe(false);
  });

  it('drives the pending → granted → consumed lifecycle', async () => {
    const ctx = mkCtx();
    await fireCheckpointPg(ctx, 'gate', 'body');
    expect(await listCheckpointsPg(ctx)).toEqual({ pending: ['gate'], granted: [] });

    expect(await grantCheckpointPg(ctx, 'gate')).toBe(true);
    expect(await listCheckpointsPg(ctx)).toEqual({ pending: [], granted: ['gate'] });

    expect(await clearGrantedCheckpointsPg(ctx)).toEqual(['gate']);
    // Consumed rows drop out of the list (the "any row exists / .fired" predicate
    // is a separate query that intentionally still sees them).
    expect(await listCheckpointsPg(ctx)).toEqual({ pending: [], granted: [] });
  });

  it('grant is a no-op on an already-granted checkpoint', async () => {
    const ctx = mkCtx();
    await fireCheckpointPg(ctx, 'g', '');
    expect(await grantCheckpointPg(ctx, 'g')).toBe(true);
    expect(await grantCheckpointPg(ctx, 'g')).toBe(false);
  });

  it('clear only consumes granted checkpoints, leaving pending ones', async () => {
    const ctx = mkCtx();
    await fireCheckpointPg(ctx, 'p1', '');
    await fireCheckpointPg(ctx, 'g1', '');
    await grantCheckpointPg(ctx, 'g1');
    expect(await clearGrantedCheckpointsPg(ctx)).toEqual(['g1']);
    expect(await listCheckpointsPg(ctx)).toEqual({ pending: ['p1'], granted: [] });
  });

  it('isolates checkpoints by harness', async () => {
    const a = mkCtx();
    const b = mkCtx();
    await fireCheckpointPg(a, 'x', '');
    expect((await listCheckpointsPg(a)).pending).toEqual(['x']);
    expect((await listCheckpointsPg(b)).pending).toEqual([]);
  });
});
