/**
 * slack-messages-to-bug-reports-2026-10-05 P-002 (R-2), integration layer: recorded Socket
 * Mode envelopes for each report gesture go through ingestSlackSocketEnvelope and the real
 * external-trigger ingestion into Postgres. Each gesture lands exactly one report-bug
 * chat-message event, validated against the chat-message payload schema, and a replayed
 * envelope lands nothing new.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { ingestExternalTriggerEvent } from './ingestion';
import { ingestSlackSocketEnvelope, type SlackSocketEnvelope } from './slack';
import { SLACK_REPORT_BUG_MODAL_CALLBACK_ID, SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID } from './slack-report-bug';
import { upsertOwnedExternalTriggerSource, type ExternalTriggerSourceRow } from './source-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// Same isolation as slack-flagship.integration.test.ts: every shared-store read and
// write stays inside this throwaway database.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const WS = 'slack-report-bug-it';
// The chat-message payload schema exactly as the registry carries it in papercusp-workspace.
const CHAT_MESSAGE_SCHEMA = {
  type: 'object',
  required: ['id', 'text'],
  properties: {
    id: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    sender: { type: 'string' },
    mentions: { type: 'array', items: { type: 'string' } },
    threadId: { type: 'string' },
    channelId: { type: 'string' },
    occurredAt: { type: 'string' },
    attachments: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: true,
};

let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'slack-report-bug-owner-' + Date.now()}, 'Slack Report Bug Owner')
    RETURNING id`;
  userId = users[0]!.id;
  await sql`
    INSERT INTO harness_shared.datatype_registry
      (workspace_id, id, title, description, tier, payload_schema, authoritative_writer)
    VALUES (
      ${WS}, 'chat-message', 'Chat message', 'Normalized chat event', 'workspace',
      ${JSON.stringify(CHAT_MESSAGE_SCHEMA)}::text::jsonb, 'papercusp'
    )
    ON CONFLICT (workspace_id, id) DO UPDATE SET payload_schema = EXCLUDED.payload_schema`;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

async function reportingSource(): Promise<ExternalTriggerSourceRow> {
  return upsertOwnedExternalTriggerSource(sql, {
    workspaceId: WS,
    kind: 'slack',
    ownerUserId: userId,
    credentialRef: 'slack-socket:owner',
    status: 'connected',
    config: {
      installSlug: 'papercusp',
      botUserId: 'UPAPER',
      reportBug: {
        channels: {
          C1: { reaction: true, shortcut: true, mention: true },
          CBUGS: { bugChannel: true, mention: true },
        },
      },
    },
  });
}

function events(eventId: string, event: Record<string, unknown>): SlackSocketEnvelope {
  return { envelope_id: `env-${eventId}`, type: 'events_api', payload: { event_id: eventId, event_time: 1_777_000_000, event } };
}

const GESTURES: Array<[string, SlackSocketEnvelope]> = [
  ['reaction', events('EvR', {
    type: 'reaction_added', user: 'U1', reaction: 'bug',
    item: { type: 'message', channel: 'C1', ts: '1777000000.000100' }, event_ts: '1777000001.000200',
  })],
  ['mention', events('EvM', {
    type: 'app_mention', channel: 'C1', user: 'U3', text: '<@UPAPER> bug the export is empty',
    ts: '1777000005.000500', thread_ts: '1777000000.000100',
  })],
  ['shortcut', {
    envelope_id: 'env-view', type: 'interactive', payload: {
      type: 'view_submission', user: { id: 'U4' },
      view: {
        id: 'VIEW1', callback_id: SLACK_REPORT_BUG_MODAL_CALLBACK_ID,
        private_metadata: JSON.stringify({ channelId: 'C1', messageTs: '1777000003.000300' }),
        state: { values: { note: { note: { value: 'every export' } }, consent: { consent: { selected_options: [] } } } },
      },
    },
  }],
  ['bug-channel', events('EvB', {
    type: 'message', channel: 'CBUGS', channel_type: 'channel', user: 'U5', text: 'login loops forever',
    ts: '1777000010.000100',
  })],
];

describe('Slack report-bug gestures through real ingestion', () => {
  it('lands exactly one schema-valid report-bug chat event per gesture, and none for the companion envelopes', async () => {
    const source = await reportingSource();
    const emit = vi.fn(async (opts: { key: string }) => ({
      ok: true as const, key: opts.key, woken: 0, notified: [], msgId: null, waiters: 0,
    }));
    const ingest = (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
      ingestExternalTriggerEvent(db, input, { emit: emit as never });

    for (const [, envelope] of GESTURES) {
      const normalized = await ingestSlackSocketEnvelope(sql, source, envelope, ingest);
      expect(normalized?.event).toBe('report-bug');
    }
    // Companions that must NOT add a report: the app_mention copy of the bug-channel post,
    // and the shortcut click that only opens the form.
    const companions: SlackSocketEnvelope[] = [
      events('EvB2', { type: 'app_mention', channel: 'CBUGS', user: 'U5', text: '<@UPAPER> login loops forever', ts: '1777000010.000100' }),
      {
        envelope_id: 'env-click', type: 'interactive', payload: {
          type: 'message_action', callback_id: SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID, trigger_id: 'trig-1',
          user: { id: 'U4' }, channel: { id: 'C1' }, message: { ts: '1777000003.000300', text: 'x' },
        },
      },
    ];
    for (const envelope of companions) {
      expect(await ingestSlackSocketEnvelope(sql, source, envelope, ingest)).toBeNull();
    }

    const rows = await sql<Array<{ dedupeKey: string; datatypeId: string; payload: Record<string, unknown> }>>`
      SELECT dedupe_key AS "dedupeKey", datatype_id AS "datatypeId", payload
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source.id} AND payload IS NOT NULL
       ORDER BY dedupe_key`;
    expect(rows.map((row) => row.dedupeKey)).toEqual(['slack:EvB', 'slack:EvM', 'slack:EvR', 'slack:view:VIEW1']);
    expect(new Set(rows.map((row) => row.datatypeId))).toEqual(new Set(['chat-message']));
    const gestures = rows.map((row) => [row.payload.gesture, row.payload.signal]).sort();
    expect(gestures).toEqual([
      ['bug-channel', 'report-bug'], ['mention', 'report-bug'], ['reaction', 'report-bug'], ['shortcut', 'report-bug'],
    ]);
    for (const row of rows) {
      expect(row.payload).toMatchObject({ reporter: { kind: 'chat', provider: 'slack' } });
      expect(typeof (row.payload.target as Record<string, unknown>).ts).toBe('string');
    }
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('a replayed envelope is deduped: still one event per gesture', async () => {
    const source = await reportingSource();
    const emit = vi.fn(async (opts: { key: string }) => ({
      ok: true as const, key: opts.key, woken: 0, notified: [], msgId: null, waiters: 0,
    }));
    const ingest = (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
      ingestExternalTriggerEvent(db, input, { emit: emit as never });
    const [, reaction] = GESTURES[0]!;
    await ingestSlackSocketEnvelope(sql, source, reaction, ingest);
    await ingestSlackSocketEnvelope(sql, source, reaction, ingest);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source.id} AND dedupe_key = 'slack:EvR' AND payload IS NOT NULL`;
    expect(rows[0]!.n).toBe(1);
  });

  it('a channel with no rule ingests no report; "@Papercusp bug" there stays an ordinary mention trigger', async () => {
    const source = await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: WS, kind: 'slack', ownerUserId: userId, credentialRef: 'slack-socket:owner', status: 'connected',
      config: { installSlug: 'papercusp', botUserId: 'UPAPER' },
    });
    const ingest = vi.fn(async (_db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) => ({
      ok: true, event: { key: input.event } as never, deliveries: [],
    }));
    const results = [];
    for (const [gesture, envelope] of GESTURES) {
      results.push([gesture, (await ingestSlackSocketEnvelope(sql, source, envelope, ingest as never))?.event ?? null]);
    }
    expect(results).toEqual([['reaction', null], ['mention', 'mention'], ['shortcut', null], ['bug-channel', null]]);
    expect(ingest.mock.calls.map((call) => call[1].event)).toEqual(['mention']);
  });
});
