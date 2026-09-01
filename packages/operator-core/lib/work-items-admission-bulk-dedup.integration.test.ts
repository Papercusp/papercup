import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { runWorkItemAdmissionBulkDedup } = await import('./work-items-admission-bulk-dedup');
const { LEARNING_MODEL_SPEC } = await import('./learning/model-policy');

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
          servedAccount: 'pool-account-a',
        };
      },
    });

    expect(result.scope).toBe('machine-emitter-targeted');
    expect(result.converged).toBe(true);
    expect(result.initialCensus).toBe(1);
    expect(result.finalCensus).toBe(0);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({
      pairs: 1,
      merged: 1,
      censusBefore: 1,
      censusAfter: 0,
      servedAccounts: ['pool-account-a'],
    });

    const items = await db.sql<Array<{ feature_id: string; status: string; canonical: string | null }>>`
      SELECT feature_id, status, payload #>> '{admissionMerge,canonicalId}' AS canonical
        FROM harness_shared.work_items ORDER BY feature_id`;
    expect(items).toEqual([
      { feature_id: 'a', status: 'open', canonical: null },
      { feature_id: 'b', status: 'dropped', canonical: 'a' },
      { feature_id: 'c', status: 'open', canonical: null },
    ]);
    const ledger = await db.sql<
      Array<{
        state: string;
        before: number;
        after: number;
        unit: string;
        attempted: number;
        successful: number;
        unchanged: number;
        rows_changed: number;
        served_accounts: string[];
        canary_account: string;
      }>
    >`
      SELECT detail->>'status' AS state, census_before AS before, census_after AS after,
             detail #>> '{outcome,unit}' AS unit,
             (detail #>> '{outcome,attempted}')::int AS attempted,
             (detail #>> '{outcome,successful}')::int AS successful,
             (detail #>> '{outcome,unchanged}')::int AS unchanged,
             (detail #>> '{outcome,uniqueRowsChanged}')::int AS rows_changed,
             ARRAY(SELECT jsonb_array_elements_text(detail->'servedAccounts')) AS served_accounts,
             detail #>> '{canary,servedAccount}' AS canary_account
        FROM harness_shared.admission_runs WHERE id = 'bulk-success-stage-1'`;
    expect(ledger).toEqual([
      {
        state: 'complete',
        before: 1,
        after: 0,
        unit: 'pairs',
        attempted: 1,
        successful: 1,
        unchanged: 0,
        rows_changed: 1,
        served_accounts: ['pool-account-a'],
        canary_account: 'pool-account-a',
      },
    ]);
  }, 60_000);

  /**
   * ATTRIBUTABILITY — what census convergence does NOT prove.
   *
   * The test above merges a seeded duplicate and the census goes 1 -> 0, which
   * invites the reading "the census fell BECAUSE we merged". It did not.
   * `readUnadjudicatedCensus` counts hard `dedup_edges` with NO
   * `dedup_adjudications` row (work-items-admission-census.ts), and the
   * adjudication INSERT writes a row for EVERY judgement — only
   * `r-finding-merge` also merges (work-items-admission-promoter.ts: verdicts
   * are distinct | r-finding-merge | r-remedy-keep | r-related | hold). So
   * ADJUDICATING a pair retires it from the census just as completely as
   * merging it.
   *
   * This case is the paired control: the SAME seeded duplicate pair, judged
   * `r-related` instead. Census 1 -> 0 and converged:true, identical to the
   * merge case — with merged:0 and every item still standing. Run the two
   * together and the conclusion is forced: census convergence is a measure of
   * ADJUDICATION PROGRESS, and the only attributable merge-efficacy signals are
   * `merged` and the surviving items' `admissionMerge.canonicalId` pointers.
   *
   * This is why the d035-4 stage converged while merging ZERO of 1500 pairs
   * (verdicts={'r-related':1500}). That run was not a failure to converge; it
   * was convergence carrying no merge signal — and nothing in the census, the
   * ratchet, or the stage's `complete` status distinguishes the two.
   */
  it('converges identically on a judged-but-UNMERGED pair, so census fall attributes nothing to merging', async () => {
    await seed();
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-adjudicated-only',
      sql: db.sql,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async () => ({
        text: '',
        json: {
          judgements: [{ pairKey: 'a::b', verdict: 'r-related', reason: 'same subsystem, different finding' }],
        },
        inputTokens: 100,
        outputTokens: 20,
      }),
    });

    // Byte-for-byte the convergence signature of the merge case above…
    expect(result.converged).toBe(true);
    expect(result.initialCensus).toBe(1);
    expect(result.finalCensus).toBe(0);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ pairs: 1, censusBefore: 1, censusAfter: 0 });
    // …reached with NOTHING merged.
    expect(result.stages[0]?.merged).toBe(0);

    const items = await db.sql<Array<{ feature_id: string; status: string; canonical: string | null }>>`
      SELECT feature_id, status, payload #>> '{admissionMerge,canonicalId}' AS canonical
        FROM harness_shared.work_items ORDER BY feature_id`;
    expect(items).toEqual([
      { feature_id: 'a', status: 'open', canonical: null },
      { feature_id: 'b', status: 'open', canonical: null },
      { feature_id: 'c', status: 'open', canonical: null },
    ]);

    // The pair left the census by ADJUDICATION, which is the whole point.
    const adjudications = await db.sql<Array<{ a: string; b: string; verdict: string }>>`
      SELECT a, b, verdict FROM harness_shared.dedup_adjudications ORDER BY a, b`;
    expect(adjudications).toEqual([{ a: 'a', b: 'b', verdict: 'r-related' }]);

    const ledger = await db.sql<Array<{ state: string; before: number; after: number }>>`
      SELECT detail->>'status' AS state, census_before AS before, census_after AS after
        FROM harness_shared.admission_runs WHERE id = 'bulk-adjudicated-only-stage-1'`;
    expect(ledger).toEqual([{ state: 'complete', before: 1, after: 0 }]);
  }, 60_000);

  // The ledger's model_id used to be a hardcoded LEARNING_MODEL_SPEC literal
  // written regardless of which model the run actually called. That is a
  // second copy of a truth the run already owns, so it could only ever drift —
  // and it drifts exactly when a run is deliberately driven onto a different
  // backend, which is the one time the column is load-bearing evidence. These
  // two cases pin the identity from BOTH ends: what llmCall received, and what
  // landed in the column.
  it('defaults to the canonical learning model and records THAT model in the ledger', async () => {
    await seed();
    const seen: string[] = [];
    await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-model-default',
      sql: db.sql,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async (input) => {
        seen.push(input.model);
        return {
          text: '',
          json: { judgements: [{ pairKey: 'a::b', verdict: 'r-finding-merge', reason: 'same failure' }] },
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    });

    expect(seen).toEqual([LEARNING_MODEL_SPEC]);
    const ledger = await db.sql<Array<{ model_id: string | null }>>`
      SELECT model_id FROM harness_shared.admission_runs WHERE id = 'bulk-model-default-stage-1'`;
    expect(ledger).toEqual([{ model_id: LEARNING_MODEL_SPEC }]);
  }, 60_000);

  it('drives one run onto an override model and records the OVERRIDE, not the policy constant', async () => {
    await seed();
    const override = 'claude-opus-5:xhigh';
    // Guard the guard: an override equal to the default would make the
    // assertions below pass for the wrong reason.
    expect(override).not.toBe(LEARNING_MODEL_SPEC);
    const seen: string[] = [];
    await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-model-override',
      sql: db.sql,
      model: override,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async (input) => {
        seen.push(input.model);
        return {
          text: '',
          json: { judgements: [{ pairKey: 'a::b', verdict: 'r-finding-merge', reason: 'same failure' }] },
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    });

    expect(seen).toEqual([override]);
    const ledger = await db.sql<Array<{ model_id: string | null }>>`
      SELECT model_id FROM harness_shared.admission_runs WHERE id = 'bulk-model-override-stage-1'`;
    expect(ledger).toEqual([{ model_id: override }]);
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

    const occurrences = await db.sql<Array<{ canonical: string; kind: string; evidence: Record<string, unknown> }>>`
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
    const stage = await db.sql<Array<{ state: string; error: string; unit: string; failure: string }>>`
      SELECT detail->>'status' AS state, detail->>'error' AS error,
             detail #>> '{outcome,unit}' AS unit,
             detail #>> '{outcome,failureReason}' AS failure
        FROM harness_shared.admission_runs WHERE id = 'bulk-rise-stage-1'`;
    expect(stage[0]?.state).toBe('failed');
    expect(stage[0]?.error).toMatch(/ratchet violated/);
    expect(stage[0]?.unit).toBe('pairs');
    expect(stage[0]?.failure).toMatch(/ratchet violated/);
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

    const stage = await db.sql<
      Array<{ detail: { status: string; error: string; errorCause: Record<string, unknown> } }>
    >`
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

    await expect(
      runWorkItemAdmissionBulkDedup({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'bulk-cause',
        sql: db.sql,
        census: { chunkCount: 2, targetTokens: 1_000 },
        llmCall: async () => ({
          text: '',
          json: { judgements: [{ pairKey: 'not::supplied', verdict: 'distinct', reason: 'invalid cross-pair' }] },
          inputTokens: 50,
          outputTokens: 10,
        }),
      }),
    ).rejects.toThrow('bulk dedup made no scoped progress');

    const retried = await db.sql<Array<{ detail: Record<string, unknown>; has_error_cause: boolean }>>`
      SELECT detail, detail ? 'errorCause' AS has_error_cause
        FROM harness_shared.admission_runs WHERE id = 'bulk-cause-stage-1'`;
    expect(retried[0]?.detail).toMatchObject({
      status: 'failed',
      error: 'bulk dedup made no scoped progress: 1 -> 1 pair(s)',
    });
    expect(retried[0]?.has_error_cause).toBe(false);
  }, 60_000);

  it('contains an unlisted cross-pair to its batch and retries an omitted expected pair in the next stage', async () => {
    await seed();
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, 'd', 'Unrelated sibling', 'A separate failure and remedy',
              'open', NULL, '{}'::jsonb, 'change', 'watch:other', 4, 4,
              '[0,0.999,0.04]'::vector, 'gemma', 'admitted', now(), 'test')`;
    await db.sql`
      UPDATE harness_shared.work_items
         SET condition_key = NULL
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;

    const seenBatches: string[][] = [];
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-cross-pair',
      sql: db.sql,
      pairsPerCall: 1,
      shardConcurrency: 1,
      census: { chunkCount: 1, targetTokens: 1_000, fullCorpusPairThreshold: 0 },
      llmCall: async (input) => {
        const keys = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)].map((match) => match[1]!);
        seenBatches.push(keys);
        const pairKey = keys[0]!;
        return {
          text: '',
          json: {
            judgements:
              seenBatches.length === 1
                ? [{ pairKey: 'c::d', verdict: 'distinct', reason: 'authoritative but unlisted cross-pair' }]
                : [{ pairKey, verdict: 'distinct', reason: 'separate finding' }],
          },
          inputTokens: 50,
          outputTokens: 10,
        };
      },
    });

    expect(seenBatches).toEqual([['a::b'], ['c::d'], ['a::b']]);
    expect(result).toMatchObject({ converged: true, initialCensus: 2, finalCensus: 0 });
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]).toMatchObject({
      pairs: 2,
      ignoredUnknownJudgements: 1,
      omittedExpectedJudgements: 1,
      scopedPairsAfter: 1,
    });
    expect(result.stages[1]).toMatchObject({
      pairs: 1,
      ignoredUnknownJudgements: 0,
      omittedExpectedJudgements: 0,
      scopedPairsAfter: 0,
    });

    const firstStage = await db.sql<Array<{ protocol: Record<string, unknown> }>>`
      SELECT detail->'modelProtocol' AS protocol
        FROM harness_shared.admission_runs WHERE id = 'bulk-cross-pair-stage-1'`;
    expect(firstStage[0]?.protocol).toMatchObject({
      failures: 0,
      exhaustedBatches: 0,
      ignoredUnknownJudgements: 1,
      omittedExpectedJudgements: 1,
    });
  }, 60_000);

  it('retries a later transient socket failure without replaying an earlier judged batch', async () => {
    await seed();
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, 'd', 'Unrelated sibling', 'A separate failure and remedy',
              'open', NULL, '{}'::jsonb, 'change', 'watch:other', 4, 4,
              '[0,0.999,0.04]'::vector, 'gemma', 'admitted', now(), 'test')`;

    let calls = 0;
    const seenPairs: string[] = [];
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-transient-retry',
      sql: db.sql,
      pairsPerCall: 1,
      shardConcurrency: 1,
      batchRetryBackoffsMs: [1],
      batchRetryDelay: async () => undefined,
      census: { chunkCount: 1, targetTokens: 1_000 },
      llmCall: async (input) => {
        calls += 1;
        const pairKey = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)][0]?.[1];
        expect(pairKey).toBeTruthy();
        seenPairs.push(pairKey!);
        if (calls === 2) {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
        }
        return {
          text: '',
          json: {
            judgements: [
              {
                pairKey,
                verdict: pairKey === 'a::b' ? 'r-finding-merge' : 'distinct',
                reason: pairKey === 'a::b' ? 'same failure and remedy' : 'different failure and remedy',
              },
            ],
          },
          inputTokens: 50,
          outputTokens: 10,
        };
      },
    });

    expect(calls).toBe(3);
    expect(seenPairs).toEqual(['a::b', 'c::d', 'c::d']);
    expect(result).toMatchObject({ converged: true, initialCensus: 2, finalCensus: 0 });
    expect(result.stages[0]).toMatchObject({
      pairs: 2,
      modelCalls: 2,
      modelRetries: 1,
      censusBefore: 2,
      censusAfter: 0,
      scopedPairsAfter: 0,
    });

    const adjudications = await db.sql<Array<{ a: string; b: string }>>`
      SELECT a, b FROM harness_shared.dedup_adjudications ORDER BY a, b`;
    expect(adjudications).toEqual([
      { a: 'a', b: 'b' },
      { a: 'c', b: 'd' },
    ]);
    const stage = await db.sql<Array<{ state: string; retries: number }>>`
      SELECT detail->>'status' AS state, (detail->>'modelRetries')::int AS retries
        FROM harness_shared.admission_runs WHERE id = 'bulk-transient-retry-stage-1'`;
    expect(stage).toEqual([{ state: 'complete', retries: 1 }]);
  }, 60_000);

  it('returns the durable terminal result on a repeated root runId without another census or model call', async () => {
    await seed();
    let modelCalls = 0;
    const stepNames: string[] = [];
    const preflight = vi.fn(async () => ({
      status: 'ready' as const,
      provider: 'claude' as const,
      model: 'test-model',
      checkedAt: '2026-09-01T00:00:00.000Z',
      reason: 'integration capacity is injected',
    }));
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      stepNames.push(name);
      return fn();
    };
    const first = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-root-replay',
      sql: db.sql,
      executionId: 'executor-first',
      model: 'test-model',
      preflight,
      step,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async () => {
        modelCalls += 1;
        return {
          text: '',
          json: { judgements: [{ pairKey: 'a::b', verdict: 'r-finding-merge', reason: 'same failure' }] },
          inputTokens: 11,
          outputTokens: 7,
        };
      },
    });

    const callsBeforeReplay = modelCalls;
    const preflightCallsBeforeReplay = preflight.mock.calls.length;
    const replay = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-root-replay',
      sql: db.sql,
      executionId: 'executor-replay',
      model: 'test-model',
      preflight: async () => {
        throw new Error('terminal replay must not preflight');
      },
      step,
      census: { chunkCount: 2, targetTokens: 1_000 },
      llmCall: async () => {
        throw new Error('terminal replay must not call the model');
      },
    });

    expect(replay).toEqual(first);
    expect(modelCalls).toBe(callsBeforeReplay);
    expect(preflight.mock.calls.length).toBe(preflightCallsBeforeReplay);
    expect(stepNames).toEqual([
      'bulk:bulk-root-replay:census:0',
      'bulk:bulk-root-replay-stage-1:canary',
      'bulk:bulk-root-replay:census:0',
      'bulk:bulk-root-replay-stage-1:canary',
    ]);
    expect(
      await db.sql<Array<{ stages: number; stageRows: number }>>`
        SELECT 1::int AS stages,
               (SELECT count(*)::int FROM harness_shared.admission_runs WHERE id = 'bulk-root-replay-stage-1') AS "stageRows"`,
    ).toEqual([{ stages: 1, stageRows: 1 }]);
  }, 60_000);

  it('takes over an expired running stage and replays only the uncheckpointed shard batch', async () => {
    await seed();
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         item_kind, condition_key, created_ts, updated_ts, embedding, embedding_mode, admission,
         admitted_at, admitted_by)
      VALUES (${WS}, ${HARNESS}, 'd', 'Unrelated sibling', 'A separate failure and remedy',
              'open', NULL, '{}'::jsonb, 'change', 'watch:other', 4, 4,
              '[0,0.999,0.04]'::vector, 'gemma', 'admitted', now(), 'test')`;
    await db.sql`
      UPDATE harness_shared.work_items
         SET condition_key = NULL
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;

    let modelCalls = 0;
    const seenPairs: string[] = [];
    const ready = {
      status: 'ready' as const,
      provider: 'claude' as const,
      model: 'test-model',
      checkedAt: '2026-09-01T00:00:00.000Z',
      reason: 'integration capacity is injected',
    };
    const firstStepNames: string[] = [];
    const firstStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      firstStepNames.push(name);
      return fn();
    };
    await expect(
      runWorkItemAdmissionBulkDedup({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'bulk-stale-takeover',
        sql: db.sql,
        executionId: 'executor-dead',
        model: 'test-model',
        stageLeaseMs: 1_000,
        now: () => 10_000,
        preflight: async () => ready,
        step: firstStep,
        pairsPerCall: 1,
        shardConcurrency: 1,
        batchRetryBackoffsMs: [],
        census: { chunkCount: 1, targetTokens: 1_000, fullCorpusPairThreshold: 0 },
        llmCall: async (input) => {
          modelCalls += 1;
          const pairKey = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)][0]?.[1];
          expect(pairKey).toBeTruthy();
          seenPairs.push(pairKey!);
          if (modelCalls === 2) throw new Error('executor died after first checkpoint');
          return {
            text: '',
            json: { judgements: [{ pairKey, verdict: 'distinct', reason: 'separate finding' }] },
            inputTokens: 13,
            outputTokens: 5,
          };
        },
      }),
    ).rejects.toThrow('executor died after first checkpoint');

    const failed = await db.sql<Array<{ detail: Record<string, unknown> }>>`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'bulk-stale-takeover-stage-1'`;
    expect(failed[0]?.detail).toMatchObject({
      status: 'failed',
      checkpoints: { batches: expect.any(Object) },
    });
    const oldLease = {
      ownerId: 'executor-dead',
      acquiredAt: 1,
      heartbeatAt: 1,
      expiresAt: 1,
      takeoverCount: 0,
    };
    // Simulate a process death after the first durable batch checkpoint. The
    // lease is deliberately expired, while the checkpoint map remains intact.
    await db.sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = NULL,
             detail = detail || ${JSON.stringify({ status: 'running', lease: oldLease })}::text::jsonb
       WHERE id = 'bulk-stale-takeover-stage-1'`;

    const resumedStepNames: string[] = [];
    const resumed = await runWorkItemAdmissionBulkDedup({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'bulk-stale-takeover',
      sql: db.sql,
      executionId: 'executor-replacement',
      model: 'test-model',
      stageLeaseMs: 1_000,
      now: () => 20_000,
      preflight: async () => ready,
      step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        resumedStepNames.push(name);
        return fn();
      },
      pairsPerCall: 1,
      shardConcurrency: 1,
      batchRetryBackoffsMs: [],
      census: { chunkCount: 1, targetTokens: 1_000, fullCorpusPairThreshold: 0 },
      llmCall: async (input) => {
        modelCalls += 1;
        const pairKey = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)][0]?.[1];
        expect(pairKey).toBeTruthy();
        seenPairs.push(pairKey!);
        return {
          text: '',
          json: { judgements: [{ pairKey, verdict: 'distinct', reason: 'separate finding' }] },
          inputTokens: 17,
          outputTokens: 6,
        };
      },
    });

    expect(modelCalls).toBe(3);
    expect(seenPairs).toEqual(['a::b', 'c::d', 'c::d']);
    expect(resumed).toMatchObject({ converged: true, initialCensus: 2, finalCensus: 0 });
    expect(resumed.stages[0]).toMatchObject({
      pairs: 2,
      modelCalls: 2,
      reusedBatches: 1,
      modelRetries: 0,
      censusBefore: 2,
      censusAfter: 0,
    });
    expect(resumedStepNames).toContain('bulk:bulk-stale-takeover-stage-1:canary');
    const recovered = await db.sql<
      Array<{ state: string; takeover_count: number; checkpoint_count: number; reused: number }>
    >`
      SELECT detail->>'status' AS state,
             (detail #>> '{lease,takeoverCount}')::int AS takeover_count,
             (SELECT count(*)::int FROM jsonb_object_keys(detail #> '{checkpoints,batches}')) AS checkpoint_count,
             (detail->>'reusedBatches')::int AS reused
        FROM harness_shared.admission_runs WHERE id = 'bulk-stale-takeover-stage-1'`;
    expect(recovered).toEqual([{ state: 'complete', takeover_count: 1, checkpoint_count: 2, reused: 1 }]);
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
              'admitted', now(), 'test'),
             (${WS}, ${HARNESS}, 'e', 'Third finding', ${'e'.repeat(180)}, 'open', NULL, '{}'::jsonb,
              'change', 'watch:third', 5, 5, '[0,0,1]'::vector, 'gemma',
              'admitted', now(), 'test'),
             (${WS}, ${HARNESS}, 'f', 'Third finding sibling', ${'f'.repeat(180)}, 'open', NULL, '{}'::jsonb,
              'change', 'watch:third', 6, 6, '[0.04,0,0.999]'::vector, 'gemma',
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
        await new Promise((resolve) => setTimeout(resolve, 75));
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
    expect(result.stages[0]).toMatchObject({ pairs: 3, modelCalls: 3, censusBefore: 3, censusAfter: 0 });
  }, 60_000);
});
