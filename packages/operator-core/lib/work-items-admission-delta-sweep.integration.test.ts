import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { readDeltaSweepContext, runWorkItemAdmissionDeltaSweep } = await import('./work-items-admission-delta-sweep');
const { LEARNING_MODEL_SPEC } = await import('./learning/model-policy');
const { ALL_TERMINAL_STATUSES } = await import('./work-item-blocking');

const WS = 'default';
const HARNESS = 'papercusp';
const NOW = Date.parse('2026-08-26T12:00:00Z');
let db: FreshPgDb;

const DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
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
    admitted_by text,
    condition_key text,
    payload jsonb,
    lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
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
  CREATE TABLE harness_shared.dedup_edges (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    cos real NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.delta_sweep_test_links (
    source_id text NOT NULL,
    umbrella_id text NOT NULL,
    relation text NOT NULL,
    PRIMARY KEY (source_id, umbrella_id, relation)
  );
`;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission-delta-sweep');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

// Shared-container DROP DATABASE is explicitly budgeted at 60s by the fixture
// contract; make it local so direct-file Vitest runs do not fall back to 10s.
afterAll(async () => db?.cleanup(), 60_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.admission_runs,
    harness_shared.dedup_shard_map, harness_shared.dedup_edges,
    harness_shared.delta_sweep_test_links`;
});

async function seedItem(input: {
  id: string;
  title: string;
  summary: string;
  admittedAt: string;
  status?: string;
}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       admission, admitted_at, admitted_by, condition_key, payload)
    VALUES (${WS}, ${HARNESS}, ${input.id}, ${input.title}, ${input.summary}, ${input.status ?? 'open'}, 'bug',
            'admitted', ${input.admittedAt}::timestamptz, 'system:promoter', NULL, NULL)`;
}

describe('work-item admission hourly delta sweep (real PostgreSQL)', () => {
  it('turns five differently-worded symptoms into one pending umbrella, five links, and one complete ledger row', async () => {
    const burst = [
      ['WI-1', 'CLI command never returns', 'The command waits on the checkout mutex after its child has exited.'],
      ['WI-2', 'Release queue stops advancing', 'Promotion is blocked behind the same stale checkout lock holder.'],
      ['WI-3', 'Sync deadline expires', 'The synchronization worker cannot enter its checkout critical section.'],
      ['WI-4', 'Test runner appears frozen', 'A dead process left the repository checkout lease behind.'],
      [
        'WI-5',
        'Operator startup misses readiness',
        'Startup waits for a shared checkout lock that no live process owns.',
      ],
    ] as const;
    for (const [index, [id, title, summary]] of burst.entries()) {
      await seedItem({ id, title, summary, admittedAt: `2026-08-26T11:${20 + index}:00Z` });
    }
    await seedItem({
      id: 'WI-old',
      title: 'Earlier orphaned lock warning',
      summary: 'Historical context only.',
      admittedAt: '2026-08-26T06:00:00Z',
    });
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at, detail)
      VALUES ('census-live', ${WS}, ${HARNESS}, 'census', '2026-08-26T10:00:00Z',
              '2026-08-26T10:01:00Z', '{"status":"complete"}'::jsonb)`;
    for (const id of [...burst.map(([id]) => id), 'WI-old']) {
      await db.sql`
        INSERT INTO harness_shared.dedup_shard_map
          (run_id, workspace_id, harness_slug, shard_id, item_id, role)
        VALUES ('census-live', ${WS}, ${HARNESS}, 0, ${id}, 'member')`;
    }
    await db.sql`
      INSERT INTO harness_shared.dedup_edges (workspace_id, harness_slug, a, b, cos)
      VALUES (${WS}, ${HARNESS}, 'WI-1', 'WI-2', 0.86),
             (${WS}, ${HARNESS}, 'WI-1', 'WI-3', 0.87)`;

    const llmCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => ({
      text: '',
      json: {
        umbrellas: [
          {
            title: 'Orphaned checkout mutex stalls unrelated operator workflows',
            body: 'A dead child leaves the shared checkout mutex held, so every later checkout consumer waits forever.',
            reason: 'All five symptoms name independent consumers blocked at the same checkout boundary.',
            memberIds: burst.map(([id]) => id),
          },
        ],
      },
      inputTokens: 900,
      outputTokens: 120,
    }));
    const fileUmbrella = vi.fn(async (input: { proposal: { title: string; body: string } }) => {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, admission, payload)
        VALUES (${WS}, ${HARNESS}, 'EI-umbrella', ${input.proposal.title}, ${input.proposal.body},
                'open', 'bug', 'pending', NULL)
        ON CONFLICT DO NOTHING`;
      return { id: 'EI-umbrella', created: true };
    });
    const linkUmbrella = vi.fn(async (input: { umbrellaId: string; sourceIds: string[] }) => {
      for (const sourceId of input.sourceIds) {
        await db.sql`
          INSERT INTO harness_shared.delta_sweep_test_links (source_id, umbrella_id, relation)
          VALUES (${sourceId}, ${input.umbrellaId}, 'caused-by')
          ON CONFLICT DO NOTHING`;
      }
      return input.sourceIds.length;
    });

    const options = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-live',
      sql: db.sql,
      now: () => NOW,
      clusterExemplarsPerShard: 2,
      llmCall,
      fileUmbrella,
      linkUmbrella,
    };
    const result = await runWorkItemAdmissionDeltaSweep(options);

    expect(result).toMatchObject({
      recentItems: 5,
      titleItems: 6,
      clusterShards: 1,
      sourceCensusRunId: 'census-live',
      modelCalled: true,
      tokensIn: 900,
      tokensOut: 120,
      umbrellaYield: 1,
      linksWritten: 5,
    });
    expect(llmCall).toHaveBeenCalledTimes(1);
    const prompt = llmCall.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain('The command waits on the checkout mutex after its child has exited.');
    expect(prompt).toContain('Earlier orphaned lock warning');
    expect(prompt).toContain('WI-1: CLI command never returns');

    const umbrella = await db.sql<Array<{ feature_id: string; admission: string }>>`
      SELECT feature_id, admission FROM harness_shared.work_items WHERE feature_id = 'EI-umbrella'`;
    expect(umbrella).toEqual([{ feature_id: 'EI-umbrella', admission: 'pending' }]);
    const links = await db.sql<Array<{ source_id: string; relation: string }>>`
      SELECT source_id, relation FROM harness_shared.delta_sweep_test_links ORDER BY source_id`;
    expect(links).toHaveLength(5);
    expect(links.every((row) => row.relation === 'caused-by')).toBe(true);
    const ledger = await db.sql<
      Array<{
        run_kind: string;
        batch_size: number;
        tokens_in: string;
        tokens_out: string;
        status: string;
        umbrella_yield: number;
        links_written: number;
        outcome_unit: string;
        outcome_attempted: number;
        outcome_successful: number;
      }>
    >`
      SELECT run_kind, batch_size, tokens_in::text, tokens_out::text,
             detail->>'status' AS status,
             (detail->>'umbrellaYield')::int AS umbrella_yield,
             (detail->>'linksWritten')::int AS links_written,
             detail #>> '{outcome,unit}' AS outcome_unit,
             (detail #>> '{outcome,attempted}')::int AS outcome_attempted,
             (detail #>> '{outcome,successful}')::int AS outcome_successful
        FROM harness_shared.admission_runs WHERE id = 'delta-live'`;
    expect(ledger).toEqual([
      {
        run_kind: 'delta-sweep',
        batch_size: 5,
        tokens_in: '900',
        tokens_out: '120',
        status: 'complete',
        umbrella_yield: 1,
        links_written: 5,
        outcome_unit: 'links',
        outcome_attempted: 5,
        outcome_successful: 5,
      },
    ]);

    const replay = await runWorkItemAdmissionDeltaSweep(options);
    expect(replay).toEqual(result);
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(fileUmbrella).toHaveBeenCalledTimes(1);
    expect(linkUmbrella).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('excludes every cross-family terminal state from current and title context', async () => {
    for (const [index, status] of [...ALL_TERMINAL_STATUSES].entries()) {
      await seedItem({
        id: `WI-terminal-${status}`,
        title: `Terminal ${status} must stay out of delta context`,
        summary: `A ${status} row is historical evidence, not a current contributor.`,
        status,
        admittedAt: `2026-08-26T11:${30 + index}:00Z`,
      });
    }

    const context = await readDeltaSweepContext(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      nowMs: NOW,
      recentWindowMinutes: 60,
      titleWindowHours: 24,
      clusterExemplarsPerShard: 2,
    });

    expect(context.recentItems).toEqual([]);
    expect(context.last24hTitles).toEqual([]);
  }, 60_000);

  /**
   * D-035 model identity, delta-sweep half. The runner used to bind
   * `model: LEARNING_MODEL_SPEC` inline at its llmCall AND write the same
   * constant into `admission_runs.model_id`, so it could not be steered off a
   * model whose account was rejecting it, and the column named a constant
   * rather than the model the run actually called. bulk-dedup already pins this
   * from both ends; delta-sweep had NO model coverage at all, which is how it
   * kept the pre-fix shape after its three siblings were fixed.
   *
   * Both ends matter: what `llmCall` RECEIVED, and what landed in the COLUMN.
   * Asserting only the column would pass if the run called one model and
   * recorded another — the exact drift the resolve-once seam exists to stop.
   */
  const seedOneRecentItem = async (): Promise<void> => {
    await seedItem({
      id: 'WI-model',
      title: 'Model identity probe',
      summary: 'One recent admitted item, enough to spend exactly one model call.',
      admittedAt: '2026-08-26T11:30:00Z',
    });
  };

  // The `input` parameter is declared so vi.fn records a typed call tuple —
  // without it mock.calls[0] is `[]` and the model assertions cannot index it.
  const noUmbrellas = async (input: { model: string }) => ({
    text: '',
    json: { umbrellas: [] },
    inputTokens: 10,
    outputTokens: 5,
    echoedModel: input.model,
  });

  it('defaults to the canonical learning model and records THAT model in the ledger', async () => {
    await seedOneRecentItem();
    const llmCall = vi.fn(noUmbrellas);
    const result = await runWorkItemAdmissionDeltaSweep({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-model-default',
      sql: db.sql,
      now: () => NOW,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });

    expect(result.modelCalled).toBe(true);
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(llmCall.mock.calls[0]![0]).toMatchObject({ model: LEARNING_MODEL_SPEC });

    const ledger = await db.sql<Array<{ model_id: string | null }>>`
      SELECT model_id FROM harness_shared.admission_runs WHERE id = 'delta-model-default'`;
    expect(ledger).toEqual([{ model_id: LEARNING_MODEL_SPEC }]);
  }, 60_000);

  it('drives one run onto an override model and records the OVERRIDE, not the policy constant', async () => {
    await seedOneRecentItem();
    const override = 'claude-opus-5:xhigh';
    // Guard the guard: if the override ever equals the policy constant this
    // test proves nothing, because both assertions would pass either way.
    expect(override).not.toBe(LEARNING_MODEL_SPEC);

    const llmCall = vi.fn(noUmbrellas);
    await runWorkItemAdmissionDeltaSweep({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-model-override',
      sql: db.sql,
      now: () => NOW,
      model: override,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });

    expect(llmCall.mock.calls[0]![0]).toMatchObject({ model: override });
    const ledger = await db.sql<Array<{ model_id: string | null }>>`
      SELECT model_id FROM harness_shared.admission_runs WHERE id = 'delta-model-override'`;
    expect(ledger).toEqual([{ model_id: override }]);
  }, 60_000);

  it('records an empty hourly tick without spending a model call', async () => {
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionDeltaSweep({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-empty',
      sql: db.sql,
      now: () => NOW,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({ recentItems: 0, modelCalled: false, umbrellaYield: 0 });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('retries transient model transport failures with bounded backoff', async () => {
    await seedItem({
      id: 'WI-retry',
      title: 'Transient retry probe',
      summary: 'A recent item exercises the model transport retry path.',
      admittedAt: '2026-08-26T11:30:00Z',
    });
    const llmCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNRESET 10.0.0.1:443'))
      .mockResolvedValueOnce({ text: '', json: { umbrellas: [] }, inputTokens: 7, outputTokens: 3 });
    const delay = vi.fn(async () => undefined);
    const result = await runWorkItemAdmissionDeltaSweep({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-transient-retry',
      sql: db.sql,
      now: () => NOW,
      llmCall,
      retryBackoffsMs: [1],
      retryDelay: delay,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({ modelCalled: true, tokensIn: 7, tokensOut: 3 });
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1);
  }, 60_000);

  it('resumes a failed effect from the admission ledger without another model call', async () => {
    const ids = ['WI-r1', 'WI-r2', 'WI-r3'];
    for (const [index, id] of ids.entries()) {
      await seedItem({ id, title: `Resume item ${id}`, summary: 'Same resumable umbrella cause.', admittedAt: `2026-08-26T11:3${index}:00Z` });
    }
    const proposal = {
      title: 'Resumable umbrella',
      body: 'A partial effect is resumed from the ledger.',
      reason: 'The effect checkpoint keeps the parsed result.',
      memberIds: ids,
    };
    const llmCall = vi.fn(async () => ({ text: '', json: { umbrellas: [proposal] }, inputTokens: 9, outputTokens: 4 }));
    const fileUmbrella = vi.fn(async () => ({ id: 'EI-resume', created: true }));
    const linkUmbrella = vi
      .fn()
      .mockRejectedValueOnce(new Error('link interrupted'))
      .mockResolvedValueOnce(ids.length);
    await expect(
      runWorkItemAdmissionDeltaSweep({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'delta-resume',
        sql: db.sql,
        now: () => NOW,
        llmCall,
        fileUmbrella,
        linkUmbrella,
      }),
    ).rejects.toThrow('link interrupted');
    const resumed = await runWorkItemAdmissionDeltaSweep({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'delta-resume',
      sql: db.sql,
      now: () => NOW,
      llmCall,
      fileUmbrella,
      linkUmbrella,
    });
    expect(resumed).toMatchObject({ modelCalled: true, umbrellaYield: 1, linksWritten: 3 });
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(fileUmbrella).toHaveBeenCalledTimes(1);
    expect(linkUmbrella).toHaveBeenCalledTimes(2);
  }, 60_000);
});
