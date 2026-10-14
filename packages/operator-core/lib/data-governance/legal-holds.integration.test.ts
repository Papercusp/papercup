/**
 * Legal-hold administration against real Postgres (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-017, child P-017b WI-6554700010012480).
 *
 * Acceptance under test:
 *  - an authorized actor places, lists and releases holds on a whole source or one container;
 *  - each place and release appends one papercusp_auth.organization_audit_events row naming the hold,
 *    source, container, reason and actor, in the same transaction as the hold write;
 *  - an actor without the deletion permission, or acting in another organization, is refused and
 *    nothing is written;
 *  - the listing reports, per hold, the rows it keeps (the deletion receipt's holdConflicts rule);
 *  - a container given in its permission-list form `<sourceId>#<container>` is stored bare, so chat
 *    and document enforcement both match it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { containerPermissionRef, upsertChatMessages } from '../data-sources/chat-retrieval-units';
import { upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';
import {
  exportLegalHoldContent,
  LEGAL_HOLD_ACTIONS,
  LegalHoldError,
  listOrganizationLegalHolds,
  placeOrganizationLegalHold,
  releaseOrganizationLegalHold,
} from './legal-holds';
import type { OrganizationDataScope, ReceiptActor } from './organization-data-receipts';

let org: OrgTestDb;
const WS = 'legal-holds-test';
const OTHER_WS = 'legal-holds-test-other';
const CH = 'T1:CHELD';
const admin: ReceiptActor = { kind: 'staff_admin', id: 'admin:tester' };
let scope: OrganizationDataScope;
let slackId: string;
let ghId: string;

const member = (permissions: string[], organizationId: string): ReceiptActor => ({
  kind: 'customer_user',
  principal: createHostedPrincipal({
    workspaceId: 'control', userId: '22222222-2222-4222-8222-222222222222', activeOrganizationId: organizationId,
    sessionId: 'session', sessionVersion: 1, permissions: permissions as never,
  }),
});

const msg = (channelId: string, id: string) => ({
  channelId, providerMessageId: id, threadKey: null, authorRef: 'T1:UALICE', authorLabel: 'alice', body: `message ${id}`,
  postedAt: '2026-09-30T10:00:00Z',
});

async function auditRows() {
  return org.adminSql<Array<{ action: string; actor_kind: string; actor_id: string; workspace_id: string | null;
    purpose: string; target_type: string; target_id: string; metadata: Record<string, any> }>>`
    SELECT action, actor_kind, actor_id, workspace_id, purpose, target_type, target_id, metadata
      FROM papercusp_auth.organization_audit_events
     WHERE organization_id = ${scope.organizationId}::uuid ORDER BY recorded_at, id`;
}

async function holdRows() {
  return org.adminSql<Array<{ id: string; channel_id: string | null; placed_by: string; released_by: string | null }>>`
    SELECT id, channel_id, placed_by, released_by FROM harness_shared.data_source_legal_holds
     WHERE workspace_id IN (${WS}, ${OTHER_WS}) ORDER BY placed_at, id`;
}

async function source(workspaceId: string, kind: string): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
    VALUES (${workspaceId}, ${kind}, ${org.adminSql.json({ mode: 'source-acl' })}, ${`vault://legal-holds/${kind}`})
    RETURNING id`;
  return row!.id;
}

beforeAll(async () => {
  org = await createOrgTestDb();
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  scope = { organizationId: randomUUID(), workspaceIds: [WS] };
  for (const ws of [WS, OTHER_WS]) {
    await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${ws}`;
  }
  slackId = await source(WS, 'slack');
  await upsertChatMessages(org.adminSql, WS, slackId, [msg(CH, '1.1'), msg(CH, '1.2'), msg('T1:COPEN', '2.1')]);
  ghId = await source(WS, 'github');
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'github', sourceRef: containerPermissionRef(ghId, 'acme/held'), title: 'acme/held' });
  await upsertOrganizationDocuments(org.adminSql, WS, list.id, [
    { source: 'github', kind: 'issue', dedupeKey: 'acme/held#1', sourceId: ghId, title: 'held issue', text: 'Held issue body.' },
  ]);
});

describe('legal-hold administration (P-017b)', () => {
  it('places a container hold, reports what it keeps, and audits the placement', async () => {
    const { hold, auditEventId } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 11',
    });
    expect(hold).toMatchObject({ workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 11',
      placedBy: 'admin:tester', releasedAt: null });
    expect(hold.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: LEGAL_HOLD_ACTIONS.place, actor_kind: 'staff_admin', actor_id: 'admin:tester', workspace_id: null,
      purpose: 'litigation 11', target_type: 'legal_hold', target_id: hold.holdId,
    });
    expect(rows[0]!.metadata).toMatchObject({ holdId: hold.holdId, workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'litigation 11' });
    expect(rows[0]!.metadata.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));
    // The audit event id is the row just read.
    const [{ id }] = await org.adminSql<{ id: string }[]>`
      SELECT id::text AS id FROM papercusp_auth.organization_audit_events WHERE organization_id = ${scope.organizationId}::uuid`;
    expect(auditEventId).toBe(id);
  });

  it('stores a permission-list container (<sourceId>#<container>) bare, so its documents are counted as held', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: containerPermissionRef(ghId, 'acme/held'),
      reason: 'litigation 12',
    });
    expect(hold.channelId).toBe('acme/held');
    expect(hold.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.documents', rows: 1 }]));
    await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`)
      .rejects.toThrow(/document_under_legal_hold/);
  });

  it('refuses an actor without the deletion permission, or from another organization, and writes nothing', async () => {
    const attempts: ReceiptActor[] = [
      member(['members:manage'], scope.organizationId),
      member(['workspace:destroy'], randomUUID()),
    ];
    for (const actor of attempts) {
      const err = await placeOrganizationLegalHold(org.adminSql, {
        scope, actor, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 13',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LegalHoldError);
      expect((err as LegalHoldError).code).toBe('forbidden');
    }
    // Listing needs the export permission: a viewer is refused, an owner-equivalent is not.
    await expect(listOrganizationLegalHolds(org.adminSql, { scope, actor: member(['workspace:view'], scope.organizationId) }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(await holdRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    // Positive control: the same customer user with the deletion permission succeeds.
    await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: member(['workspace:destroy'], scope.organizationId), workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'litigation 13',
    });
    expect((await auditRows()).map((r) => r.actor_kind)).toEqual(['customer_user']);
  });

  it('refuses a workspace outside the scope and an unknown source', async () => {
    const otherSource = await source(OTHER_WS, 'slack');
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: OTHER_WS, dataSourceId: otherSource, reason: 'litigation 14',
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: otherSource, reason: 'litigation 14',
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(await holdRows()).toEqual([]);
  });

  it('rolls the hold back when the audit append refuses the event', async () => {
    // Credential-shaped text fails assertGovernancePayloadSafe inside the same transaction.
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'see Bearer abcdefghijklmnop0123456789',
    })).rejects.toThrow(/credential-like material/);
    expect(await holdRows()).toEqual([]);
  });

  it('lists active holds with what each keeps, and released holds only when asked', async () => {
    const whole = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, reason: 'litigation 15',
    });
    const container = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 16',
    });
    await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: container.hold.holdId, reason: 'matter closed' });

    const active = await listOrganizationLegalHolds(org.adminSql, { scope, actor: admin });
    expect(active.map((h) => h.holdId)).toEqual([whole.hold.holdId]);
    expect(active[0]!.channelId).toBeNull();
    expect(active[0]!.retained).toEqual(expect.arrayContaining([
      { store: 'harness_shared.documents', rows: 1 },
      { store: 'harness_shared.data_sources', rows: 1 },
    ]));

    const all = await listOrganizationLegalHolds(org.adminSql, { scope, actor: admin, includeReleased: true });
    expect(all.map((h) => [h.holdId, h.releasedBy, h.retained === null])).toEqual([
      [whole.hold.holdId, null, false],
      [container.hold.holdId, 'admin:tester', true],
    ]);
  });

  it('releases a hold with an audit event naming what it kept, and refuses a second release or a foreign hold', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 17',
    });
    const out = await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'matter closed' });
    expect(out.hold).toMatchObject({ holdId: hold.holdId, releasedBy: 'admin:tester', retained: null });
    expect(out.hold.releasedAt).not.toBeNull();

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([LEGAL_HOLD_ACTIONS.place, LEGAL_HOLD_ACTIONS.release]);
    expect(rows[1]).toMatchObject({ purpose: 'matter closed', target_type: 'legal_hold', target_id: hold.holdId });
    expect(rows[1]!.metadata).toMatchObject({ holdId: hold.holdId, channelId: CH, reason: 'matter closed',
      placedReason: 'litigation 17', placedBy: 'admin:tester' });
    expect(rows[1]!.metadata.retainedAtRelease).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));

    // Released: the chat rows are no longer protected.
    await org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH}`;

    await expect(releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'again' }))
      .rejects.toMatchObject({ code: 'already_released' });
    const otherSource = await source(OTHER_WS, 'slack');
    const foreign = await placeOrganizationLegalHold(org.adminSql, {
      scope: { organizationId: scope.organizationId, workspaceIds: [OTHER_WS] }, actor: admin, workspaceId: OTHER_WS,
      dataSourceId: otherSource, reason: 'other workspace',
    });
    await expect(releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: foreign.hold.holdId, reason: 'x' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(releaseOrganizationLegalHold(org.adminSql, {
      scope, actor: member(['members:manage'], scope.organizationId), holdId: hold.holdId, reason: 'x',
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('exports exactly the content an active hold keeps, with a stable digest and an audit event (P-017d)', async () => {
    const { hold: chatHold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 21',
    });
    const first = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: chatHold.holdId, purpose: 'e-discovery 21' });
    const byStore = Object.fromEntries(first.stores.map((s) => [s.store, s]));
    expect(byStore['harness_shared.chat_messages']!.rows.map((r) => r.provider_message_id).sort()).toEqual(['1.1', '1.2']);
    expect(byStore['harness_shared.documents']!.rows).toHaveLength(0);
    for (const s of first.stores) expect(s.columns.some((c) => s.excludedColumns.includes(c))).toBe(false);
    const again = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: chatHold.holdId, purpose: 'e-discovery 21b' });
    expect(again.digest).toBe(first.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);

    const { hold: docHold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held', reason: 'matter 22',
    });
    const docs = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: docHold.holdId, purpose: 'e-discovery 22' });
    const docRows = docs.stores.find((s) => s.store === 'harness_shared.documents')!.rows;
    expect(docRows.map((r) => r.title)).toEqual(['held issue']);
    expect(docs.digest).not.toBe(first.digest);

    const exports = (await auditRows()).filter((r) => r.action === LEGAL_HOLD_ACTIONS.export);
    expect(exports).toHaveLength(3);
    expect(exports[0]).toMatchObject({ actor_id: 'admin:tester', workspace_id: null, purpose: 'e-discovery 21',
      target_type: 'legal_hold', target_id: chatHold.holdId });
    expect(exports[0]!.metadata).toMatchObject({ holdId: chatHold.holdId, workspaceId: WS, digest: first.digest });
    expect(exports[0]!.metadata.exported).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));
  });

  it('refuses an export by an actor without the export permission, of a foreign or released hold, and writes nothing', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 23',
    });
    const before = (await auditRows()).length;
    await expect(exportLegalHoldContent(org.adminSql, {
      scope, actor: member(['workspace:destroy'], scope.organizationId), holdId: hold.holdId, purpose: 'x',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(exportLegalHoldContent(org.adminSql, {
      scope: { organizationId: scope.organizationId, workspaceIds: [OTHER_WS] }, actor: admin, holdId: hold.holdId, purpose: 'x',
    })).rejects.toMatchObject({ code: 'not_found' });
    expect((await auditRows()).length).toBe(before);
    await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'matter closed' });
    await expect(exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: hold.holdId, purpose: 'x' }))
      .rejects.toMatchObject({ code: 'already_released' });
    expect((await auditRows()).filter((r) => r.action === LEGAL_HOLD_ACTIONS.export)).toHaveLength(0);
  });
});
