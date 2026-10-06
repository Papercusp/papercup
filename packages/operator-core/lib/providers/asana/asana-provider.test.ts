/**
 * Asana provider package, unit level (linear-asana-task-sync-2026-10-05 P-005, R-5; design D-011).
 *
 * Loads the real `libs/papercusp/plugins/asana` package and drives its adapter through a fake
 * `host.fetch` that answers Asana's REST API. Every fixture and recorded response is typed against
 * Asana's own OpenAPI document (the pinned subset in asana-openapi.subset.json, generated into
 * asana-openapi.d.ts by scripts/gen-asana-openapi-subset.mjs), and every `opt_fields` path the
 * provider requests is checked to resolve in that document, so a field Asana does not serve fails
 * here rather than silently reading as undefined in production.
 *
 * Covers the task -> ticket mapping (columns from completion and mapped sections, the container of
 * a multi-homed task), stories -> status changes and comments, the crawl + Events-token cursor
 * (token before crawl, offset expiry, 412 reset, config change), rate-limit and auth signals, and
 * the writes (ticket.read, ticket.comment, ticket.transition). The real-driver/Postgres proof is
 * asana-provider.integration.test.ts.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  HostFetch,
  HostFetchRequest,
  HostFetchResponse,
  ProviderInvokeRequest,
  ProviderSyncRequest,
} from '@papercusp/plugin-sdk';
import { TICKET_STATUS_CATEGORIES, ticketTransitionBetween } from '../../data-sources/ticket-vocabulary';
import type { components } from './asana-openapi';
import openapi from './asana-openapi.subset.json';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin = requireCjs(resolve(REPO_ROOT, 'libs/papercusp/plugins/asana/index.cjs')) as any;
const adapter = plugin.providerAdapter;
const internal = plugin._internal;

type Schemas = components['schemas'];
/**
 * Asana documents a task's `created_by` as "A *user* object" but its schema lists only gid and
 * resource_type; the API serves `created_by.name` (the provider requests it). The fixture type
 * widens exactly that field to a UserCompact; the spec-gap test below pins the gap.
 */
type Task = Omit<Schemas['TaskResponse'], 'created_by'> & { created_by?: Schemas['UserCompact'] };
type Story = Schemas['StoryResponse'];
type AsanaEvent = Schemas['EventResponse'];

/** The host passes the data source id; host.fetch resolves its token from it. */
const SOURCE = 'src-asana';
const API = 'https://app.asana.com/api/1.0';

const CONFIG = {
  workspaceGid: 'ws-1',
  projectGids: ['proj-eng', 'proj-ops'],
  // Keys match a section gid or name, case-insensitively; an unknown column is dropped.
  sectionCategories: { 'To do': 'todo', Doing: 'in-progress', 'sec-review': 'in-review', Done: 'done', Bogus: 'shipped' },
};

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; source: string; request: HostFetchRequest };
type Route = (call: Call) => HostFetchResponse | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

/** A fake Asana: `route` answers each request; an unanswered request fails the test loudly. */
function fakeHost(route: Route) {
  const calls: Call[] = [];
  const fetch: HostFetch = async ({ source, request }) => {
    expect(request.url.startsWith(`${API}/`)).toBe(true);
    const url = new URL(request.url);
    const call: Call = {
      method: request.method ?? 'GET',
      path: url.pathname.slice('/api/1.0'.length),
      query: url.searchParams,
      body: request.body === undefined ? undefined : JSON.parse(request.body),
      source,
      request,
    };
    calls.push(call);
    const response = route(call);
    if (!response) throw new Error(`unrouted Asana request: ${call.method} ${call.path}?${call.query}`);
    return response;
  };
  const named = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { calls, named, host: { fetch } };
}

const ENG = { gid: 'proj-eng', resource_type: 'project', name: 'Engineering' };
const OPS = { gid: 'proj-ops', resource_type: 'project', name: 'Operations' };
const SECTIONS = {
  todo: { gid: 'sec-todo', resource_type: 'section', name: 'To do' },
  doing: { gid: 'sec-doing', resource_type: 'section', name: 'Doing' },
  review: { gid: 'sec-review', resource_type: 'section', name: 'Code review' },
  done: { gid: 'sec-done', resource_type: 'section', name: 'Done' },
  backlog: { gid: 'sec-backlog', resource_type: 'section', name: 'Backlog' },
  icebox: { gid: 'sec-icebox', resource_type: 'section', name: 'Icebox' },
  opsInbox: { gid: 'sec-ops-inbox', resource_type: 'section', name: 'Inbox' },
} satisfies Record<string, Schemas['SectionCompact']>;

/**
 * Task t-1 is multi-homed: filed in Operations' Inbox FIRST and Engineering's Doing second, so the
 * configured project order (Engineering first) decides its container, not membership order.
 */
function task(over: Partial<Task> = {}): Task {
  return {
    gid: 't-1', resource_type: 'task', name: 'Cold start fails', notes: 'Steps attached.',
    completed: false, created_at: '2026-10-01T08:00:00.000Z', modified_at: '2026-10-02T09:00:00.000Z',
    due_on: '2026-10-09', permalink_url: 'https://app.asana.com/0/proj-eng/t-1',
    assignee: { gid: 'u-bob', resource_type: 'user', name: 'Bob' },
    created_by: { gid: 'u-alice', resource_type: 'user', name: 'Alice' },
    parent: { gid: 't-0', resource_type: 'task', name: 'Reliability epic' },
    tags: [{ gid: 'tag-bug', resource_type: 'tag', name: 'bug' }, { gid: 'tag-p1', resource_type: 'tag', name: 'p1' }],
    memberships: [{ project: OPS, section: SECTIONS.opsInbox }, { project: ENG, section: SECTIONS.doing }],
    ...over,
  };
}

function story(over: Partial<Story> & Pick<Story, 'gid' | 'resource_subtype'>): Story {
  return {
    resource_type: 'story', created_at: '2026-10-02T10:00:00.000Z',
    created_by: { gid: 'u-bob', resource_type: 'user', name: 'Bob' },
    ...over,
  };
}

const cfg = () => internal.configOf(CONFIG);
const ticketOf = (t: Task = task()) => internal.taskToTicket(t, cfg());

function thrown(fn: () => unknown): Error & { kind?: string; retryAfterSeconds?: number } {
  try {
    fn();
  } catch (error) {
    return error as Error & { kind?: string };
  }
  throw new Error('expected a throw');
}

describe('the Asana package declares an Asana ticket provider', () => {
  it('describes itself: datatypes, write capabilities, OAuth, egress and the config it needs', async () => {
    const descriptor = await adapter.describe();
    expect(descriptor).toMatchObject({
      id: 'asana',
      contractVersion: 1,
      datatypes: ['ticket', 'ticket-status-change', 'ticket-comment'],
      capabilities: ['ticket.read', 'ticket.comment', 'ticket.transition'],
      egressHosts: ['app.asana.com'],
      oauth: {
        authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
        tokenUrl: 'https://app.asana.com/-/oauth_token',
        identity: { url: 'https://app.asana.com/api/1.0/users/me?opt_fields=name', idField: 'data.gid' },
      },
      configSchema: { required: ['projectGids'] },
    });
    expect(descriptor.oauth.scopes).toEqual(expect.arrayContaining(['tasks:read', 'tasks:write', 'stories:read', 'stories:write', 'projects:read']));
  });

  it('agrees with the ticket vocabulary on every transition between two columns', () => {
    for (const from of [null, ...TICKET_STATUS_CATEGORIES]) {
      for (const to of TICKET_STATUS_CATEGORIES) {
        expect(internal.transitionBetween(from, to)).toBe(ticketTransitionBetween(from, to));
      }
    }
  });

  it('refuses a source with no projects, and drops a section mapped to an unknown column', () => {
    expect(thrown(() => internal.configOf({ workspaceGid: 'ws-1' }))).toMatchObject({ kind: 'transient', message: expect.stringContaining('asana_projects_missing') });
    const config = cfg();
    expect(config.projects).toEqual(['proj-eng', 'proj-ops']);
    expect(internal.sectionCategory(config, { gid: 'sec-x', name: 'Bogus' })).toBeNull();
  });
});

describe('an Asana task becomes one canonical ticket', () => {
  it('maps identity, container, column, people, labels, dates and parent', () => {
    expect(ticketOf()).toEqual({
      provider: 'asana',
      externalId: 't-1',
      container: 'Engineering',
      title: 'Cold start fails',
      body: 'Steps attached.',
      state: 'open',
      statusCategory: 'in-progress',
      assignees: ['Bob'],
      labels: ['bug', 'p1'],
      statusName: 'Doing',
      section: 'Doing',
      projects: ['Operations', 'Engineering'],
      dueAt: '2026-10-09T00:00:00.000Z',
      parentExternalId: 't-0',
      author: 'Alice',
      url: 'https://app.asana.com/0/proj-eng/t-1',
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-02T09:00:00.000Z',
    });
  });

  it('a multi-homed task maps to the same ticket whichever project it is read through', () => {
    const reversed = task({ memberships: [{ project: ENG, section: SECTIONS.doing }, { project: OPS, section: SECTIONS.opsInbox }] });
    expect(ticketOf(reversed)).toMatchObject({ externalId: 't-1', container: 'Engineering', statusCategory: 'in-progress' });
    // Config order decides: a source listing Operations first files it there.
    const opsFirst = internal.configOf({ ...CONFIG, projectGids: ['proj-ops', 'proj-eng'] });
    expect(internal.taskToTicket(task(), opsFirst)).toMatchObject({ container: 'Operations', statusCategory: 'todo', statusName: 'Inbox' });
  });

  it('a completed task is done and closed, whatever its section', () => {
    const done = ticketOf(task({ completed: true, completed_at: '2026-10-03T10:00:00Z' }));
    expect(done).toMatchObject({ state: 'closed', statusCategory: 'done', statusName: 'Completed', section: 'Doing', closedAt: '2026-10-03T10:00:00.000Z' });
  });

  it('maps a section by gid or name; an unmapped section is todo', () => {
    const inSection = (section: Schemas['SectionCompact']) => ticketOf(task({ memberships: [{ project: ENG, section }] }));
    expect(inSection(SECTIONS.review)).toMatchObject({ statusCategory: 'in-review', statusName: 'Code review' });
    expect(inSection({ ...SECTIONS.done, name: 'DONE' })).toMatchObject({ statusCategory: 'done', state: 'closed' });
    expect(inSection(SECTIONS.backlog)).toMatchObject({ statusCategory: 'todo', state: 'open', statusName: 'Backlog' });
  });

  it('due_at wins over due_on; an unconfigured project falls back to the first membership', () => {
    expect(ticketOf(task({ due_at: '2026-10-09T17:00:00Z' })).dueAt).toBe('2026-10-09T17:00:00.000Z');
    const elsewhere = task({ memberships: [{ project: { gid: 'proj-x', resource_type: 'project' }, section: SECTIONS.doing }] });
    expect(ticketOf(elsewhere)).toMatchObject({ container: 'proj-x', statusCategory: 'in-progress' });
    const bare = ticketOf(task({ assignee: undefined, tags: [], parent: undefined, due_on: undefined, memberships: [] }));
    expect(bare).toMatchObject({ assignees: [], labels: [], statusCategory: 'todo' });
    expect(bare).not.toHaveProperty('parentExternalId');
    expect(bare).not.toHaveProperty('dueAt');
  });
});

describe('stories become status changes and comments', () => {
  const at = '2026-10-02T10:00:00.000Z';
  const record = (s: Story) => internal.storyRecord(s, ticketOf(), cfg());

  it('a comment story is a ticket-comment keyed story:<gid>', () => {
    expect(record(story({ gid: 's-1', resource_subtype: 'comment_added', text: 'Looking into it' }))).toEqual({
      datatype: 'ticket-comment',
      nativeId: 'story:s-1',
      event: 'task-comment',
      payload: {
        provider: 'asana', externalId: 's-1', ticketExternalId: 't-1', text: 'Looking into it', author: 'Bob',
        url: 'https://app.asana.com/0/proj-eng/t-1', occurredAt: at,
      },
      occurredAt: at,
    });
  });

  it('completion and reopening are closed and reopened changes', () => {
    expect(record(story({ gid: 's-2', resource_subtype: 'marked_complete' }))).toEqual({
      datatype: 'ticket-status-change',
      nativeId: 'story:s-2',
      event: 'task-status-changed',
      payload: { provider: 'asana', externalId: 'story:s-2', ticketExternalId: 't-1', transition: 'closed', toCategory: 'done', actor: 'Bob', occurredAt: at },
      occurredAt: at,
    });
    expect(record(story({ gid: 's-3', resource_subtype: 'marked_incomplete' })).payload).toMatchObject({ transition: 'reopened', fromCategory: 'done' });
  });

  it('a section move between mapped columns uses the vocabulary; between unmapped sections it is a move', () => {
    const move = (old_section: Schemas['SectionCompact'], new_section: Schemas['SectionCompact']) =>
      record(story({ gid: 's-4', resource_subtype: 'section_changed', old_section, new_section }));
    expect(move(SECTIONS.doing, SECTIONS.done).payload).toEqual({
      provider: 'asana', externalId: 'story:s-4', ticketExternalId: 't-1', transition: 'closed',
      fromCategory: 'in-progress', toCategory: 'done', fromStatusName: 'Doing', toStatusName: 'Done', actor: 'Bob', occurredAt: at,
    });
    expect(move(SECTIONS.todo, SECTIONS.review).payload).toMatchObject({ transition: 'moved', fromCategory: 'todo', toCategory: 'in-review' });
    const board = move(SECTIONS.backlog, SECTIONS.icebox).payload;
    expect(board).toMatchObject({ transition: 'moved', fromStatusName: 'Backlog', toStatusName: 'Icebox' });
    expect(board).not.toHaveProperty('fromCategory');
    expect(move(SECTIONS.backlog, SECTIONS.doing).payload).toMatchObject({ transition: 'moved', toCategory: 'in-progress' });
    expect(move(SECTIONS.backlog, SECTIONS.backlog)).toBeNull();
  });

  it('other stories and a story without a gid produce nothing', () => {
    expect(record(story({ gid: 's-5', resource_subtype: 'assigned' }))).toBeNull();
    expect(record(story({ gid: '', resource_subtype: 'comment_added', text: 'x' }))).toBeNull();
  });
});

describe('events name the tasks to re-read', () => {
  it('task events name the task, story events name their parent task, deduped in order', () => {
    const events: AsanaEvent[] = [
      { resource: { gid: 't-1', resource_type: 'task' }, action: 'changed', type: 'task' },
      { resource: { gid: 's-9', resource_type: 'story' }, parent: { gid: 't-2', resource_type: 'task' }, action: 'added', type: 'story' },
      { resource: { gid: 't-1', resource_type: 'task' }, action: 'changed', type: 'task' },
      { resource: { gid: 'sec-1', resource_type: 'section' }, parent: { gid: 'proj-eng', resource_type: 'project' }, action: 'added' },
      { resource: { gid: 's-10', resource_type: 'story' }, parent: { gid: 'proj-eng', resource_type: 'project' }, action: 'added' },
    ];
    expect(internal.touchedTasks(events)).toEqual(['t-1', 't-2']);
  });
});

describe('the cursor', () => {
  const projects = ['proj-eng', 'proj-ops'];
  const raw = (over: Record<string, unknown>) =>
    JSON.stringify({ v: 1, projects, project: 0, phase: 'events', offset: null, tokens: { 'proj-eng': 'tok' }, fresh: {}, ...over });

  it('no cursor starts a crawl of the first project', () => {
    expect(internal.decodeCursor(null, projects)).toEqual({ v: 1, projects, project: 0, phase: 'crawl', offset: null, tokens: {}, fresh: {} });
  });

  it('a changed project list restarts the crawl; an unreadable or foreign cursor is expired', () => {
    expect(internal.decodeCursor(raw({ projects: ['proj-eng'] }), projects)).toMatchObject({ phase: 'crawl', project: 0, tokens: {} });
    expect(thrown(() => internal.decodeCursor('{not json', projects)).kind).toBe('cursor-expired');
    expect(thrown(() => internal.decodeCursor(raw({ v: 2 }), projects)).kind).toBe('cursor-expired');
    expect(thrown(() => internal.decodeCursor(raw({ phase: 'later' }), projects)).kind).toBe('cursor-expired');
    expect(thrown(() => internal.decodeCursor(raw({ project: 2 }), projects)).kind).toBe('cursor-expired');
  });
});

/** A small Asana workspace: two projects, t-1 multi-homed in both. */
function workspace() {
  const t1 = task();
  const t2 = task({ gid: 't-2', name: 'Flaky deploy check', memberships: [{ project: ENG, section: SECTIONS.todo }] });
  const t3 = task({ gid: 't-3', name: 'Rotate certificates', memberships: [{ project: OPS, section: SECTIONS.opsInbox }] });
  const tasks = new Map<string, Task>([[t1.gid!, t1], [t2.gid!, t2], [t3.gid!, t3]]);
  const stories = new Map<string, Story[]>([['t-1', [story({ gid: 's-1', resource_subtype: 'comment_added', text: 'Looking into it' })]]]);
  const syncExpired = (sync: string) => json(412, { errors: [{ message: 'Sync token invalid or too old.' }], sync } satisfies Schemas['GetEventsSyncExpired']);
  const route: Route = (c) => {
    if (c.method === 'GET' && c.path === '/events' && !c.query.get('sync')) return syncExpired(`tok-${c.query.get('resource')}-0`);
    const crawl = /^\/projects\/([^/]+)\/tasks$/.exec(c.path);
    if (c.method === 'GET' && crawl) {
      const pages: Record<string, Schemas['GetTasksForProjectOk']> = {
        'proj-eng:': { data: [t1], next_page: { offset: 'off-2', path: '/projects/proj-eng/tasks?offset=off-2', uri: `${API}/projects/proj-eng/tasks?offset=off-2` } },
        'proj-eng:off-2': { data: [t2], next_page: null },
        'proj-ops:': { data: [t1, t3], next_page: null },
      };
      const page = pages[`${crawl[1]}:${c.query.get('offset') ?? ''}`];
      return page ? json(200, page) : undefined;
    }
    const storiesOf = /^\/tasks\/([^/]+)\/stories$/.exec(c.path);
    if (c.method === 'GET' && storiesOf) return json(200, { data: stories.get(storiesOf[1]) ?? [], next_page: null } satisfies Schemas['GetStoriesForTaskOk']);
    const one = /^\/tasks\/([^/]+)$/.exec(c.path);
    if (c.method === 'GET' && one) {
      const hit = tasks.get(one[1]);
      return hit ? json(200, { data: hit } satisfies Schemas['GetTaskOk']) : json(404, { errors: [{ message: 'Not found' }] } satisfies Schemas['ErrorResponse']);
    }
    return undefined;
  };
  return { t1, t2, t3, tasks, stories, route };
}

const syncReq = (cursor: string | null, over: Partial<ProviderSyncRequest> = {}): ProviderSyncRequest => ({
  source: SOURCE, cursor, mode: cursor ? 'incremental' : 'backfill', config: CONFIG, ...over,
});
const keys = (records: Array<{ datatype: string; nativeId: string }>) => records.map((r) => `${r.datatype}:${r.nativeId}`);

describe('backfill crawls each project after taking its Events token', () => {
  it('pages through both projects; a multi-homed task is the same ticket from either', async () => {
    const ws = workspace();
    const fake = fakeHost(ws.route);

    const first = await adapter.syncPage(syncReq(null), fake.host);
    expect(keys(first.records)).toEqual(['ticket:t-1', 'ticket-status-change:opened:t-1', 'ticket-comment:story:s-1']);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.nextCursor)).toEqual({
      v: 1, projects: ['proj-eng', 'proj-ops'], project: 0, phase: 'crawl', offset: 'off-2', tokens: {}, fresh: { 'proj-eng': 'tok-proj-eng-0' },
    });
    // The token is taken before the first task page, so a change made during the crawl is replayed.
    const order = fake.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('GET /events')).toBeLessThan(order.indexOf('GET /projects/proj-eng/tasks'));
    const crawl = fake.named('GET', '/projects/proj-eng/tasks')[0];
    expect(crawl.query.get('limit')).toBe('50');
    expect(crawl.query.get('opt_fields')).toBe(internal.fields.task);

    const second = await adapter.syncPage(syncReq(first.nextCursor), fake.host);
    expect(keys(second.records)).toEqual(['ticket:t-2', 'ticket-status-change:opened:t-2']);
    expect(JSON.parse(second.nextCursor)).toMatchObject({ project: 1, phase: 'crawl', offset: null });
    expect(fake.named('GET', '/events')).toHaveLength(1); // a continued page takes no new token

    const third = await adapter.syncPage(syncReq(second.nextCursor), fake.host);
    expect(keys(third.records)).toEqual([
      'ticket:t-1', 'ticket-status-change:opened:t-1', 'ticket-comment:story:s-1', 'ticket:t-3', 'ticket-status-change:opened:t-3',
    ]);
    expect(third.records[0].payload).toEqual(first.records[0].payload);
    expect(third.hasMore).toBe(false);
    expect(JSON.parse(third.nextCursor)).toEqual({
      v: 1, projects: ['proj-eng', 'proj-ops'], project: 0, phase: 'events', offset: null,
      tokens: { 'proj-eng': 'tok-proj-eng-0', 'proj-ops': 'tok-proj-ops-0' }, fresh: {},
    });
    expect(fake.calls.every((c) => c.source === SOURCE)).toBe(true);
  });

  it('an expired crawl offset restarts that project without a new token', async () => {
    const ws = workspace();
    const fake = fakeHost((c) =>
      c.path === '/projects/proj-eng/tasks' && c.query.get('offset') === 'stale'
        ? json(400, { errors: [{ message: 'offset: Your pagination token has expired.' }] } satisfies Schemas['ErrorResponse'])
        : ws.route(c));
    const cursor = JSON.stringify({ v: 1, projects: CONFIG.projectGids, project: 0, phase: 'crawl', offset: 'stale', tokens: {}, fresh: { 'proj-eng': 'tok' } });
    const page = await adapter.syncPage(syncReq(cursor), fake.host);
    expect(fake.named('GET', '/projects/proj-eng/tasks').map((c) => c.query.get('offset'))).toEqual(['stale', null]);
    expect(fake.named('GET', '/events')).toHaveLength(0);
    expect(keys(page.records)[0]).toBe('ticket:t-1');
    expect(JSON.parse(page.nextCursor)).toMatchObject({ fresh: { 'proj-eng': 'tok' }, offset: 'off-2' });
  });
});

describe('incremental reads each project\'s events and re-reads the touched tasks', () => {
  const settled = JSON.stringify({
    v: 1, projects: CONFIG.projectGids, project: 0, phase: 'events', offset: null,
    tokens: { 'proj-eng': 'tok-eng-0', 'proj-ops': 'tok-ops-0' }, fresh: {},
  });

  it('advances each token; a deleted task is skipped; each touched task is read once', async () => {
    const ws = workspace();
    const events: Record<string, Schemas['GetEventsOk']> = {
      'proj-eng:tok-eng-0': {
        data: [
          { resource: { gid: 't-1', resource_type: 'task' }, action: 'changed', type: 'task' },
          { resource: { gid: 's-9', resource_type: 'story' }, parent: { gid: 't-9', resource_type: 'task' }, action: 'added', type: 'story' },
          { resource: { gid: 't-1', resource_type: 'task' }, action: 'changed', type: 'task' },
        ],
        sync: 'tok-eng-1',
        has_more: true,
      },
      'proj-eng:tok-eng-1': { data: [], sync: 'tok-eng-2', has_more: false },
      'proj-ops:tok-ops-0': { data: [], sync: 'tok-ops-1', has_more: false },
    };
    const fake = fakeHost((c) => {
      if (c.path === '/events' && c.query.get('sync')) {
        const page = events[`${c.query.get('resource')}:${c.query.get('sync')}`];
        expect(c.query.get('opt_fields')).toBe(internal.fields.event);
        return page ? json(200, page) : undefined;
      }
      return ws.route(c);
    });

    const first = await adapter.syncPage(syncReq(settled), fake.host);
    expect(keys(first.records)).toEqual(['ticket:t-1', 'ticket-status-change:opened:t-1', 'ticket-comment:story:s-1']);
    expect(fake.named('GET', '/tasks/t-1')).toHaveLength(1);
    expect(fake.named('GET', '/tasks/t-9')).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.nextCursor)).toMatchObject({ project: 0, tokens: { 'proj-eng': 'tok-eng-1', 'proj-ops': 'tok-ops-0' } });

    const second = await adapter.syncPage(syncReq(first.nextCursor), fake.host);
    expect(second.records).toEqual([]);
    expect(JSON.parse(second.nextCursor)).toMatchObject({ project: 1, tokens: { 'proj-eng': 'tok-eng-2' } });

    const third = await adapter.syncPage(syncReq(second.nextCursor), fake.host);
    expect(third.hasMore).toBe(false);
    expect(JSON.parse(third.nextCursor)).toEqual({
      v: 1, projects: CONFIG.projectGids, project: 0, phase: 'events', offset: null,
      tokens: { 'proj-eng': 'tok-eng-2', 'proj-ops': 'tok-ops-1' }, fresh: {},
    });
  });

  it('a 412 (Asana dropped the token) is cursor-expired, so the driver re-backfills', async () => {
    const fake = fakeHost(() => json(412, { errors: [{ message: 'Sync token invalid or too old.' }], sync: 'tok-new' } satisfies Schemas['GetEventsSyncExpired']));
    await expect(adapter.syncPage(syncReq(settled), fake.host)).rejects.toMatchObject({ kind: 'cursor-expired', message: 'asana_sync_token_expired:proj-eng' });
    const tokenless = JSON.stringify({ ...JSON.parse(settled), tokens: {} });
    await expect(adapter.syncPage(syncReq(tokenless), fakeHost(() => undefined).host)).rejects.toMatchObject({ kind: 'cursor-expired', message: 'asana_sync_token_absent:proj-eng' });
  });

  it('429 is rate-limited with Asana\'s retry time; 401/403 is an auth failure', async () => {
    const limited = fakeHost(() => json(429, { errors: [{ message: 'You have made too many requests recently.' }] }, { 'Retry-After': '17' }));
    await expect(adapter.syncPage(syncReq(settled), limited.host)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 17 });
    const denied = fakeHost(() => json(401, { errors: [{ message: 'Not Authorized' }] }));
    await expect(adapter.syncPage(syncReq(settled), denied.host)).rejects.toMatchObject({ kind: 'auth', message: 'asana_access_denied:401: Not Authorized' });
  });
});

describe('writes: ticket.read, ticket.comment, ticket.transition', () => {
  const invokeReq = (capability: string, args: Record<string, unknown>): ProviderInvokeRequest => ({ source: SOURCE, capability, args, config: CONFIG });
  const sections: Schemas['GetSectionsForProjectOk'] = {
    data: [SECTIONS.todo, SECTIONS.doing, SECTIONS.review, SECTIONS.done],
    next_page: null,
  };

  /** Asana holding one task; records every write the provider sends. */
  function writable(current: Task) {
    return fakeHost((c) => {
      if (c.method === 'GET' && c.path === `/tasks/${current.gid}`) return json(200, { data: current } satisfies Schemas['GetTaskOk']);
      if (c.method === 'GET' && c.path === '/projects/proj-eng/sections') return json(200, sections);
      if (c.method === 'PUT' && c.path === `/tasks/${current.gid}`) return json(200, { data: current } satisfies Schemas['UpdateTaskOk']);
      if (c.method === 'POST' && /^\/sections\/[^/]+\/addTask$/.test(c.path)) return json(200, { data: {} });
      if (c.method === 'POST' && c.path === `/tasks/${current.gid}/stories`) {
        return json(201, { data: { gid: 's-77', resource_type: 'story', resource_subtype: 'comment_added', text: 'On it.' } } satisfies Schemas['CreateStoryForTaskCreated']);
      }
      if (c.method === 'GET') return json(404, { errors: [{ message: 'Not found' }] });
      return undefined;
    });
  }
  const writes = (fake: ReturnType<typeof fakeHost>) =>
    fake.calls.filter((c) => c.method !== 'GET').map((c) => ({ op: `${c.method} ${c.path}`, body: c.body }));

  it('ticket.comment posts one comment story; its updateId is the nativeId the sync reports', async () => {
    const fake = writable(task());
    const result = await adapter.invoke(invokeReq('ticket.comment', { externalId: 't-1', text: '  On it.  ' }), fake.host);
    expect(result).toEqual({ externalRef: 's-77', updateId: 'story:s-77' });
    const body: Schemas['CreateStoryForTaskBody'] = { data: { text: 'On it.' } };
    expect(writes(fake)).toEqual([{ op: 'POST /tasks/t-1/stories', body }]);
    const echoed = internal.storyRecord(story({ gid: 's-77', resource_subtype: 'comment_added', text: 'On it.' }), ticketOf(), cfg());
    expect(echoed.nativeId).toBe(result.updateId);
    await expect(adapter.invoke(invokeReq('ticket.comment', { externalId: 't-1', text: '   ' }), fake.host)).rejects.toThrow('ticket_comment_text_required');
    await expect(adapter.invoke(invokeReq('ticket.comment', { text: 'x' }), fake.host)).rejects.toThrow('ticket_ref_invalid');
    expect(fake.calls).toHaveLength(1);
  });

  it('ticket.transition to done completes the task and files it in the section mapped to done', async () => {
    const fake = writable(task());
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'done' }), fake.host))
      .toEqual({ changed: true, externalRef: 't-1', toStatusName: 'Completed' });
    const complete: Schemas['UpdateTaskBody'] = { data: { completed: true } };
    const file: Schemas['AddTaskForSectionBody'] = { data: { task: 't-1' } };
    expect(writes(fake)).toEqual([{ op: 'PUT /tasks/t-1', body: complete }, { op: 'POST /sections/sec-done/addTask', body: file }]);
  });

  it('an open column reopens a completed task and moves it; a column move alone does not touch completion', async () => {
    const reopen = writable(task({ completed: true, memberships: [{ project: ENG, section: SECTIONS.done }] }));
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'in-progress' }), reopen.host))
      .toEqual({ changed: true, externalRef: 't-1', toStatusName: 'Doing' });
    expect(writes(reopen)).toEqual([
      { op: 'PUT /tasks/t-1', body: { data: { completed: false } } },
      { op: 'POST /sections/sec-doing/addTask', body: { data: { task: 't-1' } } },
    ]);

    const move = writable(task({ memberships: [{ project: ENG, section: SECTIONS.todo }] }));
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'in-review' }), move.host))
      .toEqual({ changed: true, externalRef: 't-1', toStatusName: 'Code review' });
    expect(writes(move)).toEqual([{ op: 'POST /sections/sec-review/addTask', body: { data: { task: 't-1' } } }]);
  });

  it('canceled completes the task; a column no section is mapped to, or the current column, is a no-op', async () => {
    const cancel = writable(task());
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'canceled' }), cancel.host))
      .toEqual({ changed: true, externalRef: 't-1', toStatusName: 'Completed' });
    expect(writes(cancel)).toEqual([{ op: 'PUT /tasks/t-1', body: { data: { completed: true } } }]);

    const unmapped = writable(task());
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'backlog' }), unmapped.host))
      .toEqual({ changed: false, externalRef: 't-1' });
    expect(writes(unmapped)).toEqual([]);

    const same = writable(task());
    expect(await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'in-progress' }), same.host))
      .toEqual({ changed: false, externalRef: 't-1' });
    expect(same.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /tasks/t-1']);
  });

  it('refuses an unknown column, an unknown task and an undeclared capability; reads a ticket', async () => {
    const fake = writable(task());
    await expect(adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'shipped' }), fake.host)).rejects.toThrow('transition_category_invalid:shipped');
    expect(fake.calls).toHaveLength(0);
    await expect(adapter.invoke(invokeReq('ticket.read', { externalId: 't-404' }), fake.host)).rejects.toThrow('ticket_not_found:t-404');
    await expect(adapter.invoke(invokeReq('ticket.delete', { externalId: 't-1' }), fake.host)).rejects.toThrow('provider_capability_unsupported:ticket.delete');
    expect(await adapter.invoke(invokeReq('ticket.read', { externalId: 't-1' }), fake.host)).toEqual({ ticket: ticketOf() });
  });

  it('every request goes to the Asana API through host.fetch with no credential of its own', async () => {
    const fake = writable(task());
    await adapter.invoke(invokeReq('ticket.transition', { externalId: 't-1', toCategory: 'done' }), fake.host);
    await adapter.invoke(invokeReq('ticket.comment', { externalId: 't-1', text: 'On it.' }), fake.host);
    for (const call of fake.calls) {
      const headers = Object.fromEntries(Object.entries(call.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      expect(headers.authorization).toBeUndefined();
      expect(headers.accept).toBe('application/json');
      expect(headers['content-type']).toBe(call.body === undefined ? undefined : 'application/json');
    }
  });
});

describe('every field the provider requests exists in Asana\'s OpenAPI document', () => {
  type Schema = { $ref?: string; allOf?: Schema[]; oneOf?: Schema[]; anyOf?: Schema[]; items?: Schema; properties?: Record<string, Schema>; description?: string };
  const schemas = (openapi as unknown as { components: { schemas: Record<string, Schema> } }).components.schemas;
  const deref = (s: Schema | undefined): Schema | undefined => {
    let at = s;
    for (let hops = 0; at?.$ref && hops < 20; hops++) at = schemas[at.$ref.split('/').pop()!];
    return at;
  };
  const propertiesOf = (s: Schema | undefined, out: Record<string, Schema> = {}): Record<string, Schema> => {
    const at = deref(s);
    if (!at) return out;
    for (const part of [...(at.allOf ?? []), ...(at.oneOf ?? []), ...(at.anyOf ?? [])]) propertiesOf(part, out);
    if (at.items) propertiesOf(at.items, out);
    return Object.assign(out, at.properties ?? {});
  };
  /** The schema a dotted opt_fields path reaches from `root`, or undefined when a segment is absent. */
  const resolvePath = (root: string, path: string): Schema | undefined => {
    let at: Schema | undefined = schemas[root];
    for (const segment of path.split('.')) {
      at = propertiesOf(at)[segment];
      if (!at) return undefined;
    }
    return at;
  };
  /** Paths the API serves but the document does not list (see the Task fixture type above). */
  const SPEC_GAPS: Record<string, string> = { 'TaskResponse:created_by.name': 'created_by is documented as "A *user* object" but lists only gid and resource_type' };

  it.each([
    ['TaskResponse', 'task'],
    ['StoryResponse', 'story'],
    ['EventResponse', 'event'],
    ['SectionCompact', 'section'],
  ])('%s serves every %s opt_field', (root, kind) => {
    const fields = String(internal.fields[kind]).split(',');
    expect(fields.length).toBeGreaterThan(0);
    const missing = fields.filter((field) => !resolvePath(root, field) && !SPEC_GAPS[`${root}:${field}`]);
    expect(missing).toEqual([]);
  });

  it('the resolver is not vacuous, and each recorded spec gap is still a gap', () => {
    expect(resolvePath('TaskResponse', 'memberships.section.name')).toBeDefined();
    expect(resolvePath('TaskResponse', 'memberships.section.colour')).toBeUndefined();
    expect(resolvePath('TaskResponse', 'nonexistent_field')).toBeUndefined();
    for (const key of Object.keys(SPEC_GAPS)) {
      const [root, path] = key.split(':');
      expect(resolvePath(root, path)).toBeUndefined();
      const parent = resolvePath(root, path.split('.').slice(0, -1).join('.'));
      expect(parent?.description).toMatch(/\*user\* object/);
    }
  });
});
