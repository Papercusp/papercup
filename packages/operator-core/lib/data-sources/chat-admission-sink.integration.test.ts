/**
 * Slack bug rules at ingest (slack-messages-to-bug-reports-2026-10-05 P-003, decisions D-008 and
 * D-009), against a real throwaway Postgres: admission_rules rows with chat source kinds and the
 * action column, evaluated by the chat admission sink that the Slack ingest attaches.
 *
 * Real: the rule table (migration 1392), chat_messages, work_admissions, the chat admission
 * resolvers, admitWorkItem, the Slack key mapping (createSlackChatAdmissionAdapter) and the full
 * Socket Mode ingest. Stubbed: work-item creation (no row in the live operator DB) and the Slack
 * Web API (a fake fetch).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { AdmitDeps } from '../work-admission/admit';
import { admissionsForSource } from '../work-admission/admit';
import { setAdmissionRule, listAdmissionRules } from '../work-admission/admission-rules';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { ingestSlackSocketEnvelope, type SlackSocketEnvelope } from '../external-triggers/slack';
import { upsertOwnedExternalTriggerSource, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import {
  CHAT_ADMISSION_SINK_KIND,
  admitChatEvent,
  chatRulePreset,
  createChatAdmissionSink,
  type ChatAdmissionDeps,
} from './chat-admission-sink';
import { CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND, chatMessageSourceKey, chatThreadSourceKey } from './chat-admission-sources';
import { upsertChatMessages } from './chat-retrieval-units';
import { createSlackChatAdmissionAdapter } from './slack-org-connector';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

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

const WS = 'chat-admission-sink-it';
const BUGS = 'papercusp-bugs';
const TEAM = 'T1';
const CHAT_MESSAGE_SCHEMA = {
  type: 'object',
  required: ['id', 'text'],
  properties: {
    id: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    sender: { type: 'string' },
    threadId: { type: 'string' },
    channelId: { type: 'string' },
  },
  additionalProperties: true,
};

let org: OrgTestDb;
let sql: Sql;
let userId: string;
let source: ExternalTriggerSourceRow;
let created: Array<{ kind: string; title: string; harness: string }>;
let nextId = 0;
let slackCalls: Array<{ method: string; params: Record<string, string> }>;
let slackMessages: Record<string, Record<string, unknown>>;
/** What the bug intake was handed, per filing (P-005: reporter kind and the context block). */
let bugInputs: Array<Record<string, unknown>>;

function admitDeps(): AdmitDeps {
  return {
    sql: sql as unknown as AdmitDeps['sql'],
    createWorkItem: async (input) => {
      created.push({ kind: String(input.kind), title: String(input.title), harness: String(input.harness ?? '') });
      nextId += 1;
      return { id: `WI-CHAT-RULE-${nextId}` };
    },
    // Slack bugs reach the ONE bug intake, not createWorkItem (slack-messages-to-bug-reports P-004,
    // D-007). `created` records whichever door minted the item, so these assertions keep meaning
    // "one bug was filed"; admit-bug-intake.integration.test.ts pins the door itself.
    captureBug: async (input) => {
      bugInputs.push(input as unknown as Record<string, unknown>);
      const harness = typeof input.scope === 'string' && input.scope.startsWith('harness:') ? input.scope.slice('harness:'.length) : '';
      created.push({ kind: String(input.kind), title: String(input.title), harness });
      nextId += 1;
      return { ok: true, created: true, issue: { id: `WI-CHAT-RULE-${nextId}` } as never, possibleDuplicates: [] };
    },
  };
}

/**
 * A fake Slack Web API: conversations.history / conversations.replies over `slackMessages`, and
 * chat.postEphemeral (P-007), which answers `ephemeralError` when one is set.
 */
let ephemeralError: string | null = null;
const fakeSlackFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  // A consented file download (P-005): bytes from Slack's file host; a 'BROKEN' file fails.
  if (url.hostname === 'files.slack.com') {
    slackCalls.push({ method: 'download', params: { path: url.pathname } });
    if (url.pathname.includes('BROKEN')) return new Response('boom', { status: 500 });
    return new Response(new TextEncoder().encode(`bytes of ${url.pathname.split('/').at(-1)}`), { status: 200 });
  }
  const method = url.pathname.replace('/api/', '');
  if (method === 'chat.postEphemeral') {
    slackCalls.push({ method, params: JSON.parse(String(init?.body ?? '{}')) as Record<string, string> });
    const body = ephemeralError ? { ok: false, error: ephemeralError } : { ok: true, message_ts: '1777009999.000001' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const params = Object.fromEntries(url.searchParams.entries());
  slackCalls.push({ method, params });
  // The report facts (P-005, D-012): a message link, the channel's name, the reporter's name.
  const facts: Record<string, unknown> = {
    'chat.getPermalink': { ok: true, permalink: `https://acme.slack.test/archives/${params.channel}/p${String(params.message_ts).replace('.', '')}` },
    'conversations.info': { ok: true, channel: { id: params.channel, name: 'bugs' } },
    'users.info': { ok: true, user: { name: params.user, profile: { display_name: `display-${params.user}` } } },
  };
  if (facts[method]) return new Response(JSON.stringify(facts[method]), { status: 200, headers: { 'content-type': 'application/json' } });
  const message = slackMessages[params.ts ?? params.latest ?? ''];
  const messages = !message ? [] : method === 'conversations.history' && message.thread_ts && message.thread_ts !== message.ts ? [] : [message];
  return new Response(JSON.stringify({ ok: true, messages }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/**
 * The real Slack adapter over the fake API. Most cases pin admission and message fetching, so by
 * default the adapter has no reportFacts and makes no report-facts calls; the P-005 case below
 * turns them on and pins them.
 */
function adapter(opts: { reportFacts?: boolean } = {}) {
  const real = createSlackChatAdmissionAdapter(source, async () => 'xoxb-test', {
    fetch: fakeSlackFetch,
    apiOrigin: 'https://slack.test',
    isEnabled: async () => true,
  });
  if (opts.reportFacts) return real;
  const { reportFacts: _withoutFacts, ...rest } = real;
  return rest;
}

const deps = (opts: { reportFacts?: boolean } = {}) => ({ ...admitDeps(), adapter: adapter(opts) });

async function rule(preset: 'report-bug' | 'new-thread', channel: string, action: 'admit' | 'suggest' = 'admit') {
  const { sourceKind, match } = chatRulePreset(preset, channel);
  return setAdmissionRule({
    workspaceId: WS, dataSourceId: source.id, title: `${preset} in ${channel}`, match, sourceKind, action,
    harness: BUGS, workKind: 'bug', createdBy: 'su-chat-admission-sink-it',
  }, sql);
}

/** A P-002 report-bug signal payload, as slack-report-bug.ts builds it. */
function signal(gesture: string, channelId: string, ts: string, extra: { threadTs?: string; text?: string } = {}) {
  return {
    id: `Ev-${gesture}-${ts}`, channelId, threadId: extra.threadTs ?? ts, sender: 'U5', text: extra.text ?? '',
    signal: 'report-bug', gesture, reporter: { kind: 'chat', provider: 'slack', externalUserId: 'U5' },
    target: { channelId, ts, ...(extra.threadTs ? { threadTs: extra.threadTs } : {}), ...(extra.text ? { text: extra.text } : {}) },
  };
}

/** An ordinary top-level post or reply, as normalizeSlackSocketEnvelope builds it. */
function post(channelId: string, ts: string, text: string, threadTs?: string) {
  return {
    id: `Ev-post-${ts}`, channelId, threadId: threadTs ?? ts, sender: 'U7', text,
    target: { channelId, ts, ...(threadTs ? { threadTs } : {}), text },
  };
}

async function admissionCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.work_admissions WHERE workspace_id = ${WS}`;
  return row!.n;
}

async function stored(channel: string, ts: string) {
  const [row] = await sql<{ body: string; thread_key: string | null }[]>`
    SELECT body, thread_key FROM harness_shared.chat_messages
     WHERE workspace_id = ${WS} AND data_source_id = ${source.id}::uuid
       AND channel_id = ${`${TEAM}:${channel}`} AND provider_message_id = ${ts}`;
  return row ?? null;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'chat-admission-sink-owner-' + Date.now()}, 'Chat Admission Owner') RETURNING id`;
  userId = users[0]!.id;
  await sql`
    INSERT INTO harness_shared.datatype_registry
      (workspace_id, id, title, description, tier, payload_schema, authoritative_writer)
    VALUES (${WS}, 'chat-message', 'Chat message', 'Normalized chat event', 'workspace',
            ${JSON.stringify(CHAT_MESSAGE_SCHEMA)}::text::jsonb, 'papercusp')
    ON CONFLICT (workspace_id, id) DO UPDATE SET payload_schema = EXCLUDED.payload_schema`;
}, 120_000);

afterAll(async () => {
  if (userId) await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  created = [];
  bugInputs = [];
  slackCalls = [];
  slackMessages = {};
  ephemeralError = null;
  await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  source = await upsertOwnedExternalTriggerSource(sql, {
    workspaceId: WS, kind: 'slack', ownerUserId: userId, credentialRef: 'slack-socket:owner', status: 'connected',
    config: {
      installSlug: 'papercusp', teamId: TEAM, botUserId: 'UPAPER',
      reportBug: {
        channels: {
          CBUGS: { bugChannel: true, reaction: true },
          // P-007: suggest-only channels. CSUG lets people report with the bug reaction; CQUIET has
          // the suggest switch but no report gesture switched on.
          CSUG: { suggest: true, reaction: true },
          CQUIET: { suggest: true },
        },
      },
    },
  });
});

describe('Slack bug rules on admission_rules (P-003)', () => {
  it('a report-bug signal in a rule channel files ONE bug in the rule harness, storing the reported message', async () => {
    const r = await rule('report-bug', 'CBUGS');
    const event = signal('bug-channel', 'CBUGS', '1777000010.000100', { text: 'Login loops forever on Safari' });

    const out = await admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload: event }, deps());

    expect(out.threadStart).toBe(true);
    expect(out.admitted).toHaveLength(1);
    expect(out.admitted[0]).toMatchObject({ ruleId: r.id, sourceKind: CHAT_MESSAGE_SOURCE_KIND, result: { ok: true, reason: 'admitted' } });
    expect(created).toEqual([{ kind: 'bug', title: 'Login loops forever on Safari', harness: BUGS }]);
    expect(await stored('CBUGS', '1777000010.000100')).toEqual({ body: 'Login loops forever on Safari', thread_key: null });
    const identity = {
      kind: CHAT_MESSAGE_SOURCE_KIND,
      key: chatMessageSourceKey({ dataSourceId: source.id, channelId: `${TEAM}:CBUGS`, providerMessageId: '1777000010.000100' }),
    };
    const admissions = await admissionsForSource(WS, identity, sql as never);
    expect(admissions.map((a) => [a.admittedVia, a.dataSourceId])).toEqual([['rule', source.id]]);

    // Re-delivery is idempotent: same work item, nothing new created.
    const again = await admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload: event }, deps());
    expect(again.admitted[0]!.result).toMatchObject({ ok: true, reason: 'existing' });
    expect(created).toHaveLength(1);
  });

  it('no rule, or a message that matches no rule, creates no work and fetches nothing', async () => {
    // No chat rule on the source at all: the reaction's message is never even fetched.
    const unruled = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('reaction', 'CBUGS', '1777000020.000100'),
    }, deps());
    expect(unruled).toMatchObject({ subject: null, admitted: [], suggested: [] });
    expect(slackCalls).toEqual([]);

    // A rule exists for CBUGS: an ordinary (unflagged) message there, and a signal in another
    // channel, both stay data.
    await rule('report-bug', 'CBUGS');
    const unflagged = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CBUGS', '1777000021.000100', 'lunch?'),
    }, deps());
    const elsewhere = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('mention', 'CRANDOM', '1777000022.000100', { text: 'bug: x' }),
    }, deps());
    expect([unflagged.admitted, elsewhere.admitted]).toEqual([[], []]);
    expect(created).toEqual([]);
    expect(await admissionCount()).toBe(0);
  });

  it("a 'suggest' rule creates nothing and reports the match", async () => {
    const r = await rule('report-bug', 'CBUGS', 'suggest');
    const out = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('bug-channel', 'CBUGS', '1777000030.000100', { text: 'Export is empty' }),
    }, deps());
    expect(out.admitted).toEqual([]);
    expect(out.suggested).toEqual([{ ruleId: r.id, sourceKind: CHAT_MESSAGE_SOURCE_KIND, harness: BUGS }]);
    expect(created).toEqual([]);
    expect(await admissionCount()).toBe(0);
  });

  it('the new-thread preset files a new top-level post as its thread, and a later bug signal on it folds onto that item', async () => {
    await rule('new-thread', 'CBUGS');
    await rule('report-bug', 'CBUGS');
    const ts = '1777000040.000100';

    const opened = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CBUGS', ts, 'Checkout 500s since deploy'),
    }, deps());
    expect(opened.admitted).toHaveLength(1);
    expect(opened.admitted[0]).toMatchObject({ sourceKind: CHAT_THREAD_SOURCE_KIND, result: { ok: true, reason: 'admitted' } });
    const threadKey = `${TEAM}:CBUGS:${ts}`;
    const threadAdmissions = await admissionsForSource(WS, {
      kind: CHAT_THREAD_SOURCE_KIND,
      key: chatThreadSourceKey({ dataSourceId: source.id, channelId: `${TEAM}:CBUGS`, threadKey }),
    }, sql as never);
    expect(threadAdmissions).toHaveLength(1);
    const threadItem = threadAdmissions[0]!.workItemId;

    // :bug: on the same post: the message rule matches, and is covered by the thread's item.
    const reacted = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('reaction', 'CBUGS', ts),
    }, deps());
    expect(reacted.admitted).toHaveLength(1);
    expect(reacted.admitted[0]!.result).toMatchObject({ ok: true, reason: 'covered', workItemId: threadItem });
    expect(created).toHaveLength(1);
    expect(slackCalls).toEqual([]);
  });

  it('a reply is not a thread start, so the new-thread preset ignores it', async () => {
    await rule('new-thread', 'CBUGS');
    const out = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id,
      payload: post('CBUGS', '1777000051.000200', 'same here', '1777000050.000100'),
    }, deps());
    expect(out.threadStart).toBe(false);
    expect(out.admitted).toEqual([]);
    expect(await stored('CBUGS', '1777000051.000200')).toEqual({ body: 'same here', thread_key: `${TEAM}:CBUGS:1777000050.000100` });
  });

  it('a reaction on a message not yet stored fetches that one message; a vanished message fails loudly', async () => {
    await rule('report-bug', 'CBUGS');
    slackMessages['1777000060.000100'] = { ts: '1777000060.000100', user: 'U9', text: 'Avatar upload hangs' };

    const sink = createChatAdmissionSink(sql, source, deps());
    await sink.deliver({ payload: signal('reaction', 'CBUGS', '1777000060.000100') } as never);
    expect(slackCalls.map((c) => [c.method, c.params.channel])).toEqual([['conversations.history', 'CBUGS']]);
    expect(await stored('CBUGS', '1777000060.000100')).toEqual({ body: 'Avatar upload hangs', thread_key: null });
    expect(created).toEqual([{ kind: 'bug', title: 'Avatar upload hangs', harness: BUGS }]);

    // A reply is found through conversations.replies, keeping its thread.
    slackMessages['1777000061.000200'] = { ts: '1777000061.000200', thread_ts: '1777000061.000100', user: 'U9', text: 'And on Firefox' };
    await sink.deliver({ payload: signal('reaction', 'CBUGS', '1777000061.000200') } as never);
    expect(slackCalls.slice(1).map((c) => c.method)).toEqual(['conversations.history', 'conversations.replies']);
    expect(await stored('CBUGS', '1777000061.000200')).toEqual({ body: 'And on Firefox', thread_key: `${TEAM}:CBUGS:1777000061.000100` });

    await expect(sink.deliver({ payload: signal('reaction', 'CBUGS', '1777000069.000100') } as never))
      .rejects.toThrow(/chat_admission_subject_unavailable/);
  });

  it('an in-thread mention reports the thread root without storing the mention text as the root', async () => {
    await rule('report-bug', 'CBUGS');
    const root = '1777000070.000100';
    slackMessages[root] = { ts: root, thread_ts: root, reply_count: 2, user: 'U1', text: 'Search returns stale results' };
    // slack-report-bug.ts: an in-thread mention targets the root and carries no target.text.
    const mention = { ...signal('mention', 'CBUGS', root, { threadTs: root }), text: '<@UPAPER> bug this' };

    const out = await admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload: mention }, deps());
    // About the root, but not the root being posted: not a thread start.
    expect(out.threadStart).toBe(false);
    expect(await stored('CBUGS', root)).toEqual({ body: 'Search returns stale results', thread_key: `${TEAM}:CBUGS:${root}` });
    expect(created.map((c) => c.title)).toEqual(['Search returns stale results']);
  });

  it('a stored message wins over a replayed live event (its thread_key is not reset)', async () => {
    await rule('report-bug', 'CBUGS');
    const ts = '1777000080.000100';
    await upsertChatMessages(sql, WS, source.id, [{
      channelId: `${TEAM}:CBUGS`, providerMessageId: ts, threadKey: `${TEAM}:CBUGS:${ts}`, authorRef: `${TEAM}:U1`,
      authorLabel: 'U1', body: 'Original post', postedAt: new Date(Number(ts) * 1000),
    }]);
    await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('bug-channel', 'CBUGS', ts, { text: 'Original post' }),
    }, deps());
    expect(await stored('CBUGS', ts)).toEqual({ body: 'Original post', thread_key: `${TEAM}:CBUGS:${ts}` });
  });

  it('rule validation: suggest is chat-only, source kinds are known, a rule keeps its source kind', async () => {
    await expect(setAdmissionRule({
      workspaceId: WS, dataSourceId: source.id, title: 'x', match: { container: { eq: 'a' } }, action: 'suggest',
      harness: BUGS, createdBy: 'su-test',
    }, sql)).rejects.toThrow(/suggest' applies to chat rules/);
    await expect(setAdmissionRule({
      workspaceId: WS, dataSourceId: source.id, title: 'x', match: { channelId: { eq: 'C' } }, sourceKind: 'email',
      harness: BUGS, createdBy: 'su-test',
    }, sql)).rejects.toThrow(/sourceKind must be one of/);
    const r = await rule('report-bug', 'CBUGS');
    await expect(setAdmissionRule({
      id: r.id, workspaceId: WS, dataSourceId: source.id, title: 'x', match: r.match, sourceKind: CHAT_THREAD_SOURCE_KIND,
      harness: BUGS, createdBy: 'su-test',
    }, sql)).rejects.toThrow(/sourceKind is fixed/);
    // Updating without an action keeps it; listing by source kind sees only chat rules.
    const kept = await setAdmissionRule({
      id: r.id, workspaceId: WS, dataSourceId: source.id, title: 'renamed', match: r.match, harness: BUGS, createdBy: 'su-test',
    }, sql);
    expect([kept.action, kept.sourceKind, kept.title]).toEqual(['admit', CHAT_MESSAGE_SOURCE_KIND, 'renamed']);
    const suggest = await setAdmissionRule({
      id: r.id, workspaceId: WS, dataSourceId: source.id, title: 'renamed', match: r.match, action: 'suggest', harness: BUGS, createdBy: 'su-test',
    }, sql);
    expect(suggest.action).toBe('suggest');
    expect((await listAdmissionRules(WS, { dataSourceId: source.id, sourceKinds: ['record'] }, sql))).toEqual([]);
  });

  it('end to end: a bug-channel post through the real Slack Socket Mode ingest becomes a bug via the attached sink', async () => {
    await rule('report-bug', 'CBUGS');
    const emit = vi.fn(async (opts: { key: string }) => ({ ok: true as const, key: opts.key, woken: 0, notified: [], msgId: null, waiters: 0 }));
    const ingest = (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
      ingestExternalTriggerEvent(db, input, { emit: emit as never });
    const envelope: SlackSocketEnvelope = {
      envelope_id: 'env-EvB', type: 'events_api',
      payload: {
        event_id: 'EvB', event_time: 1_777_000_000,
        event: { type: 'message', channel: 'CBUGS', channel_type: 'channel', user: 'U5', text: 'Billing page is blank', ts: '1777000090.000100' },
      },
    };
    const sink = createChatAdmissionSink(sql, source, deps());

    const normalized = await ingestSlackSocketEnvelope(sql, source, envelope, ingest, [sink]);
    expect(normalized?.event).toBe('report-bug');
    expect(created).toEqual([{ kind: 'bug', title: 'Billing page is blank', harness: BUGS }]);
    const deliveries = await sql<{ sink_kind: string; outcome: string }[]>`
      SELECT sink_kind, outcome FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND sink_kind = ${CHAT_ADMISSION_SINK_KIND}`;
    expect(deliveries).toEqual([{ sink_kind: CHAT_ADMISSION_SINK_KIND, outcome: 'delivered' }]);

    // Replaying the same envelope is deduplicated by the delivery ledger.
    await ingestSlackSocketEnvelope(sql, source, envelope, ingest, [sink]);
    expect(created).toHaveLength(1);
  });
});

/**
 * slack-messages-to-bug-reports-2026-10-05 P-007 (R-7, D-010): in a suggest-only channel the
 * classifier only reminds, privately, and never files. Only the person's own report gesture does.
 */
describe('looks-like-a-bug suggestions (P-007)', () => {
  const BUGGY = 'the export button is broken again, every time I click it nothing downloads';

  function slackPost(eventId: string, channel: string, ts: string, text: string, user = 'U7'): SlackSocketEnvelope {
    return {
      envelope_id: `env-${eventId}`, type: 'events_api',
      payload: { event_id: eventId, event_time: 1_777_000_000, event: { type: 'message', channel, channel_type: 'channel', user, text, ts } },
    };
  }

  async function suggestionRows() {
    return sql<{ channel_id: string; provider_message_id: string; author_external_id: string; outcome: string; error: string | null; classifier_version: string }[]>`
      SELECT channel_id, provider_message_id, author_external_id, outcome, error, classifier_version
        FROM harness_shared.chat_bug_suggestions
       WHERE workspace_id = ${WS}
       ORDER BY created_at, provider_message_id`;
  }

  const ephemerals = () => slackCalls.filter((c) => c.method === 'chat.postEphemeral').map((c) => c.params);

  function ingestVia() {
    const emit = vi.fn(async (opts: { key: string }) => ({ ok: true as const, key: opts.key, woken: 0, notified: [], msgId: null, waiters: 0 }));
    return (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) => ingestExternalTriggerEvent(db, input, { emit: emit as never });
  }

  it('R-7: a bug-like post in a suggest-only channel gets one private note and files nothing; the reaction it asks for files one bug', async () => {
    await rule('report-bug', 'CSUG');
    const suggestRule = await rule('new-thread', 'CSUG', 'suggest');
    const ingest = ingestVia();
    const sink = createChatAdmissionSink(sql, source, deps());

    const envelope = slackPost('EvS1', 'CSUG', '1777000200.000100', BUGGY);
    const normalized = await ingestSlackSocketEnvelope(sql, source, envelope, ingest, [sink]);
    expect(normalized?.event).toBe('message');
    expect(created).toEqual([]);
    expect(await admissionCount()).toBe(0);
    expect(ephemerals()).toEqual([{ channel: 'CSUG', user: 'U7', text: 'Looks like a bug. React :bug: to report it.' }]);
    expect(await suggestionRows()).toEqual([{
      channel_id: `${TEAM}:CSUG`, provider_message_id: '1777000200.000100', author_external_id: 'U7',
      outcome: 'notified', error: null, classifier_version: 'lexical-v1',
    }]);

    // The same envelope replayed, and the same post arriving as a second event, never send again.
    await ingestSlackSocketEnvelope(sql, source, envelope, ingest, [sink]);
    const second = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CSUG', '1777000200.000100', BUGGY),
    }, deps());
    expect(second.suggested).toEqual([{ ruleId: suggestRule.id, sourceKind: CHAT_THREAD_SOURCE_KIND, harness: BUGS }]);
    expect(second.suggestion).toMatchObject({ outcome: 'duplicate' });
    expect(ephemerals()).toHaveLength(1);
    expect(created).toEqual([]);

    // The person follows the note: their bug reaction is a report and files exactly one bug.
    const reacted = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: signal('reaction', 'CSUG', '1777000200.000100'),
    }, deps());
    expect(reacted.admitted).toHaveLength(1);
    expect(reacted.admitted[0]!.result).toMatchObject({ ok: true, reason: 'admitted' });
    expect(created).toEqual([{ kind: 'bug', title: BUGGY, harness: BUGS }]);
  });

  it('a post that does not look like a bug gets nothing, and stores nothing', async () => {
    await rule('report-bug', 'CSUG');
    await rule('new-thread', 'CSUG', 'suggest');
    const out = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CSUG', '1777000210.000100', 'lunch at 12:30 today?'),
    }, deps());
    expect(out.suggestion).toMatchObject({ outcome: 'below-threshold' });
    expect(ephemerals()).toEqual([]);
    expect(await suggestionRows()).toEqual([]);
    expect(await admissionCount()).toBe(0);
  });

  it('one note per person per channel within the cooldown; another person still gets theirs', async () => {
    await rule('report-bug', 'CSUG');
    await rule('new-thread', 'CSUG', 'suggest');
    const run = (ts: string, sender: string) => admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: { ...post('CSUG', ts, BUGGY), sender },
    }, deps());
    expect((await run('1777000220.000100', 'U7')).suggestion).toMatchObject({ outcome: 'notified' });
    expect((await run('1777000221.000100', 'U7')).suggestion).toMatchObject({ outcome: 'cooldown' });
    expect((await run('1777000222.000100', 'U8')).suggestion).toMatchObject({ outcome: 'notified' });
    expect(ephemerals().map((p) => p.user)).toEqual(['U7', 'U8']);
  });

  it('no note when the advice would do nothing: no rule files a report there, or no report gesture is switched on', async () => {
    // Suggest rule only: a reaction in CSUG would file nothing, so no note is sent.
    await rule('new-thread', 'CSUG', 'suggest');
    const unfiled = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CSUG', '1777000230.000100', BUGGY),
    }, deps());
    expect(unfiled.suggestion).toMatchObject({ outcome: 'no-route' });

    // A report rule exists in CQUIET but no gesture is switched on there.
    await rule('report-bug', 'CQUIET');
    await rule('new-thread', 'CQUIET', 'suggest');
    const quiet = await admitChatEvent(sql, {
      workspaceId: WS, dataSourceId: source.id, payload: post('CQUIET', '1777000231.000100', BUGGY),
    }, deps());
    expect(quiet.suggestion).toMatchObject({ outcome: 'no-route' });

    expect(ephemerals()).toEqual([]);
    expect((await suggestionRows()).map((r) => [r.channel_id, r.outcome])).toEqual([
      [`${TEAM}:CSUG`, 'no-route'],
      [`${TEAM}:CQUIET`, 'no-route'],
    ]);
    expect(await admissionCount()).toBe(0);
  });

  it('a refused note is recorded with its error, does not fail the delivery, and files nothing', async () => {
    await rule('report-bug', 'CSUG');
    await rule('new-thread', 'CSUG', 'suggest');
    ephemeralError = 'missing_scope';
    const sink = createChatAdmissionSink(sql, source, deps());
    await ingestSlackSocketEnvelope(sql, source, slackPost('EvS5', 'CSUG', '1777000240.000100', BUGGY), ingestVia(), [sink]);
    const rows = await suggestionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failed' });
    expect(rows[0]!.error).toContain('missing_scope');
    const deliveries = await sql<{ outcome: string }[]>`
      SELECT outcome FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND sink_kind = ${CHAT_ADMISSION_SINK_KIND}`;
    expect(deliveries).toEqual([{ outcome: 'delivered' }]);
    expect(await admissionCount()).toBe(0);
  });

  it('a post in a channel without the suggest switch never reaches the rules', async () => {
    await rule('report-bug', 'COTHER');
    await rule('new-thread', 'COTHER', 'suggest');
    const sink = createChatAdmissionSink(sql, source, deps());
    const normalized = await ingestSlackSocketEnvelope(sql, source, slackPost('EvS6', 'COTHER', '1777000250.000100', BUGGY), ingestVia(), [sink]);
    expect(normalized).toBeNull();
    expect(ephemerals()).toEqual([]);
    expect(await suggestionRows()).toEqual([]);
  });
});

describe("a chat report's context block (P-005, D-012)", () => {
  const TS = '1777000300.000100';
  const shortcut = () => ({
    ...signal('shortcut', 'CBUGS', TS),
    note: 'Since this morning, every query',
    attachmentConsent: true,
    occurredAt: '2026-10-06T21:00:00.000Z',
  });

  beforeEach(() => {
    slackMessages[TS] = {
      ts: TS,
      user: 'U9',
      text: 'Search returns nothing',
      user_profile: { display_name: 'nina' },
      files: [{
        name: 'shot.png',
        mimetype: 'image/png',
        size: 10,
        permalink: 'https://acme.slack.test/files/U9/F1/shot.png',
        url_private: 'https://files.slack.com/files-pri/T-F1/shot.png',
      }],
    };
  });

  it("a shortcut report files as a 'chat' report carrying the gesture, reporter, note, consent and Slack's facts", async () => {
    await rule('report-bug', 'CBUGS');
    const sink = createChatAdmissionSink(sql, source, deps({ reportFacts: true }));
    await sink.deliver({ payload: shortcut() } as never);

    expect(created).toHaveLength(1);
    const input = bugInputs[0]!;
    expect(input.reporterKind).toBe('chat');
    const chat = (input.reportContext as { chat?: Record<string, unknown> }).chat;
    expect(chat).toMatchObject({
      gesture: 'shortcut',
      reportedAt: '2026-10-06T21:00:00.000Z',
      reporter: { externalUserId: 'U5', displayName: 'display-U5' },
      author: expect.objectContaining({ displayName: 'nina' }),
      note: 'Since this morning, every query',
      attachmentConsent: true,
      permalink: `https://acme.slack.test/archives/CBUGS/p${TS.replace('.', '')}`,
      attachments: [expect.objectContaining({ name: 'shot.png', url: 'https://acme.slack.test/files/U9/F1/shot.png' })],
    });
    expect(JSON.stringify(input)).not.toContain('files-pri');
  });

  it('reads Slack once per event: one message read serves the fetch and the facts, one facts call each', async () => {
    await rule('report-bug', 'CBUGS');
    const sink = createChatAdmissionSink(sql, source, deps({ reportFacts: true }));
    await sink.deliver({ payload: shortcut() } as never);
    const count = (method: string) => slackCalls.filter((c) => c.method === method).length;
    // The subject was not stored, so the adapter fetched it; reportFacts reused that read.
    expect(count('conversations.history')).toBe(1);
    expect([count('chat.getPermalink'), count('conversations.info'), count('users.info')]).toEqual([1, 1, 1]);
  });

  it('a facts call that throws still files the report, and keeps and logs the error (EI-25270704981198981)', async () => {
    await rule('report-bug', 'CBUGS');
    const base = deps({ reportFacts: true });
    // A provider refusal arrives as an absent fact, so a throw is an adapter defect, like the
    // shadowed-const bug that once hid every fact behind a catch-to-null.
    const broken = {
      ...base,
      adapter: { ...base.adapter, reportFacts: async () => { throw new TypeError('memo is not a function'); } },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload: shortcut() }, broken);

      expect(out.admitted.map(({ result }) => result.ok)).toEqual([true]);
      expect(created).toHaveLength(1);
      const chat = (bugInputs[0]!.reportContext as { chat?: Record<string, unknown> }).chat;
      expect(chat).toMatchObject({ gesture: 'shortcut', note: 'Since this morning, every query' });
      expect(chat).not.toHaveProperty('permalink');
      expect(out.reportFactsError).toBe('memo is not a function');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain('[chat-admission] report facts failed');
    } finally {
      logged.mockRestore();
    }
  });

  it('facts that arrive leave no facts error behind', async () => {
    await rule('report-bug', 'CBUGS');
    const out = await admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload: shortcut() }, deps({ reportFacts: true }));
    expect(out.admitted.map(({ result }) => result.ok)).toEqual([true]);
    expect(out.reportFactsError).toBeUndefined();
  });

  describe('consented files (unified D-013, D-048)', () => {
    const withFiles = (...ids: string[]) => {
      slackMessages[TS] = {
        ...slackMessages[TS],
        files: ids.map((id) => ({
          id, name: `${id}.png`, mimetype: 'image/png', size: 10,
          permalink: `https://acme.slack.test/files/U9/${id}/${id}.png`,
          url_private: `https://files.slack.com/files-pri/T-${id}/${id}.png`,
        })),
      };
    };
    let stored: Array<Record<string, unknown>>;
    const putAttachment: NonNullable<ChatAdmissionDeps['putAttachment']> = async (attachment) => {
      stored.push({ ...attachment, content: new TextDecoder().decode(attachment.content as Uint8Array) });
      return { ok: true, id: `ATT-${stored.length}`, deduplicated: false, redaction: 'not-redactable', byteSize: 10 };
    };
    const admit = (payload: Record<string, unknown>) =>
      admitChatEvent(sql, { workspaceId: WS, dataSourceId: source.id, payload }, { ...deps({ reportFacts: true }), putAttachment });

    beforeEach(() => {
      stored = [];
    });

    it('with consent, each file is downloaded once and stored against the filed bug', async () => {
      await rule('report-bug', 'CBUGS');
      withFiles('F1', 'F2');
      const out = await admit(shortcut());
      expect(created).toHaveLength(1);
      expect(out.attachments).toEqual({ stored: 2, failed: 0, error: null });
      const bug = (out.admitted[0]!.result as { workItemId: string }).workItemId;
      expect(stored).toEqual([
        expect.objectContaining({ workspaceId: WS, workItemId: bug, door: 'slack', kind: 'screenshot', mime: 'image/png', externalId: 'slack:F1', content: 'bytes of F1.png' }),
        expect.objectContaining({ workspaceId: WS, workItemId: bug, door: 'slack', kind: 'screenshot', mime: 'image/png', externalId: 'slack:F2', content: 'bytes of F2.png' }),
      ]);
      expect(slackCalls.filter((c) => c.method === 'download')).toHaveLength(2);
    });

    it('without consent nothing is downloaded or stored; the files stay Slack links', async () => {
      await rule('report-bug', 'CBUGS');
      withFiles('F1');
      const out = await admit({ ...shortcut(), attachmentConsent: false });
      expect(created).toHaveLength(1);
      expect(out.attachments).toBeUndefined();
      expect(stored).toEqual([]);
      expect(slackCalls.filter((c) => c.method === 'download')).toEqual([]);
      expect((bugInputs[0]!.reportContext as { chat: { attachments: unknown[] } }).chat.attachments).toHaveLength(1);
    });

    it('a failed download costs the files, never the report', async () => {
      await rule('report-bug', 'CBUGS');
      withFiles('BROKEN');
      const out = await admit(shortcut());
      expect(created).toHaveLength(1);
      expect(out.admitted[0]!.result).toMatchObject({ ok: true });
      expect(out.attachments).toEqual({ stored: 0, failed: 0, error: expect.stringMatching(/^slack_file_download_500:BROKEN/) });
      expect(stored).toEqual([]);
    });

    it('nothing is downloaded when no admit rule filed the report', async () => {
      await rule('report-bug', 'CBUGS', 'suggest');
      withFiles('F1');
      const out = await admit(shortcut());
      expect(created).toEqual([]);
      expect(out.attachments).toBeUndefined();
      expect(slackCalls.filter((c) => c.method === 'download')).toEqual([]);
    });
  });

  it('ordinary traffic that matches no admit rule makes no report-facts call', async () => {
    await rule('report-bug', 'CBUGS', 'suggest');
    const sink = createChatAdmissionSink(sql, source, deps({ reportFacts: true }));
    await sink.deliver({ payload: shortcut() } as never);
    expect(created).toEqual([]);
    expect(slackCalls.filter((c) => ['chat.getPermalink', 'conversations.info', 'users.info'].includes(c.method))).toEqual([]);
  });
});
