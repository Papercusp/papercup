import AdmZip from 'adm-zip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { buildPersonalAmbientContextBlock, type PersonalAmbientDeps } from './ambient';
import { parsePersonalArchive } from './archive-import';
import { authorizePersonalAccess } from './authorization';
import {
  createPersonalGrant,
  replacePersonalGrant,
  purgePersonalSource,
  searchPersonalDocuments,
  setPersonalSyncState,
  setPersonalVaultEnabled,
  upsertPersonalDocuments,
} from './store';
import {
  createPersonalVaultExternalSinkForSource,
  syncGoogleContacts,
} from './live-sink';

let org: OrgTestDb;
let userId: string;
const WS = 'personal-vault-test';

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'personal-test-' + Date.now()}, 'Personal Test') RETURNING id`;
  userId = user.id;
  const emailType = await getDatatype(org.adminSql, 'papercusp-workspace', 'email-message');
  if (!emailType) throw new Error('personal_vault_test_email_datatype_missing');
  await upsertDatatype(org.adminSql, {
    id: emailType.id,
    workspaceId: WS,
    potSlug: emailType.potSlug,
    title: emailType.title,
    description: emailType.description,
    tier: emailType.tier,
    workItemKind: emailType.workItemKind,
    payloadSchema: emailType.payloadSchema,
    authoritativeWriter: emailType.authoritativeWriter,
    selfImprovement: emailType.selfImprovement,
    published: emailType.published,
    tags: emailType.tags,
    createdBy: 'personal-vault-integration',
  });
});

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_documents WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_sync_state WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_identity_aliases WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_identities WHERE user_id = ${userId}`;
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

  it('ambient recall is positive only for the granted context and byte-empty otherwise', async () => {
    const archive = new AdmZip();
    archive.addFile('Takeout/Mail/All mail Including Spam and Trash.mbox', Buffer.from(
      'From sender@example.com Tue Jan 1 00:00:00 2026\n'
      + 'Message-ID: <ambient-mail-1@example.com>\n'
      + 'Date: Tue, 01 Jan 2026 00:00:00 +0000\n'
      + 'From: Ada <ada@example.com>\n'
      + 'To: Owner <owner@example.com>\n'
      + 'Subject: Acme renewal review\n\n'
      + 'Ada requested a renewal timeline review before Friday.',
    ));
    const parsed = parsePersonalArchive('takeout.zip', archive.toBuffer());
    expect(parsed).toMatchObject({ sources: ['gmail'], warnings: [] });
    await upsertPersonalDocuments(org.adminSql, WS, userId, parsed.documents);
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: ['gmail'], grantedBy: 'owner',
    });
    // Even an explicit grant must not bypass the absolute coding-role fence.
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'worker',
      scopes: ['gmail'], grantedBy: 'owner',
    });

    const build = (role: string) => buildPersonalAmbientContextBlock(
      { ownerId: `agent-${role}`, userId, workspaceId: WS, query: 'Acme renewal' },
      {
        sql: org.adminSql,
        resolveContext: async () => ({ workspaceId: WS, role }),
        authorize: authorizePersonalAccess,
        embedQuery: async () => null,
        search: searchPersonalDocuments,
      } satisfies PersonalAmbientDeps,
    );

    const granted = await build('meeting-prep');
    expect(granted).toContain('## Granted Personal Vault context');
    expect(granted).toContain('Acme renewal review');
    await expect(build('ungranted-assistant')).resolves.toBeNull();
    await expect(build('worker')).resolves.toBeNull();
  });

  it('owner approval replaces a broader live grant instead of leaving stale access', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'plan-template', principalId: 'meeting-prep',
      scopes: ['gmail', 'calendar'], grantedBy: 'owner',
    });
    const replacement = await replacePersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'plan-template', principalId: 'meeting-prep',
      scopes: ['gmail'], grantedBy: 'owner',
    });
    expect(replacement).toMatchObject({ scopes: ['personal:gmail'], revoked: 1 });
    const live = await org.adminSql<Array<{ scopes: string[] }>>`
      SELECT scopes FROM harness_shared.personal_grants
       WHERE user_id = ${userId} AND principal_type = 'plan-template'
         AND principal_id = 'meeting-prep' AND revoked_at IS NULL`;
    expect(live).toEqual([{ scopes: ['personal:gmail'] }]);
  });

  it('resolves one human across contact email, mail address, and social display name', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'contacts', kind: 'contact', externalId: 'people/ada',
      participants: ['ada@example.com'], title: 'Ada Lovelace', text: 'ada@example.com', dedupeKey: 'ada-contact',
    }]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'gmail', kind: 'message', externalId: 'mail-ada',
      participants: ['Ada Lovelace <ada@example.com>'], title: 'Project Phoenix', text: 'Project Phoenix update', dedupeKey: 'ada-mail',
    }]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'instagram', kind: 'message', externalId: 'social-ada',
      participants: ['Ada Lovelace'], title: 'Ada thread', text: 'Project Phoenix follow-up', dedupeKey: 'ada-social',
    }]);
    const rows = await org.adminSql<Array<{ source: string; participant_ids: string[] }>>`
      SELECT source, participant_ids FROM harness_shared.personal_documents
       WHERE user_id = ${userId} ORDER BY source`;
    expect(rows.every((row) => row.participant_ids.length === 1)).toBe(true);
    expect(new Set(rows.flatMap((row) => row.participant_ids)).size).toBe(1);

    const found = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'Project Phoenix', participants: ['ada@example.com'], limit: 10,
    });
    expect(found.map((row) => row.source).sort()).toEqual(['gmail', 'instagram']);
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
    const sources = await org.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, status)
      VALUES (${WS}, 'gmail', ${userId}, 'ready')
      RETURNING id`;
    const sink = await createPersonalVaultExternalSinkForSource(org.adminSql, WS, sources[0].id);
    expect(sink).toMatchObject({ kind: 'personal-vault', ref: `user:${userId}` });
    const event = {
      id: 'live-m1', from: 'ada@example.com', to: ['bob@example.com'],
      subject: 'Live mail', text: 'Hello',
    };
    const ingested = await ingestExternalTriggerEvent(org.adminSql, {
      workspaceId: WS,
      sourceId: sources[0].id,
      source: 'gmail',
      event: 'message.received',
      externalId: event.id,
      datatypeId: 'email-message',
      adapterPayload: event,
      normalize: (payload) => payload as typeof event,
      occurredAt: '2026-08-22T00:00:00Z',
      additionalSinks: [sink],
    }, {
      emit: async () => ({ ok: true, key: 'ext:gmail:message.received', woken: 0, notified: [], msgId: null, waiters: 0 }),
    });
    expect(ingested.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered' }),
    ]));
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
