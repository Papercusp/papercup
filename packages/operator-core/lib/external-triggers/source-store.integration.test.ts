import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createOwnedExternalTriggerSource,
  disconnectOwnedExternalTriggerSources,
  getExternalTriggerSource,
  listOwnedExternalTriggerSources,
  listPollableExternalTriggerSources,
  requireExternalTriggerSourceOwner,
  setOwnedExternalTriggerSourceCapability,
  updateExternalTriggerSourceSyncState,
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

    await expect(requireExternalTriggerSourceOwner(sql, WS, rows[0].id)).rejects.toThrow(
      `external_trigger_source_owner_required:${rows[0].id}`,
    );
  });

  it('enforces the local-user foreign key at the database boundary', async () => {
    await expect(
      createOwnedExternalTriggerSource(sql, {
        workspaceId: WS,
        kind: 'gmail',
        ownerUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/trigger_sources_owner_user_id_fkey/);
  });

  it('lists only pollable owned sources and persists cursor/status transitions', async () => {
    const extraOwners = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES
        (${'trigger-disabled-' + Date.now()}, 'Disabled Trigger Owner'),
        (${'trigger-recovering-' + Date.now()}, 'Recovering Trigger Owner')
      RETURNING id`;
    const pollable = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: extraOwners[0].id,
      credentialRef: 'google-workspace:owner',
      status: 'ready',
    });
    await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: extraOwners[1].id,
      credentialRef: 'google-workspace:disabled-owner',
      status: 'disabled',
    });
    await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner',
      status: 'connected',
    });
    const recovering = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      credentialRef: 'google-workspace:recovering-owner',
      status: 'connecting',
    });

    await expect(listPollableExternalTriggerSources(sql, WS, 'gcal')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pollable.id, kind: 'gcal', status: 'ready' }),
        expect.objectContaining({ id: recovering.id, kind: 'gcal', status: 'connecting' }),
      ]),
    );

    const connected = await updateExternalTriggerSourceSyncState(sql, WS, pollable.id, {
      status: 'connected',
      cursor: { syncToken: 'sync-2', lastSyncAt: '2026-08-22T12:00:00.000Z' },
      lastError: null,
      connected: true,
    });
    expect(connected).toMatchObject({
      status: 'connected',
      cursor: { syncToken: 'sync-2', lastSyncAt: '2026-08-22T12:00:00.000Z' },
    });

    const degraded = await updateExternalTriggerSourceSyncState(sql, WS, pollable.id, {
      status: 'degraded',
      lastError: 'provider timeout',
    });
    expect(degraded.cursor).toEqual(connected.cursor);
    const stored = await sql<Array<{ last_error: string; last_connected_at: Date | null }>>`
      SELECT last_error, last_connected_at
        FROM harness_shared.trigger_sources
       WHERE workspace_id = ${WS} AND id = ${pollable.id}::uuid`;
    expect(stored[0].last_error).toBe('provider timeout');
    expect(stored[0].last_connected_at).toBeInstanceOf(Date);
  });

  it('lists one owner safely and disconnects selected kinds without deleting rows', async () => {
    const otherUsers = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES (${'trigger-other-' + Date.now()}, 'Other Trigger Owner')
      RETURNING id`;
    const gmail = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner-user',
      status: 'connected',
      cursor: { historyId: 'private-provider-cursor', lastSyncAt: '2026-08-23T00:00:00.000Z' },
    });
    const calendar = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner-user',
      status: 'degraded',
    });
    const other = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: otherUsers[0].id,
      credentialRef: 'google-workspace:other-user',
      status: 'connected',
    });

    await expect(listOwnedExternalTriggerSources(sql, WS, userId)).resolves.toEqual([
      expect.objectContaining({ id: calendar.id, kind: 'gcal', ownerUserId: userId }),
      expect.objectContaining({ id: gmail.id, kind: 'gmail', ownerUserId: userId }),
    ]);
    await expect(disconnectOwnedExternalTriggerSources(sql, WS, userId, ['gmail', 'gcal'])).resolves.toEqual({
      sources: 2,
      credentialRefs: ['google-workspace:owner-user'],
    });

    const disconnected = await listOwnedExternalTriggerSources(sql, WS, userId);
    expect(disconnected).toEqual([
      expect.objectContaining({ id: calendar.id, status: 'disabled', credentialRef: null }),
      expect.objectContaining({ id: gmail.id, status: 'disabled', credentialRef: null }),
    ]);
    await expect(listPollableExternalTriggerSources(sql, WS, 'gmail')).resolves.toEqual([
      expect.objectContaining({ id: other.id, ownerUserId: otherUsers[0].id }),
    ]);
  });

  it('persists a per-surface toggle without clearing the shared credential or deleting the row', async () => {
    const disabled = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      enabled: false,
      createdBy: `owner:${userId}`,
    });
    expect(disabled).toMatchObject({
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      status: 'disabled',
      config: { capabilityEnabled: false },
    });
    await expect(listPollableExternalTriggerSources(sql, WS, 'contacts')).resolves.toEqual([]);

    const enabled = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      enabled: true,
      createdBy: `owner:${userId}`,
    });
    expect(enabled).toMatchObject({
      id: disabled.id,
      status: 'connected',
      config: { capabilityEnabled: true },
    });
    await expect(listPollableExternalTriggerSources(sql, WS, 'contacts')).resolves.toEqual([
      expect.objectContaining({ id: disabled.id, credentialRef: 'google-workspace:owner-user' }),
    ]);
  });
});
