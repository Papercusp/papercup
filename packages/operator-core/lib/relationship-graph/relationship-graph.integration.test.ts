/**
 * The platform relationship graph against real Postgres (crm-agent-sales-onboarding-apps-
 * 2026-10-06 P-002, D-001 / D-011).
 *
 * The shared connector driver, its default sinks (record + admission + the relationship-graph
 * resolve sink), createWorkItem, mergeWorkItemPayload and migration 1383's registry rows all run
 * for real; only the two providers are fixtures (a CRM-like source and a Phone-like source).
 *
 * Properties under test:
 *   - one canonical person per real human ACROSS sources: records sharing an email or phone merge
 *     into one PER- row, with every member stamped `personId`;
 *   - per-field provenance: each merged field names its source record, data source and
 *     observed-at time; an accepted value carries acceptedBy and outranks later observations;
 *   - canonical ids are stable: a record joining a cluster never changes its id, and when two
 *     clusters merge the younger canonical row is retired with `mergedInto` (readers follow it);
 *   - a person links to an organization by email domain, also when the organization arrives later;
 *   - interaction participants (email-message) resolve to graph persons; unknown keys are reported;
 *   - every graph row is nature `record` (never claimable work), and a source that does not route
 *     `person` to `record` writes nothing to the graph;
 *   - replay and a full backfill converge on the same rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostFetch, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { runConnectorSync } from '../providers/connector-runtime';
import { dataSourceRecordId } from '../data-sources/datatype-destination-sink';
import { listProvenanceKey } from './merge';
import {
  acceptEntityField,
  findEntityByIdentity,
  getCanonicalEntity,
  resolveIdentities,
  resolveInteractionParticipants,
} from './resolver';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const CRM = 'graph-crm-fixture';
const PHONE = 'graph-phone-fixture';

const MAIL = 'graph-mail-fixture';
const FIXTURE_DATATYPES = ['person', 'organization', 'email-message', 'calendar-event', 'call'] as const;

interface FixtureRecord {
  datatype: (typeof FIXTURE_DATATYPES)[number];
  nativeId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

const feeds: Record<string, FixtureRecord[]> = { [CRM]: [], [PHONE]: [], [MAIL]: [] };

function fixtureProvider(id: string): { descriptor: ProviderDescriptor; adapter: ProviderAdapter } {
  const descriptor: ProviderDescriptor = {
    id,
    contractVersion: 1,
    datatypes: [...FIXTURE_DATATYPES],
    // Capabilities are `<domain>.<verb>` (no hyphen), so the mail and calendar datatypes read
    // under the same `mail.read` / `calendar.read` domains the real providers declare.
    capabilities: ['person.read', 'organization.read', 'mail.read', 'calendar.read', 'call.read'],
    egressHosts: [`${id}.example.com`],
  };
  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: async () => ({
      records: feeds[id]!.map((r) => ({
        datatype: r.datatype,
        nativeId: r.nativeId,
        event: `${r.datatype}-updated`,
        payload: { provider: id, externalId: r.nativeId, ...r.payload },
        ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}),
      })),
      nextCursor: null,
      hasMore: false,
    }),
    invoke: async () => {
      throw new Error(`${id} is a read-only fixture`);
    },
  };
  return { descriptor, adapter };
}

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let registry: ProviderRegistry;
const noFetch: HostFetch = async () => ({ status: 404, headers: {}, body: '', bodyEncoding: 'utf8' });

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

async function sync(sourceId: string): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId] },
    { registry, ingest, hostFetchFor: () => noFetch, leaseOwner: 'relationship-graph-it' },
  );
  expect(result.sources).toEqual([expect.objectContaining({ sourceId, outcome: 'synced', rejected: 0 })]);
}

async function connect(kind: string, policy: Record<string, string[]> = { person: ['record'], organization: ['record'] }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${alice}, ${`${kind}-account-${Date.now()}-${Math.random()}`}, 'connected',
            ${sql.json({ harnessSlug: HARNESS })}, 'organization',
            ${sql.json(policy)}, ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  return row!.id;
}

interface GraphRow {
  feature_id: string;
  item_kind: string;
  nature: string;
  title: string;
  payload: Record<string, unknown>;
}

async function graphRows(prefix: 'PER-' | 'ORG-' | 'DSR-', datatype: 'person' | 'organization'): Promise<GraphRow[]> {
  return sql<GraphRow[]>`
    SELECT feature_id, item_kind, nature, title, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND item_kind = ${datatype} AND feature_id LIKE ${`${prefix}%`}
     ORDER BY created_ts, feature_id`;
}

const live = (rows: GraphRow[]) => rows.filter((r) => !r.payload.mergedInto);

async function clean(): Promise<void> {
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${CRM}, ${PHONE}, ${MAIL})`;
  const ids = sources.map((s) => s.id);
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND item_kind IN ('person', 'organization')
             AND (feature_id LIKE 'PER-%' OR feature_id LIKE 'ORG-%' OR payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[]))`;
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${CRM}, ${PHONE}, ${MAIL})`;
  feeds[CRM] = [];
  feeds[PHONE] = [];
  feeds[MAIL] = [];
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`relationship-graph-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
  registry = createProviderRegistry();
  for (const id of [CRM, PHONE, MAIL]) {
    const { descriptor, adapter } = fixtureProvider(id);
    // Awaited: register() is async and validates the descriptor, so an un-awaited rejection would
    // leave the registry empty and surface only as every sync returning `sources: []`.
    await registry.register({ descriptor, adapter, pluginName: id, runtime: 'js' } as never);
  }
  expect(registry.list().map((p) => p.descriptor.id).sort()).toEqual([CRM, MAIL, PHONE].sort());
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await clean();
});

describe('platform relationship graph (P-002, R-1)', () => {
  it('registers person/organization/commitment as records and call as a document (migration 1383)', async () => {
    const rows = await sql<Array<{ id: string; tier: string; work_item_kind: string | null; nature: string }>>`
      SELECT id, tier, work_item_kind, nature FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id IN ('person', 'organization', 'commitment', 'call') ORDER BY id`;
    expect(rows).toEqual([
      { id: 'call', tier: 'first-class', work_item_kind: null, nature: 'document' },
      { id: 'commitment', tier: 'generic-kind', work_item_kind: 'commitment', nature: 'record' },
      { id: 'organization', tier: 'generic-kind', work_item_kind: 'organization', nature: 'record' },
      { id: 'person', tier: 'generic-kind', work_item_kind: 'person', nature: 'record' },
    ]);
  });

  it('merges one human across sources into one canonical person with per-field provenance and a stable id', async () => {
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada L.', title: 'CTO', emails: ['ada@acme.com'], updatedAt: '2026-09-01T00:00:00Z' } },
      { datatype: 'person', nativeId: 'crm-bob', payload: { displayName: 'Bob', emails: ['bob@beta.io'], updatedAt: '2026-09-01T00:00:00Z' } },
      // Delivered AFTER the persons: Ada must still be linked to it (relink path).
      { datatype: 'organization', nativeId: 'crm-acme', payload: { name: 'Acme', domains: ['acme.com'], updatedAt: '2026-09-01T00:00:00Z' } },
    ];
    const crm = await connect(CRM);
    await sync(crm);

    const [acme] = live(await graphRows('ORG-', 'organization'));
    expect(acme).toMatchObject({ title: 'Acme', nature: 'record', payload: { canonical: true, domains: ['acme.com'] } });
    const afterCrm = live(await graphRows('PER-', 'person'));
    expect(afterCrm.map((r) => r.title).sort()).toEqual(['Ada L.', 'Bob']);
    const adaId = afterCrm.find((r) => r.title === 'Ada L.')!.feature_id;
    const adaAfterCrm = afterCrm.find((r) => r.feature_id === adaId)!;
    expect(adaAfterCrm.payload.organizationId).toBe(acme!.feature_id);
    expect(adaAfterCrm.payload.provenance).toMatchObject({
      organizationId: { source: { kind: 'derived', from: 'email-domain:acme.com' }, acceptedBy: null },
    });

    feeds[PHONE] = [
      { datatype: 'person', nativeId: 'ph-ada', payload: { displayName: 'Ada Lovelace', emails: ['ADA@acme.com'], phones: ['+1 (555) 123-4567'], updatedAt: '2026-10-01T00:00:00Z' } },
    ];
    const phone = await connect(PHONE);
    await sync(phone);

    const persons = live(await graphRows('PER-', 'person'));
    expect(persons).toHaveLength(2); // one per real human, across both sources
    const ada = persons.find((r) => r.feature_id === adaId)!; // the id did not move
    const crmAda = dataSourceRecordId(WS, crm, 'person', 'crm-ada');
    const phoneAda = dataSourceRecordId(WS, phone, 'person', 'ph-ada');
    expect(ada).toMatchObject({ item_kind: 'person', nature: 'record', title: 'Ada Lovelace' });
    expect(ada.payload).toMatchObject({
      canonical: true,
      provider: 'relationship-graph',
      externalId: adaId,
      displayName: 'Ada Lovelace',
      title: 'CTO',
      emails: ['ada@acme.com'],
      phones: ['+15551234567'],
      memberRecordIds: [crmAda, phoneAda].sort(),
      identityKeys: ['email:ada@acme.com', 'phone:+15551234567'],
    });
    expect(ada.payload.provenance).toMatchObject({
      displayName: { source: { kind: 'record', recordId: phoneAda, dataSourceId: phone, provider: PHONE }, observedAt: '2026-10-01T00:00:00.000Z', acceptedBy: null },
      title: { source: { kind: 'record', recordId: crmAda, dataSourceId: crm, provider: CRM }, observedAt: '2026-09-01T00:00:00.000Z', acceptedBy: null },
      'phones:+15551234567': { source: { recordId: phoneAda } },
    });

    // Every member row is stamped with its canonical person and stays a record.
    const members = await graphRows('DSR-', 'person');
    expect(members.filter((r) => [crmAda, phoneAda].includes(r.feature_id)).map((r) => [r.payload.personId, r.nature]))
      .toEqual([[adaId, 'record'], [adaId, 'record']]);

    // Lookup by any identity key reaches the same person.
    expect((await findEntityByIdentity(sql, WS, 'person', 'phone:+15551234567'))?.id).toBe(adaId);

    // Interaction participants resolve to graph persons; an unknown address is reported.
    expect(await resolveInteractionParticipants(sql, WS, 'email-message', { from: 'Ada <ada@acme.com>', to: ['bob@beta.io', 'zed@zeta.io'] }))
      .toEqual({ personIds: [adaId, persons.find((r) => r.title === 'Bob')!.feature_id].sort(), unresolved: ['email:zed@zeta.io'] });

    // Replay and a full backfill converge on the same rows.
    const snapshot = async () => (await graphRows('PER-', 'person')).map((r) => ({ id: r.feature_id, title: r.title, members: r.payload.memberRecordIds, merged: r.payload.mergedInto ?? null }));
    const before = await snapshot();
    await sync(crm);
    await sync(phone);
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'person' });
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('a record that bridges two clusters retires the younger canonical person into the older', async () => {
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'] } },
      { datatype: 'person', nativeId: 'crm-bob', payload: { displayName: 'Bob', emails: ['bob@beta.io'] } },
    ];
    const crm = await connect(CRM);
    await sync(crm);
    const [first, second] = live(await graphRows('PER-', 'person'));
    expect(second).toBeDefined();

    feeds[PHONE] = [{ datatype: 'person', nativeId: 'ph-shared', payload: { emails: ['ada@acme.com', 'bob@beta.io'] } }];
    const phone = await connect(PHONE);
    await sync(phone);

    const rows = await graphRows('PER-', 'person');
    expect(live(rows).map((r) => r.feature_id)).toEqual([first!.feature_id]);
    const retired = rows.find((r) => r.feature_id === second!.feature_id)!;
    expect(retired.payload).toMatchObject({ mergedInto: first!.feature_id, memberRecordIds: [], identityKeys: [] });
    expect((await getCanonicalEntity(sql, WS, 'person', second!.feature_id))?.id).toBe(first!.feature_id);
    expect(live(rows)[0]!.payload.memberRecordIds).toHaveLength(3);
  });

  it('an accepted value carries acceptedBy and outranks a later observation', async () => {
    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'], updatedAt: '2026-09-01T00:00:00Z' } }];
    const crm = await connect(CRM);
    await sync(crm);
    const [ada] = live(await graphRows('PER-', 'person'));

    const accepted = await acceptEntityField(sql, {
      workspaceId: WS, datatype: 'person', canonicalId: ada!.feature_id, field: 'displayName', value: 'Countess Ada', acceptedBy: 'user:avi',
    }, { now: () => new Date('2026-10-02T00:00:00Z') });
    expect(accepted.payload).toMatchObject({
      displayName: 'Countess Ada',
      provenance: { displayName: { source: { kind: 'accepted' }, observedAt: '2026-10-02T00:00:00.000Z', acceptedBy: 'user:avi' } },
    });

    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada Renamed', emails: ['ada@acme.com'], updatedAt: '2026-10-05T00:00:00Z' } }];
    await sync(crm);
    const after = await getCanonicalEntity(sql, WS, 'person', ada!.feature_id);
    expect(after?.payload.displayName).toBe('Countess Ada');
    expect(after?.title).toBe('Countess Ada');

    await expect(acceptEntityField(sql, {
      workspaceId: WS, datatype: 'person', canonicalId: ada!.feature_id, field: 'favouriteColour', value: 'blue', acceptedBy: 'user:avi',
    })).rejects.toMatchObject({ code: 'unknown_field' });
  });

  it('a source that does not route person to record writes nothing to the graph', async () => {
    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'] } }];
    const crm = await connect(CRM, { organization: ['record'] });
    await sync(crm);
    expect(await graphRows('DSR-', 'person')).toEqual([]);
    expect(await graphRows('PER-', 'person')).toEqual([]);
  });

  it('ingesting an email, a calendar event and a phone call for the same address yields exactly one person (SPEC-P-002, R-1)', async () => {
    const policy = { person: ['record'], organization: ['record'], call: ['document'] };
    const email = { from: '"Ada Lovelace" <ada@acme.com>', to: ['me@papercusp.test'], subject: 'Renewal pricing', body: 'CONFIDENTIAL-BODY' };
    const event = { title: 'Renewal review', organizer: 'me@papercusp.test', attendees: [{ email: 'ADA@acme.com', displayName: 'Ada' }], description: 'CONFIDENTIAL-AGENDA' };
    const call = { title: 'Call with Ada', from: '+1 (555) 123-4567', to: ['+15550009999'], participants: [{ name: 'Ada Lovelace', email: 'ada@acme.com', phone: '+1 555 123 4567' }], text: 'CONFIDENTIAL-TRANSCRIPT' };
    feeds[MAIL] = [
      { datatype: 'email-message', nativeId: 'msg-1', payload: email, occurredAt: '2026-10-02T09:00:00.000Z' },
      { datatype: 'email-message', nativeId: 'msg-2', payload: { from: 'No Reply <no-reply@acme.com>', to: ['me@papercusp.test'], subject: 'Receipt' }, occurredAt: '2026-10-02T10:00:00.000Z' },
      { datatype: 'calendar-event', nativeId: 'evt-1', payload: event, occurredAt: '2026-10-03T15:00:00.000Z' },
    ];
    feeds[PHONE] = [{ datatype: 'call', nativeId: 'call-1', payload: call, occurredAt: '2026-10-04T11:00:00.000Z' }];
    const mail = await connect(MAIL, policy);
    const phone = await connect(PHONE, policy);
    await sync(mail);
    await sync(phone);

    // Each interaction was stored by its own store sink (Vault for mail/calendar, corpus for the call)
    // and projected by the participant sink, with no delivery error.
    const deliveries = await sql<{ datatype_id: string; sink_kind: string; error: string | null }[]>`
      SELECT datatype_id, sink_kind, error FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array([mail, phone])}::uuid[])
         AND datatype_id IN ('email-message', 'calendar-event', 'call')`;
    expect(deliveries.filter((d) => d.error)).toEqual([]);
    for (const datatype of ['email-message', 'calendar-event', 'call']) {
      const kinds = new Set(deliveries.filter((d) => d.datatype_id === datatype).map((d) => d.sink_kind));
      expect(kinds.has('relationship-graph-participants'), datatype).toBe(true);
      expect([...kinds].some((k) => k !== 'relationship-graph-participants'), datatype).toBe(true);
    }

    // Exactly one platform person for that address (the SPEC-P-002 falsifier is two).
    const adas = live(await graphRows('PER-', 'person')).filter((r) => (r.payload.identityKeys as string[]).includes('email:ada@acme.com'));
    expect(adas).toHaveLength(1);
    const ada = adas[0]!;
    expect(ada.payload).toMatchObject({
      canonical: true,
      displayName: 'Ada Lovelace',
      emails: ['ada@acme.com'],
      phones: ['+15551234567'],
      identityKeys: ['email:ada@acme.com', 'phone:+15551234567'],
    });
    expect([...(ada.payload.memberRecordIds as string[])].sort()).toEqual([
      dataSourceRecordId(WS, mail, 'person', 'participant:email:ada@acme.com'),
      dataSourceRecordId(WS, phone, 'person', 'participant:email:ada@acme.com'),
      dataSourceRecordId(WS, phone, 'person', 'participant:phone:+15551234567'),
    ].sort());

    // The three interaction records resolve to that one person.
    for (const [datatype, payload] of [['email-message', email], ['calendar-event', event], ['call', call]] as const) {
      expect((await resolveInteractionParticipants(sql, WS, datatype, payload)).personIds, datatype).toContain(ada.feature_id);
    }

    // Every field carries source, observed-at and accepted-by provenance.
    const provenance = ada.payload.provenance as Record<string, { source?: unknown; observedAt?: unknown; acceptedBy?: unknown }>;
    for (const key of ['displayName', listProvenanceKey('emails', 'ada@acme.com'), listProvenanceKey('phones', '+15551234567')]) {
      expect(Object.keys(provenance), key).toContain(key);
    }
    for (const [key, entry] of Object.entries(provenance)) {
      expect(entry.source, key).toEqual(expect.any(Object));
      expect(entry.observedAt, key).toEqual(expect.any(String));
      expect(entry.acceptedBy === null || typeof entry.acceptedBy === 'string', key).toBe(true);
    }
    expect(provenance.displayName).toMatchObject({ source: { kind: 'record', dataSourceId: phone }, observedAt: '2026-10-04T11:00:00.000Z', acceptedBy: null });

    // Identity only: no subject, body, agenda or transcript reached the graph.
    const graphText = JSON.stringify([...(await graphRows('PER-', 'person')), ...(await graphRows('DSR-', 'person'))]);
    for (const secret of ['CONFIDENTIAL', 'Renewal pricing', 'Renewal review', 'Receipt']) expect(graphText).not.toContain(secret);

    // An automated sender is not a person.
    expect(await findEntityByIdentity(sql, WS, 'person', 'email:no-reply@acme.com')).toBeNull();

    // Replaying both sources adds no person.
    const before = live(await graphRows('PER-', 'person')).map((r) => r.feature_id);
    await sync(mail);
    await sync(phone);
    expect(live(await graphRows('PER-', 'person')).map((r) => r.feature_id)).toEqual(before);
  });

  it('a source that does not route person to record projects no interaction participants (D-013 grant)', async () => {
    feeds[PHONE] = [{ datatype: 'call', nativeId: 'call-1', payload: { from: '+1 555 123 4567', participants: [{ name: 'Ada', email: 'ada@acme.com' }] } }];
    const phone = await connect(PHONE, { call: ['document'] });
    await sync(phone);
    // Positive control: the call itself was stored, so the empty graph is the grant, not a dropped delivery.
    const stored = await sql<{ sink_kind: string }[]>`
      SELECT sink_kind FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${phone}::uuid AND datatype_id = 'call'`;
    expect(stored.map((s) => s.sink_kind)).toEqual(['data-source-document']);
    expect(await graphRows('DSR-', 'person')).toEqual([]);
    expect(await graphRows('PER-', 'person')).toEqual([]);
  });
});
