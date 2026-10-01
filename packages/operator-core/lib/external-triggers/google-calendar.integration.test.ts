import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { syncGoogleCalendarSource } from './google-calendar';
import { ingestExternalTriggerEvent } from './ingestion';
import { createOwnedExternalTriggerSource, getExternalTriggerSource } from './source-store';

const WS = 'google-calendar-adapter-test';
const NOW = new Date('2026-08-22T12:00:00.000Z');
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'gcal-owner-' + Date.now()}, 'Calendar Owner')
    RETURNING id`;
  userId = users[0].id;
  const calendarType = await getDatatype(sql, 'papercusp-workspace', 'calendar-event');
  if (!calendarType) throw new Error('google_calendar_test_datatype_missing');
  await upsertDatatype(sql, {
    id: calendarType.id,
    workspaceId: WS,
    potSlug: calendarType.potSlug,
    title: calendarType.title,
    description: calendarType.description,
    tier: calendarType.tier,
    nature: calendarType.nature,
    audience: calendarType.audience,
    workItemKind: calendarType.workItemKind,
    payloadSchema: calendarType.payloadSchema,
    authoritativeWriter: calendarType.authoritativeWriter,
    selfImprovement: calendarType.selfImprovement,
    published: calendarType.published,
    tags: calendarType.tags,
    createdBy: 'google-calendar-integration',
  });
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  // Strict shared-container DROP DATABASE cleanup is documented at 6s-267s;
  // keep this adapter on the canonical real-PG teardown budget instead of the
  // integration layer's ordinary 90s hook deadline (EI-21580561576387499).
}, 300_000);

describe('Google Calendar adapter with the real delivery ledger and Personal Vault sink', () => {
  it('persists the provider cursor and dedupes repeated upcoming polls into one private document', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner',
      status: 'ready',
    });
    const event = {
      id: 'meeting-1',
      created: '2026-08-22T11:00:00.000Z',
      updated: '2026-08-22T11:30:00.000Z',
      summary: 'Launch review',
      description: 'Review the launch checklist',
      organizer: { email: 'owner@example.com' },
      attendees: [{ email: 'ada@example.com', displayName: 'Ada' }],
      start: { dateTime: '2026-08-22T12:10:00.000Z' },
      end: { dateTime: '2026-08-22T12:40:00.000Z' },
    };
    // The adapter reads responses through Gaxios, which parses a body as JSON
    // only when it is labelled application/json (as real Google responses are).
    // A bare `new Response(string)` is text/plain, so Gaxios hands back the raw
    // string and every field read (nextSyncToken included) is undefined.
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return json({ items: [event], nextSyncToken: 'sync-1' });
      if (call === 2) return json({ items: [event] });
      if (call === 3) return json({ items: [], nextSyncToken: 'sync-2' });
      return json({ items: [event] });
    }) as unknown as typeof fetch;
    const emit = vi.fn(async (opts: { key: string }) => ({
      ok: true as const,
      key: opts.key,
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const deps = {
      fetch: fetchImpl,
      now: () => NOW,
      apiOrigin: 'https://calendar.test',
      ingest: (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
        ingestExternalTriggerEvent(db, input, { emit }),
    };

    await expect(syncGoogleCalendarSource(sql, source, 'access-token', {}, deps)).resolves.toMatchObject({
      mode: 'full',
      created: 1,
      upcoming: 1,
      syncToken: 'sync-1',
    });
    const advanced = await getExternalTriggerSource(sql, WS, source.id);
    expect(advanced).toMatchObject({
      status: 'connected',
      cursor: { syncToken: 'sync-1', lastSyncAt: NOW.toISOString() },
    });
    await expect(syncGoogleCalendarSource(sql, advanced!, 'access-token', {}, deps)).resolves.toMatchObject({
      mode: 'incremental',
      created: 0,
      updated: 0,
      upcoming: 1,
      syncToken: 'sync-2',
    });

    const documents = await sql<
      Array<{
        source: string;
        kind: string;
        external_id: string;
        title: string;
        participants: string[];
      }>
    >`
      SELECT source, kind, external_id, title, participants
        FROM harness_shared.personal_documents
       WHERE workspace_id = ${WS} AND user_id = ${userId}`;
    expect(documents).toEqual([
      expect.objectContaining({
        source: 'calendar',
        kind: 'event',
        external_id: 'meeting-1',
        title: 'Launch review',
        participants: expect.arrayContaining(['owner@example.com', 'ada@example.com']),
      }),
    ]);

    const deliveries = await sql<Array<{ event_key: string; sink_kind: string; attempts: number }>>`
      SELECT event_key, sink_kind, attempts
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source.id}::uuid
       ORDER BY event_key, sink_kind`;
    expect(deliveries).toHaveLength(6);
    expect(deliveries.map((row) => row.event_key)).toEqual(
      expect.arrayContaining(['ext:gcal:event-created', 'ext:gcal:event-upcoming']),
    );
    expect(deliveries.every((row) => row.attempts === 1)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
