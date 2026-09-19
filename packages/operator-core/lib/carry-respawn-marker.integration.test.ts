/**
 * carry-respawn-marker.integration.test.ts — the respawn-expected marker against
 * a REAL fully-migrated Postgres (migration 716).
 *
 * WHY THIS FILE EXISTS AT ALL, given carry-respawn-marker.test.ts already passes:
 * the bug this table was created to fix (WI-6756 follow-on) was invisible to unit
 * tests BY CONSTRUCTION. The original marker kept its state in a module-scoped
 * `Map` and had a full, green unit suite — single-use, TTL, per-owner isolation,
 * all correct. It still lost su-e02f5c3d's three work-item claims live on
 * 2026-08-02, because the operator is CLUSTERED: `session:request-compaction`
 * marked one :3070 worker's heap and the dying child's SessionEnd hook
 * round-robined to a different worker, which saw nothing and released
 * everything. A test that shares one process with the code under test cannot
 * observe that class of failure — only a shared durable substrate can.
 *
 * ⚠ BE PRECISE ABOUT WHAT DISCRIMINATES, or this file grows a false green. These
 * tests all run in ONE process, so the two-independent-connections case below
 * does NOT by itself rule out an in-memory implementation — a shared module-level
 * Map would satisfy it trivially. The assertion that actually distinguishes
 * durable from in-memory is the DIRECT TABLE READ (`rowCount`, issued on
 * `db.adminSql` rather than through the module): a marker that never writes a row
 * fails it, and no amount of in-process cleverness can fake it. The
 * two-connection tests prove the weaker but still necessary property that the
 * mark is CONNECTION-INDEPENDENT and that concurrent consumers cannot both win.
 * Genuine cross-PROCESS behavior is not testable here at all; it follows from the
 * state living in Postgres, which is exactly what `rowCount` pins down.
 *
 * The rest re-proves the semantics the unit suite covers, but against the real
 * SQL (make_interval arithmetic, the ON CONFLICT refresh, DELETE … RETURNING),
 * because a hand-rolled fake `sql` can only ever confirm the logic wrapped around
 * a statement, never the statement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { RESPAWN_EXPECTED_TTL_MS, consumeRespawnExpected, markRespawnExpected } = await import(
  './carry-respawn-marker'
);
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
  await sql`DELETE FROM harness_shared.session_respawn_expected`;
  await sql`DELETE FROM harness_shared.coord_presence WHERE owner_id = 'su-respawn-identity'`;
});

/**
 * A SEPARATE connection to the same database — the stand-in for a second :3070
 * cluster worker. It must be a genuinely independent client, not `db.adminSql`
 * again: sharing a client would re-create the very same-process assumption
 * whose falseness is what this file exists to prove.
 */
function otherWorker(): Sql {
  return postgres(db.adminDsn, {
    max: 1,
    onnotice: () => {},
    prepare: false,
    connection: { search_path: 'harness_shared, public' },
  });
}

async function rowCount(ownerId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.session_respawn_expected WHERE owner_id = ${ownerId}`;
  return Number(row?.n ?? 0);
}

describe('carry-respawn marker — real Postgres (migration 716)', () => {
  it('clears the predecessor identity and context estimate in the same durable mark statement', async () => {
    await sql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, heartbeat_at, host, pid, tty, context_tokens, context_estimated_at)
      VALUES
        ('su-respawn-identity', now(), 'old-host', 4051146, '/dev/pts/9', 380000, now())`;

    await markRespawnExpected('su-respawn-identity', RESPAWN_EXPECTED_TTL_MS, { sql });

    const [presence] = await sql<{
      host: string;
      pid: number | null;
      tty: string | null;
      context_tokens: number | null;
      context_estimated_at: Date | null;
    }[]>`
      SELECT host, pid, tty, context_tokens, context_estimated_at
        FROM harness_shared.coord_presence
       WHERE owner_id = 'su-respawn-identity'`;
    expect(presence).toMatchObject({
      host: '',
      pid: null,
      tty: null,
      context_tokens: null,
      context_estimated_at: null,
    });
    expect(await rowCount('su-respawn-identity')).toBe(1);
  });

  it('a mark written by one connection is visible to a DIFFERENT one (connection-independence — the clustered-worker shape)', async () => {
    // Two independent connections stand in for two cluster workers: the writer
    // handled session:request-compaction, the reader is whichever worker the
    // round-robin handed the dying child's SessionEnd hook to. See the file
    // header on what this does and does NOT discriminate — the durability
    // proof is the direct table read in the `rowCount` test below.
    const writerWorker = db.adminSql;
    const readerWorker = otherWorker();
    try {
      await markRespawnExpected('su-clustered', RESPAWN_EXPECTED_TTL_MS, { sql: writerWorker });
      expect(await consumeRespawnExpected('su-clustered', { sql: readerWorker })).toBe(true);
    } finally {
      await readerWorker.end();
    }
  });

  it('a mark is consumed by exactly ONE of two concurrent readers (DELETE … RETURNING is atomic)', async () => {
    await markRespawnExpected('su-race', RESPAWN_EXPECTED_TTL_MS, { sql });
    const second = otherWorker();
    try {
      const [a, b] = await Promise.all([
        consumeRespawnExpected('su-race', { sql }),
        consumeRespawnExpected('su-race', { sql: second }),
      ]);
      // Exactly one wins: a double-suppress would let a genuine death keep its
      // claims, and a double-miss would strip a live successor's.
      expect([a, b].filter(Boolean)).toHaveLength(1);
    } finally {
      await second.end();
    }
  });

  it('an unmarked owner is never treated as respawn-expected', async () => {
    expect(await consumeRespawnExpected('su-never-marked', { sql })).toBe(false);
  });

  it('marking then consuming returns true, and the row is gone afterwards', async () => {
    await markRespawnExpected('su-a', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await rowCount('su-a')).toBe(1);
    expect(await consumeRespawnExpected('su-a', { sql })).toBe(true);
    expect(await rowCount('su-a')).toBe(0);
  });

  it('consuming is SINGLE-USE — a second SessionEnd for the same owner is not suppressed', async () => {
    await markRespawnExpected('su-b', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('su-b', { sql })).toBe(true);
    expect(await consumeRespawnExpected('su-b', { sql })).toBe(false);
  });

  it('marks are scoped per-owner', async () => {
    await markRespawnExpected('su-c', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('su-d', { sql })).toBe(false);
    expect(await consumeRespawnExpected('su-c', { sql })).toBe(true);
  });

  it('an EXPIRED mark reports false AND is cleared (a respawn that never landed falls to the P-001 backstop)', async () => {
    // Negative TTL ⇒ already expired at insert, so this asserts real
    // make_interval arithmetic rather than a sleep.
    await markRespawnExpected('su-stale', -5_000, { sql });
    expect(await rowCount('su-stale')).toBe(1);
    expect(await consumeRespawnExpected('su-stale', { sql })).toBe(false);
    expect(await rowCount('su-stale')).toBe(0);
  });

  it('re-marking before consumption refreshes the expiry rather than inserting a duplicate (ON CONFLICT)', async () => {
    await markRespawnExpected('su-g', 1_000, { sql });
    await markRespawnExpected('su-g', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await rowCount('su-g')).toBe(1);
    expect(await consumeRespawnExpected('su-g', { sql })).toBe(true);
  });

  it('a blank ownerId never writes a row', async () => {
    await markRespawnExpected('   ', RESPAWN_EXPECTED_TTL_MS, { sql });
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.session_respawn_expected`;
    expect(Number(row?.n ?? 0)).toBe(0);
  });
});
