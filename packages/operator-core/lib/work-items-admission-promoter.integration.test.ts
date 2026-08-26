import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  readWorkItemAdmissionSnapshot,
  readWorkItemAdmissionProducerPressure,
  runWorkItemAdmissionFailOpen,
  runWorkItemAdmissionPromoter,
  WORK_ITEM_ADMISSION_PROMOTER,
} = await import('./work-items-admission-promoter');

const WS = 'default';
const HARNESS = 'papercusp';
const NOW = Date.parse('2026-08-26T12:00:00Z');
let db: FreshPgDb;

const DDL = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(value text)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT value = ANY(ARRAY['done','dropped','deprecated','passed','failed','resolved','closed']::text[])
  $$;
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text,
    item_kind text,
    admission text,
    admitted_at timestamptz,
    first_claimed_at timestamptz,
    admitted_by text,
    condition_key text,
    lane text,
    payload jsonb,
    see_also text[],
    created_ts bigint,
    updated_ts bigint,
    closed_ts bigint,
    terminal_reason text,
    terminal_owner text,
    embedding vector(3),
    embedding_mode text,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
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
  CREATE TABLE harness_shared.work_item_occurrences (
    occurrence_id bigserial PRIMARY KEY,
    workspace_id text NOT NULL,
    canonical_harness_slug text NOT NULL,
    canonical_work_item_id text NOT NULL,
    reporter text,
    source_tool text NOT NULL,
    report_kind text NOT NULL,
    reported_title text NOT NULL,
    evidence jsonb,
    admission_identity jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE harness_shared.routines (
    id text PRIMARY KEY,
    install_slug text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (install_slug, name)
  );
`;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission-promoter');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => db?.cleanup());

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.dedup_edges,
    harness_shared.dedup_adjudications, harness_shared.admission_runs,
    harness_shared.work_item_occurrences, harness_shared.routines RESTART IDENTITY`;
});

async function seedItem(input: {
  id: string;
  title?: string;
  summary?: string;
  admission?: string;
  status?: string;
  createdAtMs?: number;
  vector?: string | null;
  conditionKey?: string | null;
}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       admission, condition_key, lane, payload, created_ts, updated_ts, embedding, embedding_mode)
    VALUES (${WS}, ${HARNESS}, ${input.id}, ${input.title ?? 'vitest clone failure'},
            ${input.summary ?? 'same finding and same retry remedy'}, ${input.status ?? 'open'}, 'bug',
            ${input.admission ?? 'pending'}, ${input.conditionKey ?? null}, NULL, '{}'::jsonb,
            ${input.createdAtMs ?? NOW - 10_000}, ${input.createdAtMs ?? NOW - 10_000},
            ${input.vector === undefined ? '[1,0,0]' : input.vector}::vector,
            ${input.vector === null ? null : 'gemma'})`;
}

function judgementCall(verdict: 'r-finding-merge' | 'r-remedy-keep') {
  return vi.fn(async (input: { messages: Array<{ content: string }> }) => {
    const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    return {
      text: '',
      json: { judgements: keys.map((pairKey) => ({ pairKey, verdict, reason: 'fixture verdict' })) },
      inputTokens: 100,
      outputTokens: 20,
    };
  });
}

describe('work-item admission promoter (real Postgres)', () => {
  it('replays six vitest clones: one promotes and five merge into one canonical', async () => {
    for (let i = 1; i <= 6; i += 1) await seedItem({ id: `WI-${i}`, createdAtMs: NOW - 20_000 + i });
    const llmCall = judgementCall('r-finding-merge');
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-clones',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    expect(result).toMatchObject({ batchSize: 6, promoted: 1, merged: 5, held: 0, modelCalled: true });
    expect(llmCall).toHaveBeenCalledTimes(1);
    const rows = await db.sql<
      Array<{
        feature_id: string;
        status: string;
        admission: string;
        payload: { admissionMerge?: { canonicalId?: string } } | null;
        terminal_reason: string | null;
      }>
    >`
      SELECT wi.feature_id, wi.status, wi.admission, wi.payload, wi.terminal_reason
        FROM harness_shared.work_items wi ORDER BY feature_id`;
    expect(rows[0]).toMatchObject({ feature_id: 'WI-1', status: 'open', admission: 'admitted' });
    for (const [index, row] of rows.slice(1).entries()) {
      expect(row).toMatchObject({
        feature_id: `WI-${index + 2}`,
        status: 'dropped',
        admission: 'admitted',
        terminal_reason: expect.stringContaining('duplicate of WI-1'),
      });
      expect(row.payload).toEqual({ admissionMerge: { canonicalId: 'WI-1', runId: 'promoter-clones' } });
    }
    const run = await db.sql<Array<{ promoted: number; merged: number; status: string }>>`
      SELECT promoted, merged, detail->>'status' AS status
        FROM harness_shared.admission_runs WHERE id = 'promoter-clones'`;
    expect(run).toEqual([{ promoted: 1, merged: 5, status: 'complete' }]);
  }, 60_000);

  it('promotes a zero-flag item without any model call', async () => {
    await seedItem({ id: 'WI-unique', title: 'uniquely worded isolated queue item', vector: null });
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-zero-flag',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });
    expect(result).toMatchObject({ flaggedPairs: 0, promoted: 1, merged: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('keeps and cross-links an R-remedy pair', async () => {
    await seedItem({ id: 'WI-1', summary: 'remedy: intake lease' });
    await seedItem({ id: 'WI-2', summary: 'remedy: refractory window' });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-remedies',
      sql: db.sql,
      llmCall: judgementCall('r-remedy-keep'),
      now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 2, merged: 0 });
    const rows = await db.sql<Array<{ feature_id: string; admission: string; see_also: string[] }>>`
      SELECT feature_id, admission, see_also FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-1', admission: 'admitted', see_also: ['WI-2'] },
      { feature_id: 'WI-2', admission: 'admitted', see_also: ['WI-1'] },
    ]);
  });

  it('admits only rows older than two ticks and alarms when the promoter is killed', async () => {
    await seedItem({ id: 'WI-old', createdAtMs: NOW - 61 * 60_000, vector: null });
    await seedItem({ id: 'WI-fresh', createdAtMs: NOW - 59 * 60_000, vector: null });
    await db.sql`
      INSERT INTO harness_shared.routines (id, install_slug, workspace_id, name, active, created_at)
      VALUES ('rt-promoter', ${HARNESS}, ${WS}, ${WORK_ITEM_ADMISSION_PROMOTER}, false,
              to_timestamp(${NOW - 4 * 60 * 60_000} / 1000.0))`;

    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-killed',
      sql: db.sql,
      now: () => NOW,
    });
    expect(result.autoPromoted).toEqual(['WI-old']);
    expect(result.liveness).toMatchObject({ stale: true, reason: 'promoter routine is inactive' });
    const rows = await db.sql<Array<{ feature_id: string; admission: string }>>`
      SELECT feature_id, admission FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-fresh', admission: 'pending' },
      { feature_id: 'WI-old', admission: 'unreviewed' },
    ]);
  });

  it('serves the owner snapshot with real SQL filters, percentiles, trend, and latest-rise evidence', async () => {
    await seedItem({ id: 'WI-pending', admission: 'pending' });
    await seedItem({ id: 'WI-unreviewed', admission: 'unreviewed' });
    await seedItem({ id: 'WI-claimed-fast', admission: 'admitted' });
    await seedItem({ id: 'WI-claimed-slow', admission: 'admitted' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET admitted_at = CASE feature_id
               WHEN 'WI-claimed-fast' THEN '2026-08-26T10:00:00Z'::timestamptz
               WHEN 'WI-claimed-slow' THEN '2026-08-26T11:00:00Z'::timestamptz
             END,
             first_claimed_at = CASE feature_id
               WHEN 'WI-claimed-fast' THEN '2026-08-26T10:00:01Z'::timestamptz
               WHEN 'WI-claimed-slow' THEN '2026-08-26T11:00:05Z'::timestamptz
             END
       WHERE workspace_id = ${WS}
         AND harness_slug = ${HARNESS}
         AND feature_id IN ('WI-claimed-fast', 'WI-claimed-slow')`;
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at,
         batch_size, promoted, merged, held, census_before, census_after,
         model_id, tokens_in, tokens_out, latency_ms, detail)
      VALUES
        ('census-old', ${WS}, ${HARNESS}, 'census', '2026-08-26T13:00:00Z', '2026-08-26T13:00:01Z',
         10, 0, 0, 0, 10, 7, NULL, 0, 0, 1000, '{"status":"complete"}'::jsonb),
        ('promoter-rise', ${WS}, ${HARNESS}, 'promoter-tick', '2026-08-26T14:00:00Z', '2026-08-26T14:00:02Z',
         4, 2, 1, 1, 7, 8, 'model-a', 100, 20, 2000, '{"status":"complete"}'::jsonb)`;

    const snapshot = await readWorkItemAdmissionSnapshot({
      workspaceId: WS,
      harnessSlug: HARNESS,
      kind: 'promoter-tick',
      state: 'complete',
      sql: db.sql,
    });

    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      id: 'promoter-rise',
      tokensIn: 100,
      tokensOut: 20,
      censusDelta: 1,
    });
    expect(snapshot.summary).toMatchObject({
      pending: 1,
      unreviewed: 1,
      promotedToFirstClaim: { sampleSize: 2, p50Ms: 3000, p95Ms: 4800 },
      latestCensus: { runId: 'promoter-rise', after: 8 },
      latestCensusRise: { runId: 'promoter-rise', delta: 1 },
    });
    expect(snapshot.censusTrend.map((point) => point.runId)).toEqual(['census-old', 'promoter-rise']);
    await expect(
      readWorkItemAdmissionProducerPressure({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql }),
    ).resolves.toMatchObject({
      source: 'p005-queue-health',
      level: 'normal',
      pending: 1,
      latencySampleSize: 2,
      p95Ms: 4800,
      maxIdeators: null,
    });
  });
});
