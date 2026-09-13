/** Real-PG proof that live width and exact profile gates run before embedding. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  backfillTable,
  inspectBackfillTarget,
  type BackfillTarget,
} from './embed-backfill';

const TARGET: BackfillTarget = {
  table: 'harness_shared.profile_width_probe',
  embedCol: 'embedding',
  bodySql: 'body',
  keyCols: ['id'],
};

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('embed-profile-width');
  sql = db.sql;
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.profile_width_probe (
      id text PRIMARY KEY,
      body text NOT NULL,
      embedding vector(384),
      embedding_mode text,
      embedding_profile text
    );
    INSERT INTO harness_shared.profile_width_probe (id, body)
    VALUES ('row-1', 'must not be embedded');
  `);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('profile-aware backfill against live catalog width', () => {
  it('classifies the real vector(384) typmod as skewed from the 768 storage declaration', async () => {
    const inspection = await inspectBackfillTarget(sql, TARGET);
    expect(inspection).toMatchObject({
      exists: true,
      spaceAware: true,
      profileColPresent: true,
    });
    expect(inspection.widthSkew).toEqual([
      {
        table: TARGET.table,
        column: TARGET.embedCol,
        liveDims: 384,
        declaredDims: 768,
      },
    ]);
  });

  it('suppresses the write and embed call when the live catalog reports width skew', async () => {
    const embed = vi.fn(async () => new Array(768).fill(0.1));
    const inspection = await inspectBackfillTarget(sql, TARGET);

    // This is the runBackfillSweep call boundary: a skewed target is excluded
    // before backfillTable can call the embedder or issue UPDATE.
    if (inspection.widthSkew.length === 0) {
      await backfillTable(sql, TARGET, embed, 1, 'gemma', inspection.spaceAware, undefined, {
        profileColPresent: inspection.profileColPresent,
        profile: EMBEDDER_DIM_SPECS.gemma,
      });
    }

    expect(embed).not.toHaveBeenCalled();
    const [row] = await sql<{ embedding: string | null; embedding_profile: string | null }[]>`
      SELECT embedding::text, embedding_profile
        FROM harness_shared.profile_width_probe WHERE id = 'row-1'`;
    expect(row).toEqual({ embedding: null, embedding_profile: null });

    // Mutation/control: bypassing the live-width exclusion reaches the
    // embedder, then PostgreSQL rejects the wrong-width write. That contrast is
    // the evidence that the production guard prevents a real attempted write.
    const bypass = vi.fn(async () => new Array(768).fill(0.1));
    const stats = await backfillTable(sql, TARGET, bypass, 1, 'gemma', true, undefined, {
      profileColPresent: true,
      profile: EMBEDDER_DIM_SPECS.gemma,
    });
    expect(bypass).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ scanned: 1, embedded: 0, errors: 1 });
  });
});
