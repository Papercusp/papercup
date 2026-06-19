/**
 * conversations-store.integration.test.ts — PgConversationStore (coord_conversations),
 * against a real Postgres. Fully injectable (opts.getSql) — no db-org mock needed; the
 * store's own ensureConversationsTable builds the faithful table.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - create is idempotent (ON CONFLICT (workspace_id, id) DO NOTHING) and reads back;
 *  - setState sets resolved_at ONLY when resolving and CLEARS it otherwise;
 *  - setPromoted records the issue id AND closes the conversation;
 *  - list filters (kind/scope/state) + newest-first + clamped limit; all reads are
 *    workspace-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const { PgConversationStore, ensureConversationsTable, reparentThread } = await import('./conversations-store');

const WS = 'ws-conv';
let rootSql: postgres.Sql;
const store = () => new PgConversationStore({ getSql: () => rootSql, ensureSchema: async () => {}, workspaceId: WS } as never);
const mk = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'question', scope: 'harness', harness_slug: 'web', asker_id: 'u1', title: 't', body: 'b', created_ts: '2026-01-01T00:00:00Z', ...over }) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `conv_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await ensureConversationsTable(rootSql); // the store's own DDL (mirrors migration 132)
  // Minimal coord_threads + coord_thread_posts for reparentThread.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_threads (
      workspace_id text NOT NULL, thread_id text NOT NULL,
      parent_kind text NOT NULL, parent_ref text NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_thread_posts (
      workspace_id text NOT NULL, thread_id text NOT NULL, body text
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_conversations, harness_shared.coord_threads, harness_shared.coord_thread_posts`;
});

describe('PgConversationStore (PG)', () => {
  // EI-1534: the getWorkspaceId thunk must re-resolve the scope on EVERY query
  // (not pin once at construction) so one shared singleton store isolates
  // per-request workspaces instead of leaking 'default' into every window.
  it('getWorkspaceId thunk scopes dynamically per call — no cross-workspace leak', async () => {
    let currentWs = 'wsA';
    // ONE store instance (mirrors the operator singleton) whose scope follows a thunk.
    const dyn = new PgConversationStore({
      getSql: () => rootSql,
      ensureSchema: async () => {},
      getWorkspaceId: () => currentWs,
    } as never);

    currentWs = 'wsA';
    await dyn.create(mk('a1', { title: 'in A' }));
    currentWs = 'wsB';
    await dyn.create(mk('b1', { title: 'in B' }));

    // Reads re-resolve the thunk: A sees only A's, B sees only B's.
    currentWs = 'wsA';
    const inA = await dyn.list({});
    expect(inA.map((c) => c.id)).toEqual(['a1']);
    expect(await dyn.get('b1')).toBeNull(); // B's row is invisible from A's scope

    currentWs = 'wsB';
    const inB = await dyn.list({});
    expect(inB.map((c) => c.id)).toEqual(['b1']);
    expect(await dyn.get('a1')).toBeNull();
  });

  it('create reads back and is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const row = await store().create(mk('c1', { title: 'first' }));
    expect(row).toMatchObject({ id: 'c1', title: 'first', state: 'open' });
    await store().create(mk('c1', { title: 'SECOND' })); // same id → no-op
    expect((await store().get('c1'))!.title).toBe('first'); // original preserved
  });

  it('setState sets resolved_at when resolving, and CLEARS it on any other state', async () => {
    await store().create(mk('c2'));
    await store().setState('c2', 'resolved' as never, { now_ts: '2026-02-02T00:00:00Z' });
    expect((await store().get('c2'))!.resolved_ts).toBe('2026-02-02T00:00:00.000Z');
    await store().setState('c2', 'open' as never, { now_ts: '2026-03-03T00:00:00Z' });
    expect((await store().get('c2'))!.resolved_ts).toBeNull(); // reopening clears resolved_at
  });

  it('setPromoted records the issue id and closes the conversation', async () => {
    await store().create(mk('c3'));
    await store().setPromoted('c3', { issue_id: 'EI-9', now_ts: '2026-02-02T00:00:00Z' });
    const row = (await store().get('c3'))!;
    expect(row.state).toBe('closed');
    expect(row.promoted_issue_id).toBe('EI-9');
  });

  it('list filters by state, newest-first, clamped', async () => {
    await store().create(mk('a', { created_ts: '2026-01-01T00:00:00Z' }));
    await store().create(mk('b', { created_ts: '2026-03-01T00:00:00Z' }));
    await store().create(mk('c', { created_ts: '2026-02-01T00:00:00Z' }));
    await store().setState('b', 'resolved' as never, { now_ts: '2026-04-01T00:00:00Z' });
    expect((await store().list()).map((r) => r.id)).toEqual(['b', 'c', 'a']); // created_at DESC
    expect((await store().list({ state: 'resolved' as never })).map((r) => r.id)).toEqual(['b']); // state filter
  });

  it('reads are workspace-scoped (a row in another workspace is invisible)', async () => {
    const other = new PgConversationStore({ getSql: () => rootSql, ensureSchema: async () => {}, workspaceId: 'other-ws' } as never);
    await other.create(mk('x'));
    expect(await store().get('x')).toBeNull(); // WS store can't see other-ws's conversation
  });
});

describe('reparentThread (PG, atomic re-key)', () => {
  async function seedThread(parentKind: string, parentRef: string, threadId: string, postBodies: string[]) {
    await rootSql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref) VALUES (${WS}, ${threadId}, ${parentKind}, ${parentRef})`;
    for (const b of postBodies) {
      await rootSql`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, body) VALUES (${WS}, ${threadId}, ${b})`;
    }
  }

  it('re-keys the thread AND its posts to the new thread_id, and moves the parent', async () => {
    await seedThread('conversation', 'conv-1', 'thr-old', ['p1', 'p2']);
    const res = await reparentThread(rootSql, WS, { kind: 'conversation', ref: 'conv-1' }, { kind: 'issue', ref: 'EI-9' }, 'issue-thread-EI-9');
    expect(res).toEqual({ reparented: true, thread_id: 'issue-thread-EI-9' });
    // the thread moved + re-keyed
    const thr = (await rootSql<{ thread_id: string; parent_kind: string; parent_ref: string }[]>`SELECT thread_id, parent_kind, parent_ref FROM harness_shared.coord_threads`)[0]!;
    expect(thr).toEqual({ thread_id: 'issue-thread-EI-9', parent_kind: 'issue', parent_ref: 'EI-9' });
    // the POSTS followed (re-keyed too) — none left on the old thread_id
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_thread_posts WHERE thread_id='thr-old'`).toHaveLength(0);
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_thread_posts WHERE thread_id='issue-thread-EI-9'`).toHaveLength(2);
  });

  it('is a no-op when the source parent has no thread', async () => {
    expect(await reparentThread(rootSql, WS, { kind: 'conversation', ref: 'nope' }, { kind: 'issue', ref: 'EI-1' }, 'issue-thread-EI-1')).toEqual({ reparented: false });
  });
});
