// @vitest-environment node
/**
 * P-003's real-Postgres guard.  The source contract test catches expression
 * drift; this test applies the actual migration to an isolated database and
 * proves that both session-key spellings and the legacy default workspace are
 * reachable through the new partial index.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  HERE,
  '../../../libs/papercusp/libs/db/sql/1114-activity-report-session-lookup-index.sql',
);
const INDEX = 'tool_invocations_activity_session_lookup_idx';
const WORKSPACE = 'p003-workspace';
const SESSION = 'p003-target-session';

let db: FreshPgDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshPgDb('conversation-context-index');
  sql = db.sql;
  await sql.unsafe(`
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL DEFAULT 'papercusp',
      plugin_name text NOT NULL DEFAULT 'test',
      tool_name text NOT NULL,
      role text NOT NULL DEFAULT 'agent',
      spawn_id text NOT NULL DEFAULT 'spawn',
      window_key text NOT NULL DEFAULT 'window',
      invoked_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'ok',
      args_json jsonb,
      error_message text,
      coord_owner_id text,
      goal_ref text
    )`);

  // Keep the matching set tiny compared with the unrelated telemetry so the
  // planner has the same selectivity pressure as the production table.
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, tool_name, invoked_at, args_json)
    VALUES
      (1, ${WORKSPACE}, 'activity:report', now() - interval '2 seconds', ${JSON.stringify({ session_id: SESSION })}::jsonb),
      (2, 'default', 'activity_report', now() - interval '1 second', ${JSON.stringify({ sessionId: SESSION })}::jsonb),
      (3, ${WORKSPACE}, 'activity:report', now(), ${JSON.stringify({ session_id: 'other-session' })}::jsonb)`;
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, tool_name, invoked_at, args_json)
    SELECT 100 + g,
           ${WORKSPACE},
           CASE WHEN g % 2 = 0 THEN 'activity:report' ELSE 'other:tool' END,
           now() - (g || ' seconds')::interval,
           jsonb_build_object('session_id', 'noise-' || g)
      FROM generate_series(1, 50_000) AS g`;

  await applyMigrationForTest(sql, MIGRATION);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('conversation-context-projection activity-report index', () => {
  it('returns both key spellings from requested and default workspaces', async () => {
    const rows = await sql<{
      id: number;
      workspace_id: string;
      tool_name: string;
      session_key: string;
    }[]>`
      SELECT id, workspace_id, tool_name,
             COALESCE(args_json->>'session_id', args_json->>'sessionId') AS session_key
        FROM harness_shared.tool_invocations
       WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
         AND tool_name IN ('activity:report', 'activity_report')
         AND (args_json ? 'session_id' OR args_json ? 'sessionId')
         AND COALESCE(args_json->>'session_id', args_json->>'sessionId') = ${SESSION}
       ORDER BY invoked_at DESC, id DESC`;

    expect(rows.map((row) => Number(row.id))).toEqual([2, 1]);
    expect(rows.map((row) => row.workspace_id)).toEqual(['default', WORKSPACE]);
    expect(rows.every((row) => row.session_key === SESSION)).toBe(true);
  });

  it('uses the migration index for the bounded newest-first lookup', async () => {
    const explained = await sql<{ 'QUERY PLAN': unknown }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, tool_name, args_json, status, error_message, invoked_at,
             coord_owner_id, goal_ref
        FROM harness_shared.tool_invocations
       WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
         AND tool_name IN ('activity:report', 'activity_report')
         AND (args_json ? 'session_id' OR args_json ? 'sessionId')
         AND COALESCE(args_json->>'session_id', args_json->>'sessionId') = ${SESSION}
       ORDER BY invoked_at DESC, id DESC
       LIMIT 200`;
    const plan = JSON.stringify(explained[0]?.['QUERY PLAN'] ?? explained);
    expect(plan).toContain(INDEX);
    expect(plan).toContain('Index Cond');
  }, 30_000);

  it('keeps the partial index restricted to activity rows with a session key', async () => {
    const [definition] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'harness_shared' AND indexname = ${INDEX}`;
    expect(definition?.indexdef).toMatch(/activity:report/i);
    expect(definition?.indexdef).toMatch(/activity_report/i);
    expect(definition?.indexdef).toMatch(/session_id/i);
    expect(definition?.indexdef).toMatch(/sessionId/i);
  });
});
