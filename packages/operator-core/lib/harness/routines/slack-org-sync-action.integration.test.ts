/**
 * `system:slack-org-sync` against a recorded fake Slack Web API and a real org DB
 * (enterprise-data-sources-2026-10-01 P-016, D-026): the routine RUNS the connector
 * — membership sync feeding the permission lists, then paced backfill — and does
 * nothing at all while the connector flag is dark.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { TokenStorage } from '../../oauth/token';
import { connectOrganizationSlackSource, slackOrgChannelRef } from '../../data-sources/slack-org-connector';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import { runSlackOrgSync, type SlackOrgSyncDeps } from './slack-org-sync-action';

const WS = 'slack-org-sync-action-test';
const INSTALL = 'slack-org-sync-test';
// Fake fixture credentials, assembled at runtime so no token-shaped literal sits in the tree.
const BOT = ['xoxb', 'sweep', 'fixture'].join('-');
const APP = ['xapp', 'sweep', 'fixture'].join('-');
const T0 = Date.parse('2026-10-01T12:00:00.000Z');

let org: OrgTestDb;
let owner: string;

interface FakeSlack { calls: string[]; fetch: typeof fetch }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Recorded fake of the Slack Web API methods the connector calls: one member channel, two history pages. */
function fakeSlack(): FakeSlack {
  const state: FakeSlack = { calls: [], fetch: undefined as never };
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace(/^\/api\//, '');
    const cursor = url.searchParams.get('cursor');
    state.calls.push(cursor ? `${method}@${cursor}` : method);
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${BOT}`) return json({ ok: false, error: 'not_authed' });
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
        return json({ ok: true, members: ['UALICE', 'UBOB'], response_metadata: { next_cursor: '' } });
      case 'conversations.history':
        if (!cursor) {
          return json({
            ok: true,
            messages: [{ ts: '1790000000.000100', user: 'UALICE', text: 'orchid launch plan for the quarter' }],
            response_metadata: { next_cursor: 'page2' },
          });
        }
        return json({
          ok: true,
          messages: [{ ts: '1790000100.000200', user: 'UBOB', text: 'standup notes about the gazebo rebuild' }],
          response_metadata: { next_cursor: '' },
        });
      case 'conversations.replies':
        return json({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
      default:
        return json({ ok: false, error: 'unknown_method' }, 404);
    }
  }) as typeof fetch;
  return state;
}

function memoryStorage(): TokenStorage {
  const data = new Map<string, Record<string, unknown>>();
  return {
    async read(plugin, harness) { return { ...(data.get(`${plugin}/${harness}`) ?? {}) }; },
    async update(plugin, harness, patch) {
      data.set(`${plugin}/${harness}`, { ...(data.get(`${plugin}/${harness}`) ?? {}), ...patch });
    },
  };
}

/** A clock that only moves when the sweep sleeps, so pacing is exercised without real waits. */
function sweepDeps(slack: FakeSlack, storage: TokenStorage, extra: Partial<SlackOrgSyncDeps> = {}): SlackOrgSyncDeps {
  let clock = T0;
  return {
    sql: org.adminSql,
    fetch: slack.fetch,
    apiOrigin: 'https://slack.test',
    storage,
    now: () => new Date(clock),
    sleep: async (ms: number) => { clock += ms; },
    isEnabled: async () => true,
    ...extra,
  };
}

async function connect(slack: FakeSlack, storage: TokenStorage): Promise<ExternalTriggerSourceRow> {
  return connectOrganizationSlackSource(org.adminSql, {
    workspaceId: WS, ownerUserId: owner, installSlug: INSTALL, appToken: APP, botToken: BOT,
  }, { fetch: slack.fetch, apiOrigin: 'https://slack.test', storage, now: () => new Date(T0), isEnabled: async () => true });
}

const ctx = { workspaceId: WS, installSlug: INSTALL, triggerConfig: { max_steps: 10, membership_interval_sec: 3_600 } };

async function members(channelId: string): Promise<string[]> {
  const rows = await org.adminSql<Array<{ provider_user_id: string }>>`
    SELECT m.provider_user_id
      FROM harness_shared.document_permission_members m
      JOIN harness_shared.document_permission_lists l ON l.id = m.list_id
     WHERE l.workspace_id = ${WS} AND l.source = 'slack' AND l.source_ref = ${slackOrgChannelRef('T1', channelId)}
     ORDER BY m.provider_user_id`;
  return rows.map((r) => r.provider_user_id);
}

/**
 * Raw chat messages the paced backfill wrote. The backfill stores messages
 * (upsertChatMessages → harness_shared.chat_messages); documents are built later
 * by the rollup queue, so the documents table is NOT this sweep's output.
 */
async function chatMessageCount(): Promise<number> {
  const [row] = await org.adminSql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
  return row!.n;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [u] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`slack-org-sweep-${Date.now()}`}, 'owner') RETURNING id`;
  owner = u!.id;
});

afterAll(async () => {
  if (owner) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${owner}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.chat_rollup_queue WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
});

describe('system:slack-org-sync (P-016)', () => {
  it('is a no-op while the connector flag is dark: no source read, no Slack call', async () => {
    const slack = fakeSlack();
    const storage = memoryStorage();
    await connect(slack, storage);
    const before = slack.calls.length;
    const result = await runSlackOrgSync(ctx, sweepDeps(slack, storage, { isEnabled: async () => false }));
    expect(result).toMatchObject({ enabled: false, sources: 0, membershipSynced: 0, steps: 0, written: 0 });
    expect(slack.calls.length).toBe(before);
    expect(await chatMessageCount()).toBe(0);
  });

  it('syncs membership into the permission list, then backfills paced history to completion', async () => {
    const slack = fakeSlack();
    const storage = memoryStorage();
    await connect(slack, storage);
    const result = await runSlackOrgSync(ctx, sweepDeps(slack, storage));
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ enabled: true, sources: 1, membershipSynced: 1, completed: 1 });
    expect(result.steps).toBeGreaterThanOrEqual(2);
    expect(result.written).toBeGreaterThanOrEqual(2);
    // Principals are team-qualified (slackUserPrincipal → `${teamId}:${userId}`).
    expect(await members('CGENERAL')).toEqual(['T1:UALICE', 'T1:UBOB']);
    expect(slack.calls).toContain('conversations.history@page2');
    expect(await chatMessageCount()).toBeGreaterThanOrEqual(2);

    // A second fire inside the membership interval does not re-sync membership.
    const again = await runSlackOrgSync(ctx, sweepDeps(slack, storage));
    expect(again.failures).toEqual([]);
    expect(again.membershipSynced).toBe(0);
  });

  it('ignores a Slack source that is not an organization (customer internal app) source', async () => {
    const slack = fakeSlack();
    const storage = memoryStorage();
    const source = await connect(slack, storage);
    await org.adminSql`
      UPDATE harness_shared.data_sources SET config = config - 'credentialModel'
       WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
    const before = slack.calls.length;
    const result = await runSlackOrgSync(ctx, sweepDeps(slack, storage));
    expect(result).toMatchObject({ enabled: true, sources: 0, steps: 0 });
    expect(slack.calls.length).toBe(before);
  });

  it('marks the source degraded and reports the failure when its credentials cannot be read', async () => {
    const slack = fakeSlack();
    const source = await connect(slack, memoryStorage());
    const result = await runSlackOrgSync(ctx, sweepDeps(slack, memoryStorage()));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sourceId).toBe(source.id);
    const [row] = await org.adminSql<Array<{ status: string }>>`
      SELECT status FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
    expect(row!.status).toBe('degraded');
  });
});
