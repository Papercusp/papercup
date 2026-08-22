// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { composeCompanionSummary, type CompanionListSummary } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  agentRunsSummarySelection,
  buildAgentRunsPredicate,
  normalizeAgentRunsListArgs,
  readAgentRunsPageFromStore,
  readAgentRunsSummaryFromStore,
  type AgentRunsListWireArgs,
} from './agent-runs-list-query';

const ROWS = 2_050;
const workspaceId = 'p8-agent-runs-ws';
const foreignWorkspaceId = 'p8-agent-runs-foreign';
const harnessSlug = 'p8-agent-runs-hive';
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

const AGENT_RUNS_DDL = `
  CREATE TABLE harness_shared.agent_runs_consolidated (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    run_id text NOT NULL,
    role text NOT NULL,
    feature_id text,
    ts bigint NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0,
    cost_usd double precision,
    running boolean NOT NULL DEFAULT false,
    last_event_ts bigint,
    PRIMARY KEY (workspace_id, harness_slug, run_id)
  )`;

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    child_role text NOT NULL,
    feature_id text,
    run_id text NOT NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL,
    exit_code integer,
    error_message text,
    session_id text
  )`;

const runId = (g: number) => `p8-run-${g.toString().padStart(4, '0')}`;

const pageFor = async (args: AgentRunsListWireArgs, cursor: string | null = null) => {
  const normalized = normalizeAgentRunsListArgs({ ...args, cursor });
  return readAgentRunsPageFromStore(sql, buildAgentRunsPredicate(normalized));
};

const summaryFor = async (args: AgentRunsListWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeAgentRunsListArgs(args);
  const aggregate = await readAgentRunsSummaryFromStore(
    sql,
    buildAgentRunsPredicate(normalized),
  );
  return composeCompanionSummary(aggregate, {
    selection: agentRunsSummarySelection(normalized),
  });
};

beforeAll(async () => {
  db = await createFreshPgDb('agent-runs-list-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(AGENT_RUNS_DDL);
  await sql.unsafe(SPAWNED_AGENTS_DDL);
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, feature_id, run_id,
       status, started_at, heartbeat_at, exit_code, error_message, session_id)
    SELECT 'p8-spawn-' || lpad(g::text, 4, '0'),
           ${workspaceId},
           ${harnessSlug},
           CASE WHEN g % 2 = 0 THEN 'engineer' ELSE 'reviewer' END,
           CASE WHEN g % 5 = 0 THEN 'F-' || g ELSE NULL END,
           'p8-run-' || lpad(g::text, 4, '0'),
           CASE WHEN g = 1750 THEN 'running'
                WHEN g = 1900 THEN 'restarting'
                ELSE 'done' END,
           to_timestamp((${BASE_TS}::bigint - g) / 1000.0),
           to_timestamp((${BASE_TS}::bigint - g) / 1000.0),
           0,
           NULL,
           'p8-session-' || g
      FROM generate_series(1, ${ROWS}) AS g`;

  // Same slug + run id in another workspace: the old join omitted workspace_id
  // and could pair this foreign legacy row with the target live spawn, then
  // filter the combined row out through coalesce(workspace_id).
  await sql`
    INSERT INTO harness_shared.agent_runs_consolidated
      (workspace_id, harness_slug, run_id, role, feature_id, ts, size_bytes,
       cost_usd, running, last_event_ts)
    VALUES (${foreignWorkspaceId}, ${harnessSlug}, 'p8-collision', 'foreign', NULL,
            ${BASE_TS + 10_000}, 0, 0, false, ${BASE_TS + 10_000})`;
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, feature_id, run_id,
       status, started_at, heartbeat_at, session_id)
    VALUES ('p8-target-collision', ${workspaceId}, ${harnessSlug}, 'engineer',
            'F-collision', 'p8-collision', 'running',
            to_timestamp(${BASE_TS - 10_000} / 1000.0),
            to_timestamp(${BASE_TS - 10_000} / 1000.0), 'p8-collision-session')`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
  // EI-10571: strict DROP DATABASE cleanup on the shared reusable container can
  // legitimately spend 6s-267s+ draining concurrent backends and database files.
}, 300_000);

describe('agentRunsConsolidated.bySlug + summary real-PG P-008 contract', () => {
  it('finds active runs older than page one and returns exact total/running aggregates', async () => {
    const args: AgentRunsListWireArgs = {
      workspaceId,
      harnessSlug,
      runningOnly: true,
      limit: 10,
    };
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor(args), summaryFor(args)]);
    expect(page.rows.map((row) => row.runId)).toEqual([
      runId(1750),
      runId(1900),
      'p8-collision',
    ]);
    expect(summary).toMatchObject({ total: ROWS + 1, matched: 3 });
    expect(summary.facets.find((facet) => facet.key === 'state')?.values).toContainEqual(
      expect.objectContaining({ value: 'running', count: 3 }),
    );
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThan(100_000);
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('keyset-pages mutable newest-first history without skips or duplicates across inserts/status flips', async () => {
    const args: AgentRunsListWireArgs = { workspaceId, harnessSlug, limit: 137 };
    const ids: string[] = [];
    let maxPageBytes = 0;
    let cursor: string | null = null;
    let pageNo = 0;
    for (;;) {
      const page = await pageFor(args, cursor);
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page.rows)));
      ids.push(...page.rows.map((row) => row.runId));
      cursor = page.nextCursor;
      if (pageNo === 0) {
        await sql`
          INSERT INTO harness_shared.spawned_agents
            (spawn_id, workspace_id, harness_slug, child_role, run_id, status,
             started_at, heartbeat_at)
          VALUES ('p8-insert-mid-page', ${workspaceId}, ${harnessSlug}, 'engineer',
                  'p8-newer-after-cursor', 'done',
                  to_timestamp(${BASE_TS + 50_000} / 1000.0),
                  to_timestamp(${BASE_TS + 50_000} / 1000.0))`;
        await sql`
          UPDATE harness_shared.spawned_agents
             SET status = 'restarting'
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${harnessSlug}
             AND run_id = ${runId(1800)}`;
      }
      pageNo += 1;
      if (!cursor) break;
      expect(pageNo).toBeLessThan(30);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(ROWS + 1);
    expect(ids).not.toContain('p8-newer-after-cursor');
    expect(ids).toContain(runId(1800));
    expect(ids).toContain('p8-collision');
    expect(maxPageBytes).toBeLessThan(250_000);
  });

  it('preserves an exact zero-running state on an empty row page', async () => {
    await sql`
      UPDATE harness_shared.spawned_agents
         SET status = 'done'
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`;
    const args: AgentRunsListWireArgs = {
      workspaceId,
      harnessSlug,
      runningOnly: true,
      limit: 25,
    };
    const [page, summary] = await Promise.all([pageFor(args), summaryFor(args)]);
    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
    expect(summary).toMatchObject({ total: ROWS + 2, matched: 0 });
    expect(summary.facets.find((facet) => facet.key === 'state')?.values).toContainEqual(
      expect.objectContaining({ value: 'running', count: 0 }),
    );
  });
});
