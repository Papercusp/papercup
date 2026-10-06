/**
 * Linear provider package, unit level (linear-asana-task-sync-2026-10-05 P-004, R-4).
 *
 * Loads the real `libs/papercusp/plugins/linear` package and drives its adapter through a fake
 * `host.fetch` that answers Linear's GraphQL endpoint. Covers the issue -> ticket mapping, the
 * workflow-state -> column mapping, status changes from issue history, the cursor (pagination,
 * team order, watermark fold, config change), rate-limit and auth signals, and the writes
 * (ticket.comment, ticket.transition). The real-driver/Postgres proof is
 * linear-provider.integration.test.ts.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HostFetch, HostFetchRequest, HostFetchResponse } from '@papercusp/plugin-sdk';
import { TICKET_STATUS_CATEGORIES, ticketTransitionBetween } from '../../data-sources/ticket-vocabulary';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = requireCjs(resolve(REPO_ROOT, 'libs/papercusp/plugins/linear/index.cjs')) as any;
const adapter = plugin.providerAdapter;
const internal = plugin._internal;

/** The host passes the data source id; host.fetch resolves its token from it. */
const SOURCE = 'src-1';

type Gql = { query: string; variables: Record<string, unknown> };
type Handler = (op: string, variables: Record<string, unknown>) => HostFetchResponse;

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

function fakeHost(handler: Handler) {
  const calls: Array<{ op: string; variables: Record<string, unknown>; request: HostFetchRequest }> = [];
  const fetch: HostFetch = async ({ request }) => {
    expect(request.url).toBe('https://api.linear.app/graphql');
    expect(request.method).toBe('POST');
    const parsed = JSON.parse(String(request.body)) as Gql;
    const op = /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? '?';
    calls.push({ op, variables: parsed.variables, request });
    return handler(op, parsed.variables);
  };
  return { fetch, calls, host: { fetch } };
}

const STATES = {
  triage: { id: 'st-triage', name: 'Triage', type: 'triage', position: 0 },
  backlog: { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 1 },
  todo: { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 2 },
  ready: { id: 'st-ready', name: 'Ready', type: 'unstarted', position: 3 },
  doing: { id: 'st-doing', name: 'In Progress', type: 'started', position: 5 },
  review: { id: 'st-review', name: 'In Review', type: 'started', position: 4 },
  done: { id: 'st-done', name: 'Done', type: 'completed', position: 6 },
  canceled: { id: 'st-canceled', name: 'Canceled', type: 'canceled', position: 7 },
};

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'iss-1', identifier: 'ENG-1', number: 1, title: 'Cold start fails', description: 'Steps attached.',
    url: 'https://linear.app/acme/issue/ENG-1', priority: 2, priorityLabel: 'High', estimate: 3, dueDate: '2026-10-09',
    createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z', completedAt: null, canceledAt: null,
    state: STATES.doing, team: { id: 'team-a', key: 'ENG' },
    assignee: { id: 'u-bob', name: 'bob', displayName: 'Bob' }, delegate: { id: 'u-app', name: 'papercusp', displayName: 'Papercusp' },
    creator: { id: 'u-alice', name: 'alice', displayName: 'Alice' }, parent: { id: 'iss-0' }, project: { id: 'p-1', name: 'Reliability' },
    labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] },
    history: { nodes: [] as unknown[] },
    ...over,
  };
}

function page(field: string, nodes: unknown[], endCursor: string | null = null) {
  return json(200, { data: { [field]: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } });
}

describe('Linear workflow states map onto the canonical columns', () => {
  it('maps every state type, a started "review" state to in-review, and agrees with the host vocabulary', () => {
    expect(internal.categoryOf(STATES.triage)).toBe('triage');
    expect(internal.categoryOf(STATES.backlog)).toBe('backlog');
    expect(internal.categoryOf(STATES.todo)).toBe('todo');
    expect(internal.categoryOf(STATES.doing)).toBe('in-progress');
    expect(internal.categoryOf(STATES.review)).toBe('in-review');
    expect(internal.categoryOf(STATES.done)).toBe('done');
    expect(internal.categoryOf(STATES.canceled)).toBe('canceled');
    expect(internal.categoryOf({ id: 'x', name: 'Dup', type: 'duplicate' })).toBe('canceled');
    expect(internal.categoryOf({ id: 'x', name: '?', type: 'nonsense' })).toBeNull();
    // The plugin restates the host's transition rule; pin it to the TypeScript source of truth.
    for (const from of [null, ...TICKET_STATUS_CATEGORIES]) {
      for (const to of TICKET_STATUS_CATEGORIES) {
        expect(internal.transitionBetween(from, to)).toBe(ticketTransitionBetween(from, to));
      }
    }
  });
});

describe('a Linear issue becomes one canonical ticket', () => {
  it('maps identity, column, people, priority, dates and relations', () => {
    expect(internal.issueToTicket(issue())).toEqual({
      provider: 'linear', externalId: 'iss-1', container: 'ENG', number: 1, identifier: 'ENG-1',
      title: 'Cold start fails', body: 'Steps attached.', state: 'open', statusCategory: 'in-progress', statusName: 'In Progress',
      assignees: ['Bob'], delegates: ['Papercusp'], labels: ['bug', 'p1'], priority: { level: 2, name: 'High' }, estimate: 3,
      dueAt: '2026-10-09T00:00:00.000Z', parentExternalId: 'iss-0', projects: ['Reliability'], author: 'Alice',
      url: 'https://linear.app/acme/issue/ENG-1', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
    });
  });

  it('a completed issue is closed with its completion time; an unassigned undelegated issue has empty people', () => {
    const ticket = internal.issueToTicket(issue({
      state: STATES.done, completedAt: '2026-10-03T10:00:00.000Z', assignee: null, delegate: null, parent: null, project: null,
      description: null, dueDate: null, estimate: null,
    }));
    expect(ticket).toMatchObject({ state: 'closed', statusCategory: 'done', closedAt: '2026-10-03T10:00:00.000Z', assignees: [], body: '' });
    for (const key of ['delegates', 'parentExternalId', 'projects', 'dueAt', 'estimate']) expect(ticket).not.toHaveProperty(key);
  });
});

describe('workflow-state history becomes ticket-status-change records', () => {
  it('emits opened once, then closed / reopened / moved by column, skipping non-state history', () => {
    const ticket = internal.issueToTicket(issue());
    const records = internal.statusChangesOf(issue({
      history: { nodes: [
        { id: 'h1', createdAt: '2026-10-01T09:00:00.000Z', fromState: STATES.todo, toState: STATES.doing, actor: { name: 'bob' } },
        { id: 'h2', createdAt: '2026-10-01T10:00:00.000Z', fromState: STATES.doing, toState: STATES.done, actor: null },
        { id: 'h3', createdAt: '2026-10-01T11:00:00.000Z', fromState: STATES.done, toState: STATES.todo, actor: null },
        { id: 'h4', createdAt: '2026-10-01T12:00:00.000Z', fromState: STATES.todo, toState: STATES.ready, actor: null },
        { id: 'h5', createdAt: '2026-10-01T13:00:00.000Z', fromState: null, toState: null, actor: null },
      ] },
    }), ticket);
    expect(records.map((r: { nativeId: string; payload: Record<string, unknown> }) => [r.nativeId, r.payload.transition, r.payload.fromCategory ?? null, r.payload.toCategory ?? null]))
      .toEqual([
        ['opened:iss-1', 'opened', null, null],
        ['history:h1', 'moved', 'todo', 'in-progress'],
        ['history:h2', 'closed', 'in-progress', 'done'],
        ['history:h3', 'reopened', 'done', 'todo'],
        ['history:h4', 'moved', 'todo', 'todo'],
      ]);
    expect(records[1].payload).toMatchObject({
      ticketExternalId: 'iss-1', fromStatusName: 'Todo', toStatusName: 'In Progress', actor: 'bob', occurredAt: '2026-10-01T09:00:00.000Z',
    });
  });
});

describe('syncPage walks issues then comments per team, folding watermarks only at the end of a pass', () => {
  it('paginates, crosses teams in config order, and filters the next pass by the newest updatedAt seen', async () => {
    const fake = fakeHost((op, vars) => {
      const filter = vars.filter as Record<string, unknown>;
      if (op === 'PapercuspIssues') {
        const team = (filter.team as { id: { eq: string } }).id.eq;
        if (team === 'team-a' && !vars.after) return page('issues', [issue()], 'cur-a1');
        if (team === 'team-a') return page('issues', [issue({ id: 'iss-2', number: 2, updatedAt: '2026-10-02T11:00:00.000Z' })]);
        return page('issues', []);
      }
      // Comments live on team-a's issue only.
      const commentTeam = ((filter.issue as { team: { id: { eq: string } } }).team).id.eq;
      if (commentTeam !== 'team-a') return page('comments', []);
      return page('comments', [{
        id: 'c-1', body: 'repro attached', url: 'https://linear.app/acme/issue/ENG-1#comment-c1',
        createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', user: { name: 'alice' }, issue: { id: 'iss-1' },
      }]);
    });
    const config = { teamIds: ['team-a', 'team-b'] };
    const pages: Array<{ hasMore: boolean; ids: string[] }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const out = await adapter.syncPage({ source: SOURCE, config, cursor }, fake.host);
      pages.push({ hasMore: out.hasMore, ids: out.records.map((r: { nativeId: string }) => r.nativeId) });
      cursor = out.nextCursor;
      if (!out.hasMore) break;
    }
    expect(fake.calls.map((c) => `${c.op}:${JSON.stringify((c.variables.filter as Record<string, unknown>))}:${c.variables.after ?? ''}`)).toEqual([
      'PapercuspIssues:{"team":{"id":{"eq":"team-a"}}}:',
      'PapercuspIssues:{"team":{"id":{"eq":"team-a"}}}:cur-a1',
      'PapercuspComments:{"issue":{"team":{"id":{"eq":"team-a"}}}}:',
      'PapercuspIssues:{"team":{"id":{"eq":"team-b"}}}:',
      'PapercuspComments:{"issue":{"team":{"id":{"eq":"team-b"}}}}:',
    ]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, true, true, false]);
    expect(pages[0]!.ids).toEqual(['iss-1', 'opened:iss-1']);
    expect(pages[2]!.ids).toEqual(['comment:c-1']);

    // Next pass: the same calls, now bounded by the newest updatedAt each (team, phase) saw.
    fake.calls.length = 0;
    await adapter.syncPage({ source: SOURCE, config, cursor }, fake.host);
    expect(fake.calls[0]!.variables.filter).toEqual({ team: { id: { eq: 'team-a' } }, updatedAt: { gte: '2026-10-02T11:00:00.000Z' } });
    expect(JSON.parse(cursor!).since).toEqual({
      'team-a:issues': '2026-10-02T11:00:00.000Z',
      'team-a:comments': '2026-10-02T10:00:00.000Z',
    });
  });

  it('a changed team list starts a fresh pass that keeps the remaining teams\' watermarks', () => {
    const raw = JSON.stringify({
      v: 1, teams: ['team-a', 'team-b'], team: 1, phase: 'comments', after: 'x',
      since: { 'team-a:issues': '2026-10-01T00:00:00.000Z', 'team-b:issues': '2026-10-01T00:00:00.000Z' }, seen: {},
    });
    expect(internal.decodeCursor(raw, ['team-a', 'team-c'])).toEqual({
      v: 1, teams: ['team-a', 'team-c'], team: 0, phase: 'issues', after: null,
      since: { 'team-a:issues': '2026-10-01T00:00:00.000Z' }, seen: {},
    });
    expect(() => internal.decodeCursor('not json', ['team-a'])).toThrow(/linear_cursor_unreadable/);
    expect(() => internal.decodeCursor(JSON.stringify({ v: 2 }), ['team-a'])).toThrow(/linear_cursor_unrecognised/);
  });

  it('refuses a source with no teams', async () => {
    await expect(adapter.syncPage({ source: SOURCE, config: {}, cursor: null }, fakeHost(() => json(200, {})).host))
      .rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('linear_teams_missing') });
  });
});

describe('Linear failures map onto the host sync signals', () => {
  const config = { teamIds: ['team-a'] };
  it('RATELIMITED (Linear answers 400 with the GraphQL code) is rate-limited with the reset time', async () => {
    const resetMs = Date.now() + 90_000;
    const host = fakeHost(() => json(400, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      { 'X-RateLimit-Requests-Reset': String(resetMs) })).host;
    const err = await adapter.syncPage({ source: SOURCE, config, cursor: null }, host).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate-limited' });
    expect((err as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(85);
    expect((err as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it('HTTP 429 honours Retry-After', async () => {
    const host = fakeHost(() => json(429, {}, { 'retry-after': '12' })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, host)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 12 });
  });

  it('classifies by extensions.type too, the field @linear/sdk reads (errorMap: "ratelimited", "authentication error")', async () => {
    const limited = fakeHost(() => json(400, { errors: [{ message: 'slow down', extensions: { type: 'ratelimited' } }] }, { 'retry-after': '7' })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, limited)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 7 });
    const denied = fakeHost(() => json(400, { errors: [{ message: 'auth', extensions: { type: 'authentication error' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, denied)).rejects.toMatchObject({ kind: 'auth' });
    const forbidden = fakeHost(() => json(200, { errors: [{ message: 'no', extensions: { type: 'forbidden' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, forbidden)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('an authentication error is auth; any other GraphQL error is transient', async () => {
    const denied = fakeHost(() => json(400, { errors: [{ message: 'auth', extensions: { code: 'AUTHENTICATION_ERROR' } }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, denied)).rejects.toMatchObject({ kind: 'auth' });
    const broken = fakeHost(() => json(200, { errors: [{ message: 'Cannot query field "x"' }] })).host;
    await expect(adapter.syncPage({ source: SOURCE, config, cursor: null }, broken))
      .rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('Cannot query field') });
  });
});

describe('writes: ticket.comment and ticket.transition', () => {
  it('comments through commentCreate and returns the comment phase\'s nativeId as updateId', async () => {
    const fake = fakeHost((op, vars) => {
      expect(op).toBe('PapercuspCommentCreate');
      expect(vars.input).toEqual({ issueId: 'iss-1', body: 'Picked up by Papercusp.' });
      return json(200, { data: { commentCreate: { success: true, comment: { id: 'c-9', url: 'https://linear.app/c/9' } } } });
    });
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.comment', args: { externalId: 'iss-1', text: ' Picked up by Papercusp. ' } }, fake.host))
      .resolves.toEqual({ externalRef: 'https://linear.app/c/9', updateId: 'comment:c-9' });
  });

  function statesHost(current: { id: string; name: string; type: string }, onUpdate: (stateId: string) => void) {
    return fakeHost((op, vars) => {
      if (op === 'PapercuspIssueStates') {
        return json(200, { data: { issue: { id: 'iss-1', state: current, team: { id: 'team-a', states: { nodes: Object.values(STATES) } } } } });
      }
      expect(op).toBe('PapercuspIssueTransition');
      onUpdate((vars.input as { stateId: string }).stateId);
      return json(200, { data: { issueUpdate: { success: true, issue: { id: 'iss-1', updatedAt: 'x', state: current } } } });
    });
  }

  it('moves to the first state (by position) of the mapped type, preferring review-named states only for in-review', async () => {
    const moves: string[] = [];
    for (const toCategory of ['todo', 'in-progress', 'in-review', 'done', 'canceled', 'backlog', 'triage']) {
      // The issue sits in a backlog state, so a move to backlog is a no-op (changed: false).
      const fake = statesHost({ id: 'st-icebox', name: 'Icebox', type: 'backlog' }, (id) => moves.push(`${toCategory}->${id}`));
      const out = await adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory } }, fake.host);
      if (toCategory !== 'backlog') expect(out).toMatchObject({ changed: true, externalRef: 'iss-1' });
    }
    expect(moves).toEqual([
      'todo->st-todo', 'in-progress->st-doing', 'in-review->st-review', 'done->st-done', 'canceled->st-canceled', 'triage->st-triage',
    ]);
  });

  it('leaves an issue already in the column alone, and refuses an unknown column or a capability it lacks', async () => {
    let updated = false;
    const fake = statesHost(STATES.done, () => { updated = true; });
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory: 'done' } }, fake.host))
      .resolves.toMatchObject({ changed: false });
    expect(updated).toBe(false);
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.transition', args: { externalId: 'iss-1', toCategory: 'shipped' } }, fake.host))
      .rejects.toThrow(/transition_category_invalid:shipped/);
    await expect(adapter.invoke({ source: SOURCE, capability: 'ticket.assign', args: {} }, fake.host))
      .rejects.toThrow(/provider_capability_unsupported:ticket.assign/);
  });
});
