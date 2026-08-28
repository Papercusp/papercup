/**
 * agent-chat-lock.integration.test.ts — the per-chat streaming lock against a
 * REAL fully-migrated Postgres (migration 740).
 *
 * WHY THIS FILE EXISTS AT ALL, given the route's own unit suite already
 * exercises `acquireAgentChatLock`/`releaseAgentChatLock` through a mock: the
 * bug this table was created to fix (WI-7139) is invisible to unit tests BY
 * CONSTRUCTION. The original lock kept its state in a module-scoped
 * `activeChats` Map — a full, green unit suite could exist for it and still
 * miss the failure, because `:3070` is a 16-worker `node:cluster` release
 * cluster (`operator-3070-is-clustered-no-in-process-state`,
 * session-death-claim-release-2026-07-11#D-001): two POSTs for the same
 * chatId landing on two different workers each see an EMPTY local Map. A test
 * that shares one process with the code under test cannot observe that class
 * of failure — only a shared durable substrate can.
 *
 * ⚠ BE PRECISE ABOUT WHAT DISCRIMINATES, or this file grows a false green.
 * These tests all run in ONE process, so the two-independent-connections
 * cases below do NOT by themselves rule out an in-memory implementation — a
 * shared module-level Map would satisfy them trivially. The assertion that
 * actually distinguishes durable from in-memory is the DIRECT TABLE READ
 * (`rowCount`, issued on `db.adminSql` rather than through the module): a
 * lock that never writes a row fails it, and no amount of in-process
 * cleverness can fake it. The two-connection tests prove the weaker but still
 * necessary property that the lock is CONNECTION-INDEPENDENT and that
 * concurrent acquirers cannot both win. Genuine cross-PROCESS behavior is not
 * testable here at all; it follows from the state living in Postgres, which
 * is exactly what `rowCount` pins down.
 *
 * This lock's shape differs from carry-respawn-marker.ts (its sibling in the
 * same bug class, migration 716) on purpose: that marker is written once and
 * consumed (deleted) near-instantly. This lock is HELD across a whole
 * streaming turn, so acquire is a "steal-if-stale" upsert rather than a bare
 * INSERT-or-fail, and release is TOKEN-scoped so a holder whose lock was
 * legitimately stolen for staleness can never delete the new holder's row out
 * from under it. The tests below cover exactly those two differences in
 * addition to re-proving the base acquire/release semantics against the real
 * SQL (the ON CONFLICT ... WHERE <stale> upsert, make_interval arithmetic,
 * the token-scoped DELETE) — a hand-rolled fake `sql` can only ever confirm
 * the logic wrapped around a statement, never the statement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { AGENT_CHAT_LOCK_TTL_MS, acquireAgentChatLock, releaseAgentChatLock, isAgentChatLocked } =
  await import('./agent-chat-lock');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_chat_locks`;
});

/**
 * A SEPARATE connection to the same database — the stand-in for a second
 * :3070 cluster worker. Must be a genuinely independent client, not
 * `db.adminSql` again: sharing a client would re-create the very
 * same-process assumption whose falseness this file exists to prove.
 */
function otherWorker(): Sql {
  return postgres(db.adminDsn, {
    max: 1,
    onnotice: () => {},
    prepare: false,
    connection: { search_path: 'harness_shared, public' },
  });
}

async function rowCount(chatId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.agent_chat_locks WHERE chat_id = ${chatId}`;
  return Number(row?.n ?? 0);
}

async function tokenOf(chatId: string): Promise<string | null> {
  const [row] = await sql<{ token: string }[]>`
    SELECT token FROM harness_shared.agent_chat_locks WHERE chat_id = ${chatId}`;
  return row?.token ?? null;
}

describe('agent-chat-lock — real Postgres (migration 740)', () => {
  it('a lock acquired by one connection is VISIBLE to a DIFFERENT one (connection-independence — the clustered-worker shape)', async () => {
    // Two independent connections stand in for two cluster workers: the
    // writer is the worker that got the first POST, the reader is whichever
    // worker the round-robin hands the SECOND POST to. See the file header on
    // what this does and does NOT discriminate — the durability proof is the
    // direct table read in the `rowCount` test below.
    const writerWorker = db.adminSql;
    const readerWorker = otherWorker();
    try {
      const handle = await acquireAgentChatLock('chat-clustered', 'ws-1', { sql: writerWorker });
      expect(handle).not.toBeNull();
      // The second worker must see the lock as held — a module-scoped Map on
      // the writer's process would leave the reader's local state empty and
      // wrongly grant a second acquire here.
      expect(await acquireAgentChatLock('chat-clustered', 'ws-1', { sql: readerWorker })).toBeNull();
      expect(await isAgentChatLocked('chat-clustered', { sql: readerWorker })).toBe(true);
    } finally {
      await readerWorker.end();
    }
  });

  it('at most ONE of two concurrent acquirers for the same chat wins (ON CONFLICT ... WHERE <stale> is atomic)', async () => {
    const second = otherWorker();
    try {
      const [a, b] = await Promise.all([
        acquireAgentChatLock('chat-race', 'ws-1', { sql }),
        acquireAgentChatLock('chat-race', 'ws-1', { sql: second }),
      ]);
      // Exactly one wins: a double-grant would let two workers both spawn an
      // agent turn for the same chat — precisely the WI-7139 bug.
      expect([a, b].filter((h) => h !== null)).toHaveLength(1);
      expect(await rowCount('chat-race')).toBe(1);
    } finally {
      await second.end();
    }
  });

  it('acquiring then releasing removes the row, and a fresh acquire succeeds afterwards', async () => {
    const handle = await acquireAgentChatLock('chat-a', 'ws-1', { sql });
    expect(handle).not.toBeNull();
    expect(await rowCount('chat-a')).toBe(1);
    await releaseAgentChatLock(handle, { sql });
    expect(await rowCount('chat-a')).toBe(0);
    expect(await acquireAgentChatLock('chat-a', 'ws-1', { sql })).not.toBeNull();
  });

  it('a LIVE lock cannot be acquired a second time (the 409 case)', async () => {
    expect(await acquireAgentChatLock('chat-b', 'ws-1', { sql })).not.toBeNull();
    expect(await acquireAgentChatLock('chat-b', 'ws-1', { sql })).toBeNull();
    expect(await rowCount('chat-b')).toBe(1);
  });

  it('a bounded post-cancel waiter acquires only after the prior token-scoped release', async () => {
    const first = await acquireAgentChatLock('chat-cancelled-retry', 'ws-1', { sql });
    expect(first).not.toBeNull();

    const waiting = acquireAgentChatLock('chat-cancelled-retry', 'ws-1', {
      sql,
      waitMs: 1_000,
      retryMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await rowCount('chat-cancelled-retry')).toBe(1);
    await releaseAgentChatLock(first, { sql });

    const second = await waiting;
    expect(second).not.toBeNull();
    expect(second?.token).not.toBe(first?.token);
    expect(await tokenOf('chat-cancelled-retry')).toBe(second?.token);
  });

  /**
   * `ttlMs` on acquire/isLocked is the STALENESS THRESHOLD applied to an
   * EXISTING row at check time — it does not backdate the row this call
   * itself writes (that's always `now()`). So to set up a genuinely stale
   * lock deterministically (no reliance on wall-clock race on a shared,
   * possibly-loaded box), seed the row directly via SQL with an old
   * `started_at`, bypassing the module — exactly the "crashed holder, never
   * reached its `finally`" scenario this steal-if-stale upsert exists for.
   */
  async function seedStaleLock(chatId: string, token: string, ageMs: number): Promise<void> {
    await sql`
      INSERT INTO harness_shared.agent_chat_locks (chat_id, workspace_id, token, started_at)
      VALUES (${chatId}, 'ws-1', ${token}, now() - make_interval(secs => ${Math.round(ageMs / 1000)}))`;
  }

  it('a STALE lock (older than the TTL) can be STOLEN by a new acquirer, and the row gets a NEW token', async () => {
    await seedStaleLock('chat-stale', 'stale-token', AGENT_CHAT_LOCK_TTL_MS + 60_000);
    expect(await rowCount('chat-stale')).toBe(1);

    const second = await acquireAgentChatLock('chat-stale', 'ws-1', { sql, ttlMs: AGENT_CHAT_LOCK_TTL_MS });
    expect(second).not.toBeNull();
    expect(second?.token).not.toBe('stale-token');
    // The steal is an UPDATE, not a new row — exactly one row survives.
    expect(await rowCount('chat-stale')).toBe(1);
    expect(await tokenOf('chat-stale')).toBe(second?.token);
  });

  it('a lock younger than the TTL CANNOT be stolen (only genuinely stale locks yield)', async () => {
    const first = await acquireAgentChatLock('chat-fresh', 'ws-1', { sql });
    expect(first).not.toBeNull();
    expect(await acquireAgentChatLock('chat-fresh', 'ws-1', { sql, ttlMs: AGENT_CHAT_LOCK_TTL_MS })).toBeNull();
    expect(await tokenOf('chat-fresh')).toBe(first?.token);
  });

  it("releasing a STOLEN (superseded) handle is a NO-OP — it must never delete the new holder's row", async () => {
    // This is the failure mode token-scoping exists to prevent: worker A's
    // original `finally` release runs AFTER its lock was stolen for
    // staleness and must not clobber worker B's live lock.
    await seedStaleLock('chat-steal', 'original-token', AGENT_CHAT_LOCK_TTL_MS + 60_000);
    const original = { chatId: 'chat-steal', token: 'original-token' };
    const newHolder = await acquireAgentChatLock('chat-steal', 'ws-1', { sql, ttlMs: AGENT_CHAT_LOCK_TTL_MS });
    expect(newHolder).not.toBeNull();
    expect(newHolder?.token).not.toBe('original-token');

    // Worker A's stale handle, releasing late (its `finally` finally runs).
    await releaseAgentChatLock(original, { sql });

    // The new holder's row must still be there, untouched.
    expect(await rowCount('chat-steal')).toBe(1);
    expect(await tokenOf('chat-steal')).toBe(newHolder?.token);
  });

  it('isAgentChatLocked reports false once the lock has expired past its TTL, even without an explicit release', async () => {
    await seedStaleLock('chat-ttl-read', 'old-token', AGENT_CHAT_LOCK_TTL_MS + 60_000);
    expect(await rowCount('chat-ttl-read')).toBe(1); // the row is still there —
    expect(await isAgentChatLocked('chat-ttl-read', { sql, ttlMs: AGENT_CHAT_LOCK_TTL_MS })).toBe(false); // but read as not-live
  });

  it('locks are scoped per-chat', async () => {
    expect(await acquireAgentChatLock('chat-c', 'ws-1', { sql })).not.toBeNull();
    expect(await acquireAgentChatLock('chat-d', 'ws-1', { sql })).not.toBeNull();
    expect(await rowCount('chat-c')).toBe(1);
    expect(await rowCount('chat-d')).toBe(1);
  });

  it('a blank chatId never writes a row', async () => {
    expect(await acquireAgentChatLock('   ', 'ws-1', { sql })).toBeNull();
    const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM harness_shared.agent_chat_locks`;
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it('releasing a handle whose token no longer matches the live row is a no-op that leaves the live row intact', async () => {
    const handle = await acquireAgentChatLock('chat-e', 'ws-1', { sql });
    expect(handle).not.toBeNull();
    await releaseAgentChatLock({ chatId: 'chat-e', token: 'not-the-real-token' }, { sql });
    expect(await rowCount('chat-e')).toBe(1);
    expect(await tokenOf('chat-e')).toBe(handle?.token);
  });
});
