/**
 * rubrics.integration.test.ts — the rubrics store end-to-end against REAL Postgres
 * (rubric-driven-observations-2026-06-20 P-002 / brief B2). Drives rubrics.ts over
 * migration 326 with getOrgPg pointed at a throwaway DB.
 *
 * Proves what a mock-SQL unit test can't:
 *  • the migration 326 DDL applies (generated tsvector _search column, status CHECK,
 *    jsonb-is-array CHECKs, GIN/btree indexes);
 *  • propose → proposed; ratify → active (+ ratified_by); the seed path (status:'active')
 *    is an idempotent upsert (re-propose updates content, never duplicates);
 *  • criteria + rating_scale jsonb round-trip (incl. a per-criterion ratingScale override);
 *  • list orders active-first and filters by status/characteristic; get returns full
 *    criteria; search hits the real FTS (_search @@ websearch_to_tsquery);
 *  • the status CHECK constraint rejects a bad status at the PG level.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

// Strip psql metacommands (\set), GRANTs (no framework roles in the throwaway DB),
// and explicit txn markers (the pooled test client rejects them).
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const rubrics = await import('./rubrics');

let db: FreshPgDb;

const sampleCriteria = [
  {
    key: 'placement-health',
    title: 'Placement health',
    model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
    method: 'Count ready work_items with no claim older than the cadence; check fleet:assignments load balance.',
    driftMarkers: 'A growing backlog of ready-but-unplaced items; bees idle while the frontier is non-empty.',
  },
  {
    key: 'ideation-diversity',
    title: 'Ideation diversity',
    model: 'Scout lens weights drift away from uniform as grades steer ideation.',
    method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'], // per-criterion override
    driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
  },
];

beforeAll(async () => {
  db = await createFreshPgDb('rubrics');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('326-rubrics-store.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.rubrics`;
});

describe('migration 326 — rubrics table DDL', () => {
  it('applies: table, generated _search column, and the status CHECK exist', async () => {
    const cols = await db.sql<{ column_name: string; is_generated: string }[]>`
      SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'rubrics'`;
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual(expect.arrayContaining(['rubric_id', 'characteristic', 'criteria', 'rating_scale', 'status', '_search']));
    expect(cols.find((c) => c.column_name === '_search')?.is_generated).toBe('ALWAYS');
  });

  it('the status CHECK rejects an invalid status at the PG level', async () => {
    await expect(
      db.sql`INSERT INTO harness_shared.rubrics (rubric_id, title, status)
             VALUES ('bad', 'bad', 'bogus')`,
    ).rejects.toThrow(/rubrics_status_chk|check constraint/i);
  });
});

describe('propose / ratify lifecycle', () => {
  it('propose creates a proposed rubric with criteria + default rating scale', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'hive-coordination-health',
      characteristic: 'hive-coordination',
      title: 'Hive coordination health',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: sampleCriteria,
      methodRef: 'hive-coordination-health-runbook',
      by: 'su-test',
    });
    expect(r.status).toBe('proposed');
    expect(r.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0].key).toBe('placement-health');
    expect(r.criteria[1].ratingScale).toContain('n/a'); // per-criterion override round-trips
    expect(r.proposedBy).toBe('su-test');
    expect(r.ratifiedBy).toBeNull();
    expect(r.methodRef).toBe('hive-coordination-health-runbook');
  });

  it('ratify flips proposed → active and records ratified_by', async () => {
    await rubrics.proposeRubric({ rubricId: 'x', characteristic: 'c', title: 'X', criteria: sampleCriteria, by: 'a' });
    const active = await rubrics.ratifyRubric('x', 'queen-1');
    expect(active?.status).toBe('active');
    expect(active?.ratifiedBy).toBe('queen-1');
  });

  it('ratify of an unknown rubric returns null', async () => {
    expect(await rubrics.ratifyRubric('nope', 'q')).toBeNull();
  });

  it('the seed path (status:active) upserts idempotently — re-propose updates content, no duplicate', async () => {
    await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v1', criteria: sampleCriteria, status: 'active', by: 'seed' });
    const r2 = await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v2', criteria: sampleCriteria, status: 'active', by: 'seed' });
    expect(r2.title).toBe('v2');
    expect(r2.status).toBe('active');
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'seed')).toHaveLength(1); // ON CONFLICT, not a second row
  });
});

describe('list / get / search reads', () => {
  beforeEach(async () => {
    await rubrics.proposeRubric({ rubricId: 'active-a', characteristic: 'hive-coordination', title: 'Active A', criteria: sampleCriteria, status: 'active', by: 's' });
    await rubrics.proposeRubric({ rubricId: 'proposed-b', characteristic: 'memory-recall', title: 'Proposed B', criteria: sampleCriteria, by: 's' });
  });

  it('list orders active-first, then proposed', async () => {
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId)).toEqual(['active-a', 'proposed-b']);
  });

  it('list filters by status and by characteristic', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-a']);
    expect((await rubrics.listRubrics({ characteristic: 'memory-recall' })).map((r) => r.rubricId)).toEqual(['proposed-b']);
  });

  it('get returns the full criteria; unknown id → null', async () => {
    const got = await rubrics.getRubric('active-a');
    expect(got?.criteria).toHaveLength(2);
    expect(got?.criteria[0].model).toContain('Queen places');
    expect(await rubrics.getRubric('missing')).toBeNull();
  });

  it('search hits the real FTS over title / characteristic, and misses cleanly', async () => {
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('active-a');
    expect((await rubrics.searchRubrics('memory')).map((r) => r.rubricId)).toContain('proposed-b');
    expect(await rubrics.searchRubrics('zzzznotarubric')).toEqual([]);
  });
});
