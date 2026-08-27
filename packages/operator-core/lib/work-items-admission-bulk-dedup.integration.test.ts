import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { runWorkItemAdmissionBulkDedup } = await import('./work-items-admission-bulk-dedup');

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
    updated_ts bigint,
    embedding vector(3),
    embedding_mode text,
    admission text,
    admitted_at timestamptz,
    admitted_by text,
    see_also text[],
    terminal_reason text,
    terminal_owner text,
    closed_ts bigint,
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
  CREATE TABLE harness_shared.work_item_occurrences (
    occurrence_id bigserial PRIMARY KEY,
    workspace_id text NOT NULL,
    canonical_harness_slug text NOT NULL,
    canonical_work_item_id text NOT NULL,
    reporter text,
    source_tool text NOT NULL,
    report_kind text NOT NULL,
    reported_title text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    admission_identity jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
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
  db = await createFreshPgDb('work-items-admission-bulk-dedup');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.scout_routed_ideas,
    harness_shared.work_item_occurrences,
    harness_shared.dedup_edges, harness_shared.dedup_adjudications,
    harness_shared.admission_runs, harness_shared.dedup_shard_map`;
});

async function seed(): Promise<void> {
  const rows = [
    { id: 'a', title: 'Clone failure', condition: 'watch:clone', created: 1, vec: '[1,0,0]' },
    { id: 'b', title: 'Clone failure again', condition: 'watch:clone', created: 2, vec: '[0.999,0.04,0]' },
    { id: 'c', title: 'Unrelated', condition: 'watch:other', created: 3, vec: '[0,1,0]' },
  ];
  for (const row of rows) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, ${row.id}, ${row.title}, ${`${row.title} summary`}, 'open', NULL, '{}'::jsonb,
              'change', ${row.condition}, ${row.created}, ${row.created}, ${row.vec}::vector, 'gemma',
              'admitted', now(), 'test')`;
  }
}

describe('runWorkItemAdmissionBulkDedup (real Postgres)', () => {
  it('judges the pinned targeted shard, merges the clone, and records converged stage evidence', async () => {
    await seed();
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-success',
      sql: db.sql,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async (input) => {
        expect(input.system).toContain('DUPLICATION ONLY');
        expect(input.messages[0]?.content).toContain('READ-ONLY GHOST CONTEXT');
        return {
          text: '',
          json: {
            judgements: [{ pairKey: 'a::b', verdict: 'r-finding-merge', reason: 'same failure and remedy' }],
          },
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    });

    expect(result.scope).toBe('machine-emitter-targeted');
    expect(result.converged).toBe(true);
    expect(result.initialCensus).toBe(1);
    expect(result.finalCensus).toBe(0);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ pairs: 1, merged: 1, censusBefore: 1, censusAfter: 0 });

    const items = await db.sql<Array<{ feature_id: string; status: string; canonical: string | null }>>`
      SELECT feature_id, status, payload #>> '{admissionMerge,canonicalId}' AS canonical
        FROM harness_shared.work_items ORDER BY feature_id`;
    expect(items).toEqual([
      { feature_id: 'a', status: 'open', canonical: null },
      { feature_id: 'b', status: 'dropped', canonical: 'a' },
      { feature_id: 'c', status: 'open', canonical: null },
    ]);
    const ledger = await db.sql<Array<{ state: string; before: number; after: number }>>`
      SELECT detail->>'status' AS state, census_before AS before, census_after AS after
        FROM harness_shared.admission_runs WHERE id = 'bulk-success-stage-1'`;
    expect(ledger).toEqual([{ state: 'complete', before: 1, after: 0 }]);
  }, 60_000);

  it('includes durable parks but mutates only an exact duplicate, preserving park and occurrence provenance', async () => {
    await seed();
    const mergedPark = {
      _claimHold: true,
      claim_hold_by: 'su-parked-duplicate',
      claim_hold_at: '2026-08-26T12:00:00.000Z',
      claim_hold_reason: 'awaiting deterministic reconciliation',
    };
    const distinctPark = {
      _claimHold: true,
      claim_hold_by: 'su-parked-distinct',
      claim_hold_at: '2026-08-26T13:00:00.000Z',
      claim_hold_reason: 'operator decision: preserve independently',
    };
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = ${JSON.stringify(mergedPark)}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'b'`;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, 'd', 'Unrelated follow-up', 'A separate failure and remedy',
              'open', NULL, ${JSON.stringify(distinctPark)}::text::jsonb, 'change', 'watch:other', 4, 4,
              '[0,0.999,0.04]'::vector, 'gemma', 'admitted', now(), 'test')`;

    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-parks',
      sql: db.sql,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async (input) => {
        expect(input.system).toContain('DUPLICATION ONLY');
        expect(input.messages[0]?.content).toContain('a::b');
        expect(input.messages[0]?.content).toContain('c::d');
        return {
          text: '',
          json: {
            judgements: [
              { pairKey: 'a::b', verdict: 'r-finding-merge', reason: 'same failure and remedy' },
              { pairKey: 'c::d', verdict: 'distinct', reason: 'different failure and remedy' },
            ],
          },
          inputTokens: 100,
          outputTokens: 30,
        };
      },
    });

    expect(result).toMatchObject({
      scope: 'machine-emitter-targeted',
      converged: true,
      initialCensus: 2,
      finalCensus: 0,
    });

    const parked = await db.sql<
      Array<{
        feature_id: string;
        status: string;
        payload: Record<string, unknown>;
        terminal_owner: string | null;
      }>
    >`
      SELECT feature_id, status, payload, terminal_owner
        FROM harness_shared.work_items
       WHERE feature_id = ANY(ARRAY['b', 'd']::text[])
       ORDER BY feature_id`;
    expect(parked[0]).toMatchObject({
      feature_id: 'b',
      status: 'dropped',
      terminal_owner: 'system:work-item-admission-bulk-dedup',
      payload: {
        ...mergedPark,
        admissionMerge: {
          canonicalId: 'a',
          runId: 'bulk-parks-stage-1',
          actor: 'system:work-item-admission-bulk-dedup',
        },
      },
    });
    expect(parked[1]).toEqual({
      feature_id: 'd',
      status: 'open',
      payload: distinctPark,
      terminal_owner: null,
    });

    const occurrences = await db.sql<
      Array<{ canonical: string; kind: string; evidence: Record<string, unknown> }>
    >`
      SELECT canonical_work_item_id AS canonical,
             report_kind AS kind,
             evidence
        FROM harness_shared.work_item_occurrences
       ORDER BY occurrence_id`;
    expect(occurrences).toEqual([
      {
        canonical: 'a',
        kind: 'duplicate',
        evidence: {
          mergedFrom: 'b',
          summary: 'Clone failure again summary',
          runId: 'bulk-parks-stage-1',
          disposition: 'r-finding-merge',
        },
      },
    ]);

    const adjudications = await db.sql<Array<{ a: string; b: string; verdict: string; canonical: string | null }>>`
      SELECT a, b, verdict, canonical
        FROM harness_shared.dedup_adjudications
       ORDER BY a, b`;
    expect(adjudications).toEqual([
      { a: 'a', b: 'b', verdict: 'r-finding-merge', canonical: 'a' },
      { a: 'c', b: 'd', verdict: 'distinct', canonical: null },
    ]);
  }, 60_000);

  it('rolls back the complete stage and marks it failed when an injected post-judgement census rises', async () => {
    await seed();
    await expect(
      runWorkItemAdmissionBulkDedup({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'bulk-rise',
        sql: db.sql,
        census: { chunkCount: 2, targetTokens: 1_000 },
        llmCall: async () => ({
          text: '',
          json: { judgements: [{ pairKey: 'a::b', verdict: 'distinct', reason: 'different remedy' }] },
          inputTokens: 50,
          outputTokens: 10,
        }),
        beforePostStageCensus: async (sql) => {
          await sql`UPDATE harness_shared.work_items SET embedding = '[1,0,0]'::vector WHERE feature_id = 'c'`;
        },
      }),
    ).rejects.toThrow(/admission census ratchet violated: 1 -> 2/);

    expect(
      await db.sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM harness_shared.dedup_adjudications`,
    ).toEqual([{ count: 0 }]);
    expect(
      await db.sql<Array<{ embedding: string }>>`
        SELECT embedding::text AS embedding FROM harness_shared.work_items WHERE feature_id = 'c'`,
    ).toEqual([{ embedding: '[0,1,0]' }]);
    const stage = await db.sql<Array<{ state: string; error: string }>>`
      SELECT detail->>'status' AS state, detail->>'error' AS error
        FROM harness_shared.admission_runs WHERE id = 'bulk-rise-stage-1'`;
    expect(stage[0]?.state).toBe('failed');
    expect(stage[0]?.error).toMatch(/ratchet violated/);
  }, 60_000);

  it('persists a nested transport Error.cause alongside the compatible error message', async () => {
    await seed();
    const nested = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect failed'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
        cause: { code: 'ETIMEDOUT', message: 'connect timed out' },
      }),
    });
    await expect(
      runWorkItemAdmissionBulkDedup({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'bulk-cause',
        sql: db.sql,
        census: { chunkCount: 2, targetTokens: 1_000 },
        llmCall: async () => {
          throw nested;
        },
      }),
    ).rejects.toThrow('fetch failed');

    const stage = await db.sql<Array<{ detail: { status: string; error: string; errorCause: Record<string, unknown> } }>>`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'bulk-cause-stage-1'`;
    expect(stage[0]?.detail).toMatchObject({
      status: 'failed',
      error: 'fetch failed',
      errorCause: {
        name: 'Error',
        message: 'connect failed',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        cause: { code: 'ETIMEDOUT', message: 'connect timed out' },
      },
    });
  }, 60_000);

  it('judges independent shards concurrently while keeping each shard internally ordered', async () => {
    await seed();
    await db.sql`
      UPDATE harness_shared.work_items
         SET summary = repeat(feature_id, 180)
       WHERE feature_id = ANY(ARRAY['a', 'b', 'c']::text[])`;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, 'd', 'Unrelated sibling', ${'d'.repeat(180)}, 'open', NULL, '{}'::jsonb,
              'change', 'watch:other', 4, 4, '[0,0.999,0.04]'::vector, 'gemma',
              'admitted', now(), 'test')`;

    let active = 0;
    let maxActive = 0;
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-concurrent-shards',
      sql: db.sql,
      shardConcurrency: 2,
      census: { chunkCount: 2, targetTokens: 110 },
      llmCall: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        const keys = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)].map((match) => match[1]!);
        return {
          text: '',
          json: {
            judgements: keys.map((pairKey) => ({ pairKey, verdict: 'distinct', reason: 'separate finding' })),
          },
          inputTokens: 25,
          outputTokens: 10,
        };
      },
    });

    expect(maxActive).toBe(2);
    expect(result.stages[0]).toMatchObject({ pairs: 2, modelCalls: 2, censusBefore: 2, censusAfter: 0 });
  }, 60_000);
});
