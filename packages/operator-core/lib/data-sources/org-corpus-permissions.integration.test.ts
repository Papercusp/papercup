/**
 * Organization documents corpus — permission enforcement against real Postgres
 * (plan enterprise-data-sources-2026-10-01 P-014, rubric criterion R-8; schema:
 * migration 1316).
 *
 * The property under test: an organization document is returned to a principal
 * only when ALL of these hold at query time — a live `organization` vault grant,
 * the document's source permission list contains a provider identity, and that
 * identity is explicitly and live-mapped to the principal (D-002). Each case
 * below removes exactly one of them and expects the document to disappear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant, searchPersonalDocuments, upsertPersonalDocuments } from '../personal-vault/store';
import { personalVaultRefusal } from '../pg-read-query';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  replacePermissionListMembers,
  revokeProviderIdentityMapping,
  searchOrganizationDocuments,
  upsertOrganizationDocuments,
  upsertPermissionList,
} from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let bob: string;
let noGrant: string;
const WS = 'org-corpus-permissions-test';
const AGENT_ROLE = 'meeting-prep';
const ctx = { workspaceId: WS, role: AGENT_ROLE };
const SLACK_ALICE = { provider: 'slack', providerUserId: 'T1:UALICE' };
const SLACK_BOB = { provider: 'slack', providerUserId: 'T1:UBOB' };

async function makeUser(label: string): Promise<string> {
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label}) RETURNING id`;
  return user!.id;
}

async function grantOrganization(userId: string): Promise<void> {
  await createPersonalGrant(org.adminSql, {
    workspaceId: WS, userId, principalType: 'agent-role', principalId: AGENT_ROLE,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
  });
}

/** A Slack channel list with `members`, holding one document about the cobalt roadmap. */
async function seedChannel(members: Array<{ provider: string; providerUserId: string }>): Promise<string> {
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: 'T1:CROADMAP', title: '#roadmap' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, members);
  await upsertOrganizationDocuments(org.adminSql, WS, list.id, [{
    source: 'slack', kind: 'message', dedupeKey: 'T1:CROADMAP:1700000000.000100',
    externalId: '1700000000.000100', occurredAt: '2026-09-30T12:00:00Z',
    title: '#roadmap', text: 'The cobalt roadmap ships the quarterly planning review.',
  }]);
  return list.id;
}

async function search(userId: string, role = AGENT_ROLE) {
  return searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: 'org-corpus-test', query: 'cobalt roadmap',
  });
}

async function visibleTitles(userId: string): Promise<string[]> {
  const out = await search(userId);
  if (!out.allowed) throw new Error(`expected allowed search, got ${out.reason}`);
  return out.results.map((r) => r.title);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  alice = await makeUser('org-corpus-alice');
  bob = await makeUser('org-corpus-bob');
  noGrant = await makeUser('org-corpus-nogrant');
});

afterAll(async () => {
  for (const id of [alice, bob, noGrant].filter(Boolean)) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await grantOrganization(alice);
  await grantOrganization(bob);
});

describe('organization corpus permissions (R-8)', () => {
  it('returns the document to a granted principal whose mapped identity is on the list', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    const out = await search(alice);
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.results.map((r) => r.title)).toEqual(['#roadmap']);
    expect(out.results[0]).toMatchObject({ source: 'slack', kind: 'message', externalId: '1700000000.000100' });
    expect(out.withheld).toBe(0);
  });

  it('returns nothing to a granted principal with no mapped provider identity', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await visibleTitles(bob)).toEqual([]);
  });

  it('a mapped identity that is not on the list grants nothing', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await visibleTitles(bob)).toEqual([]);
  });

  it('a membership refresh moves access on the next read, with no cache to invalidate', async () => {
    const listId = await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);
    expect(await visibleTitles(bob)).toEqual([]);

    const delta = await replacePermissionListMembers(org.adminSql, WS, listId, [SLACK_BOB]);
    expect(delta).toEqual({ added: 1, removed: 1 });
    expect(await visibleTitles(alice)).toEqual([]);
    expect(await visibleTitles(bob)).toEqual(['#roadmap']);
  });

  it('revoking a mapping removes access; the identity can then be mapped to someone else', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);

    await expect(
      mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: bob, mappedBy: 'owner' }),
    ).rejects.toThrow('provider_identity_already_mapped');

    const revoked = await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
    expect(revoked).toEqual({ revoked: 1 });
    expect(await visibleTitles(alice)).toEqual([]);

    const remapped = await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: bob, mappedBy: 'owner' });
    expect(remapped.created).toBe(true);
    expect(await visibleTitles(bob)).toEqual(['#roadmap']);
  });

  it('refuses without a live organization grant, even when the ACL would allow it', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: noGrant, mappedBy: 'owner' });
    expect(await search(noGrant)).toEqual({ allowed: false, reason: 'no_live_grant' });
  });

  it('hard-denies a coding role regardless of grant and ACL', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await search(alice, 'worker')).toEqual({ allowed: false, reason: 'coding_agent_denied' });
  });

  it('personal search never returns organization rows, and organization search never returns personal rows', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    await upsertPersonalDocuments(org.adminSql, WS, alice, [{
      source: 'gmail', kind: 'message', externalId: 'p1', participants: [],
      title: 'Personal cobalt roadmap', text: 'My own cobalt roadmap notes.', dedupeKey: 'p1',
    }]);
    const personal = await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'cobalt roadmap' });
    expect(personal.map((r) => r.title)).toEqual(['Personal cobalt roadmap']);
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);
  });

  it('the schema refuses an organization row that names an owner or omits its list', async () => {
    const listId = await seedChannel([]);
    await expect(org.adminSql`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, scope, permission_list_id, source, kind, dedupe_key)
      VALUES (${WS}, ${alice}, 'organization', ${listId}::uuid, 'slack', 'message', 'owned')`,
    ).rejects.toThrow(/personal_documents_scope_chk/);
    await expect(org.adminSql`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, scope, permission_list_id, source, kind, dedupe_key)
      VALUES (${WS}, NULL, 'organization', NULL, 'slack', 'message', 'listless')`,
    ).rejects.toThrow(/personal_documents_scope_chk/);
  });

  it('ad-hoc SQL against the access-control tables is refused', () => {
    for (const table of ['document_permission_lists', 'document_permission_members', 'provider_identity_mappings']) {
      expect(personalVaultRefusal(`SELECT * FROM harness_shared.${table}`)).toMatch(/organization documents corpus/);
    }
  });
});
