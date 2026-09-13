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
    embedding_profile text,
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

    const runs = await db.sql<Array<{ id: string; status: string; members: number; unit: string; attempted: number; successful: number }>>`
      SELECT id, detail->>'status' AS status,
             (detail #>> '{coverageAssertion,memberRows}')::int AS members,
             detail #>> '{outcome,unit}' AS unit,
             (detail #>> '{outcome,attempted}')::int AS attempted,
             (detail #>> '{outcome,successful}')::int AS successful
        FROM harness_shared.admission_runs ORDER BY id`;
    expect(runs).toEqual([
      { id: 'census-1', status: 'complete', members: 4, unit: 'snapshots', attempted: 1, successful: 1 },
      { id: 'census-2', status: 'complete', members: 4, unit: 'snapshots', attempted: 1, successful: 1 },
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

  it('pins corpus membership and reads canonical edges even when eligibility and edge provenance change between chunks', async () => {
    await seed();
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION mutate_admission_census_eligibility()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE harness_shared.work_items
           SET status = 'done'
         WHERE workspace_id = '${WS}'
           AND harness_slug = '${HARNESS}'
           AND feature_id = 'c'
           AND status = 'open';
        RETURN NULL;
      END;
      $$;
      CREATE OR REPLACE FUNCTION rewrite_admission_census_provenance()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.a = 'a' AND NEW.b = 'b' THEN
          NEW.run_id := 'create-prescreen';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER admission_census_eligibility_mutation
        AFTER INSERT OR UPDATE ON harness_shared.dedup_edges
        FOR EACH STATEMENT EXECUTE FUNCTION mutate_admission_census_eligibility();
      CREATE TRIGGER admission_census_provenance_mutation
        BEFORE INSERT OR UPDATE ON harness_shared.dedup_edges
        FOR EACH ROW EXECUTE FUNCTION rewrite_admission_census_provenance();
    `);

    let first: Awaited<ReturnType<typeof runWorkItemAdmissionCensus>>;
    try {
      first = await runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'mutating-corpus-1',
        chunkCount: 2,
        targetTokens: 100,
        ghostFraction: 0.5,
        sql: db.sql,
        now: () => 3_000,
      });
    } finally {
      await db.sql.unsafe(`
        DROP TRIGGER IF EXISTS admission_census_eligibility_mutation ON harness_shared.dedup_edges;
        DROP TRIGGER IF EXISTS admission_census_provenance_mutation ON harness_shared.dedup_edges;
        DROP FUNCTION IF EXISTS mutate_admission_census_eligibility();
        DROP FUNCTION IF EXISTS rewrite_admission_census_provenance();
      `);
    }

    expect(first.corpusSize).toBe(4);
    expect(first.embeddedItems).toBe(3);
    expect(first.chunkCoverage.reduce((sum, n) => sum + n, 0)).toBe(3);
    expect(first.memberRows).toBe(4);
    expect(
      await db.sql<Array<{ status: string }>>`
        SELECT status FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`,
    ).toEqual([{ status: 'done' }]);
    expect(
      await db.sql<Array<{ run_id: string }>>`
        SELECT run_id FROM harness_shared.dedup_edges
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND a = 'a' AND b = 'b'`,
    ).toEqual([{ run_id: 'create-prescreen' }]);

    await db.sql`
      UPDATE harness_shared.work_items SET status = 'open'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`;
    const second = await runWorkItemAdmissionCensus({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'mutating-corpus-2',
      chunkCount: 2,
      targetTokens: 100,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => 4_000,
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.memberRows).toBe(first.memberRows);
    expect(second.hardEdges).toBe(first.hardEdges);
  }, 60_000);

  /**
   * F1 (WI-2140406 / EI-22068819110487948) — lexical hard edges.
   *
   * Measured blindness this guards against: with cosine as the only corpus-wide
   * candidate generator, an identical-title pair that is EMBEDDED but lands
   * cos < 0.85 (divergent summaries) gets no edge from ANY leg, and text-context
   * edges never enter the unadjudicated set, so the merge projection reports a
   * dup-twin corpus as empty (1,826 open twin pairs, 0 edges, 2026-09-01).
   */
  it('forms lexical hard edges for identity twins regardless of embedding state and counts them in the projection', async () => {
    const rows = [
      // (a) embedded twins, orthogonal vectors: cos = 0 — invisible to every leg today
      { id: 'e1', title: 'Dup twin', vec: '[1,0,0]', mode: 'gemma', condition: null },
      { id: 'e2', title: 'Dup twin', vec: '[0,1,0]', mode: 'gemma', condition: null },
      // (b) unembedded twins: text leg glues the plan, but the projection never sees them
      { id: 'u1', title: 'Ghost twin', vec: null, mode: null, condition: null },
      { id: 'u2', title: 'Ghost twin', vec: null, mode: null, condition: null },
      // (c) same recurring-detector condition, different titles
      { id: 'k1', title: 'Watcher red', vec: '[0,0,1]', mode: 'gemma', condition: 'watch:same' },
      { id: 'k2', title: 'Watcher blue', vec: '[-1,0,0]', mode: 'gemma', condition: 'watch:same' },
    ];
    for (const row of rows) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
           condition_key, created_ts, embedding, embedding_mode)
        VALUES (${WS}, ${HARNESS}, ${row.id}, ${row.title}, '', 'open', NULL, '{}'::jsonb,
                ${row.condition}, 1, ${row.vec}::vector, ${row.mode})`;
    }
    // An already-adjudicated lexical pair must stay out of the unadjudicated set.
    await db.sql`
      INSERT INTO harness_shared.dedup_adjudications
        (workspace_id, harness_slug, a, b, verdict, judged_by, run_id)
      VALUES (${WS}, ${HARNESS}, 'u1', 'u2', 'distinct', 'seed', 'pre-adjudicated')`;

    const result = await runWorkItemAdmissionCensus({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'lexical-1',
      chunkCount: 2,
      targetTokens: 6,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => 5_000,
    });

    // All three identity twins produce a hard lexical edge; the adjudicated one
    // is excluded from the unadjudicated companion count.
    expect(result.lexicalEdges).toBe(3);
    expect(result.lexicalUnadjudicated).toBe(2);

    // Each twin pair is glued into one hard component => co-resident members.
    // targetTokens=6 forces one component per shard, so co-residency here is
    // component cohesion, not incidental packing.
    const shardOf = (id: string) =>
      result.shards.find((shard) => shard.members.includes(id))?.shardId ?? `missing:${id}`;
    expect(shardOf('e1')).toBe(shardOf('e2'));
    expect(shardOf('u1')).toBe(shardOf('u2'));
    expect(shardOf('k1')).toBe(shardOf('k2'));

    // The merge projection finally sees the lexical dup mass.
    expect(result.projection.byPairClass).toEqual({
      'agent-filed × agent-filed': 1,
      'machine-emitter × machine-emitter': 1,
    });
    expect(result.projection.outsideMachineEmitterPairs).toBe(1);
    expect(result.projection.componentCollapseUpperBound).toEqual({
      'agent-filed': 1,
      'machine-emitter': 1,
    });

    // The ledger carries the companion lexical counts.
    const detail = await db.sql<Array<{ lex: number; lexu: number }>>`
      SELECT (detail #>> '{edges,lexicalHard}')::int AS lex,
             (detail #>> '{edges,lexicalUnadjudicated}')::int AS lexu
        FROM harness_shared.admission_runs WHERE id = 'lexical-1'`;
    expect(detail).toEqual([{ lex: 3, lexu: 2 }]);
  }, 60_000);

  it('records a failed run instead of laundering an identity-unknown vector into a clean census', async () => {
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
    ).rejects.toThrow(/compatible embedding_profile/);

    const rows = await db.sql<Array<{ status: string; error: string; unit: string; failure: string }>>`
      SELECT detail->>'status' AS status, detail->>'error' AS error,
             detail #>> '{outcome,unit}' AS unit,
             detail #>> '{outcome,failureReason}' AS failure
        FROM harness_shared.admission_runs WHERE id = 'mixed-mode'`;
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toMatch(/compatible embedding_profile/);
    expect(rows[0]?.unit).toBe('snapshots');
    expect(rows[0]?.failure).toMatch(/compatible embedding_profile/);
  }, 60_000);
  });

  it('rejects equal-mode vectors carrying two different exact accepted profiles', async () => {
    await seed();
    await db.sql`
      UPDATE harness_shared.work_items
         SET embedding_profile = CASE feature_id
           WHEN 'c' THEN 'openai-text-embedding-3-small-768@v1'
           ELSE 'gemma-embeddinggemma-300m-768@v1'
         END
       WHERE embedding IS NOT NULL AND lane IS DISTINCT FROM 'observation' AND status = 'open'`;

    await expect(
      runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'census-mixed-exact-profiles',
        sql: db.sql,
      }),
    ).rejects.toThrow(/mixed embedding profiles/);
  });
