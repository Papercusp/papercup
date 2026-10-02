/**
 * GitHub Issues ticket connector against real Postgres and a recorded fake GitHub REST client
 * (plan enterprise-data-sources-2026-10-01 P-019, D-025). The REAL createWorkItem and
 * mergeWorkItemPayload run, so the nature stamp comes from the 1332 registry rows through the
 * 1322 trigger, exactly as in production.
 *
 * Properties under test:
 *   - an issue lands as a `ticket` work_items row with nature 'record', which the one work
 *     predicate (work_item_is_agent_work, D-022) rejects, so it is never claimable agent work;
 *   - the first sighting of a ticket and each close/reopen land as `ticket-status-change` rows
 *     with nature 'event', also rejected by the work predicate;
 *   - a comment lands as ONE `ticket-comment` document in the documents corpus, bound to the
 *     repository's permission list, and the list holds the repository's collaborators;
 *   - pull requests, their comments and their events are skipped;
 *   - a re-poll is idempotent: tickets are updated in place, no status change is duplicated,
 *     the comment document is upserted rather than duplicated;
 *   - a 429 keeps every watermark, marks the source degraded and pauses until Retry-After;
 *   - a source whose destination policy does not route `ticket` to `record` writes no ticket,
 *     and a workspace with no registered ticket datatypes fails closed before any write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getExternalTriggerSource, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import {
  connectGitHubIssuesSource,
  githubCommentDedupeKey,
  pollGitHubIssuesOnce,
  syncGitHubRepoMembership,
  type GitHubComment,
  type GitHubIssue,
  type GitHubIssueEvent,
  type GitHubIssuesClient,
  type GitHubUser,
} from './github-issues-connector';
import { countWorkItems, countWorkItemsByState, listWorkItems, searchWorkItems } from '../work-items';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// mergeWorkItemPayload / getWorkItem read in the operator's active workspace; pin it to the
// workspace the 1332 registry rows live in instead of whatever the host registry says.
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const WS = 'papercusp-workspace';
const UNREGISTERED_WS = 'github-issues-unregistered-test';
const HARNESS = 'papercusp';
const OWNER = 'acme';
const REPO = 'orchid';
const REPO_REF = `${OWNER}/${REPO}`;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const URL_BASE = `https://api.github.com/repos/${REPO_REF}/issues`;
/** The deterministic ids the connector mints: TKT- tickets, TKS- status changes. */
const CONNECTOR_ID_RE = '^TK[TS]-';

let org: OrgTestDb;
let sql: Sql;
let alice: string;

interface FakeGitHub {
  client: GitHubIssuesClient;
  calls: string[];
  issues: GitHubIssue[];
  comments: GitHubComment[];
  events: GitHubIssueEvent[];
  collaborators: GitHubUser[];
  /** Lists that throw a 429 once, with this Retry-After (seconds). */
  rateLimitOnce: Map<string, number>;
}

/** A recorded fake of the four Octokit REST calls the connector makes; one page each. */
function fakeGitHub(): FakeGitHub {
  const state: FakeGitHub = {
    client: undefined as never,
    calls: [],
    rateLimitOnce: new Map(),
    collaborators: [{ login: 'alice-gh', id: 1001 }, { login: 'bob-gh', id: 1002 }],
    issues: [
      {
        id: 9001, number: 1, title: 'Orchid deploy fails on cold start', body: 'Steps to reproduce attached.',
        state: 'closed', state_reason: 'completed', user: { login: 'alice-gh', id: 1001 },
        assignees: [{ login: 'bob-gh', id: 1002 }], labels: ['bug', { name: 'p1' }],
        html_url: 'https://github.com/acme/orchid/issues/1',
        created_at: '2026-09-30T10:00:00Z', updated_at: '2026-10-01T09:00:00Z', closed_at: '2026-10-01T09:00:00Z',
      },
      {
        id: 9002, number: 2, title: 'Fix cold start', body: 'Closes #1', state: 'closed', user: { login: 'bob-gh', id: 1002 },
        pull_request: { url: 'https://api.github.com/repos/acme/orchid/pulls/2' },
        created_at: '2026-09-30T11:00:00Z', updated_at: '2026-10-01T09:30:00Z',
      },
      {
        id: 9003, number: 3, title: 'Gazebo docs are stale', body: null, state: 'open', user: { login: 'bob-gh', id: 1002 },
        assignees: [], labels: [], created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T10:00:00Z',
      },
    ],
    comments: [
      {
        id: 101, issue_url: `${URL_BASE}/1`, body: 'orchid repro: the cache is cold after deploy',
        user: { login: 'bob-gh', id: 1002 }, html_url: 'https://github.com/acme/orchid/issues/1#issuecomment-101',
        created_at: '2026-10-01T08:30:00Z', updated_at: '2026-10-01T08:30:00Z',
      },
      {
        id: 102, issue_url: `${URL_BASE}/2`, body: 'lgtm', user: { login: 'alice-gh', id: 1001 },
        created_at: '2026-10-01T09:20:00Z', updated_at: '2026-10-01T09:20:00Z',
      },
    ],
    events: [
      { id: 503, event: 'labeled', actor: { login: 'bob-gh' }, created_at: '2026-10-01T09:40:00Z', issue: { number: 3 } },
      {
        id: 502, event: 'closed', actor: { login: 'bob-gh' }, created_at: '2026-10-01T09:30:00Z',
        issue: { number: 2, pull_request: { url: 'x' } },
      },
      {
        id: 501, event: 'closed', state_reason: 'completed', actor: { login: 'alice-gh' },
        created_at: '2026-10-01T09:00:00Z', issue: { number: 1 },
      },
    ],
  };
  const call = (name: string, params: Record<string, unknown>) => {
    state.calls.push(`${name}@${String(params.page)}`);
    const retryAfter = state.rateLimitOnce.get(name);
    if (retryAfter !== undefined) {
      state.rateLimitOnce.delete(name);
      throw Object.assign(new Error('API rate limit exceeded'), {
        status: 429, response: { headers: { 'retry-after': String(retryAfter) } },
      });
    }
    return params.page === 1;
  };
  state.client = {
    issues: {
      listForRepo: async (p) => ({ data: call('issues', p) ? state.issues : [] }),
      listCommentsForRepo: async (p) => ({ data: call('comments', p) ? state.comments : [] }),
      listEventsForRepo: async (p) => ({ data: call('events', p) ? state.events : [] }),
    },
    repos: { listCollaborators: async (p) => ({ data: call('collaborators', p) ? state.collaborators : [] }) },
  };
  return state;
}

async function connect(workspaceId = WS): Promise<ExternalTriggerSourceRow> {
  return connectGitHubIssuesSource(sql, {
    workspaceId, ownerUserId: alice, owner: OWNER, repo: REPO, harnessSlug: HARNESS, createdBy: 'github-issues-test',
  });
}

async function reread(source: ExternalTriggerSourceRow): Promise<ExternalTriggerSourceRow> {
  const row = await getExternalTriggerSource(sql, source.workspaceId, source.id);
  if (!row) throw new Error('source vanished');
  return row;
}

interface TicketRow {
  feature_id: string;
  kind: string;
  nature: string;
  audience: string | null;
  agent_work: boolean;
  payload: Record<string, unknown>;
}

/** Every row the connector wrote, with the D-022 work predicate evaluated on it. */
async function connectorRows(workspaceId = WS): Promise<TicketRow[]> {
  return sql<TicketRow[]>`
    SELECT feature_id, item_kind AS kind, nature, audience,
           harness_shared.work_item_is_agent_work(nature, audience, lane, needs_owner_action) AS agent_work, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND feature_id ~ ${CONNECTOR_ID_RE}
     ORDER BY item_kind, payload->>'externalId'`;
}

async function commentDocs() {
  return sql<Array<{
    kind: string; scope: string; source: string; dedupe_key: string; external_id: string;
    permission_list_id: string | null; text: string; metadata: Record<string, unknown>;
  }>>`
    SELECT kind, scope, source, dedupe_key, external_id, permission_list_id, text, metadata
      FROM harness_shared.documents WHERE workspace_id = ${WS} ORDER BY external_id`;
}

async function repoList() {
  const [list] = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.document_permission_lists
     WHERE workspace_id = ${WS} AND source = 'github' AND source_ref = ${REPO_REF}`;
  const members = list
    ? await sql<Array<{ provider_user_id: string }>>`
        SELECT provider_user_id FROM harness_shared.document_permission_members
         WHERE list_id = ${list.id} ORDER BY provider_user_id`
    : [];
  return { id: list?.id ?? null, members: members.map((m) => m.provider_user_id) };
}

async function clean(): Promise<void> {
  for (const ws of [WS, UNREGISTERED_WS]) {
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${ws} AND feature_id ~ ${CONNECTOR_ID_RE}`;
    await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${ws}`;
  }
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`github-issues-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(clean);

describe('GitHub Issues ticket connector (P-019)', () => {
  it('registers the three canonical ticket datatypes with one nature each (migration 1332)', async () => {
    const rows = await sql<Array<{ id: string; nature: string; tier: string; work_item_kind: string | null }>>`
      SELECT id, nature, tier, work_item_kind FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id IN ('ticket', 'ticket-comment', 'ticket-status-change') AND status = 'active'
       ORDER BY id`;
    expect(rows).toEqual([
      { id: 'ticket', nature: 'record', tier: 'generic-kind', work_item_kind: 'ticket' },
      { id: 'ticket-comment', nature: 'document', tier: 'first-class', work_item_kind: null },
      { id: 'ticket-status-change', nature: 'event', tier: 'generic-kind', work_item_kind: 'ticket-status-change' },
    ]);
  });

  it('connects an organization-scoped source and syncs collaborators into the repo permission list', async () => {
    const gh = fakeGitHub();
    const source = await connect();
    const [cols] = await sql<Array<{ scope: string; permission_mapping: { mode?: string }; destination_policy: unknown }>>`
      SELECT scope, permission_mapping, destination_policy FROM harness_shared.data_sources
       WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
    expect(cols!.scope).toBe('organization');
    expect(cols!.permission_mapping.mode).toBe('source-acl');
    expect(cols!.destination_policy).toEqual({
      ticket: ['record'], 'ticket-comment': ['document'], 'ticket-status-change': ['event'],
    });
    expect(await syncGitHubRepoMembership(sql, source, { client: gh.client })).toEqual({ members: 2, added: 2, removed: 0 });
    expect((await repoList()).members).toEqual(['1001', '1002']);
    gh.collaborators = [{ login: 'alice-gh', id: 1001 }];
    expect(await syncGitHubRepoMembership(sql, source, { client: gh.client })).toEqual({ members: 1, added: 0, removed: 1 });
    expect((await repoList()).members).toEqual(['1001']);
  });

  it('ingests issues as records, transitions as events and comments as documents, skipping pull requests', async () => {
    const gh = fakeGitHub();
    const source = await connect();
    await syncGitHubRepoMembership(sql, source, { client: gh.client });
    const result = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    // Two tickets (#1, #3), their two synthetic `opened` changes and the `closed` event on #1.
    expect(result).toEqual({
      status: 'progressed', tickets: { created: 2, updated: 0 }, statusChanges: 3,
      comments: { written: 1, skipped: 1 }, nextAt: null,
    });

    const rows = await connectorRows();
    expect(rows.map((r) => [r.kind, r.nature, r.audience, r.agent_work, r.payload.externalId])).toEqual([
      // Records and events carry no audience: the D-018 trigger copies the registry's NULL.
      ['ticket', 'record', null, false, 'acme/orchid#1'],
      ['ticket', 'record', null, false, 'acme/orchid#3'],
      ['ticket-status-change', 'event', null, false, '501'],
      ['ticket-status-change', 'event', null, false, 'opened:acme/orchid#1'],
      ['ticket-status-change', 'event', null, false, 'opened:acme/orchid#3'],
    ]);
    const ticket1 = rows.find((r) => r.payload.externalId === 'acme/orchid#1')!;
    // The id's determinism is proved by the idempotent re-poll below, not by re-deriving it here.
    expect(ticket1.feature_id).toMatch(/^TKT-./);
    expect(ticket1.payload).toMatchObject({
      provider: 'github', container: REPO_REF, number: 1, state: 'closed', stateReason: 'completed',
      author: 'alice-gh', assignees: ['bob-gh'], labels: ['bug', 'p1'], closedAt: '2026-10-01T09:00:00.000Z',
    });
    const closed = rows.find((r) => r.payload.externalId === '501')!;
    expect(closed.payload).toMatchObject({
      transition: 'closed', ticketExternalId: 'acme/orchid#1', ticketWorkItemId: ticket1.feature_id, actor: 'alice-gh',
    });
    // The pull request produced no ticket, no status change and no document.
    expect(rows.some((r) => JSON.stringify(r.payload).includes('acme/orchid#2'))).toBe(false);

    const docs = await commentDocs();
    const list = await repoList();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      kind: 'ticket-comment', scope: 'organization', source: 'github', external_id: '101',
      dedupe_key: githubCommentDedupeKey(source.id, 101), permission_list_id: list.id,
      text: 'orchid repro: the cache is cold after deploy',
    });
    expect(docs[0]!.metadata).toMatchObject({ ticketExternalId: 'acme/orchid#1', ticketWorkItemId: ticket1.feature_id });

    const cursor = (await reread(source)).cursor.tickets as Record<string, string>;
    expect(cursor).toEqual({
      issuesSince: '2026-10-01T10:00:00.000Z', eventsSince: '2026-10-01T09:40:00.000Z', commentsSince: '2026-10-01T09:20:00.000Z',
    });
  });

  it('re-polls idempotently: tickets update in place, no duplicate change or document', async () => {
    const gh = fakeGitHub();
    let source = await connect();
    await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    source = await reread(source);
    gh.issues[2] = { ...gh.issues[2]!, title: 'Gazebo docs are stale (v2)', updated_at: '2026-10-01T11:00:00Z' };
    gh.comments[0] = { ...gh.comments[0]!, body: 'orchid repro, edited', updated_at: '2026-10-01T11:05:00Z' };

    const again = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    expect(again).toEqual({
      status: 'progressed', tickets: { created: 0, updated: 2 }, statusChanges: 0,
      comments: { written: 1, skipped: 1 }, nextAt: null,
    });
    const rows = await connectorRows();
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.payload.externalId === 'acme/orchid#3')!.payload.title).toBe('Gazebo docs are stale (v2)');
    const docs = await commentDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.text).toBe('orchid repro, edited');
  });

  it('keeps every watermark on a 429, marks the source degraded and pauses until Retry-After', async () => {
    const gh = fakeGitHub();
    let source = await connect();
    gh.rateLimitOnce.set('issues', 120);
    const limited = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    const nextAt = new Date(T0.getTime() + 120_000).toISOString();
    expect(limited).toMatchObject({ status: 'rate-limited', nextAt, tickets: { created: 0, updated: 0 } });
    source = await reread(source);
    expect(source.status).toBe('degraded');
    expect(source.cursor.tickets).toEqual({ nextAt });
    expect(await connectorRows()).toEqual([]);

    gh.calls.length = 0;
    const paused = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    expect(paused).toMatchObject({ status: 'paused', nextAt });
    expect(gh.calls).toEqual([]);

    const resumed = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => new Date(T0.getTime() + 121_000) });
    expect(resumed).toMatchObject({ status: 'progressed', tickets: { created: 2, updated: 0 } });
    source = await reread(source);
    expect(source.status).toBe('connected');
    expect((source.cursor.tickets as Record<string, unknown>).nextAt).toBeUndefined();
  });

  it('writes no ticket when the source does not route ticket to record', async () => {
    const gh = fakeGitHub();
    const source = await connect();
    await sql`
      UPDATE harness_shared.data_sources
         SET destination_policy = ${sql.json({ 'ticket-comment': ['document'], 'ticket-status-change': ['event'] })}
       WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
    const result = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    expect(result.tickets).toEqual({ created: 0, updated: 0 });
    expect(result.statusChanges).toBe(0);
    expect(await connectorRows()).toEqual([]);
  });

  it('fails closed before any write in a workspace with no registered ticket datatypes', async () => {
    const gh = fakeGitHub();
    const source = await connect(UNREGISTERED_WS);
    await expect(pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 }))
      .rejects.toThrow('ticket_datatype_unregistered:ticket');
    expect(gh.calls).toEqual([]);
    expect(await connectorRows(UNREGISTERED_WS)).toEqual([]);
  });
});
