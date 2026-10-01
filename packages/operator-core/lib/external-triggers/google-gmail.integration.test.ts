import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { syncGoogleGmailSource } from './google-gmail';
import { ingestExternalTriggerEvent } from './ingestion';
import { createOwnedExternalTriggerSource, getExternalTriggerSource } from './source-store';

const WS = 'google-gmail-adapter-test';
const NOW = new Date('2026-08-22T12:00:00.000Z');
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'gmail-owner-' + Date.now()}, 'Gmail Owner')
    RETURNING id`;
  userId = users[0].id;
  const emailType = await getDatatype(sql, 'papercusp-workspace', 'email-message');
  if (!emailType) throw new Error('google_gmail_test_datatype_missing');
  await upsertDatatype(sql, {
    id: emailType.id,
    workspaceId: WS,
    potSlug: emailType.potSlug,
    title: emailType.title,
    description: emailType.description,
    tier: emailType.tier,
    nature: emailType.nature,
    audience: emailType.audience,
    workItemKind: emailType.workItemKind,
    payloadSchema: emailType.payloadSchema,
    authoritativeWriter: emailType.authoritativeWriter,
    selfImprovement: emailType.selfImprovement,
    published: emailType.published,
    tags: emailType.tags,
    createdBy: 'google-gmail-integration',
  });
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  // Strict shared-container DROP DATABASE cleanup is documented at 6s-267s;
  // keep this adapter on the canonical real-PG teardown budget instead of the
  // integration layer's ordinary 90s hook deadline (EI-21580561576387499).
}, 300_000);

describe('Google Gmail adapter with the real delivery ledger and Personal Vault sink', () => {
  it('commits history after delivery and dedupes a replay into one private document', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner',
      status: 'ready',
      cursor: {
        emailAddress: 'owner@example.com',
        historyId: 'history-old',
        watchExpiration: '2026-08-28T00:00:00.000Z',
      },
    });
    const gmailMessage = {
      id: 'mail-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      snippet: 'Review Project Phoenix',
      internalDate: String(NOW.getTime()),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Ada <ada@example.com>' },
          { name: 'To', value: 'Owner <owner@example.com>' },
          { name: 'Subject', value: 'Project Phoenix review' },
        ],
        body: { data: Buffer.from('Review the launch privacy checklist').toString('base64url') },
      },
    };
    let historyCall = 0;
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history')) {
        historyCall += 1;
        return new Response(
          JSON.stringify({
            history:
              historyCall === 1
                ? [{ id: 'history-record-1', messagesAdded: [{ message: { id: 'mail-1' } }] }]
                : [{ id: 'history-record-2', messagesAdded: [{ message: { id: 'mail-1' } }] }],
            historyId: historyCall === 1 ? 'history-new' : 'history-newer',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname.endsWith('/messages/mail-1')) {
        return new Response(JSON.stringify(gmailMessage), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected Gmail request ${url}`);
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
      apiOrigin: 'https://gmail.test',
      ingest: (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
        ingestExternalTriggerEvent(db, input, { emit }),
    };

    await expect(syncGoogleGmailSource(sql, source, 'access-token', deps)).resolves.toMatchObject({
      mode: 'incremental',
      messages: 1,
      historyId: 'history-new',
    });
    const advanced = await getExternalTriggerSource(sql, WS, source.id);
    expect(advanced).toMatchObject({
      status: 'connected',
      cursor: {
        emailAddress: 'owner@example.com',
        historyId: 'history-new',
        watchExpiration: '2026-08-28T00:00:00.000Z',
        lastSyncAt: NOW.toISOString(),
      },
    });
    await expect(syncGoogleGmailSource(sql, advanced!, 'access-token', deps)).resolves.toMatchObject({
      mode: 'incremental',
      messages: 1,
      historyId: 'history-newer',
    });

    const documents = await sql<
      Array<{
        source: string;
        kind: string;
        external_id: string;
        title: string;
        participants: string[];
        text: string;
      }>
    >`
      SELECT source, kind, external_id, title, participants, text
        FROM harness_shared.personal_documents
       WHERE workspace_id = ${WS} AND user_id = ${userId}`;
    expect(documents).toEqual([
      expect.objectContaining({
        source: 'gmail',
        kind: 'message',
        external_id: 'mail-1',
        title: 'Project Phoenix review',
        participants: expect.arrayContaining(['ada@example.com', 'owner@example.com']),
        text: 'Review the launch privacy checklist',
      }),
    ]);
    const deliveries = await sql<Array<{ event_key: string; sink_kind: string; attempts: number }>>`
      SELECT event_key, sink_kind, attempts
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source.id}::uuid
       ORDER BY sink_kind`;
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((row) => row.event_key === 'ext:gmail:message.received')).toBe(true);
    expect(deliveries.every((row) => row.attempts === 1)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
