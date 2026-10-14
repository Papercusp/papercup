/**
 * Organization data receipts against real Postgres (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-007c, WI-6554700010011593).
 *
 * Acceptance under test:
 *  - export, deletion and restore each write one receipt row to papercusp_auth.organization_audit_events
 *    covering the declared store population;
 *  - secret-class columns (data_sources.credential_ref, trigger and push secret ciphertext) never appear in an export;
 *  - the population is closed under FK children of its pilot stores, so deletion counts every
 *    data-source dependent and a source with trigger bindings or deliveries (ON DELETE RESTRICT) is still deleted;
 *  - a row under a legal hold survives deletion and the receipt names the hold conflict;
 *  - a restore exercise on this scratch database brings a revoked identity back, and
 *    reconciliation denies it again.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { admitHostedCustomerDeletion, exportHostedOrganizationData, exportHostedUserData } from './hosted-customer-data';
import { authorizeHostedCustomerDeletion, freezeHostedCustomerDeletionAccess, HOSTED_DELETION_SNAPSHOT_ACTION,
  readHostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import { createPersonalGrant, purgePersonalSource, upsertPersonalDocuments } from '../personal-vault/store';
import {
  CHAT_DERIVED_DOCUMENT_KINDS,
  CHAT_WINDOW_DOCUMENT_KIND,
  containerPermissionRef,
  placeLegalHold,
  releaseLegalHold,
  upsertChatMessages,
} from '../data-sources/chat-retrieval-units';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  replacePermissionListMembers,
  revokeProviderIdentityMapping,
  searchOrganizationDocuments,
  upsertOrganizationDocuments,
  upsertPermissionList,
} from '../data-sources/documents-corpus';
import {
  DATA_SOURCE_DEPENDENTS,
  HOSTED_EXPORT_BRIDGED_STORES,
  PILOT_STORE_ACCESS_COLUMNS,
  RECEIPT_ACTIONS,
  deleteOrganizationData,
  documentsReadableThroughIdentity,
  exportOrganizationData,
  planOrganizationDataOperation,
  reconcileRestoredAccess,
  type OrganizationDataScope,
} from './organization-data-receipts';

let org: OrgTestDb;
let alice: string;
const WS = 'org-data-receipts-test';
const HELD = 'T1:CHELD';
const OPEN = 'T1:COPEN';
const SLACK_ALICE = { provider: 'slack', providerUserId: 'T1:UALICE' };
const actor = { kind: 'system' as const, id: 'org-data-receipts-test' };
let scope: OrganizationDataScope;
let sourceId: string;

const msg = (channelId: string, id: string, body: string) => ({
  channelId, providerMessageId: id, threadKey: null, authorRef: 'T1:UALICE', authorLabel: 'alice', body,
  postedAt: '2026-09-30T10:00:00Z',
});

async function receiptRow(id: string) {
  const [row] = await org.adminSql<Array<{ action: string; actor_kind: string; organization_id: string; metadata: Record<string, any> }>>`
    SELECT action, actor_kind, organization_id::text AS organization_id, metadata
      FROM papercusp_auth.organization_audit_events WHERE id = ${id}::uuid`;
  return row!;
}

async function count(store: string): Promise<number> {
  const rows = await org.adminSql.unsafe<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM ${store} WHERE workspace_id = $1`, [WS]);
  return Number(rows[0]!.n);
}

async function aliceSearch(): Promise<string[]> {
  const out = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
    workspaceId: WS, principalUserId: alice, agentOwnerId: 'org-data-receipts-test', query: 'cobalt roadmap',
  });
  if (!out.allowed) throw new Error(`organization search refused: ${out.reason}`);
  return out.results.map((r) => r.title);
}

/**
 * A Slack source with a credential reference, two channels (one held), a permission list, one document,
 * and one row in each data-source dependent that has required columns (trigger binding and delivery
 * reference the source ON DELETE RESTRICT).
 */
async function seed(opts: { hold: boolean }): Promise<void> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: 'source-acl' })}, 'vault://org-data-receipts/slack-bot')
    RETURNING id`;
  sourceId = row!.id;
  // A direct work-item target: goal_id and plan_slug carry FKs this seed would have to satisfy too.
  const [binding] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, event_pattern, work_item_kind, work_item_harness_slug)
    VALUES (${WS}, ${sourceId}::uuid, 'slack.message', 'task', 'papercusp')
    RETURNING id`;
  // trigger_deliveries.datatype_id is NOT NULL with an FK (ON DELETE RESTRICT) to the workspace's
  // datatype registry. The registry row is not part of the data-source scope, so it survives each
  // reset; the per-file cloned database is dropped in afterAll.
  await org.adminSql`
    INSERT INTO harness_shared.datatype_registry (workspace_id, id, title, description, nature)
    VALUES (${WS}, 'slack.message', 'Slack message', 'A Slack channel message event.', 'event')
    ON CONFLICT (workspace_id, id) DO NOTHING`;
  const [delivery] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, sink_kind, sink_ref, outcome, payload)
    VALUES (${WS}, ${sourceId}::uuid, 'org-data-receipts:1', 'slack.message', 'slack.message', 'goal',
      'org-data-receipts-goal', 'delivered', ${org.adminSql.json({ text: 'delivered event' })})
    RETURNING id`;
  // Grandchild of the source through both parents (ON DELETE RESTRICT on each).
  await org.adminSql`
    INSERT INTO harness_shared.trigger_runs (workspace_id, binding_id, delivery_id, dedupe_key, args)
    VALUES (${WS}, ${binding!.id}::uuid, ${delivery!.id}::uuid, 'org-data-receipts:run:1',
      ${org.adminSql.json({ text: 'derived from the delivered event' })})`;
  await org.adminSql`
    INSERT INTO harness_shared.trigger_webhook_secrets (workspace_id, source_id, secret_ct)
    VALUES (${WS}, ${sourceId}::uuid, ${Buffer.from('webhook-secret-ciphertext')})`;
  await org.adminSql`
    INSERT INTO harness_shared.connector_push_secrets (workspace_id, source_id, secret_ct)
    VALUES (${WS}, ${sourceId}::uuid, ${Buffer.from('push-secret-ciphertext')})`;
  await org.adminSql`
    INSERT INTO harness_shared.admission_rules (workspace_id, data_source_id, title, match, harness_slug, created_by)
    VALUES (${WS}, ${sourceId}::uuid, 'admit bug reports', ${org.adminSql.json({ channel: OPEN })}, 'papercusp', 'org-data-receipts-test')`;
  await upsertChatMessages(org.adminSql, WS, sourceId, [msg(HELD, '1.1', 'held message'), msg(OPEN, '2.1', 'open message')]);
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: OPEN, title: '#roadmap' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, [SLACK_ALICE]);
  await upsertOrganizationDocuments(org.adminSql, WS, list.id, [{
    source: 'slack', kind: 'message', dedupeKey: 'T1:COPEN:2.1', externalId: '2.1', occurredAt: '2026-09-30T10:00:00Z',
    title: '#roadmap', text: 'The cobalt roadmap ships the quarterly planning review.',
  }]);
  await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
  if (opts.hold) await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: HELD, reason: 'litigation 7', placedBy: 'owner' });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1509-hosted-customer-data-workspace-export.sql', import.meta.url);
  await org.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(`${migration.href}.DRAFT`), 'utf8'));
  const freeze = new URL('../../../../libs/papercusp/libs/db/sql/1513-hosted-customer-deletion-freeze.sql', import.meta.url);
  await org.adminSql.unsafe(readFileSync(existsSync(freeze) ? freeze : new URL(`${freeze.href}.DRAFT`), 'utf8'));
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`org-data-receipts-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = user!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  scope = { organizationId: randomUUID(), workspaceIds: [WS] };
  await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  // ON DELETE RESTRICT descendants first, child before parent; the other dependents cascade.
  await org.adminSql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
});

describe('organization data receipts (P-007c)', () => {
  it('the hosted role can read the whole declared export population directly or through the fixed bridge (P-010)', async () => {
    const stores = planOrganizationDataOperation().filter(t => t.executor === 'hosted-control-plane'
      && t.attribution.kind !== 'unattributable').map(t => t.store);
    const missing = await org.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      const rows = await tx<{ store: string; readable: boolean }[]>`SELECT store, has_table_privilege(store, 'SELECT') AS readable
        FROM unnest(${tx.array(stores)}::text[]) AS store`;
      return rows.filter(r => !r.readable && !HOSTED_EXPORT_BRIDGED_STORES.includes(r.store)).map(r => r.store);
    });
    expect(missing, 'Every missing read must have a reviewed scoped bridge; never fix one permission at a time').toEqual([]);
  });

  it('the fixed bridge rejects unscoped reads, mismatched tenants and arbitrary stores (P-010)', async () => {
    const read = (organizationId: string | null, requested: string, store: string) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true),
        set_config('app.organization_id', ${organizationId ?? ''}, true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return tx`SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(${store}, ${requested})`;
    });
    await expect(read(null, scope.organizationId, 'harness_shared.customer_workspaces')).rejects.toThrow('service scope is invalid');
    await expect(read(scope.organizationId, randomUUID(), 'harness_shared.customer_workspaces')).rejects.toThrow('service scope is invalid');
    await expect(read(scope.organizationId, scope.organizationId, 'papercusp_auth.hosted_sessions')).rejects.toThrow('store is not allowed');
    await expect(org.appSql`SELECT data FROM papercusp_auth.read_hosted_customer_export_rows
      ('harness_shared.customer_workspaces', ${scope.organizationId})`).rejects.toThrow('permission denied');
  });

  it('every declared access column exists in the live schema', async () => {
    for (const [store, columns] of Object.entries(PILOT_STORE_ACCESS_COLUMNS)) {
      const [schema, table] = store.split('.');
      const live = await org.adminSql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema!} AND table_name = ${table!}`;
      const names = live.map((c) => c.column_name);
      for (const column of columns) expect(names, `${store}.${column}`).toContain(column);
    }
  });

  it('the population is closed under FK children of every pilot data-plane store', async () => {
    const plan = planOrganizationDataOperation();
    const population = new Set(plan.map((t) => t.store));
    const pilot = plan.filter((t) => t.executor === 'pilot-data-plane').map((t) => t.store);
    const edges = await org.adminSql<{ parent: string; child: string }[]>`
      SELECT pn.nspname || '.' || p.relname AS parent, cn.nspname || '.' || ch.relname AS child
        FROM pg_constraint c
        JOIN pg_class p ON p.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
        JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ch.relnamespace
       WHERE c.contype = 'f' AND (pn.nspname || '.' || p.relname) = ANY(${pilot}::text[])`;
    // Positive control: data_sources has FK children, so an empty result means the query is broken.
    expect(edges.some((e) => e.parent === 'harness_shared.data_sources')).toBe(true);
    expect(edges.filter((e) => !population.has(e.child)).map((e) => `${e.parent} <- ${e.child}`)).toEqual([]);
    // Each dependent hangs off data_sources directly or through another dependent; every FK child
    // of a dependent is itself a dependent; and a child is listed before its parent, because
    // deletionOrder deletes dependents in list order and the trigger edges are ON DELETE RESTRICT.
    const dependents = new Set(DATA_SOURCE_DEPENDENTS);
    const anchored = (store: string) => edges.some((e) => e.child === store
      && (e.parent === 'harness_shared.data_sources' || (dependents.has(e.parent) && e.parent !== store)));
    for (const store of DATA_SOURCE_DEPENDENTS) expect(anchored(store), store).toBe(true);
    const dependentEdges = edges.filter((e) => dependents.has(e.parent) && e.child !== e.parent);
    // Positive control: trigger_runs references two dependents.
    expect(dependentEdges.filter((e) => e.child === 'harness_shared.trigger_runs')).toHaveLength(2);
    for (const e of dependentEdges) {
      expect(dependents.has(e.child), `${e.parent} <- ${e.child}`).toBe(true);
      expect(DATA_SOURCE_DEPENDENTS.indexOf(e.child), `${e.child} before ${e.parent}`)
        .toBeLessThan(DATA_SOURCE_DEPENDENTS.indexOf(e.parent));
    }
  });

  it('exports the scope without secret-class columns and records an export receipt', async () => {
    await seed({ hold: false });
    const out = await exportOrganizationData(org.adminSql, { scope, actor, purpose: 'customer export request' });

    const sources = out.stores.find((s) => s.store === 'harness_shared.data_sources')!;
    expect(sources.rows).toHaveLength(1);
    expect(sources.columns).not.toContain('credential_ref');
    expect(Object.keys(sources.rows[0]!)).not.toContain('credential_ref');
    expect(JSON.stringify(out.stores)).not.toContain('vault://org-data-receipts/slack-bot');
    expect(out.stores.find((s) => s.store === 'harness_shared.chat_messages')!.rows).toHaveLength(2);
    // Content hashes are exported; they are content, not access material.
    expect(out.stores.find((s) => s.store === 'harness_shared.chat_retrieval_units')!.columns).toContain('content_hash');
    for (const [store, secret] of [
      ['harness_shared.trigger_webhook_secrets', 'secret_ct'],
      ['harness_shared.connector_push_secrets', 'secret_ct'],
    ] as const) {
      const s = out.stores.find((x) => x.store === store)!;
      expect(s.rows, store).toHaveLength(1);
      expect(s.columns, store).not.toContain(secret);
      expect(Object.keys(s.rows[0]!), store).not.toContain(secret);
    }
    expect(out.stores.find((s) => s.store === 'harness_shared.trigger_deliveries')!.rows).toHaveLength(1);

    const receipt = await receiptRow(out.receiptId);
    expect(receipt).toMatchObject({ action: RECEIPT_ACTIONS.export, actor_kind: 'system', organization_id: scope.organizationId });
    const meta = receipt.metadata;
    expect(meta.populationSize).toBe(planOrganizationDataOperation().length);
    expect(meta.stores.map((s: { store: string }) => s.store).sort())
      .toEqual(planOrganizationDataOperation().map((t) => t.store).sort());
    const sourceReceipt = meta.stores.find((s: { store: string }) => s.store === 'harness_shared.data_sources');
    expect(sourceReceipt).toMatchObject({ outcome: 'exported', rowCount: 1, excludedColumns: ['credential_ref'] });
    expect(sourceReceipt.exportedColumns).not.toContain('credential_ref');
    for (const s of meta.stores.filter((x: { executor: string }) => x.executor === 'hosted-control-plane')) {
      expect(['deferred', 'not-attributable']).toContain(s.outcome);
      for (const c of s.excludedColumns) expect(s.exportedColumns ?? []).not.toContain(c);
    }
  });

  it('exports hosted accounts without workspaces, including joined records, while isolating tenants and secrets (P-010)', async () => {
    const targetOrg = randomUUID();
    const otherOrg = randomUUID();
    const targetUser = randomUUID();
    const otherUser = randomUUID();
    for (const [organizationId, userId, label] of [[targetOrg, targetUser, 'target'], [otherOrg, otherUser, 'other']] as const) {
      await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
        VALUES (${organizationId}::uuid, ${`p010-${organizationId}`}, ${label})`;
      await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email)
        VALUES (${userId}::uuid, ${`${label}@example.test`})`;
      await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'organization_bootstrap')`;
      await org.adminSql`INSERT INTO papercusp_auth.hosted_sessions
        (id, user_id, organization_id, upstream_provider, upstream_session_id, expires_at)
        VALUES (${`never-emit-me-${label}`}, ${userId}, ${organizationId}, 'workos',
          ${`never-emit-me-upstream-${label}`}, now() + interval '1 hour')`;
      await org.adminSql`INSERT INTO papercusp_auth.workos_sealed_sessions (external_session_id, sealed_session, expires_at)
        VALUES (${`never-emit-me-upstream-${label}`}, ${`never-emit-me-sealed-${label}`}, now() + interval '1 hour')`;
    }
    const principal = createHostedPrincipal({ workspaceId: 'control', userId: targetUser, activeOrganizationId: targetOrg,
      sessionId: 'test', sessionVersion: 1, permissions: ['members:manage'] });
    const out = await exportOrganizationData(org.adminSql, { executor: 'hosted-control-plane',
      scope: { organizationId: targetOrg, workspaceIds: [] }, actor: { kind: 'customer_user', principal }, purpose: 'customer export' });
    const rows = (store: string) => out.stores.find((s) => s.store === store)!.rows;
    expect(rows('papercusp_auth.organizations').map((r) => r.id)).toEqual([targetOrg]);
    expect(rows('papercusp_auth.hosted_users').map((r) => r.primary_email)).toEqual(['target@example.test']);
    expect(rows('papercusp_auth.organization_memberships').map((r) => r.user_id)).toEqual([targetUser]);
    expect(rows('papercusp_auth.hosted_sessions')).toHaveLength(1);
    expect(rows('papercusp_auth.workos_sealed_sessions')).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('never-emit-me');
    expect(JSON.stringify(out)).not.toContain(otherOrg);
    expect(JSON.stringify(out)).not.toContain(otherUser);
    const receipt = await receiptRow(out.receiptId);
    expect(receipt).toMatchObject({ actor_kind: 'customer_user', organization_id: targetOrg });
    expect(receipt.metadata.workspaceIds).toEqual([]);
    expect(receipt.metadata.executor).toBe('hosted-control-plane');
    expect(receipt.metadata.populationSize).toBe(planOrganizationDataOperation().length);
    expect(receipt.metadata.stores.find((s: { store: string }) => s.store === 'papercusp_auth.workos_sealed_sessions'))
      .toMatchObject({ outcome: 'exported', rowCount: 1 });
  });

  it('refuses a new unmapped hosted column and rolls the export receipt back (P-010)', async () => {

    await org.adminSql.unsafe('ALTER TABLE papercusp_auth.hosted_users ADD COLUMN p010_unmapped text');
    try {
      await expect(exportOrganizationData(org.adminSql, { executor: 'hosted-control-plane',
        scope: { organizationId: scope.organizationId, workspaceIds: [] }, actor, purpose: 'schema drift test' }))
        .rejects.toThrow('unmapped live schema');
      const rows = await org.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
        WHERE organization_id = ${scope.organizationId}::uuid AND action = 'organization.data.export'`;
      expect(rows).toHaveLength(0);
    } finally {
      await org.adminSql.unsafe('ALTER TABLE papercusp_auth.hosted_users DROP COLUMN p010_unmapped');
    }
  });

  it('authenticates hosted exports inside their receipt transaction and rejects stale authority (P-010)', async () => {
    const organizationId = randomUUID(), userId = randomUUID();
    await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name, status)
      VALUES (${organizationId}::uuid, ${`p010-${organizationId}`}, 'Export account', 'active')`;
    await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, status)
      VALUES (${userId}::uuid, 'atomic-export@example.test', 'active')`;
    await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
      VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'organization_bootstrap')`;
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const session = await new HostedSessionStore(org.adminSql as never).create({ userId, organizationId,
      permissionVersion: authority!.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: `export-${userId}`,
      expiresAt: new Date(Date.now() + 3600000) });
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: session.id, sessionVersion: session.permissionVersion, permissions: authority!.permissions });
    const run = () => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      const [access] = await tx<{ direct: boolean }[]>`SELECT has_table_privilege('harness_shared.customer_workspaces', 'SELECT') AS direct`;
      expect(access!.direct).toBe(false);
      return exportHostedOrganizationData(tx as never, principal);
    });
    const exported = await run();
    expect(exported.stores.find(s => s.store === 'papercusp_auth.hosted_users')!.rows)
      .toEqual([expect.objectContaining({ id: userId, primary_email: 'atomic-export@example.test' })]);
    expect((await receiptRow(exported.receiptId)).actor_kind).toBe('customer_user');
    // The service helper receives a transaction with no begin: the success above
    // exercises the no-nested-BEGIN path against real Postgres.
    await org.adminSql`UPDATE papercusp_auth.organization_memberships SET role = 'member'
      WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
    await expect(run()).rejects.toThrow('customer_data_forbidden');
    await org.adminSql`UPDATE papercusp_auth.organization_memberships SET role = 'owner'
      WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
    await org.adminSql`UPDATE papercusp_auth.hosted_users SET status = 'deactivated', deactivated_at = now() WHERE id = ${userId}::uuid`;
    await expect(run()).rejects.toThrow('customer_data_forbidden');
    await org.adminSql`UPDATE papercusp_auth.hosted_users SET status = 'active', deactivated_at = NULL WHERE id = ${userId}::uuid`;
    await new HostedSessionStore(org.adminSql as never).revoke(session.id);
    await expect(run()).rejects.toThrow('customer_data_forbidden');
    const receipts = await org.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${organizationId}::uuid AND action = 'organization.data.export'`;
    expect(receipts).toHaveLength(1);
  });

  it('admits deletion with the real hosted role while preserving the policy, confirmation and global owner gates (P-010)', async () => {
    const organizationId = randomUUID(), otherOrganizationId = randomUUID(), userId = randomUUID();
    for (const id of [organizationId, otherOrganizationId]) {
      await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name, status)
        VALUES (${id}::uuid, ${`deletion-${id}`}, 'Deletion admission', 'active')`;
    }
    await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, status)
      VALUES (${userId}::uuid, 'deletion-admission@example.test', 'active')`;
    for (const id of [organizationId, otherOrganizationId]) {
      await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${id}::uuid, ${userId}::uuid, 'owner', 'organization_bootstrap')`;
    }
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const session = await new HostedSessionStore(org.adminSql as never).create({ userId, organizationId,
      permissionVersion: authority!.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: `deletion-${userId}`,
      expiresAt: new Date(Date.now() + 3600000) });
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: session.id, sessionVersion: session.permissionVersion, permissions: authority!.permissions });
    const policy = { approvalRef: 'scratch-policy-decision', stripe: 'delete' as const, consent: 'retain' as const };
    const run = (kind: 'organization' | 'user', confirmation: string, approved = true) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return admitHostedCustomerDeletion(tx as never, principal, { kind, confirmation }, async () => approved ? policy : null);
    });
    await expect(run('organization', 'DELETE ORGANIZATION', false)).rejects.toThrow('retention_policy_pending');
    await expect(run('organization', 'yes')).rejects.toThrow('confirmation_required');
    await expect(run('user', 'DELETE MY ACCOUNT')).rejects.toThrow('transfer_organization_ownership_required');
    expect(await org.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id=${organizationId}::uuid AND action='organization.data.deletion.requested'`).toHaveLength(0);
    const request = await run('organization', 'DELETE ORGANIZATION');
    expect(request.organizationId).toBe(organizationId);
    expect(request.requestedBy).toBe(userId);
    expect(request.target).toEqual({ kind: 'organization' });
    const [audit] = await org.adminSql`SELECT actor_id, target_id, metadata FROM papercusp_auth.organization_audit_events
      WHERE organization_id=${organizationId}::uuid AND action='organization.data.deletion.requested'`;
    expect(audit).toMatchObject({ actor_id: userId, target_id: organizationId,
      metadata: { operationId: request.operationId, kind: 'organization', policy } });
    await new HostedSessionStore(org.adminSql as never).revoke(session.id);
    await expect(run('organization', 'DELETE ORGANIZATION')).rejects.toThrow('customer_data_forbidden');
    expect((await org.adminSql`SELECT status FROM papercusp_auth.organizations WHERE id=${organizationId}::uuid`)[0].status).toBe('active');
  });

  it('freezes organization access atomically, preserves shared users and dedupes durable targets (P-010)', async () => {
    const organizationId = randomUUID(), otherOrg = randomUUID(), userId = randomUUID(), sharedId = randomUUID();
    for (const id of [organizationId, otherOrg]) await org.adminSql`
      INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
      VALUES (${id}::uuid, ${`org-${id}`}, 'Deletion snapshot')`;
    for (const id of [userId, sharedId]) {
      await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email)
        VALUES (${id}::uuid, ${`${id}@example.test`})`;
      await org.adminSql`INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject)
        VALUES (${id}::uuid, 'workos', ${`user-${id}`})`;
      await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${organizationId}::uuid, ${id}::uuid, ${id === userId ? 'owner' : 'member'}, 'organization_bootstrap')`;
    }
    await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
      VALUES (${otherOrg}::uuid, ${sharedId}::uuid, 'owner', 'organization_bootstrap')`;
    await org.adminSql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
      VALUES (${organizationId}::uuid, 'cus_p010snapshot', false)`;
    await org.adminSql`INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
      VALUES ('control', 'p010-connection', 'gcp', 'Snapshot', 'never-snapshot-credential', 'connected')`;
    for (const id of [organizationId, otherOrg]) {
      await org.adminSql`INSERT INTO harness_shared.workspace_hosts
        (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
        VALUES ('control', ${`host-${id}`}, 'Snapshot', 'p010-connection', 'gcp', 'project', 'us-central1',
          'e2-small', 'image', 20, 'network', 'running', 'running')`;
      await org.adminSql`INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
        VALUES ('control', ${`ws-${id}`}, ${id}, ${`host-${id}`}, 'Snapshot', 'active', 'user', ${sharedId})`;
      await org.adminSql`INSERT INTO papercusp_auth.hosted_workspace_connectors
        (control_workspace_id, organization_id, customer_workspace_id, host_id, route_label, credential_hash, state, transport)
        VALUES ('control', ${id}, ${`ws-${id}`}, ${`host-${id}`}, ${`route-${id}`}, ${'a'.repeat(64)}, 'active', 'sse')`;
    }
    const store = new HostedSessionStore(org.adminSql as never);
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const actorSession = await store.create({ userId, organizationId, permissionVersion: authority!.permissionVersion,
      upstreamProvider: 'workos', upstreamSessionId: `never-snapshot-${userId}`, expiresAt: new Date(Date.now() + 3600000) });
    const sharedSession = await store.create({ userId: sharedId, organizationId, permissionVersion: 1,
      upstreamProvider: 'workos', upstreamSessionId: `never-snapshot-shared-${sharedId}`, expiresAt: new Date(Date.now() + 3600000) });
    const otherSession = await store.create({ userId: sharedId, organizationId: otherOrg, permissionVersion: 1,
      upstreamProvider: 'workos', upstreamSessionId: `never-snapshot-other-${sharedId}`, expiresAt: new Date(Date.now() + 3600000) });
    await org.adminSql`INSERT INTO papercusp_auth.workos_sealed_sessions (external_session_id, sealed_session, expires_at)
      VALUES (${actorSession.upstreamSessionId}, 'never-snapshot-sealed-value', ${actorSession.expiresAt.toISOString()}::timestamptz)`;
    for (const id of [organizationId, otherOrg]) await org.adminSql`
      INSERT INTO papercusp_auth.hosted_cli_tokens
        (id, token_hash, control_workspace_id, user_id, organization_id, client_label, created_at, expires_at)
      VALUES (${`hct_${(id === organizationId ? 'a' : 'b').repeat(22)}`}, ${(id === organizationId ? 'a' : 'b').repeat(64)},
        'control', ${sharedId}, ${id}, 'CLI', now(), now() + interval '1 hour')`;
    const service = <T>(use: (tx: any) => Promise<T>) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return use(tx);
    });
    const policy = { approvalRef: 'scratch-retention', stripe: 'delete' as const, consent: 'retain' as const };
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: actorSession.id, sessionVersion: actorSession.permissionVersion, permissions: authority!.permissions });
    const request = await service(tx => admitHostedCustomerDeletion(tx, principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' }, async () => policy));
    await expect(service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => null)))
      .rejects.toThrow('retention-policy-not-approved');
    await expect(service(tx => authorizeHostedCustomerDeletion(tx, { ...request, requestedBy: sharedId }, async () => policy)))
      .rejects.toThrow('admission-mismatch');
    const snapshot = await service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => policy));
    expect(snapshot).toMatchObject({ schemaVersion: 1, request, stripeCustomerId: 'cus_p010snapshot',
      workspaces: [{ workspaceId: `ws-${organizationId}`, hostId: `host-${organizationId}` }],
      organizationIdentity: { provider: 'workos', subject: `org-${organizationId}` } });
    expect(snapshot.users).toEqual(expect.arrayContaining([
      { userId, deleteUser: true, identities: [{ provider: 'workos', subject: `user-${userId}` }] },
      { userId: sharedId, deleteUser: false, identities: [{ provider: 'workos', subject: `user-${sharedId}` }] },
    ]));
    expect(JSON.stringify(snapshot)).not.toContain('never-snapshot');
    expect(await store.resolve(actorSession.id)).toBeNull();
    expect(await store.resolve(sharedSession.id)).toBeNull();
    expect(await store.resolve(otherSession.id)).not.toBeNull();
    const states = await org.adminSql`SELECT id::text, status FROM papercusp_auth.hosted_users
      WHERE id IN (${userId}::uuid, ${sharedId}::uuid)`;
    expect(states).toEqual(expect.arrayContaining([{ id: userId, status: 'deactivated' }, { id: sharedId, status: 'active' }]));
    expect((await org.adminSql`SELECT status FROM papercusp_auth.organizations WHERE id=${organizationId}::uuid`)[0].status).toBe('offboarding');
    expect((await org.adminSql`SELECT status FROM papercusp_auth.organizations WHERE id=${otherOrg}::uuid`)[0].status).toBe('active');
    expect(await org.adminSql`SELECT external_session_id FROM papercusp_auth.workos_sealed_sessions
      WHERE external_session_id=${actorSession.upstreamSessionId}`).toHaveLength(0);
    const cli = await org.adminSql`SELECT organization_id, revoked_at FROM papercusp_auth.hosted_cli_tokens
      WHERE organization_id IN (${organizationId}, ${otherOrg})`;
    expect(cli.find(t => t.organization_id === organizationId)?.revoked_at).not.toBeNull();
    expect(cli.find(t => t.organization_id === otherOrg)?.revoked_at).toBeNull();
    const connectors = await org.adminSql`SELECT organization_id, state, credential_hash FROM papercusp_auth.hosted_workspace_connectors
      WHERE organization_id IN (${organizationId}, ${otherOrg})`;
    expect(connectors.find(c => c.organization_id === organizationId)).toMatchObject({ state: 'revoked', credential_hash: null });
    expect(connectors.find(c => c.organization_id === otherOrg)).toMatchObject({ state: 'active', credential_hash: 'a'.repeat(64) });
    // A later provider/binding change cannot shrink or change an already-saved scope.
    await org.adminSql`DELETE FROM papercusp_auth.hosted_billing_customers WHERE organization_id=${organizationId}::uuid`;
    await org.adminSql`UPDATE papercusp_auth.external_identities SET subject='user-changed-after-freeze'
      WHERE hosted_user_id=${userId}::uuid`;
    const replay = await Promise.all([1, 2].map(() => service(tx =>
      freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => policy))));
    expect(replay).toEqual([snapshot, snapshot]);
    expect(await service(tx => readHostedCustomerDeletionSnapshot(tx, request))).toEqual(snapshot);
    await expect(service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'different-control', async () => policy)))
      .rejects.toThrow('control-plane-mismatch');
    expect(await org.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id=${organizationId}::uuid AND action=${HOSTED_DELETION_SNAPSHOT_ACTION}`).toHaveLength(1);
    // Delayed provider upserts and fresh memberships must not reopen access.
    await expect(service(tx => tx`UPDATE papercusp_auth.organizations SET status='active', offboarding_at=NULL
      WHERE id=${organizationId}::uuid`)).rejects.toThrow('hosted customer deletion access is frozen');
    await expect(service(tx => tx`UPDATE papercusp_auth.hosted_users SET status='active', deactivated_at=NULL
      WHERE id=${userId}::uuid`)).rejects.toThrow('hosted customer deletion access is frozen');
    await expect(service(tx => tx`UPDATE papercusp_auth.organization_memberships SET status='active', revoked_at=NULL
      WHERE organization_id=${organizationId}::uuid AND user_id=${sharedId}::uuid`))
      .rejects.toThrow('hosted_service may not restore or elevate membership access');
    // The existing service no-restore fence fires first; an administrative
    // writer reaches the new deletion guard and must be refused there too.
    await expect(org.adminSql`UPDATE papercusp_auth.organization_memberships SET status='active', revoked_at=NULL
      WHERE organization_id=${organizationId}::uuid AND user_id=${sharedId}::uuid`)
      .rejects.toThrow('hosted customer deletion access is frozen');
    await expect(service(tx => tx`UPDATE papercusp_auth.external_identities SET status='active', deactivated_at=NULL
      WHERE hosted_user_id=${userId}::uuid`)).rejects.toThrow('hosted customer deletion access is frozen');
    await service(tx => tx`UPDATE papercusp_auth.hosted_users SET display_name='Shared user remains active'
      WHERE id=${sharedId}::uuid`);
  });

  it('rechecks global ownership before freezing a user and preserves shared organization resources (P-010)', async () => {
    const organizationId = randomUUID(), otherOrg = randomUUID(), userId = randomUUID(), peerId = randomUUID();
    for (const id of [userId, peerId]) await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id) VALUES (${id}::uuid)`;
    for (const id of [organizationId, otherOrg]) {
      await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
        VALUES (${id}::uuid, ${`user-freeze-${id}`}, 'User deletion')`;
      for (const uid of [userId, peerId]) await org.adminSql`
        INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${id}::uuid, ${uid}::uuid, 'owner', 'organization_bootstrap')`;
    }
    const store = new HostedSessionStore(org.adminSql as never);
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const sessions = await Promise.all([organizationId, otherOrg].map(oid => store.create({ userId, organizationId: oid,
      permissionVersion: authority!.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: `global-${oid}-${userId}`,
      expiresAt: new Date(Date.now() + 3600000) })));
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: sessions[0]!.id, sessionVersion: sessions[0]!.permissionVersion, permissions: authority!.permissions });
    const service = <T>(use: (tx: any) => Promise<T>) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service'); return use(tx);
    });
    const policy = { approvalRef: 'scratch-retention', stripe: 'delete' as const, consent: 'retain' as const };
    const request = await service(tx => admitHostedCustomerDeletion(tx, principal,
      { kind: 'user', confirmation: 'DELETE MY ACCOUNT' }, async () => policy));
    // Admission is not a permanent ownership grant. A later role change in an
    // organization outside the browser selection must prevent an orphan.
    await org.adminSql`UPDATE papercusp_auth.organization_memberships SET role='member'
      WHERE organization_id=${otherOrg}::uuid AND user_id=${peerId}::uuid`;
    await expect(service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => policy)))
      .rejects.toThrow('transfer-organization-ownership-required');
    expect(await store.resolve(sessions[0]!.id)).not.toBeNull();
    await org.adminSql`UPDATE papercusp_auth.organization_memberships SET role='owner'
      WHERE organization_id=${otherOrg}::uuid AND user_id=${peerId}::uuid`;
    const snapshot = await service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => policy));
    expect(snapshot).toMatchObject({ workspaces: [], stripeCustomerId: null,
      users: [{ userId, deleteUser: true, identities: [] }] });
    for (const session of sessions) expect(await store.resolve(session.id)).toBeNull();
    expect(await org.adminSql`SELECT id FROM papercusp_auth.organization_memberships
      WHERE user_id=${userId}::uuid AND status='active'`).toHaveLength(0);
    expect(await org.adminSql`SELECT id FROM papercusp_auth.organization_memberships
      WHERE user_id=${peerId}::uuid AND status='active'`).toHaveLength(2);
    expect(await org.adminSql`SELECT id FROM papercusp_auth.organizations
      WHERE id IN (${organizationId}::uuid, ${otherOrg}::uuid) AND status='active'`).toHaveLength(2);
  });

  it('rolls back access freeze if the immutable target receipt cannot commit (P-010)', async () => {
    const organizationId = randomUUID(), userId = randomUUID();
    await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
      VALUES (${organizationId}::uuid, ${`rollback-${organizationId}`}, 'Rollback')`;
    await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id) VALUES (${userId}::uuid)`;
    await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
      VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'organization_bootstrap')`;
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const store = new HostedSessionStore(org.adminSql as never);
    const session = await store.create({ userId, organizationId, permissionVersion: authority!.permissionVersion,
      upstreamProvider: 'workos', upstreamSessionId: `rollback-${userId}`, expiresAt: new Date(Date.now() + 3600000) });
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: session.id, sessionVersion: session.permissionVersion, permissions: authority!.permissions });
    const policy = { approvalRef: 'scratch-retention', stripe: 'retain' as const, consent: 'retain' as const };
    const service = <T>(use: (tx: any) => Promise<T>) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service'); return use(tx);
    });
    const request = await service(tx => admitHostedCustomerDeletion(tx, principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' }, async () => policy));
    await org.adminSql.unsafe(`CREATE FUNCTION papercusp_auth.p010_reject_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'organization.data.deletion.access-frozen' THEN
      RAISE EXCEPTION 'snapshot-write-refused'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER p010_reject_snapshot BEFORE INSERT ON papercusp_auth.organization_audit_events
      FOR EACH ROW EXECUTE FUNCTION papercusp_auth.p010_reject_snapshot()`);
    try {
      await expect(service(tx => freezeHostedCustomerDeletionAccess(tx, request, 'control', async () => policy)))
        .rejects.toThrow('snapshot-write-refused');
      expect(await store.resolve(session.id)).not.toBeNull();
      expect((await org.adminSql`SELECT status FROM papercusp_auth.organizations WHERE id=${organizationId}::uuid`)[0].status).toBe('active');
      expect((await org.adminSql`SELECT status FROM papercusp_auth.hosted_users WHERE id=${userId}::uuid`)[0].status).toBe('active');
      expect(await service(tx => readHostedCustomerDeletionSnapshot(tx, request))).toBeNull();
    } finally {
      await org.adminSql.unsafe(`DROP TRIGGER p010_reject_snapshot ON papercusp_auth.organization_audit_events;
        DROP FUNCTION papercusp_auth.p010_reject_snapshot()`);
    }
  });

  it('exports a member’s own user records and joined sealed-session metadata without other users or organization-level records (P-010)', async () => {
    const organizationId = randomUUID(), userId = randomUUID(), peerId = randomUUID();
    await org.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name, status)
      VALUES (${organizationId}::uuid, ${`personal-${organizationId}`}, 'Personal export', 'active')`;
    for (const id of [userId, peerId]) {
      await org.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, status)
        VALUES (${id}::uuid, ${`${id}@example.test`}, 'active')`;
      await org.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${organizationId}::uuid, ${id}::uuid, 'member', 'organization_bootstrap')`;
      await org.adminSql`INSERT INTO papercusp_auth.legal_acceptances
        (organization_id, user_id, document_kind, document_version, acceptance_source, accepted_at)
        VALUES (${organizationId}::uuid, ${id}::uuid, 'terms', 'test-v1', 'hosted_ui', now())`;
      // Migration1418 enrolls preferences on membership insertion. Exercise
      // that real path instead of inserting a duplicate fixture row.
      const preferences = await org.adminSql`UPDATE papercusp_auth.hosted_user_preferences
        SET profile = profile || ${JSON.stringify({ displayName: id })}::text::jsonb
        WHERE organization_id = ${organizationId}::uuid AND user_id = ${id}::uuid RETURNING user_id`;
      expect(preferences).toHaveLength(1);
    }
    const authority = await new PostgresHostedMembershipAuthority(org.adminSql as never).resolveActive({ userId, organizationId });
    const session = await new HostedSessionStore(org.adminSql as never).create({ userId, organizationId,
      permissionVersion: authority!.permissionVersion, upstreamProvider: 'workos', upstreamSessionId: `user-export-${userId}`,
      expiresAt: new Date(Date.now() + 3600000) });
    await org.adminSql`INSERT INTO papercusp_auth.workos_sealed_sessions (external_session_id, sealed_session, expires_at)
      VALUES (${session.upstreamSessionId}, 'never-export-sealed', ${session.expiresAt.toISOString()}::timestamptz)`;
    const principal = createHostedPrincipal({ workspaceId: 'control', userId, activeOrganizationId: organizationId,
      sessionId: session.id, sessionVersion: session.permissionVersion, permissions: authority!.permissions });
    const run = (exporter: typeof exportHostedUserData) => org.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return exporter(tx as never, principal);
    });
    await expect(run(exportHostedOrganizationData)).rejects.toThrow('customer_data_forbidden');
    const data = await run(exportHostedUserData);
    const rows = (store: string) => data.stores.find(s => s.store === store)?.rows ?? [];
    expect(rows('papercusp_auth.hosted_users')).toEqual([expect.objectContaining({ id: userId })]);
    expect(rows('papercusp_auth.organization_memberships')).toEqual([expect.objectContaining({ user_id: userId })]);
    expect(rows('papercusp_auth.legal_acceptances')).toEqual([expect.objectContaining({ user_id: userId })]);
    expect(rows('papercusp_auth.hosted_user_preferences')).toEqual([expect.objectContaining({ user_id: userId })]);
    expect(rows('papercusp_auth.workos_sealed_sessions')).toHaveLength(1);
    expect(rows('papercusp_auth.organizations')).toHaveLength(0);
    expect(JSON.stringify(data)).not.toContain(peerId);
    expect(JSON.stringify(data)).not.toContain('never-export-sealed');
    expect((await receiptRow(data.receiptId)).metadata.userId).toBe(userId);
    await new HostedSessionStore(org.adminSql as never).revoke(session.id);
    await expect(run(exportHostedUserData)).rejects.toThrow('customer_data_forbidden');
  });

  it('deletes the scope, keeps rows under a legal hold, and names the hold conflict', async () => {
    await seed({ hold: true });
    await expect(deleteOrganizationData(org.adminSql, {
      scope, actor, purpose: 'customer deletion request', confirmOrganizationId: randomUUID(),
    })).rejects.toThrow(/confirmOrganizationId/);
    expect(await count('harness_shared.chat_messages')).toBe(2);

    const out = await deleteOrganizationData(org.adminSql, {
      scope, actor, purpose: 'customer deletion request', confirmOrganizationId: scope.organizationId,
    });

    const left = await org.adminSql<{ channel_id: string; body: string | null }[]>`
      SELECT channel_id, body FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
    expect(left).toEqual([{ channel_id: HELD, body: 'held message' }]);
    expect(await count('harness_shared.documents')).toBe(0);
    expect(await count('harness_shared.document_permission_lists')).toBe(0);
    expect(await count('harness_shared.provider_identity_mappings')).toBe(0);
    expect(await count('harness_shared.data_sources')).toBe(1);
    expect(await count('harness_shared.data_source_legal_holds')).toBe(1);

    expect(out.holdConflicts).toHaveLength(1);
    expect(out.holdConflicts[0]).toMatchObject({ dataSourceId: sourceId, channelId: HELD });
    expect(out.holdConflicts[0]!.retained).toEqual(expect.arrayContaining([
      { store: 'harness_shared.chat_messages', rows: 1 },
      { store: 'harness_shared.data_sources', rows: 1 },
    ]));

    const receipt = await receiptRow(out.receiptId);
    expect(receipt.action).toBe(RECEIPT_ACTIONS.deletion);
    const byStore = new Map(receipt.metadata.stores.map((s: { store: string }) => [s.store, s]));
    expect(byStore.get('harness_shared.chat_messages')).toMatchObject({ outcome: 'deleted', rowCount: 1, rowsRemaining: 1 });
    expect(byStore.get('harness_shared.documents')).toMatchObject({ outcome: 'deleted', rowCount: 1, rowsRemaining: 0 });
    expect(byStore.get('harness_shared.document_permission_members')).toMatchObject({ outcome: 'deleted', rowCount: 1 });
    expect(byStore.get('harness_shared.data_source_legal_holds')).toMatchObject({ outcome: 'retained', rowsRemaining: 1 });
    expect(receipt.metadata.holdConflicts).toHaveLength(1);
  });

  it('a released hold still keeps its data source, and an unheld scope is removed in full', async () => {
    await seed({ hold: false });
    const out = await deleteOrganizationData(org.adminSql, {
      scope, actor, purpose: 'customer deletion request', confirmOrganizationId: scope.organizationId,
    });
    expect(out.holdConflicts).toEqual([]);
    for (const store of ['chat_messages', 'documents', 'document_permission_lists', 'provider_identity_mappings', 'data_sources']) {
      expect(await count(`harness_shared.${store}`), store).toBe(0);
    }
    // Every dependent is counted in the receipt; the RESTRICT children no longer block the source.
    const byStore = new Map(out.stores.map((s) => [s.store, s]));
    for (const store of DATA_SOURCE_DEPENDENTS) {
      expect(await count(store), store).toBe(0);
      expect(byStore.get(store), store).toMatchObject({ outcome: 'deleted', rowsRemaining: 0 });
    }
    for (const store of ['harness_shared.trigger_runs', 'harness_shared.trigger_bindings', 'harness_shared.trigger_deliveries',
      'harness_shared.trigger_webhook_secrets', 'harness_shared.connector_push_secrets', 'harness_shared.admission_rules']) {
      expect(byStore.get(store)!.rowCount, store).toBe(1);
    }
  });

  // ── P-017a (WI-6554700010012462, migration 1502): legal holds on the document route ──

  it('the document hold exemption is exactly the chat-derived kinds the code writes', async () => {
    const [fn] = await org.adminSql<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc
       WHERE proname = 'document_is_chat_derived' AND pronamespace = 'harness_shared'::regnamespace`;
    const sqlKinds = [...fn!.src.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(sqlKinds).toEqual([...CHAT_DERIVED_DOCUMENT_KINDS].sort());
    const [probe] = await org.adminSql<{ chat: boolean; issue: boolean }[]>`
      SELECT harness_shared.document_is_chat_derived(${CHAT_WINDOW_DOCUMENT_KIND}) AS chat,
             harness_shared.document_is_chat_derived('issue') AS issue`;
    expect(probe).toEqual({ chat: true, issue: false });
  });

  it('a held container keeps its documents, access list and members through deletion, and the trigger refuses to destroy them', async () => {
    await seed({ hold: false });
    // A connector whose content lives only in documents; lists keyed the way connectors key them.
    const [gh] = await org.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
      VALUES (${WS}, 'github', ${org.adminSql.json({ mode: 'source-acl' })}, 'vault://org-data-receipts/github')
      RETURNING id`;
    const ghId = gh!.id;
    const heldList = await upsertPermissionList(org.adminSql, WS, { source: 'github', sourceRef: containerPermissionRef(ghId, 'acme/held'), title: 'acme/held' });
    const openList = await upsertPermissionList(org.adminSql, WS, { source: 'github', sourceRef: containerPermissionRef(ghId, 'acme/open'), title: 'acme/open' });
    await replacePermissionListMembers(org.adminSql, WS, heldList.id, [SLACK_ALICE]);
    await replacePermissionListMembers(org.adminSql, WS, openList.id, [SLACK_ALICE]);
    await upsertOrganizationDocuments(org.adminSql, WS, heldList.id, [
      { source: 'github', kind: 'issue', dedupeKey: 'acme/held#1', sourceId: ghId, title: 'held issue', text: 'Held issue body.' },
      // A chat-derived render: its content is held in chat_messages, so the document hold exempts it.
      { source: 'github', kind: CHAT_WINDOW_DOCUMENT_KIND, dedupeKey: 'acme/held#window', sourceId: ghId, title: 'window', text: 'Rendered window.' },
    ]);
    await upsertOrganizationDocuments(org.adminSql, WS, openList.id, [
      { source: 'github', kind: 'issue', dedupeKey: 'acme/open#1', sourceId: ghId, title: 'open issue', text: 'Open issue body.' },
    ]);
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: ghId, channelId: 'acme/held', reason: 'litigation 9', placedBy: 'owner' });

    const held = org.adminSql`workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`;
    await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE ${held}`).rejects.toThrow(/document_under_legal_hold/);
    await expect(org.adminSql`UPDATE harness_shared.documents SET text = '' WHERE ${held}`).rejects.toThrow(/cannot be erased/);
    await expect(org.adminSql`UPDATE harness_shared.documents SET source_id = NULL WHERE ${held}`).rejects.toThrow(/cannot be moved/);
    // Updates that keep the content pass, including an upsert that omits the source.
    await org.adminSql`UPDATE harness_shared.documents SET metadata = ${org.adminSql.json({ labels: ['bug'] })} WHERE ${held}`;
    await upsertOrganizationDocuments(org.adminSql, WS, heldList.id, [
      { source: 'github', kind: 'issue', dedupeKey: 'acme/held#1', title: 'held issue', text: 'Held issue body, edited.' },
    ]);

    const out = await deleteOrganizationData(org.adminSql, {
      scope, actor, purpose: 'customer deletion request', confirmOrganizationId: scope.organizationId,
    });

    const docs = await org.adminSql<{ dedupe_key: string; source_id: string }[]>`
      SELECT dedupe_key, source_id::text AS source_id FROM harness_shared.documents WHERE workspace_id = ${WS}`;
    expect(docs).toEqual([{ dedupe_key: 'acme/held#1', source_id: ghId }]);
    const lists = await org.adminSql<{ id: string }[]>`
      SELECT id::text AS id FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
    expect(lists.map((l) => l.id)).toEqual([heldList.id]);
    expect(await count('harness_shared.document_permission_members')).toBe(1);
    const conflict = out.holdConflicts.find((c) => c.holdId === hold.id)!;
    expect(conflict.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.documents', rows: 1 }]));
    const byStore = new Map(out.stores.map((s) => [s.store, s]));
    expect(byStore.get('harness_shared.documents')).toMatchObject({ outcome: 'deleted', rowCount: 3, rowsRemaining: 1 });
    expect(byStore.get('harness_shared.document_permission_lists')).toMatchObject({ outcome: 'deleted', rowsRemaining: 1 });

    // Released, the document is deleted like any other.
    await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' });
    await org.adminSql`DELETE FROM harness_shared.documents WHERE ${held}`;
    expect(await count('harness_shared.documents')).toBe(0);
  });

  it('a personal purge keeps the documents of a held source and reports them as held', async () => {
    await seed({ hold: false });
    await upsertPersonalDocuments(org.adminSql, WS, alice, [
      { source: 'mail', kind: 'message', dedupeKey: 'mail:held-1', title: 'held mail', text: 'Held mail body.', sourceId, providerAccountId: 'alice@example.com' },
      { source: 'mail', kind: 'message', dedupeKey: 'mail:unsourced-1', title: 'other mail', text: 'Other mail body.' },
    ]);
    await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, reason: 'litigation 10', placedBy: 'owner' });

    const out = await purgePersonalSource(org.adminSql, WS, alice, 'mail');

    expect(out).toMatchObject({ documents: 1, held: 1 });
    const left = await org.adminSql<{ title: string }[]>`
      SELECT title FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id = ${alice}`;
    expect(left).toEqual([{ title: 'held mail' }]);
    // A cascade from the user is a delete too: the held document blocks it.
    await expect(org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`).rejects.toThrow(/document_under_legal_hold/);
  });

  it('a restore that brings back a revoked identity is reconciled and the identity is denied again', async () => {
    await seed({ hold: false });
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    expect(await aliceSearch()).toEqual(['#roadmap']);

    // Backup point: snapshot the mapping. Then alice leaves and is revoked.
    const backup = await org.adminSql<Record<string, unknown>[]>`
      SELECT * FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
    expect(backup).toHaveLength(1);
    await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
    expect(await aliceSearch()).toEqual([]);

    // Restore from the backup: the live mapping comes back, and with it alice's access.
    await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
    await org.adminSql`INSERT INTO harness_shared.provider_identity_mappings ${org.adminSql(backup)}`;
    expect(await aliceSearch()).toEqual(['#roadmap']);
    expect(await documentsReadableThroughIdentity(org.adminSql, { workspaceId: WS, ...SLACK_ALICE })).toBe(1);

    await expect(reconcileRestoredAccess(org.adminSql, {
      scope, actor, purpose: 'restore drill',
      revocations: [{ workspaceId: 'some-other-workspace', ...SLACK_ALICE, revokedBy: 'owner' }],
    })).rejects.toThrow(/outside the scope/);

    const out = await reconcileRestoredAccess(org.adminSql, {
      scope, actor, purpose: 'restore drill', revocations: [{ workspaceId: WS, ...SLACK_ALICE, revokedBy: 'owner' }],
    });
    expect(out.revocations).toEqual([{
      workspaceId: WS, ...SLACK_ALICE, mappingsRevoked: 1, readableDocuments: 0, denied: true,
    }]);
    expect(await aliceSearch()).toEqual([]);

    const receipt = await receiptRow(out.receiptId);
    expect(receipt.action).toBe(RECEIPT_ACTIONS.restore);
    expect(receipt.metadata.revocations).toEqual([expect.objectContaining({ denied: true, readableDocuments: 0 })]);
    expect(receipt.metadata.stores.find((s: { store: string }) => s.store === 'harness_shared.documents'))
      .toMatchObject({ outcome: 'verified', rowCount: 1 });
  });
});
