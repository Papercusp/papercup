/**
 * Participant backfill (plan crm-agent-sales-onboarding-apps-2026-10-06 P-003, decision D-017 point 2).
 *
 * Measured on a migrated throwaway database through the production seams: interactions stored in
 * an owner's Personal Vault are read through the team metadata path (readTeamInteractions,
 * addresses only) and projected into the relationship graph through the same participant chain
 * live delivery uses. A source's `person -> record` routing is the grant (D-013 point 4): an
 * ungranted source contributes nobody, and replaying the backfill adds no person.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { setPersonalVaultEnabled, upsertPersonalDocuments } from '../personal-vault/store';
import type { PersonalToolContext } from '../personal-vault/types';
import { backfillInteractionParticipants, runPendingParticipantBackfills } from './participant-backfill';
import { searchPeople } from './people';

const WS = 'participant-backfill-test';
const HARNESS = 'participant-backfill-test';
const CTX: PersonalToolContext = { workspaceId: WS, role: 'crm-sales-agent' };
const OWNER = 'owner@me.example';
const LEAD = 'lead@prospect.example';
const ATTENDEE = 'attendee@ungranted.example';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;
let mailSource: string;
let calendarSource: string;

async function connect(kind: string, policy: Record<string, string[]>): Promise<{ id: string; account: string }> {
  const account = `${kind}-account-${randomUUID()}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${userId}, ${account}, 'connected',
            ${sql.json({ harnessSlug: HARNESS })}, 'personal',
            ${sql.json(policy)}, ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  return { id: row!.id, account };
}

async function personIds(): Promise<string[]> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND item_kind = 'person' AND feature_id LIKE 'PER-%'
       AND (payload->>'mergedInto') IS NULL
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'participant-backfill-' + Date.now()}, 'Participant backfill')
    RETURNING id`;
  userId = user!.id;
  await setPersonalVaultEnabled(sql, WS, userId, true, 'test');

  const mail = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] });
  const calendar = await connect('gcal', { 'calendar-event': ['document', 'event'] });
  mailSource = mail.id;
  calendarSource = calendar.id;
  await upsertPersonalDocuments(sql, WS, userId, [
    {
      source: 'gmail',
      sourceId: mail.id,
      providerAccountId: mail.account,
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-05T15:00:00Z',
      participants: [LEAD, OWNER],
      title: 'Trial and security review',
      text: 'Happy to start a trial next week.',
      metadata: { from: LEAD, to: [OWNER] },
    },
    {
      source: 'gcal',
      sourceId: calendar.id,
      providerAccountId: calendar.account,
      kind: 'calendar-event',
      externalId: `evt-${randomUUID()}`,
      occurredAt: '2026-10-07T17:00:00Z',
      participants: [ATTENDEE, OWNER],
      title: 'Onboarding call',
      text: 'Agenda: install and first plan.',
      metadata: { organizer: OWNER, attendees: [ATTENDEE] },
    },
  ]);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`.catch(() => {});
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`.catch(() => {});
    for (const table of ['personal_disclosures', 'personal_grants', 'personal_documents']) {
      await sql.unsafe(`DELETE FROM harness_shared.${table} WHERE workspace_id = $1`, [WS]).catch(() => {});
    }
    await sql`DELETE FROM harness_shared.personal_vault_settings WHERE workspace_id = ${WS}`.catch(() => {});
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`.catch(() => {});
    await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

describe('interaction participant backfill (P-003, D-017 point 2)', () => {
  it('refuses a coding role before reading anything', async () => {
    const result = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: { workspaceId: WS, role: 'engineer' } });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'coding_agent_denied' });
    expect(await personIds()).toEqual([]);
  });

  it('projects participants of stored interactions from a granted source only, and a replay adds no person', async () => {
    const result = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: CTX });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const bySource = Object.fromEntries(result.sources.map((s) => [s.sourceId, s]));
    expect(bySource[mailSource]).toEqual({ sourceId: mailSource, datatype: 'email-message', granted: true, documents: 1, participants: 2 });
    // Positive control for the ungranted case: the calendar document IS stored (it is listed), so
    // the zero below is the grant, not a missing fixture.
    expect(bySource[calendarSource]).toEqual({ sourceId: calendarSource, datatype: 'calendar-event', granted: false, documents: 0, participants: 0 });

    const lead = await searchPeople(sql, WS, { emails: [LEAD] });
    expect(lead.map((p) => p.emails)).toEqual([[LEAD]]);
    expect(lead[0]!.id).toMatch(/^PER-/);
    expect(await searchPeople(sql, WS, { emails: [ATTENDEE] })).toEqual([]);

    const before = await personIds();
    expect(before).toHaveLength(2); // LEAD and OWNER from the one granted email
    const replay = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: CTX });
    expect(replay.ok).toBe(true);
    expect(await personIds()).toEqual(before);
  });

  it('the platform sweep backfills each granted source once per grant (D-018, migration 1394)', async () => {
    const marker = async (id: string) =>
      (await sql<{ at: Date | null }[]>`SELECT participant_backfill_at AS at FROM harness_shared.data_sources WHERE id = ${id}::uuid`)[0]!.at;
    // Isolate from the previous case's direct calls: the marker is only written by the sweep.
    await sql`UPDATE harness_shared.data_sources SET participant_backfill_at = NULL WHERE workspace_id = ${WS}`;

    const first = await runPendingParticipantBackfills(sql, { workspaceId: WS });
    // Only the granted mail source is pending; the ungranted calendar source is never picked.
    expect(first).toEqual([{ sourceId: mailSource, outcome: 'backfilled', documents: 1, participants: 2 }]);
    expect(await marker(mailSource)).not.toBeNull();
    expect(await marker(calendarSource)).toBeNull();
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS })).toEqual([]);

    // Revoking keeps the stamp; granting again clears it, so the next tick backfills again.
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy - 'person' WHERE id = ${mailSource}::uuid`;
    expect(await marker(mailSource)).not.toBeNull();
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy || '{"person":["record"]}'::jsonb WHERE id = ${mailSource}::uuid`;
    expect(await marker(mailSource)).toBeNull();
    expect((await runPendingParticipantBackfills(sql, { workspaceId: WS })).map((r) => [r.sourceId, r.outcome])).toEqual([[mailSource, 'backfilled']]);

    // Granting the calendar source makes it pending too; its attendee then enters the graph.
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy || '{"person":["record"]}'::jsonb WHERE id = ${calendarSource}::uuid`;
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS })).toEqual([
      { sourceId: calendarSource, outcome: 'backfilled', documents: 1, participants: 2 },
    ]);
    expect((await searchPeople(sql, WS, { emails: [ATTENDEE] })).map((p) => p.emails)).toEqual([[ATTENDEE]]);
  });
});
