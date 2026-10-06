/**
 * slack-messages-to-bug-reports-2026-10-05 P-008 (D-011): the per-channel Slack-bugs read, against
 * a fully migrated Postgres (work_admissions.outcome and the chat-admission index come from
 * migrations 1409/1410). Each column is fed from the table that owns it, and each exclusion is
 * pinned: a disabled rule, a non-chat admission, a delivered or other-sink delivery, a pending
 * suggestion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { CHAT_ADMISSION_SINK_KIND } from './chat-admission-sink';
import { chatBugsOverview, type ChatBugsChannel } from './chat-bugs-overview';

const WS = 'papercusp-workspace';
let org: OrgTestDb;
let sql: Sql;
let ds: string;

const admission = (channel: string, n: string, outcome: 'created' | 'folded', kind = 'chat-thread') => sql`
  INSERT INTO harness_shared.work_admissions
    (workspace_id, work_item_id, harness_slug, data_source_id, source_kind, source_key, admitted_via, admitted_by, outcome)
  VALUES (${WS}, ${`WI-p008-${channel}-${n}`}, 'papercusp', ${ds}, ${kind},
          ${`${ds}:${channel}:thread:${n}`}, 'person', 'su-p008', ${outcome})`;

const rule = (channel: string, enabled: boolean) => sql`
  INSERT INTO harness_shared.admission_rules
    (workspace_id, data_source_id, source_kind, title, match, harness_slug, work_kind, enabled, created_by)
  VALUES (${WS}, ${ds}, 'chat-thread', ${`bugs in ${channel}`},
          ${sql.json({ channelId: { eq: channel }, threadStart: { eq: true } })}, 'papercusp', 'bug', ${enabled}, 'su-p008')
  RETURNING id`;

const delivery = (key: string, opts: { sink?: string; outcome?: string; error?: string | null; payload?: unknown; ageMin: number }) => sql`
  INSERT INTO harness_shared.trigger_deliveries
    (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload, sink_kind, sink_ref, outcome, error, attempts, received_at, updated_at)
  VALUES (${WS}, ${ds}, ${key}, 'chat-message', 'ext:slack:message', ${opts.payload === undefined ? null : sql.json(opts.payload as never)},
          ${opts.sink ?? CHAT_ADMISSION_SINK_KIND}, ${`${ds}:chat-message`}, ${opts.outcome ?? 'failed'}, ${opts.error ?? null}, 1,
          now() - (${opts.ageMin} * interval '1 minute'), now() - (${opts.ageMin} * interval '1 minute'))`;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status, provider_account_id)
    VALUES (${WS}, 'slack', 'connected', 'T-ACME') RETURNING id::text AS id`;
  ds = source!.id;

  const [bugsRule] = await rule('CBUGS', true);
  await rule('CQUIET', true);
  await rule('CDISABLED', false);

  await admission('CBUGS', '1', 'created');
  await admission('CBUGS', '2', 'created');
  await admission('CBUGS', '3', 'folded');
  await admission('CNORULE', '1', 'created');
  // A ticket admission on the same data source is not a chat report.
  await sql`
    INSERT INTO harness_shared.work_admissions
      (workspace_id, work_item_id, harness_slug, data_source_id, source_kind, source_key, admitted_via, admitted_by)
    VALUES (${WS}, 'WI-p008-ticket', 'papercusp', ${ds}, 'ticket-record', ${`${ds}:CBUGS:ticket`}, 'person', 'su-p008')`;

  for (const [msg, outcome, error] of [
    ['1700.1', 'notified', null],
    ['1700.2', 'failed', 'slack_ephemeral_failed: channel_not_found'],
    ['1700.3', 'pending', null],
  ] as const) {
    await sql`
      INSERT INTO harness_shared.chat_bug_suggestions
        (workspace_id, data_source_id, rule_id, channel_id, provider_message_id, author_external_id, score, classifier_version, outcome, error)
      VALUES (${WS}, ${ds}, ${bugsRule!.id}, 'CBUGS', ${msg}, 'U1', 0.9, 'v1', ${outcome}, ${error})`;
  }

  // Refusals: an older one whose payload was pruned (the channel comes from the error), a newer one
  // whose payload is still held.
  await delivery('r-old', { error: 'chat_admission_refused:CBUGS:rule-1=admission_source_not_visible', ageMin: 30 });
  await delivery('r-new', {
    error: 'chat_admission_refused:CBUGS:rule-1=admission_harness_mismatch',
    payload: { target: { channelId: 'CBUGS', ts: '1700.9' } },
    ageMin: 5,
  });
  await delivery('e-fetch', { error: 'chat_admission_fetch_failed:CNORULE:1700.4:timeout', ageMin: 10 });
  // Neither of these is a chat admission failure.
  await delivery('ok', { outcome: 'delivered', payload: { target: { channelId: 'CBUGS' } }, ageMin: 1 });
  await delivery('other-sink', { sink: 'event-bus', error: 'chat_admission_refused:CBUGS:x=y', ageMin: 1 });
}, 180_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('chatBugsOverview (P-008)', () => {
  it('counts filed, merged, suggested and refused per channel, with the newest reason and error', async () => {
    const overview = await chatBugsOverview(sql, { workspaceId: WS });
    expect(overview.deliveriesTruncated).toBe(false);
    const source = overview.sources.find((s) => s.dataSourceId === ds)!;
    expect(source).toMatchObject({ kind: 'slack', status: 'connected', providerAccountId: 'T-ACME' });

    const byId = new Map(source.channels.map((c) => [c.channelId, c] as [string, ChatBugsChannel]));
    expect(source.channels.map((c) => c.channelId)).toEqual(['CBUGS', 'CQUIET', 'CNORULE']);

    expect(byId.get('CBUGS')).toMatchObject({
      configured: true,
      filed: 2,
      merged: 1,
      suggested: 1,
      refused: 2,
      lastRefusal: { reason: 'rule-1=admission_harness_mismatch' },
      lastError: { message: 'slack_ephemeral_failed: channel_not_found' },
    });
    expect(byId.get('CQUIET')).toEqual({
      channelId: 'CQUIET',
      configured: true,
      filed: 0,
      merged: 0,
      suggested: 0,
      refused: 0,
      lastRefusal: null,
      lastError: null,
    });
    expect(byId.get('CNORULE')).toMatchObject({
      configured: false,
      filed: 1,
      merged: 0,
      refused: 0,
      lastError: { message: 'chat_admission_fetch_failed:CNORULE:1700.4:timeout' },
    });
    // A disabled rule does not configure a channel.
    expect(byId.has('CDISABLED')).toBe(false);
  });

  it('reads nothing for a workspace with no chat activity', async () => {
    expect(await chatBugsOverview(sql, { workspaceId: 'p008-empty-workspace' })).toEqual({ sources: [], deliveriesTruncated: false });
  });
});
