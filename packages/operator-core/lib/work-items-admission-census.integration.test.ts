import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { runWorkItemAdmissionCensus } = await import('./work-items-admission-census');

const WS = 'default';
const HARNESS = 'h1';
let db: FreshPgDb;

const DDL = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text,
    lane text,
    payload jsonb,
    item_kind text NOT NULL DEFAULT 'task',
    origin text NOT NULL DEFAULT 'local',
    condition_key text,
    created_ts bigint,
    embedding vector(3),
    embedding_mode text,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  CREATE TABLE harness_shared.scout_routed_ideas (
    idea_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    routed_ref text NOT NULL,
    origin text NOT NULL,
    routed_at bigint NOT NULL
  );
  CREATE TABLE harness_shared.dedup_edges (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    cos real NOT NULL,
    trgm real,
    run_id text NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.dedup_adjudications (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    verdict text NOT NULL,
    canonical text,
    judged_by text NOT NULL,
    run_id text NOT NULL,
    judged_at timestamptz NOT NULL DEFAULT now(),
    evidence jsonb,
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.admission_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    run_kind text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    batch_size integer,
    promoted integer,
    merged integer,
    held integer,
    auto_promoted_unreviewed integer,
    census_before integer,
    census_after integer,
    model_id text,
    tokens_in bigint,
    tokens_out bigint,
    latency_ms integer,
    detail jsonb
  );
  CREATE TABLE harness_shared.dedup_shard_map (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    shard_id integer NOT NULL,
    item_id text NOT NULL,
    role text NOT NULL,
    PRIMARY KEY (run_id, shard_id, item_id, role)
  );
  CREATE UNIQUE INDEX dedup_shard_map_one_member_uq
    ON harness_shared.dedup_shard_map (run_id, item_id) WHERE role = 'member';
`;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission-census');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.scout_routed_ideas,
    harness_shared.dedup_edges, harness_shared.dedup_adjudications,
    harness_shared.admission_runs, harness_shared.dedup_shard_map`;
});

async function seed(): Promise<void> {
  const rows = [
    {
      id: 'a',
      title: 'Alpha',
      status: 'open',
      lane: null,
      payload: { admissionIdentity: { titleKey: 'alpha' } },
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: 'watch:a',
    },
    {
      id: 'b',
      title: 'Alpha sibling',
      status: 'open',
      lane: null,
      payload: {},
      vec: '[0.999,0.04,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'c',
      title: 'Context neighbour',
      status: 'open',
      lane: null,
      payload: {},
      vec: '[0.87,0.493,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'd',
      title: 'Alpha',
      status: 'open',
      lane: null,
      payload: { admissionIdentity: { titleKey: 'alpha' } },
      vec: null,
      mode: null,
      condition: null,
    },
    {
      id: 'obs',
      title: 'Observation',
      status: 'open',
      lane: 'observation',
      payload: {},
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'done',
      title: 'Terminal',
      status: 'done',
      lane: null,
      payload: {},
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: null,
    },
  ];
  for (const row of rows) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         condition_key, created_ts, embedding, embedding_mode)
      VALUES (${WS}, ${HARNESS}, ${row.id}, ${row.title}, '', ${row.status}, ${row.lane},
              ${JSON.stringify(row.payload)}::text::jsonb, ${row.condition}, 1,
              ${row.vec}::vector, ${row.mode})`;
  }
  await db.sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, routed_ref, origin, routed_at)
    VALUES ('idea-c', ${WS}, ${HARNESS}, 'c', 'scout', 1)`;
}

describe('runWorkItemAdmissionCensus (real Postgres)', () => {
  it('writes reproducible census runs and exact member coverage, including text-only context', async () => {
    await seed();
    let tick = 1_000;
    const common = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      chunkCount: 2,
      targetTokens: 100,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => tick++,
    };
    const first = await runWorkItemAdmissionCensus({ ...common, runId: 'census-1' });
    const second = await runWorkItemAdmissionCensus({ ...common, runId: 'census-2' });

    expect(first.corpusSize).toBe(4);
    expect(first.memberRows).toBe(4);
    expect(first.embeddedItems).toBe(3);
    expect(first.missingEmbeddingItems).toBe(1);
    expect(first.hardEdges).toBeGreaterThanOrEqual(1);
    expect(first.textContextEdges).toBeGreaterThanOrEqual(1);
    expect(first.censusAfter).toBeGreaterThanOrEqual(1);
    expect(first.chunkCoverage.reduce((sum, n) => sum + n, 0)).toBe(3);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.censusBefore).toBe(first.censusAfter);

    const runs = await db.sql<Array<{ id: string; status: string; members: number }>>`
      SELECT id, detail->>'status' AS status,
             (detail #>> '{coverageAssertion,memberRows}')::int AS members
        FROM harness_shared.admission_runs ORDER BY id`;
    expect(runs).toEqual([
      { id: 'census-1', status: 'complete', members: 4 },
      { id: 'census-2', status: 'complete', members: 4 },
    ]);

    const coverage = await db.sql<Array<{ run_id: string; members: number; unique_members: number }>>`
      SELECT run_id,
             count(*) FILTER (WHERE role = 'member')::int AS members,
             count(DISTINCT item_id) FILTER (WHERE role = 'member')::int AS unique_members
        FROM harness_shared.dedup_shard_map
       GROUP BY run_id ORDER BY run_id`;
    expect(coverage).toEqual([
      { run_id: 'census-1', members: 4, unique_members: 4 },
      { run_id: 'census-2', members: 4, unique_members: 4 },
    ]);
  }, 60_000);

  it('records a failed run instead of laundering mixed embedding spaces into a clean census', async () => {
    await seed();
    await db.sql`UPDATE harness_shared.work_items SET embedding_mode = 'foreign' WHERE feature_id = 'c'`;

    await expect(
      runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'mixed-mode',
        sql: db.sql,
        now: () => 2_000,
      }),
    ).rejects.toThrow(/mixed embedding modes/);

    const rows = await db.sql<Array<{ status: string; error: string }>>`
      SELECT detail->>'status' AS status, detail->>'error' AS error
        FROM harness_shared.admission_runs WHERE id = 'mixed-mode'`;
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toMatch(/mixed embedding modes/);
  }, 60_000);
});
