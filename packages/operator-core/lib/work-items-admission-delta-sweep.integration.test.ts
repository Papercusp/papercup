import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { runWorkItemAdmissionDeltaSweep } = await import('./work-items-admission-delta-sweep');

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

async function seedItem(input: { id: string; title: string; summary: string; admittedAt: string }): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       admission, admitted_at, admitted_by, condition_key, payload)
    VALUES (${WS}, ${HARNESS}, ${input.id}, ${input.title}, ${input.summary}, 'open', 'bug',
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
      }>
    >`
      SELECT run_kind, batch_size, tokens_in::text, tokens_out::text,
             detail->>'status' AS status,
             (detail->>'umbrellaYield')::int AS umbrella_yield,
             (detail->>'linksWritten')::int AS links_written
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
      },
    ]);

    const replay = await runWorkItemAdmissionDeltaSweep(options);
    expect(replay).toEqual(result);
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(fileUmbrella).toHaveBeenCalledTimes(1);
    expect(linkUmbrella).toHaveBeenCalledTimes(1);
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
});
