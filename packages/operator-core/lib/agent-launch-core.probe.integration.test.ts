import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestPg } from '@papercusp/test-config/pg';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

const { probeFreshLaunchSessions } = await import('./agent-launch-core');
let sql: postgres.Sql;
let dbName: string;
let adminUri: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `launch_probe_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  sql = postgres(url.toString(), { max: 1 });
  holder.sql = sql;
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.adv_sessions (
      id integer PRIMARY KEY, session_id text, coord_owner_id text,
      workspace_id text, first_seen_at timestamptz, launch_spec jsonb, launch_argv jsonb
    );
    CREATE TABLE harness_shared.tool_invocations (
      workspace_id text, coord_owner_id text, status text, call_origin text,
      tool_name text, invoked_at timestamptz, metadata_json jsonb
    );
    CREATE TABLE harness_shared.coord_presence (workspace_id text, owner_id text);
    CREATE TABLE harness_shared.work_items (
      workspace_id text, feature_id text, taken_by text, terminal_owner text,
      worked_by_history jsonb
    );
    CREATE TABLE harness_shared.routines (target_owner_id text, name text, active boolean);
    CREATE TABLE harness_shared.event_awaits (
      subscriber_id text, policy text, event_key text, note text,
      fired_at timestamptz, cancelled_at timestamptz, expires_ts timestamptz
    );
  `);
});

afterAll(async () => {
  holder.sql = null;
  if (sql) await sql.end({ timeout: 5 });
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
});

describe('fresh-launch tool-call attribution (real PG)', () => {
  it('does not credit same-owner predecessor calls to a successor with no native session or first turn', async () => {
    const since = Date.now() - 5_000;
    const firstSeen = since + 1_500;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (1, NULL, 'su-shared-owner', 'ws-launch', to_timestamp(${firstSeen / 1000}),
              '{}'::jsonb, '["psu", "--launched-by=su-launcher"]'::jsonb)
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES ('ws-launch', 'su-shared-owner', 'ok', 'agent', 'coord:orient',
              to_timestamp(${(since - 100) / 1000}))
    `;

    const probe = () => probeFreshLaunchSessions({
      workspaceId: 'ws-launch', launcherOwnerId: 'su-launcher', since,
    });
    const before = await probe();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      sessionId: null, successfulCalls: 0,
      workerAttestation: { ready: false, stages: { agentCall: { status: 'missing' } } },
    });
    expect(before[0]?.msSinceLastSignal).toBeNull();

    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES ('ws-launch', 'su-shared-owner', 'ok', 'agent', 'coord:orient',
              to_timestamp(${(firstSeen + 100) / 1000}))
    `;
    const after = await probe();
    expect(after[0]?.successfulCalls).toBe(1);
    expect(after[0]?.workerAttestation.stages.agentCall.status).toBe('satisfied');
  });
});
