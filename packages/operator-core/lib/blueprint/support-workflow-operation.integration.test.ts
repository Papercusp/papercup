import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { compileAgentSpecification, BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import { submitBlueprintOperation } from './operation-service';
import { supportToEngineeringOperation } from './support-workflow-operation';
import { createPersonalGrant } from '../personal-vault/store';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, replacePermissionListMembers,
  upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'support-operation-test';
const harnessSlug = 'support-operation';
const role = 'support-worker';
let db: OrgTestDb;
let userId: string;
let documentId: string;
let listId: string;
let revision: string;
const selection = () => ({ supportCaseId: 'case-cobalt', approvedRevision: revision,
  documentIds: [documentId], query: 'cobalt roadmap', requestedAction: 'prepare-handoff' });
const submit = (requestKey: string, overrides: Record<string, unknown> = {},
  principal = { kind: 'user', trust: 'verified', slug: userId, workspaceId }) => submitBlueprintOperation(db.adminSql, {
    workspaceId, harnessSlug, callerId: `${userId}/employee`, operationId: 'support-to-engineering',
    requestKey, expectedSpecificationRevision: revision, input: selection(), ...overrides,
  }, { principal });

beforeAll(async () => {
  db = await createOrgTestDb();
  connection.sql = db.adminSql;
  const [user] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-employee-${crypto.randomUUID()}`}, 'Support employee') RETURNING id`;
  userId = user!.id;
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'support-test-key', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await createPersonalGrant(db.adminSql, { workspaceId, userId, principalType: 'agent-role', principalId: role,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner' });
  const provider = { provider: 'slack', providerUserId: 'T1:EMPLOYEE' };
  await mapProviderIdentity(db.adminSql, workspaceId, { ...provider, userId, mappedBy: 'owner' });
  const list = await upsertPermissionList(db.adminSql, workspaceId, { source: 'slack', sourceRef: 'T1:CSUPPORT' });
  listId = list.id;
  await replacePermissionListMembers(db.adminSql, workspaceId, listId, [provider]);
  await upsertOrganizationDocuments(db.adminSql, workspaceId, listId, [{ source: 'slack', kind: 'message',
    dedupeKey: 'support-case-cobalt', externalId: 'T1:CSUPPORT:123', title: 'Cobalt support',
    text: 'The cobalt roadmap needs a reproducible engineering handoff.' }]);
  const [document] = await db.adminSql<{ id: string }[]>`SELECT id FROM harness_shared.documents
    WHERE workspace_id = ${workspaceId} AND dedupe_key = 'support-case-cobalt'`;
  documentId = document!.id;
  const operation = supportToEngineeringOperation({ id: 'support-to-engineering', version: '1', role,
    identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
    accountableOwner: 'engineering-owner', reviewerPrincipals: ['engineering-reviewer'],
    allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 });
  const source = BlueprintSchema.parse({ id: harnessSlug, workItem: { kind: 'task' }, roles: [{ id: role }],
    spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
    operations: [operation] });
  const specification = compileAgentSpecification({ source });
  revision = specification.specificationRevision;
  await projectBlueprintToPg(db.adminSql, { workspaceId, harnessSlug,
    blueprint: source, specification });
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe('selected support operation admission', () => {
  it('admits one revision-pinned receipt with only server-read content in the private store', async () => {
    const handle = await submit('employee-case');
    expect(handle).toMatchObject({ workspaceId, harnessSlug, operationId: 'support-to-engineering',
      specificationRevision: revision, target: { kind: 'work-item' } });
    expect(await submit('employee-case')).toEqual(handle);
    const [content] = await db.adminSql<{ content_text: string }[]>`SELECT content_text
      FROM harness_shared.blueprint_operation_private_inputs WHERE workspace_id = ${workspaceId}
      AND request_key = 'employee-case'`;
    expect(JSON.parse(content!.content_text)).toMatchObject({ supportCaseId: 'case-cobalt',
      documents: [{ id: documentId, source: 'slack', externalId: 'T1:CSUPPORT:123',
        snippet: expect.stringContaining('cobalt roadmap') }] });
    const [item] = await db.adminSql<{ payload: unknown }[]>`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND id = ${handle.target.kind === 'work-item' ? handle.target.id : ''}`;
    expect(JSON.stringify(item!.payload)).not.toContain('needs a reproducible');
  });

  it('refuses forged context, source writes, employee content and unapproved revisions before admission', async () => {
    for (const principal of [
      { kind: 'pi', trust: 'verified', slug: userId, workspaceId },
      { kind: 'user', trust: 'unverified', slug: userId, workspaceId },
      { kind: 'user', trust: 'verified', slug: userId, workspaceId: 'other-workspace' },
    ]) await expect(submit('forged-principal', {}, principal)).rejects.toThrow(/principal/);
    await expect(submit('source-write', { input: { ...selection(), requestedAction: 'publish' } })).rejects.toThrow(/outside/);
    await expect(submit('forged-content', { privateInput: { documents: [] } })).rejects.toThrow(/server-read/);
    await expect(submit('stale-revision', { expectedSpecificationRevision: 'a'.repeat(64) })).rejects.toThrow(/revision/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('forged-principal', 'source-write', 'forged-content', 'stale-revision')`;
    expect(count!.n).toBe(0);
  });

  it('refuses an inaccessible selected document and a revoked live grant without a new receipt', async () => {
    await replacePermissionListMembers(db.adminSql, workspaceId, listId, []);
    await expect(submit('revoked-source')).rejects.toThrow(/revoked/);
    await db.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid`;
    await expect(submit('revoked-grant')).rejects.toThrow(/no_live_grant/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}
      AND request_key IN ('revoked-source', 'revoked-grant')`;
    expect(count!.n).toBe(0);
  });
});
