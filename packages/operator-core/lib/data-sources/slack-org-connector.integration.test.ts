/**
 * Slack organization connector against real Postgres and a recorded fake Slack API
 * (plan enterprise-data-sources-2026-10-01 P-016).
 *
 * Properties under test:
 *   - the connector refuses every entry point, before any Slack call, while its
 *     owner-authority flag gate is closed (the P-016 legal-read GATE);
 *   - connect records an organization-scoped, source-acl source with the customer's
 *     internal-app credentials stored, not the installing admin as read principal;
 *   - membership sync gives each member channel a permission list of team-qualified
 *     Slack user ids, and a later sync REPLACES it (a removed member loses access);
 *   - backfill is paced (one history page per step, a spacing floor between steps),
 *     includes thread replies, skips system subtypes, and walks to `complete`;
 *   - a 429 pushes the next step to Slack's Retry-After and marks the source degraded;
 *   - backfilled messages roll up into organization documents readable only by a
 *     mapped identity that is on the channel's permission list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { TokenStorage } from '../oauth/token';
import { getExternalTriggerSource, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { createPersonalGrant } from '../personal-vault/store';
import { rollupChatUnits } from './chat-retrieval-units';
import { ORGANIZATION_CORPUS_SCOPE, mapProviderIdentity, searchOrganizationDocuments } from './documents-corpus';
import {
  SLACK_ORG_DISABLED_ERROR,
  SLACK_ORG_MIN_STEP_MS,
  backfillSlackOrgOnce,
  connectOrganizationSlackSource,
  slackOrgChannelRef,
  syncSlackOrgMembership,
  type SlackOrgDeps,
} from './slack-org-connector';

const WS = 'slack-org-connector-test';
// Same fixture shapes as external-triggers/slack.test.ts (not real credentials).
const BOT = 'xoxb-secret';
const APP = 'xapp-secret';
const T0 = new Date('2026-10-01T12:00:00.000Z');
const PARENT_TS = '1790000000.000100';
const REPLY_TS = '1790000050.000150';
const LATER_TS = '1790000100.000200';

let org: OrgTestDb;
let alice: string;
let bob: string;

interface FakeSlack {
  calls: string[];
  members: string[];
  /** Methods that answer 429 once, with this Retry-After. */
  rateLimitOnce: Map<string, number>;
  fetch: typeof fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A recorded fake of the Slack Web API methods the connector calls. */
function fakeSlack(): FakeSlack {
  const state: FakeSlack = { calls: [], members: ['UALICE', 'UBOB'], rateLimitOnce: new Map(), fetch: undefined as never };
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace(/^\/api\//, '');
    const cursor = url.searchParams.get('cursor');
    state.calls.push(cursor ? `${method}@${cursor}` : method);
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${BOT}`) return json({ ok: false, error: 'not_authed' });
    const retryAfter = state.rateLimitOnce.get(method);
    if (retryAfter !== undefined) {
      state.rateLimitOnce.delete(method);
      return json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': String(retryAfter) });
    }
    switch (method) {
      case 'auth.test':
        return json({ ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'BBOT', app_id: 'AAPP' });
      case 'conversations.list':
        return json({
          ok: true,
          channels: [
            { id: 'CGENERAL', name: 'general', is_member: true, is_archived: false },
            { id: 'CRANDOM', name: 'random', is_member: false, is_archived: false },
          ],
          response_metadata: { next_cursor: '' },
        });
      case 'conversations.members':
        return json({ ok: true, members: state.members, response_metadata: { next_cursor: '' } });
      case 'conversations.history':
        if (!cursor) {
          return json({
            ok: true,
            messages: [
              { ts: PARENT_TS, thread_ts: PARENT_TS, reply_count: 1, user: 'UALICE', text: 'orchid launch plan for the quarter' },
              { ts: '1790000010.000110', subtype: 'channel_join', user: 'UBOB', text: '<@UBOB> has joined the channel' },
            ],
            response_metadata: { next_cursor: 'page2' },
          });
        }
        return json({
          ok: true,
          messages: [{ ts: LATER_TS, user: 'UBOB', text: 'standup notes about the gazebo rebuild' }],
          response_metadata: { next_cursor: '' },
        });
      case 'conversations.replies':
        return json({
          ok: true,
          messages: [
            { ts: PARENT_TS, thread_ts: PARENT_TS, user: 'UALICE', text: 'orchid launch plan for the quarter' },
            { ts: REPLY_TS, thread_ts: PARENT_TS, user: 'UBOB', text: 'orchid budget detail in the reply' },
          ],
          response_metadata: { next_cursor: '' },
        });
      default:
        return json({ ok: false, error: 'unknown_method' }, 404);
    }
  }) as typeof fetch;
  return state;
}

function memoryStorage(): TokenStorage & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  return {
    data,
    async read(plugin, harness) { return { ...(data.get(`${plugin}/${harness}`) ?? {}) }; },
    async update(plugin, harness, patch) {
      data.set(`${plugin}/${harness}`, { ...(data.get(`${plugin}/${harness}`) ?? {}), ...patch });
    },
  };
}

function depsFor(slack: FakeSlack, extra: Partial<SlackOrgDeps> = {}): SlackOrgDeps {
  return { fetch: slack.fetch, apiOrigin: 'https://slack.test', now: () => T0, storage: memoryStorage(), isEnabled: async () => true, ...extra };
}

async function reread(source: ExternalTriggerSourceRow): Promise<ExternalTriggerSourceRow> {
  const row = await getExternalTriggerSource(org.adminSql, WS, source.id);
  if (!row) throw new Error('source vanished');
  return row;
}

async function connect(slack: FakeSlack, extra: Partial<SlackOrgDeps> = {}): Promise<ExternalTriggerSourceRow> {
  return connectOrganizationSlackSource(org.adminSql, {
    workspaceId: WS, ownerUserId: alice, installSlug: 'slack-org-test', appToken: APP, botToken: BOT,
  }, depsFor(slack, extra));
}

async function sourceColumns(id: string) {
  const [row] = await org.adminSql<Array<{
    scope: string; permission_mapping: { mode?: string }; destination_policy: Record<string, unknown>;
    backfill_status: string; status: string; last_error: string | null;
  }>>`
    SELECT scope, permission_mapping, destination_policy, backfill_status, status, last_error
      FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${id}::uuid`;
  return row!;
}

async function listMembers(channelId: string): Promise<string[]> {
  const rows = await org.adminSql<Array<{ provider_user_id: string }>>`
    SELECT m.provider_user_id
      FROM harness_shared.document_permission_members m
      JOIN harness_shared.document_permission_lists l ON l.id = m.list_id
     WHERE l.workspace_id = ${WS} AND l.source = 'slack' AND l.source_ref = ${slackOrgChannelRef('T1', channelId)}
     ORDER BY m.provider_user_id`;
  return rows.map((r) => r.provider_user_id);
}

/** Every organization-corpus document the user can read for `query`, as its text. */
async function searchAs(userId: string, query: string): Promise<string[]> {
  const out = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: 'slack-org-test', query,
  });
  if (!out.allowed) throw new Error(`organization search refused for ${query}`);
  return out.results.map((r) => JSON.stringify(r));
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [a] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`slack-org-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
  const [b] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`slack-org-bob-${Date.now()}`}, 'bob') RETURNING id`;
  bob = b!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  if (bob) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${bob}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
});

describe('Slack organization connector (P-016)', () => {
  it('refuses every entry point before any Slack call while the gate is closed', async () => {
    const slack = fakeSlack();
    const closed = { isEnabled: async () => false };
    await expect(connect(slack, closed)).rejects.toThrow(SLACK_ORG_DISABLED_ERROR);
    const fakeSource: ExternalTriggerSourceRow = {
      id: '00000000-0000-4000-8000-000000000000', workspaceId: WS, kind: 'slack', ownerUserId: alice,
      providerAccountId: 'org:T1', credentialRef: null, status: 'connected', config: { teamId: 'T1' }, cursor: {},
    };
    await expect(syncSlackOrgMembership(org.adminSql, fakeSource, BOT, depsFor(slack, closed))).rejects.toThrow(SLACK_ORG_DISABLED_ERROR);
    await expect(backfillSlackOrgOnce(org.adminSql, fakeSource, BOT, depsFor(slack, closed))).rejects.toThrow(SLACK_ORG_DISABLED_ERROR);
    expect(slack.calls).toEqual([]);
    const [count] = await org.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
    expect(count!.n).toBe(0);
  });

  it('connects an organization-scoped source-acl source and stores the internal-app credentials', async () => {
    const slack = fakeSlack();
    const storage = memoryStorage();
    const source = await connect(slack, { storage });
    expect(slack.calls).toEqual(['auth.test']);
    expect(source.providerAccountId).toBe('org:T1');
    expect(source.ownerUserId).toBe(alice);
    expect(source.config).toMatchObject({ teamId: 'T1', botUserId: 'UBOT', credentialModel: 'customer-internal-app' });
    const cols = await sourceColumns(source.id);
    expect(cols.scope).toBe('organization');
    expect(cols.permission_mapping.mode).toBe('source-acl');
    expect(cols.destination_policy).toEqual({ 'chat-message': ['document'] });
    expect(cols.backfill_status).toBe('pending');
    const stored = [...storage.data.values()][0] ?? {};
    expect(Object.values(stored)).toEqual(expect.arrayContaining([APP, BOT]));
  });

  it('syncs channel membership into team-qualified permission lists and replaces them on change', async () => {
    const slack = fakeSlack();
    let source = await connect(slack);
    const first = await syncSlackOrgMembership(org.adminSql, source, BOT, depsFor(slack));
    expect(first).toEqual({ channels: ['CGENERAL'], added: 2, removed: 0 });
    expect(await listMembers('CGENERAL')).toEqual(['T1:UALICE', 'T1:UBOB']);
    // A channel the app is not a member of gets no list and no member read.
    expect(await listMembers('CRANDOM')).toEqual([]);
    expect(slack.calls.filter((c) => c === 'conversations.members')).toHaveLength(1);

    source = await reread(source);
    expect((source.cursor.orgBackfill as { channels?: string[] }).channels).toEqual(['CGENERAL']);

    slack.members = ['UALICE'];
    const second = await syncSlackOrgMembership(org.adminSql, source, BOT, depsFor(slack));
    expect(second).toEqual({ channels: ['CGENERAL'], added: 0, removed: 1 });
    expect(await listMembers('CGENERAL')).toEqual(['T1:UALICE']);
  });

  it('backfills paced history pages with thread replies and serves them only to a listed, mapped member', async () => {
    const slack = fakeSlack();
    let source = await connect(slack);
    await syncSlackOrgMembership(org.adminSql, source, BOT, depsFor(slack));
    source = await reread(source);
    slack.calls.length = 0;

    const step1 = await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack));
    expect(step1).toEqual({
      status: 'progressed', channelId: 'CGENERAL', written: 2,
      nextAt: new Date(T0.getTime() + SLACK_ORG_MIN_STEP_MS).toISOString(),
    });
    expect(slack.calls).toEqual(['conversations.history', 'conversations.replies']);
    expect((await sourceColumns(source.id)).backfill_status).toBe('running');

    // Before the spacing floor elapses the next step makes no Slack call.
    source = await reread(source);
    const early = await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack));
    expect(early.status).toBe('paused');
    expect(slack.calls).toHaveLength(2);

    const later = () => new Date(T0.getTime() + SLACK_ORG_MIN_STEP_MS + 1);
    const step2 = await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack, { now: later }));
    expect(step2).toMatchObject({ status: 'complete', channelId: 'CGENERAL', written: 1, nextAt: null });
    expect(slack.calls.at(-1)).toBe('conversations.history@page2');
    expect((await sourceColumns(source.id)).backfill_status).toBe('complete');

    const rows = await org.adminSql<Array<{ channel_id: string; provider_message_id: string; author_ref: string | null }>>`
      SELECT channel_id, provider_message_id, author_ref FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} ORDER BY provider_message_id`;
    // The channel_join system message is not indexed.
    expect(rows).toEqual([
      { channel_id: 'T1:CGENERAL', provider_message_id: PARENT_TS, author_ref: 'T1:UALICE' },
      { channel_id: 'T1:CGENERAL', provider_message_id: REPLY_TS, author_ref: 'T1:UBOB' },
      { channel_id: 'T1:CGENERAL', provider_message_id: LATER_TS, author_ref: 'T1:UBOB' },
    ]);

    const rollup = await rollupChatUnits(org.adminSql, WS, { dataSourceId: source.id });
    expect(rollup.documentsWritten).toBeGreaterThan(0);

    // bob is removed from the channel before anyone reads; alice stays.
    slack.members = ['UALICE'];
    await syncSlackOrgMembership(org.adminSql, await reread(source), BOT, depsFor(slack));
    for (const [userId, slackUser] of [[alice, 'T1:UALICE'], [bob, 'T1:UBOB']] as const) {
      await createPersonalGrant(org.adminSql, {
        workspaceId: WS, userId, principalType: 'agent-role', principalId: 'meeting-prep',
        scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
      });
      await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: slackUser, userId, mappedBy: 'owner' });
    }
    const aliceHits = await searchAs(alice, 'orchid');
    expect(aliceHits.some((hit) => hit.includes('orchid budget detail in the reply'))).toBe(true);
    expect(await searchAs(bob, 'orchid')).toEqual([]);
  });

  it('honours a 429 Retry-After, marks the source degraded, and resumes the same page', async () => {
    const slack = fakeSlack();
    let source = await connect(slack);
    await syncSlackOrgMembership(org.adminSql, source, BOT, depsFor(slack));
    source = await reread(source);
    slack.rateLimitOnce.set('conversations.history', 30);

    const limited = await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack));
    expect(limited).toEqual({
      status: 'rate-limited', channelId: 'CGENERAL', written: 0,
      nextAt: new Date(T0.getTime() + 30_000).toISOString(),
    });
    const cols = await sourceColumns(source.id);
    expect(cols.status).toBe('degraded');
    expect(cols.last_error).toBe('slack_conversations_history_rate_limited:30');

    source = await reread(source);
    const tooSoon = () => new Date(T0.getTime() + 29_000);
    expect((await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack, { now: tooSoon }))).status).toBe('paused');

    const after = () => new Date(T0.getTime() + 30_000);
    const resumed = await backfillSlackOrgOnce(org.adminSql, source, BOT, depsFor(slack, { now: after }));
    expect(resumed).toMatchObject({ status: 'progressed', channelId: 'CGENERAL', written: 2 });
    const healed = await sourceColumns(source.id);
    expect(healed.last_error).toBeNull();
    expect(healed.status).not.toBe('degraded');
  });
});
