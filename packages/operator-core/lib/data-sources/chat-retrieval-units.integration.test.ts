/**
 * Chat retrieval units against real Postgres (plan enterprise-data-sources-2026-10-01
 * P-015; schema: migration 1320).
 *
 * Properties under test: the indexed unit is a thread or a time-gap window rendered
 * from LIVE messages; an edit re-renders it; a delete removes the text from it; and
 * a legal hold keeps held content through every delete, erase and retention path,
 * which then proceed once the hold is released.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant } from '../personal-vault/store';
import {
  chatUnitDedupeKey,
  placeLegalHold,
  purgeExpiredChatMessages,
  releaseLegalHold,
  rollupChatUnits,
  tombstoneChatMessage,
  upsertChatMessages,
} from './chat-retrieval-units';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  replacePermissionListMembers,
  searchOrganizationDocuments,
  upsertPermissionList,
} from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let sourceId: string;
const WS = 'chat-retrieval-units-test';
const CH = 'T1:CGENERAL';

async function makeSource(permissionMode: string): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_sources (workspace_id, kind, permission_mapping)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: permissionMode })})
    RETURNING id`;
  return row!.id;
}

const msg = (id: string, at: string, body: string, threadKey: string | null = null) => ({
  channelId: CH, providerMessageId: id, threadKey, authorRef: 'T1:UALICE', authorLabel: 'alice', body, postedAt: at,
});

async function docs(): Promise<Array<{ kind: string; external_id: string; text: string }>> {
  return org.adminSql<Array<{ kind: string; external_id: string; text: string }>>`
    SELECT kind, external_id, text FROM harness_shared.personal_documents
     WHERE workspace_id = ${WS} AND scope = 'organization' ORDER BY occurred_at`;
}

async function units(): Promise<Array<{ unit_kind: string; unit_key: string; message_count: number }>> {
  return org.adminSql<Array<{ unit_kind: string; unit_key: string; message_count: number }>>`
    SELECT unit_kind, unit_key, message_count FROM harness_shared.chat_retrieval_units
     WHERE workspace_id = ${WS} ORDER BY first_posted_at`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`chat-units-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = user!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  sourceId = await makeSource('source-acl');
});

describe('chat retrieval units (P-015)', () => {
  it('rolls a thread into one unit and indexes it in the organization corpus', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('1.1', '2026-09-30T10:00:00Z', 'Who owns the cobalt migration?', '1.1'),
      msg('1.2', '2026-09-30T10:05:00Z', 'Bob owns it.', '1.1'),
    ]);
    const out = await rollupChatUnits(org.adminSql, WS);
    expect(out).toMatchObject({ buckets: 1, unitsWritten: 1, documentsWritten: 1 });
    expect(await units()).toEqual([{ unit_kind: 'thread', unit_key: '1.1', message_count: 2 }]);
    expect(await docs()).toEqual([{
      kind: 'chat-thread', external_id: '1.1', text: 'alice: Who owns the cobalt migration?\nalice: Bob owns it.',
    }]);
  });

  it('the unit is retrievable only through the channel permission list (fail closed until members arrive)', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('2.1', '2026-09-30T10:00:00Z', 'The cobalt launch moved to Friday.')]);
    await rollupChatUnits(org.adminSql, WS);
    const search = () => searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: 'chat-units-test', query: 'cobalt launch',
    });
    expect(await search()).toMatchObject({ allowed: true, results: [] });
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: CH, title: '#general' });
    await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
    const out = await search();
    expect(out.allowed && out.results.map((r) => [r.kind, r.externalId])).toEqual([['chat-window', '2.1']]);
  });

  it('an edit re-renders the unit; an identical re-delivery writes nothing', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Tuesday')]);
    await rollupChatUnits(org.adminSql, WS);
    expect(await upsertChatMessages(org.adminSql, WS, sourceId, [msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Tuesday')]))
      .toEqual({ written: 0, unchanged: 1 });
    await upsertChatMessages(org.adminSql, WS, sourceId, [{ ...msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Thursday'), editedAt: '2026-09-30T10:02:00Z' }]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsWritten: 1 });
    expect((await docs()).map((d) => d.text)).toEqual(['alice: Ship on Thursday']);
  });

  it('a delete tombstones the message and removes its text; an emptied unit disappears', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('4.1', '2026-09-30T10:00:00Z', 'keep this', '4.1'),
      msg('4.2', '2026-09-30T10:01:00Z', 'secret token abc', '4.1'),
    ]);
    await rollupChatUnits(org.adminSql, WS);
    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '4.2' }))
      .toEqual({ tombstoned: true, held: false });
    const [raw] = await org.adminSql<{ body: string | null; deleted_at: Date | null }[]>`
      SELECT body, deleted_at FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '4.2'`;
    expect(raw).toMatchObject({ body: null });
    expect(raw!.deleted_at).not.toBeNull();
    await rollupChatUnits(org.adminSql, WS);
    expect((await docs()).map((d) => d.text)).toEqual(['alice: keep this']);

    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '4.1' });
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsRemoved: 1 });
    expect(await units()).toEqual([]);
    expect(await docs()).toEqual([]);
  });

  // Spec AUTO-BAR-R-9-P-015: search over ingested chat returns thread rollups, never
  // raw message rows, and edited or deleted text is not retrievable through search.
  it('search returns the thread rollup, not message rows; edited and deleted text is not searchable', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: CH, title: '#general' });
    await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('5.1', '2026-09-30T10:00:00Z', 'The zircon rollout starts Monday', '5.1'),
      msg('5.2', '2026-09-30T10:01:00Z', 'zircon owner is carol', '5.1'),
      msg('5.3', '2026-09-30T10:02:00Z', 'zircon budget password hunter2', '5.1'),
    ]);
    await rollupChatUnits(org.adminSql, WS);
    const search = async (query: string) => {
      const out = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
        workspaceId: WS, principalUserId: alice, agentOwnerId: 'chat-units-test', query,
      });
      if (!out.allowed) throw new Error(`search refused for ${query}`);
      return out.results.map((r) => [r.kind, r.externalId]);
    };

    // Three matching messages yield ONE hit: the thread rollup, never a message row.
    expect(await search('zircon')).toEqual([['chat-thread', '5.1']]);

    await upsertChatMessages(org.adminSql, WS, sourceId, [
      { ...msg('5.1', '2026-09-30T10:00:00Z', 'The zircon rollout starts Wednesday', '5.1'), editedAt: '2026-09-30T10:05:00Z' },
    ]);
    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '5.3' });
    await rollupChatUnits(org.adminSql, WS);

    expect(await search('Monday')).toEqual([]);
    expect(await search('hunter2')).toEqual([]);
    expect(await search('Wednesday')).toEqual([['chat-thread', '5.1']]);
    expect(await search('carol')).toEqual([['chat-thread', '5.1']]);
  });

  it('splits non-thread messages into time-gap windows and merges them when the gap closes', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('5.1', '2026-09-30T10:00:00Z', 'a'),
      msg('5.2', '2026-09-30T10:10:00Z', 'b'),
      msg('5.3', '2026-09-30T11:00:00Z', 'c'),
    ]);
    await rollupChatUnits(org.adminSql, WS, { gapMinutes: 30 });
    expect(await units()).toEqual([
      { unit_kind: 'window', unit_key: '5.1', message_count: 2 },
      { unit_kind: 'window', unit_key: '5.3', message_count: 1 },
    ]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('5.4', '2026-09-30T10:35:00Z', 'bridge')]);
    expect(await rollupChatUnits(org.adminSql, WS, { gapMinutes: 30 })).toMatchObject({ unitsRemoved: 1 });
    expect(await units()).toEqual([{ unit_kind: 'window', unit_key: '5.1', message_count: 4 }]);
    expect((await docs()).map((d) => d.external_id)).toEqual(['5.1']);
  });

  it('a legal hold keeps held content through delete, erase, edit and retention, then releases it', async () => {
    await org.adminSql`
      UPDATE harness_shared.trigger_sources SET retention_policy = '{"maxAgeDays": 30}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('6.1', '2026-01-01T10:00:00Z', 'old held message'),
      msg('6.2', '2026-09-30T10:00:00Z', 'original wording'),
    ]);
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: CH, reason: 'litigation 42', placedBy: 'owner' });

    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '6.1' }))
      .toEqual({ tombstoned: true, held: true });
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('6.2', '2026-09-30T10:00:00Z', 'edited wording')]);
    await expect(org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '6.2'`)
      .rejects.toThrow(/chat_message_under_legal_hold/);
    await expect(org.adminSql`UPDATE harness_shared.chat_messages SET body = NULL WHERE workspace_id = ${WS} AND provider_message_id = '6.1'`)
      .rejects.toThrow(/chat_message_under_legal_hold/);
    await expect(org.adminSql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`)
      .rejects.toThrow();

    const now = new Date('2026-10-01T00:00:00Z');
    expect(await purgeExpiredChatMessages(org.adminSql, WS, { now })).toEqual({ expired: 0, tombstonesErased: 0, revisionsDropped: 0 });
    const held = await org.adminSql<{ provider_message_id: string; body: string | null; held_revisions: unknown[] }[]>`
      SELECT provider_message_id, body, held_revisions FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} ORDER BY provider_message_id`;
    expect(held.map((m) => [m.provider_message_id, m.body, m.held_revisions.length])).toEqual([
      ['6.1', 'old held message', 0],
      ['6.2', 'edited wording', 1],
    ]);
    await rollupChatUnits(org.adminSql, WS);
    expect((await docs()).map((d) => d.text)).toEqual(['alice: edited wording']);

    expect(await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' })).toEqual({ released: 1 });
    expect(await purgeExpiredChatMessages(org.adminSql, WS, { now })).toEqual({ expired: 1, tombstonesErased: 0, revisionsDropped: 1 });
    const after = await org.adminSql<{ provider_message_id: string; held_revisions: unknown[] }[]>`
      SELECT provider_message_id, held_revisions FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
    expect(after.map((m) => [m.provider_message_id, m.held_revisions.length])).toEqual([['6.2', 0]]);
  });

  it('erases a tombstone kept by a hold once the hold is released', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('7.1', '2026-09-30T10:00:00Z', 'retracted')]);
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, reason: 'audit', placedBy: 'owner' });
    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '7.1' });
    await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' });
    expect(await purgeExpiredChatMessages(org.adminSql, WS)).toMatchObject({ tombstonesErased: 1 });
    const [row] = await org.adminSql<{ body: string | null }[]>`
      SELECT body FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '7.1'`;
    expect(row).toEqual({ body: null });
  });

  it('computes units but writes no corpus row when permission mapping is not source-acl', async () => {
    await org.adminSql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
    const ownerOnly = await makeSource('owner');
    await upsertChatMessages(org.adminSql, WS, ownerOnly, [msg('8.1', '2026-09-30T10:00:00Z', 'not for the corpus')]);
    const out = await rollupChatUnits(org.adminSql, WS);
    expect(out).toMatchObject({ unitsWritten: 1, documentsWritten: 0, corpusSkipped: { permission_mapping_not_source_acl: 1 } });
    expect(await docs()).toEqual([]);
    expect(chatUnitDedupeKey(ownerOnly, CH, 'window', '8.1')).toBe(`chat:${ownerOnly}:${CH}:window:8.1`);
  });
});
