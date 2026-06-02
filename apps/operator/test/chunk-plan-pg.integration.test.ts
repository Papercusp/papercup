/**
 * chunk-plan-pg.integration.test.ts — real-Postgres coverage for the worker
 * chunk-plan store (P-008, Phase 1). This is the resume-on-restart state.
 *
 * makeMockPg can't validate: the delete-then-insert "replace plan" atomicity,
 * the COALESCE-guarded partial status updates, and the chunk_index ordering —
 * all covered here against real Postgres.
 *
 * It ALSO confirms (via a probe, see git history) the systemic JSONB
 * double-encode bug from D-006: `files` is written with
 * `${JSON.stringify(files)}::jsonb`, which lands as a jsonb STRING scalar — even
 * WITH the `::jsonb` cast. The probe proved the only correct forms are
 * `${sql.json(files)}` / `${sql.json(files)}::jsonb`. So `files` does not
 * round-trip as an array in production (readPlan returns a string typed as
 * string[]). Captured as a tripwire below.
 *
 * chunk-plan-pg exports no DDL (its table is defined in the squashed
 * 000-baseline.sql — migration 042 was folded in), so the table is created
 * inline from the DDL below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  persistPlan,
  setChunkStatus,
  updateChunkPlan,
  readPlan,
  dropPlan,
  type ChunkPlanPgCtx,
} from '../../../libs/papercusp/packages/orchestrator/src/chunk-plan-pg';

// Mirrors harness_shared.harness_chunk_plans as defined in 000-baseline.sql.
const CHUNK_PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_chunk_plans (
    workspace_id TEXT NOT NULL, harness_slug TEXT NOT NULL, feature_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL, chunk_index INT NOT NULL, files JSONB NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    strikes INT NOT NULL DEFAULT 0, last_error TEXT, commit_sha TEXT,
    created_ts BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
    updated_ts BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
    PRIMARY KEY (workspace_id, harness_slug, feature_id, chunk_id)
  );
`;

let db: FreshPgDb;

const mkCtx = (): ChunkPlanPgCtx => ({
  pg: db.sql as unknown as ChunkPlanPgCtx['pg'],
  workspaceId: `ws_${randomBytes(4).toString('hex')}`,
  harnessSlug: `h_${randomBytes(4).toString('hex')}`,
});
const plan = (
  featureId: string,
  chunks: { id: string; files: string[]; description: string }[],
) => ({ featureId, chunks }) as unknown as Parameters<typeof persistPlan>[1];

beforeAll(async () => {
  db = await createFreshPgDb('chp');
  await db.sql.unsafe(CHUNK_PLANS_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('chunk-plan-pg against real Postgres', () => {
  it('persists a plan and reads it back ordered by chunk_index', async () => {
    const ctx = mkCtx();
    await persistPlan(
      ctx,
      plan('F-001', [
        { id: 'F-001-1', files: ['a.ts', 'b.ts'], description: 'do a' },
        { id: 'F-001-2', files: ['c.ts'], description: 'do b' },
      ]),
    );
    const got = await readPlan(ctx, 'F-001');
    expect(got.map((c) => c.chunkId)).toEqual(['F-001-1', 'F-001-2']);
    expect(got[0].index).toBe(1);
    expect(got[0].files).toEqual(['a.ts', 'b.ts']);
    expect(got[0].description).toBe('do a');
    expect(got[0].status).toBe('pending');
    expect(got[0].strikes).toBe(0);
    expect(got[0].lastError).toBeNull();
  });

  // D-007 FIX VERIFIED: persistPlan/updateChunkPlan now use sql.json (via pgJson),
  // so `files` lands as a real jsonb array and round-trips.
  it('round-trips chunk files as a jsonb array', async () => {
    const ctx = mkCtx();
    await persistPlan(ctx, plan('F-jt', [{ id: 'F-jt-1', files: ['x.ts', 'y.ts'], description: 'x' }]));
    const [row] = await db.sql<{ jt: string | null }[]>`
      SELECT jsonb_typeof(files) AS jt FROM harness_shared.harness_chunk_plans
       WHERE feature_id = 'F-jt' AND harness_slug = ${ctx.harnessSlug}`;
    expect(row.jt).toBe('array');
    expect((await readPlan(ctx, 'F-jt'))[0].files).toEqual(['x.ts', 'y.ts']);
  });

  it('setChunkStatus updates status and COALESCEs only the supplied extras', async () => {
    const ctx = mkCtx();
    await persistPlan(ctx, plan('F-2', [{ id: 'F-2-1', files: [], description: 'd' }]));

    await setChunkStatus(ctx, 'F-2', 'F-2-1', 'failing', { strikes: 2, lastError: 'boom' });
    let [c] = await readPlan(ctx, 'F-2');
    expect(c.status).toBe('failing');
    expect(c.strikes).toBe(2);
    expect(c.lastError).toBe('boom');

    // Partial update: only status + commitSha; strikes/lastError preserved via COALESCE.
    await setChunkStatus(ctx, 'F-2', 'F-2-1', 'committed', { commitSha: 'abc123' });
    [c] = await readPlan(ctx, 'F-2');
    expect(c.status).toBe('committed');
    expect(c.strikes).toBe(2);
    expect(c.lastError).toBe('boom');
    expect(c.commitSha).toBe('abc123');
  });

  it('updateChunkPlan replaces a chunk and resets it to pending', async () => {
    const ctx = mkCtx();
    await persistPlan(ctx, plan('F-5', [{ id: 'F-5-1', files: ['old.ts'], description: 'old' }]));
    await setChunkStatus(ctx, 'F-5', 'F-5-1', 'failing', { lastError: 'x' });
    await updateChunkPlan(ctx, 'F-5', {
      id: 'F-5-1',
      files: ['new.ts'],
      description: 'new',
    } as unknown as Parameters<typeof updateChunkPlan>[2]);
    const [c] = await readPlan(ctx, 'F-5');
    expect(c.files).toEqual(['new.ts']);
    expect(c.description).toBe('new');
    expect(c.status).toBe('pending');
    expect(c.lastError).toBeNull();
  });

  it('persistPlan replaces an existing plan (delete-then-insert; no lingering chunks)', async () => {
    const ctx = mkCtx();
    await persistPlan(
      ctx,
      plan('F-3', [
        { id: 'F-3-1', files: [], description: 'a' },
        { id: 'F-3-2', files: [], description: 'b' },
        { id: 'F-3-3', files: [], description: 'c' },
      ]),
    );
    await persistPlan(ctx, plan('F-3', [{ id: 'F-3-1', files: [], description: 'a2' }]));
    const got = await readPlan(ctx, 'F-3');
    expect(got.map((c) => c.chunkId)).toEqual(['F-3-1']);
    expect(got[0].description).toBe('a2');
  });

  it('dropPlan removes the feature plan', async () => {
    const ctx = mkCtx();
    await persistPlan(ctx, plan('F-4', [{ id: 'F-4-1', files: [], description: 'd' }]));
    await dropPlan(ctx, 'F-4');
    expect(await readPlan(ctx, 'F-4')).toEqual([]);
  });
});
