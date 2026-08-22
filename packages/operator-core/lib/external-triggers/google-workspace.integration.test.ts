import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { provisionOwnedGoogleWorkspaceSources } from './google-workspace';

const WS = 'google-workspace-source-test';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'google-workspace-owner-' + Date.now()}, 'Workspace Owner')
    RETURNING id`;
  userId = users[0].id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('Google Workspace owned trigger-source provisioning', () => {
  it('creates Gmail + Calendar once and preserves cursors across re-consent', async () => {
    const first = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      field: 'owner',
    });
    expect(first.map((row) => row.kind).sort()).toEqual(['gcal', 'gmail']);
    expect(first.every((row) => row.credentialRef === 'google-workspace:owner')).toBe(true);

    const calendar = first.find((row) => row.kind === 'gcal')!;
    await sql`
      UPDATE harness_shared.trigger_sources
         SET cursor = '{"syncToken":"keep-me"}'::jsonb,
             status = 'degraded',
             last_error = 'transient'
       WHERE workspace_id = ${WS} AND id = ${calendar.id}::uuid`;

    const second = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      field: 'owner-reconnected',
    });
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(second.every((row) => row.credentialRef === 'google-workspace:owner-reconnected')).toBe(true);
    expect(second.every((row) => row.status === 'connected')).toBe(true);
    expect(second.find((row) => row.kind === 'gcal')?.cursor).toEqual({ syncToken: 'keep-me' });

    const rows = await sql<Array<{ kind: string; count: number }>>`
      SELECT kind, count(*)::int AS count
        FROM harness_shared.trigger_sources
       WHERE workspace_id = ${WS} AND owner_user_id = ${userId}::uuid
       GROUP BY kind
       ORDER BY kind`;
    expect(rows).toEqual([
      { kind: 'gcal', count: 1 },
      { kind: 'gmail', count: 1 },
    ]);
  });
});
