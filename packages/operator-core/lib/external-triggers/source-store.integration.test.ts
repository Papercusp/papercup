import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createOwnedExternalTriggerSource,
  getExternalTriggerSource,
  requireExternalTriggerSourceOwner,
} from './source-store';

const WS = 'external-source-owner-test';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'trigger-owner-' + Date.now()}, 'Trigger Owner')
    RETURNING id`;
  userId = users[0].id;
});

afterAll(async () => {
  if (sql) await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`.catch(() => {});
  if (sql && userId) await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
});

describe('external trigger source ownership', () => {
  it('persists and resolves only the authenticated local principal', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:test-owner',
      status: 'ready',
      createdBy: 'audit-agent-not-the-user',
      config: { providerSubject: 'untrusted-provider-subject' },
    });

    expect(source).toMatchObject({
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:test-owner',
    });
    await expect(requireExternalTriggerSourceOwner(sql, WS, source.id)).resolves.toBe(userId);
    await expect(getExternalTriggerSource(sql, WS, source.id)).resolves.toMatchObject({ ownerUserId: userId });
  });

  it('fails closed for a legacy row even when audit and provider fields look like users', async () => {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, status, created_by, config)
      VALUES (
        ${WS}, 'gmail', 'ready', ${userId},
        ${JSON.stringify({ userId, owner: userId })}::text::jsonb
      )
      RETURNING id`;

    await expect(requireExternalTriggerSourceOwner(sql, WS, rows[0].id))
      .rejects.toThrow(`external_trigger_source_owner_required:${rows[0].id}`);
  });

  it('enforces the local-user foreign key at the database boundary', async () => {
    await expect(createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(/trigger_sources_owner_user_id_fkey/);
  });
});
