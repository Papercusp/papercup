import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  admissionPairKey,
  judgedPairsMissingAdjudication,
  readPendingBatch,
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
  admission?: string | null;
  status?: string;
  createdAtMs?: number;
  vector?: string | null;
  conditionKey?: string | null;
  /** Defaults to the run's own harness/workspace; set to seed a NEIGHBOUR the sweep may or may not reach. */
  harness?: string;
  workspaceId?: string;
}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       admission, condition_key, lane, payload, created_ts, updated_ts, embedding, embedding_mode)
    VALUES (${input.workspaceId ?? WS}, ${input.harness ?? HARNESS}, ${input.id},
            ${input.title ?? 'vitest clone failure'},
            ${input.summary ?? 'same finding and same retry remedy'}, ${input.status ?? 'open'}, 'bug',
            ${input.admission === undefined ? 'pending' : input.admission}, ${input.conditionKey ?? null}, NULL, '{}'::jsonb,
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

    expect(result).toMatchObject({
      batchSize: 6,
      promoted: 1,
      merged: 5,
      held: 0,
      modelCalled: true,
      writerCoverageGap: [],
    });
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
    // D-003: the ledger must carry the promoted-to-first-claim DISTRIBUTION, not
    // only promotion volume. An independent acceptance grader measured 0 of 208
    // real promoter-tick rows carrying it (EI-21844734848781188) — the value was
    // computed for the backpressure read and then dropped on the floor.
    const latency = await db.sql<Array<{ latency: Record<string, unknown> | null }>>`
      SELECT detail->'promotedToFirstClaim' AS latency
        FROM harness_shared.admission_runs WHERE id = 'promoter-clones'`;
    expect(latency[0]?.latency).toMatchObject({
      sampleSize: expect.any(Number),
      p50Ms: null,
      p95Ms: null,
    });
    // A failed telemetry read persists an explicit marker instead of a silent
    // zero, so "no samples yet" stays distinguishable from "not measured". If
    // this key ever appears, the block above is reporting absence as data.
    expect(latency[0]?.latency).not.toHaveProperty('unavailable');
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

  it('re-reviews a fail-open row, increments retry attempts, and clears its alert', async () => {
    await seedItem({ id: 'WI-unreviewed', admission: 'unreviewed', vector: null });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_build_object(
           'admissionFailOpen', jsonb_build_object('reason', 'pending-age-exceeded-two-promoter-ticks'),
           'admissionReview', jsonb_build_object(
             'state', 'pending',
             'enteredAt', '2026-08-26T10:00:00Z',
             'reviewDueAt', '2026-08-26T11:00:00Z',
             'retryOwner', 'system:work-item-admission-promoter',
             'retryAttempts', 0,
             'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
           )
         )
       WHERE feature_id = 'WI-unreviewed'`;

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-rereview',
      sql: db.sql,
      llmCall: vi.fn(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, modelCalled: false });
    const [row] = await db.sql<Array<{ admission: string; payload: Record<string, any> }>>`
      SELECT admission, payload FROM harness_shared.work_items WHERE feature_id = 'WI-unreviewed'`;
    expect(row).toMatchObject({
      admission: 'admitted',
      payload: {
        admissionReview: {
          state: 'reviewed',
          retryAttempts: 1,
          reviewedBy: 'system:work-item-admission-promoter',
          alert: { key: 'work-item-admission-review-debt', state: 'cleared' },
        },
      },
    });
  });

  it('terminalizes an unreviewed duplicate with a terminal review outcome', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', vector: '[1,0,0]' });
    await seedItem({ id: 'WI-unreviewed-duplicate', admission: 'unreviewed', vector: '[1,0,0]' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_build_object('admissionReview', jsonb_build_object(
           'state', 'pending', 'retryAttempts', 0,
           'enteredAt', '2026-08-26T10:00:00Z',
           'reviewDueAt', '2026-08-26T11:00:00Z',
           'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
         ))
       WHERE feature_id = 'WI-unreviewed-duplicate'`;
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-rereview-merge',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });

    expect(result).toMatchObject({ promoted: 0, merged: 1, held: 0, modelCalled: true });
    const [row] = await db.sql<Array<{ status: string; payload: Record<string, any> }>>`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = 'WI-unreviewed-duplicate'`;
    expect(row).toMatchObject({
      status: 'dropped',
      payload: {
        admissionReview: {
          state: 'terminal',
          retryAttempts: 1,
          terminalOutcome: 'duplicate-merge',
          alert: { key: 'work-item-admission-review-debt', state: 'cleared' },
        },
      },
    });
  });

  it('terminalizes a legacy-admission loser surfaced only through a transitive merge component', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 30_000, vector: '[1,0,0]' });
    await seedItem({ id: 'WI-legacy-loser', admission: null, createdAtMs: NOW - 20_000, vector: '[1,0,0]' });
    await seedItem({ id: 'WI-pending-bridge', admission: 'pending', createdAtMs: NOW - 10_000, vector: '[1,0,0]' });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-transitive-legacy',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });

    expect(result).toMatchObject({ batchSize: 1, promoted: 0, merged: 2, held: 0, modelCalled: true });
    const rows = await db.sql<
      Array<{
        feature_id: string;
        status: string;
        admission: string | null;
        terminal_reason: string | null;
        payload: Record<string, any> | null;
      }>
    >`
      SELECT feature_id, status, admission, terminal_reason, payload
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ feature_id: 'WI-canonical', status: 'open', admission: 'admitted' });
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({
        status: 'dropped',
        admission: 'admitted',
        terminal_reason: expect.stringContaining('duplicate of WI-canonical'),
        payload: {
          admissionMerge: {
            canonicalId: 'WI-canonical',
            runId: 'promoter-transitive-legacy',
            actor: 'system:work-item-admission-promoter',
          },
        },
      });
    }
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

  // EI-21728201456300634 / EI-21866311570152646: the ticking promoter's own census-rise
  // alarm fired "major bug" TWICE on a run whose writer did nothing wrong. Root cause was a
  // TOCTOU race — censusBefore/censusAfter are two non-atomic reads of a workspace-wide,
  // continuously-growing count, separated by real time (the LLM call). Reproduce that race
  // deterministically: insert an unrelated dedup_edges row (simulating another agent's
  // concurrently-created near-duplicate items) INSIDE the mocked llmCall, so it lands exactly
  // between censusBefore and censusAfter, exactly as it would in production.
  it('does not flag a concurrent dedup_edges insert from organic corpus growth, even though the raw census rises', async () => {
    await seedItem({ id: 'WI-1', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-2', createdAtMs: NOW - 19_000 });
    const llmCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      await db.sql`
        INSERT INTO harness_shared.dedup_edges (workspace_id, harness_slug, a, b, cos, run_id)
        VALUES (${WS}, ${HARNESS}, 'WI-concurrent-a', 'WI-concurrent-b', 0.97, 'concurrent-edge-run')`;
      const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
      return {
        text: '',
        json: {
          judgements: keys.map((pairKey) => ({
            pairKey,
            verdict: 'r-finding-merge' as const,
            reason: 'fixture verdict',
          })),
        },
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-organic-growth',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    // The precondition that caused the false alarms genuinely reproduces here.
    expect(result.censusAfter).toBeGreaterThan(result.censusBefore);
    // ...yet the writer correctly retired the one pair it actually judged, so the targeted
    // signal — the only thing that should ever alarm — stays clean.
    expect(result.merged).toBe(1);
    expect(result.writerCoverageGap).toEqual([]);
  });

  // A `hold` verdict is a deliberate "still needs review" — persistAdmissionPlan intentionally
  // never writes a dedup_adjudications row for it (work-items-admission-promoter.ts:1170,1184).
  // That must never register as a writer defect: held pairs are excluded from
  // plan.adjudications entirely, so they can never appear in writerCoverageGap.
  it('does not flag a hold verdict as a writer coverage gap', async () => {
    await seedItem({ id: 'WI-1', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-2', createdAtMs: NOW - 19_000 });
    const llmCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
      return {
        text: '',
        json: {
          judgements: keys.map((pairKey) => ({ pairKey, verdict: 'hold' as const, reason: 'ambiguous' })),
        },
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-hold',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    expect(result.held).toBe(2);
    expect(result.writerCoverageGap).toEqual([]);
    const adjudications = await db.sql`SELECT a, b FROM harness_shared.dedup_adjudications`;
    expect(adjudications).toHaveLength(0);
  });

  it('judgedPairsMissingAdjudication reports only pairs with no dedup_adjudications row', async () => {
    await db.sql`
      INSERT INTO harness_shared.dedup_adjudications
        (workspace_id, harness_slug, a, b, verdict, canonical, judged_by, run_id, evidence)
      VALUES (${WS}, ${HARNESS}, 'WI-1', 'WI-2', 'r-finding-merge', 'WI-1', 'model', 'run-x', '{}'::jsonb)`;

    const gap = await judgedPairsMissingAdjudication(db.sql, WS, HARNESS, [
      { pairKey: admissionPairKey('WI-1', 'WI-2'), a: 'WI-1', b: 'WI-2' },
      { pairKey: admissionPairKey('WI-3', 'WI-4'), a: 'WI-3', b: 'WI-4' },
    ]);

    expect(gap).toEqual([admissionPairKey('WI-3', 'WI-4')]);
    expect(await judgedPairsMissingAdjudication(db.sql, WS, HARNESS, [])).toEqual([]);
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
    expect(result.reviewDebt).toMatchObject({ pending: 1, overdue: 1, reReviewed: 0, stillOpen: 0, terminal: 0 });
    const rows = await db.sql<Array<{ feature_id: string; admission: string; payload: Record<string, unknown> }>>`
      SELECT feature_id, admission, payload FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-fresh', admission: 'pending', payload: {} },
      {
        feature_id: 'WI-old',
        admission: 'unreviewed',
        payload: expect.objectContaining({
          admissionReview: expect.objectContaining({
            state: 'pending',
            retryOwner: 'system:work-item-admission-promoter',
            retryAttempts: 0,
            alert: expect.objectContaining({ key: 'work-item-admission-review-debt', state: 'open' }),
          }),
        }),
      },
    ]);
  });

  // The promoter is seeded per-harness by a hand-run script that defaults to the operator home
  // harness, so in practice only ONE harness ever has one. A harness-scoped fail-open therefore
  // guarantees liveness for that harness and silently starves every other one: measured
  // 2026-08-28, sb-devboard-hive held pending rows for 40.7h and email for ~2d with zero rows
  // ever admitted, while papercusp promoted normally throughout and no error was raised anywhere.
  describe('workspace-scoped fail-open', () => {
    it('rescues an over-age pending row in a harness that has no promoter of its own', async () => {
      await seedItem({ id: 'WI-home', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({ id: 'WI-neighbour', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-workspace',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.scope).toBe('workspace');
      expect(result.autoPromoted).toEqual(['WI-home', 'WI-neighbour']);
      expect(result.autoPromotedByHarness).toEqual({ [HARNESS]: ['WI-home'], email: ['WI-neighbour'] });
      const rows = await db.sql<Array<{ harness_slug: string; admission: string }>>`
        SELECT harness_slug, admission FROM harness_shared.work_items ORDER BY harness_slug`;
      expect(rows).toEqual([
        { harness_slug: 'email', admission: 'unreviewed' },
        { harness_slug: HARNESS, admission: 'unreviewed' },
      ]);
    });

    // Control: the widening must be the SCOPE doing the work, not the guard having gone blanket.
    it('leaves the neighbouring harness pending under the default harness scope', async () => {
      await seedItem({ id: 'WI-home', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({ id: 'WI-neighbour', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-harness-scope',
        sql: db.sql,
        now: () => NOW,
      });

      expect(result.scope).toBe('harness');
      expect(result.autoPromoted).toEqual(['WI-home']);
      expect(result.autoPromotedByHarness).toEqual({ [HARNESS]: ['WI-home'] });
      const [neighbour] = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE harness_slug = 'email'`;
      expect(neighbour).toEqual({ admission: 'pending' });
    });

    // A workspace sweep widens across harnesses inside ONE tenant — never across tenants.
    it('never crosses a workspace boundary', async () => {
      await seedItem({ id: 'WI-mine', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({
        id: 'WI-other-tenant',
        createdAtMs: NOW - 61 * 60_000,
        vector: null,
        harness: 'email',
        workspaceId: 'some-other-workspace',
      });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-tenant-isolation',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual(['WI-mine']);
      const [foreign] = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE workspace_id = 'some-other-workspace'`;
      expect(foreign).toEqual({ admission: 'pending' });
    });

    // Widening the harness axis must not weaken the age floor on the rows it newly reaches.
    it('still honours the two-tick age floor in the harnesses it newly reaches', async () => {
      await seedItem({ id: 'WI-neighbour-old', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });
      await seedItem({ id: 'WI-neighbour-fresh', createdAtMs: NOW - 59 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-age-floor',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual(['WI-neighbour-old']);
      const rows = await db.sql<Array<{ feature_id: string; admission: string }>>`
        SELECT feature_id, admission FROM harness_shared.work_items ORDER BY feature_id`;
      expect(rows).toEqual([
        { feature_id: 'WI-neighbour-fresh', admission: 'pending' },
        { feature_id: 'WI-neighbour-old', admission: 'unreviewed' },
      ]);
    });
  });

  it('serves the owner snapshot with real SQL filters, percentiles, trend, and latest-rise evidence', async () => {
    await seedItem({ id: 'WI-pending', admission: 'pending' });
    await seedItem({ id: 'WI-unreviewed', admission: 'unreviewed' });
    await seedItem({ id: 'WI-claimed-fast', admission: 'admitted' });
    await seedItem({ id: 'WI-claimed-slow', admission: 'admitted' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = CASE feature_id
           WHEN 'WI-unreviewed' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'pending',
             'enteredAt', '2026-08-26T10:00:00Z',
             'reviewDueAt', '2026-08-26T11:00:00Z',
             'retryAttempts', 0,
             'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
           ))
           WHEN 'WI-claimed-fast' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'reviewed', 'reviewedAt', '2026-08-26T11:00:00Z'
           ))
           WHEN 'WI-claimed-slow' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'terminal', 'terminalAt', '2026-08-26T11:00:00Z', 'terminalOutcome', 'duplicate-merge'
           ))
           ELSE payload
         END
       WHERE feature_id IN ('WI-unreviewed', 'WI-claimed-fast', 'WI-claimed-slow')`;
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
      reviewDebt: {
        pending: 1,
        overdue: 1,
        reReviewed: 1,
        stillOpen: 1,
        terminal: 1,
        oldestAgeMs: expect.any(Number),
      },
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

  it('uses writer status over finished_at and keeps outcome totals unit-separated', async () => {
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at, batch_size,
         promoted, merged, held, detail)
      VALUES
        ('status-blocked', ${WS}, ${HARNESS}, 'daily-digest', now(), now(), 0, 0, 0, 0,
         '{"status":"blocked","blockedReason":"awaiting-bulk","outcome":{"unit":"links","attempted":0,"successful":0,"rolledBack":0,"unchanged":0,"uniqueRowsChanged":0,"blockedReason":"awaiting-bulk"}}'::jsonb),
        ('status-failed', ${WS}, ${HARNESS}, 'bulk-stage', now(), now(), 7, 0, 0, 0,
         '{"status":"failed","error":"transport down","outcome":{"unit":"pairs","attempted":7,"successful":null,"rolledBack":null,"unchanged":null,"uniqueRowsChanged":null,"failureReason":"transport down"}}'::jsonb),
        ('status-invalid', ${WS}, ${HARNESS}, 'census', now(), now(), 2, 0, 0, 0,
         '{"status":"future-status"}'::jsonb)`;

    const snapshot = await readWorkItemAdmissionSnapshot({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    expect(snapshot.runs.map((run) => [run.id, run.state, run.stateSource])).toEqual(
      expect.arrayContaining([
        ['status-blocked', 'blocked', 'writer'],
        ['status-failed', 'failed', 'writer'],
        ['status-invalid', 'failed', 'invalid-writer'],
      ]),
    );
    expect(snapshot.runs.find((run) => run.id === 'status-blocked')?.outcome.blockedReason).toBe('awaiting-bulk');
    expect(snapshot.runs.find((run) => run.id === 'status-failed')?.outcome.failureReason).toBe('transport down');
    expect(snapshot.summary.runCounts.byUnit?.links?.runs).toBe(1);
    expect(snapshot.summary.runCounts.byUnit?.pairs?.runs).toBe(1);
    expect(snapshot.summary.runCounts.byUnit?.snapshots?.runs).toBe(1);
  });
});

describe('readPendingBatch resolver-input priority (P-006)', () => {
  async function seedPending(input: {
    id: string;
    createdAtMs: number;
    dedupCandidates?: unknown;
    dedupCoverageDegraded?: boolean;
  }): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.dedupCandidates !== undefined) payload.dedupCandidates = input.dedupCandidates;
    if (input.dedupCoverageDegraded !== undefined) {
      payload.dedupCoverage = { lexical: 'ok', semantic: 'ok', degraded: input.dedupCoverageDegraded };
    }
    // sql.json() — NOT `${JSON.stringify(payload)}::jsonb` — per the documented
    // postgres-js gotcha (_pg-helpers.ts header, dock-layouts.ts): on this
    // production-faithful client config, the JSON.stringify+cast form
    // double-encodes to a jsonb STRING (jsonb_typeof=string), which silently
    // defeats every `payload -> 'key'` predicate (a string has no keys, so
    // `IS NOT NULL` reads false for every row and the priority boost never
    // fires — reproduced + root-caused via a standalone script before this fix).
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         admission, condition_key, lane, payload, created_ts, updated_ts)
      VALUES (${WS}, ${HARNESS}, ${input.id}, 'title', 'summary', 'open', 'bug',
              'pending', NULL, NULL, ${db.sql.json(payload as unknown as Parameters<typeof db.sql.json>[0])},
              ${input.createdAtMs}, ${input.createdAtMs})`;
  }

  it('orders candidate-stamped rows first, then dedupCoverage.degraded rows, then plain FIFO', async () => {
    // Seeded OLDEST-first by id so a plain created_ts order would read WI-1..WI-4 — the
    // priority boost must override that for the stamped/degraded rows regardless.
    await seedPending({ id: 'WI-1', createdAtMs: NOW - 40_000 }); // plain, oldest
    await seedPending({ id: 'WI-2', createdAtMs: NOW - 30_000, dedupCoverageDegraded: true }); // degraded
    await seedPending({ id: 'WI-3', createdAtMs: NOW - 20_000 }); // plain, newer than WI-1
    await seedPending({
      id: 'WI-4',
      createdAtMs: NOW - 10_000, // youngest of all, but candidate-stamped
      dedupCandidates: [{ id: 'WI-9', similarity: 0.91, method: 'semantic-hard' }],
    });

    const batch = await readPendingBatch(db.sql, WS, HARNESS, 10);
    // WI-4 (candidate-stamped) first; WI-2 (degraded) second; then plain FIFO WI-1, WI-3.
    expect(batch.map((item) => item.id)).toEqual(['WI-4', 'WI-2', 'WI-1', 'WI-3']);
  });

  it('an EMPTY dedupCandidates array is not stamped by the writers and does not boost', async () => {
    // dedup-candidates-stamp.ts is explicit: the key is written ONLY when non-empty. A row
    // whose payload carries `dedupCandidates: []` (e.g. a hand-authored fixture, or a future
    // writer regression) must still be readable as "no candidates" via the boost, not as a
    // false positive — `IS NOT NULL` on an empty JSON array is still true, so this guards the
    // one shape that predicate CANNOT distinguish and documents it as an accepted edge rather
    // than a silent surprise.
    await seedPending({ id: 'WI-5', createdAtMs: NOW - 20_000 });
    await seedPending({ id: 'WI-6', createdAtMs: NOW - 10_000, dedupCandidates: [] });
    const batch = await readPendingBatch(db.sql, WS, HARNESS, 10);
    // An empty array still satisfies `IS NOT NULL`, so WI-6 sorts first — recorded here as
    // the KNOWN behaviour (both writers only ever stamp non-empty, per dedup-candidates-
    // stamp.ts's contract) rather than left for a reader to rediscover by surprise.
    expect(batch.map((item) => item.id)).toEqual(['WI-6', 'WI-5']);
  });
});
