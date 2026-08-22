import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { authorizePersonalAccess } from './authorization';
import {
  createPersonalGrant,
  purgePersonalSource,
  searchPersonalDocuments,
  setPersonalSyncState,
  setPersonalVaultEnabled,
  upsertPersonalDocuments,
} from './store';
import { ingestPersonalExternalEvent, syncGoogleContacts } from './live-sink';

let org: OrgTestDb;
let userId: string;
const WS = 'personal-vault-test';

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'personal-test-' + Date.now()}, 'Personal Test') RETURNING id`;
  userId = user.id;
});

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_documents WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_sync_state WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE user_id = ${userId}`;
});

describe('Personal Vault core', () => {
  it('upserts/dedupes and hybrid-searches with scope, participant, time, and bounded snippets', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [
      { source: 'gmail', kind: 'message', externalId: 'm1', occurredAt: '2026-08-21T12:00:00Z', participants: ['ada@example.com'], title: 'Launch notes', text: 'The launch checklist includes privacy verification. '.repeat(30), dedupeKey: 'm1' },
      { source: 'calendar', kind: 'event', externalId: 'e1', occurredAt: '2026-08-20T12:00:00Z', participants: ['bob@example.com'], title: 'Dinner', text: 'Restaurant booking', dedupeKey: 'e1' },
    ]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [
      { source: 'gmail', kind: 'message', externalId: 'm1', participants: ['ada@example.com'], title: 'Launch notes', text: 'Updated privacy verification', dedupeKey: 'm1' },
    ]);
    const results = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'privacy verification', scopes: ['gmail'], participants: ['ada@example.com'],
      timeRange: { from: '2026-08-01T00:00:00Z' }, snippetChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: 'gmail', scopeKey: 'personal:gmail', title: 'Launch notes' });
    expect(results[0]!.snippet.length).toBeLessThanOrEqual(100);
    const count = await org.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int n FROM harness_shared.personal_documents WHERE user_id = ${userId}`;
    expect(count[0].n).toBe(2);
  });

  it('is default-deny, grants a non-coding role, and hard-denies coding roles', async () => {
    const baseCtx = { workspaceId: WS, role: 'meeting-prep' };
    expect((await authorizePersonalAccess(org.adminSql, baseCtx, WS, userId, ['gmail'])).allowed).toBe(false);
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: ['gmail'], grantedBy: 'owner',
    });
    const granted = await authorizePersonalAccess(org.adminSql, baseCtx, WS, userId, ['personal:gmail']);
    expect(granted).toMatchObject({ allowed: true, scopes: ['personal:gmail'] });
    const coding = await authorizePersonalAccess(org.adminSql, { workspaceId: WS, role: 'worker' }, WS, userId, ['gmail']);
    expect(coding).toMatchObject({ allowed: false, reason: 'coding_agent_denied' });
  });

  it('kill-switches all writes and purge removes documents plus cursor state', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{ source: 'gmail', kind: 'message', title: 'x', dedupeKey: 'x' }]);
    await setPersonalSyncState(org.adminSql, WS, userId, 'gmail', { historyId: '1' });
    const deleted = await purgePersonalSource(org.adminSql, WS, userId, 'gmail');
    expect(deleted).toMatchObject({ documents: 1, cursors: 1 });
    await setPersonalVaultEnabled(org.adminSql, WS, userId, false, 'owner');
    await expect(upsertPersonalDocuments(org.adminSql, WS, userId, [{ source: 'gmail', kind: 'message', dedupeKey: 'blocked' }])).rejects.toThrow('personal_vault_disabled');
  });

  it('consumes normalized Gmail/Calendar events and paged Google Contacts locally', async () => {
    await ingestPersonalExternalEvent(org.adminSql, WS, userId, {
      key: 'ext:gmail:message-received', externalId: 'live-m1', occurredAt: '2026-08-22T00:00:00Z',
      payload: { from: 'ada@example.com', to: ['bob@example.com'], subject: 'Live mail', text: 'Hello' },
    });
    const fakeFetch = async () => new Response(JSON.stringify({
      connections: [{ resourceName: 'people/1', names: [{ displayName: 'Ada' }], emailAddresses: [{ value: 'ada@example.com' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const synced = await syncGoogleContacts(org.adminSql, { workspaceId: WS, userId, accessToken: 'local-test-token', fetchImpl: fakeFetch as typeof fetch });
    expect(synced).toMatchObject({ contacts: 1, pages: 1, nextPageToken: null });
    const rows = await org.adminSql<Array<{ source: string }>>`
      SELECT source FROM harness_shared.personal_documents WHERE user_id = ${userId} ORDER BY source`;
    expect(rows.map((r) => r.source)).toEqual(['contacts', 'gmail']);
  });
});
