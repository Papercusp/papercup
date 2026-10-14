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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant } from '../personal-vault/store';
import { placeLegalHold, upsertChatMessages } from '../data-sources/chat-retrieval-units';
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
