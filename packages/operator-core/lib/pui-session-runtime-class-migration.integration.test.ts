/**
 * pui-session-runtime-class-migration.integration.test.ts — migration 1023
 * against a REAL fully-migrated Postgres
 * (pui-su-session-runtime-correction-2026-08-27 P-011 / WI-287136).
 *
 * ## What this proves that a text assertion cannot
 * The sibling unit coverage in `agent-chats-data.test.ts` asserts the WRITER
 * stamps a class and the READER refuses to guess when it is absent. Both run
 * against a mocked client, so both are satisfied by a schema that never gained
 * the column at all. What is left unproven there is everything the migration
 * itself has to get right, and each of these has a plausible failure that looks
 * like success from the outside:
 *
 *   - the column exists on the CONSOLIDATED base table, and the CHECK actually
 *     refuses a third value (a missing constraint reads identically until a bad
 *     writer appears);
 *   - the BACKFILL separates a bound chat from an unbound one, rather than
 *     stamping the whole population one way — the case the plan clause is about;
 *   - the per-harness VIEW exposes the column. This is the one an author is most
 *     likely to miss and least likely to notice: those views are `SELECT *`, but
 *     Postgres freezes their column list at creation, so the base table can gain
 *     the column while every reader that goes through a harness view — which is
 *     every reader in `agent-chats-data.ts` — still cannot see it. The write
 *     would succeed and every read would answer `null`, i.e. "unclassified", and
 *     the cutover would silently never take effect for any conversation.
 *
 * ## Why it re-runs the migration file rather than a copy of its SQL
 * The migration is idempotent, so replaying the real file against an
 * already-migrated database is a no-op for the DDL and touches exactly the rows
 * this test inserts with a NULL class. Copying its UPDATE into the test instead
 * would prove only that the copy works.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

const MIGRATION = readFileSync(
  new URL('../../../libs/papercusp/libs/db/sql/1023-pui-session-runtime-class.sql', import.meta.url),
  'utf8',
);

const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_chats_consolidated WHERE workspace_id = ${WORKSPACE}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WORKSPACE}`;
});

/** Insert a chat row the way a PRE-migration writer did: with no class at all. */
async function insertUnstampedChat(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_chats_consolidated
      (workspace_id, harness_slug, id, role, transcript, created_at, updated_at)
    VALUES (${WORKSPACE}, ${HARNESS}, ${id}, 'operator', '[]'::jsonb,
            ${Date.now()}, ${Date.now()})`;
}

async function classOf(id: string): Promise<string | null> {
  const [row] = await sql<Array<{ su_runtime_class: string | null }>>`
    SELECT su_runtime_class FROM harness_shared.agent_chats_consolidated
     WHERE workspace_id = ${WORKSPACE} AND id = ${id}`;
  return row?.su_runtime_class ?? null;
}

describe('migration 1023 — PUI session runtime classification', () => {
  it('adds the column with a CHECK that refuses a third value', async () => {
    await insertUnstampedChat('chat-check');
    await expect(
      sql`UPDATE harness_shared.agent_chats_consolidated
             SET su_runtime_class = 'something-else'
           WHERE workspace_id = ${WORKSPACE} AND id = 'chat-check'`,
    ).rejects.toThrow();
    // Calibration: the two legal values are accepted, so the rejection above is
    // the CHECK doing its job and not the UPDATE failing for some other reason.
    for (const legal of ['su-session', 'legacy-owned-loop']) {
      await sql`UPDATE harness_shared.agent_chats_consolidated
                   SET su_runtime_class = ${legal}
                 WHERE workspace_id = ${WORKSPACE} AND id = 'chat-check'`;
      expect(await classOf('chat-check')).toBe(legal);
    }
    // NULL stays legal: it is the UNCLASSIFIED reading, not an illegal state.
    await sql`UPDATE harness_shared.agent_chats_consolidated
                 SET su_runtime_class = NULL
               WHERE workspace_id = ${WORKSPACE} AND id = 'chat-check'`;
    expect(await classOf('chat-check')).toBeNull();
  });

  it('backfills a bound chat as su-session and an unbound one as legacy-owned-loop', async () => {
    await insertUnstampedChat('chat-bound');
    await insertUnstampedChat('chat-unbound');
    await sql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, su_agent_chat_id)
      VALUES (${WORKSPACE}, 'chat-bound')`;

    // Both start UNCLASSIFIED, so the assertions below cannot pass on rows that
    // were already stamped before the migration ran.
    expect(await classOf('chat-bound')).toBeNull();
    expect(await classOf('chat-unbound')).toBeNull();

    await sql.unsafe(MIGRATION);

    expect(await classOf('chat-bound')).toBe('su-session');
    expect(await classOf('chat-unbound')).toBe('legacy-owned-loop');
  });

  it('never re-stamps a row that already carries a class', async () => {
    // The backfill is `WHERE su_runtime_class IS NULL`. If that predicate were
    // dropped, a re-run (boot auto-apply replays every migration) would rewrite
    // a conversation's recorded home from its adv_sessions state — turning a
    // deliberate 'legacy-owned-loop' stamp made during a rollback back into
    // 'su-session' and re-homing the conversation. Idempotence is the guard.
    await insertUnstampedChat('chat-rollback');
    await sql`UPDATE harness_shared.agent_chats_consolidated
                 SET su_runtime_class = 'legacy-owned-loop'
               WHERE workspace_id = ${WORKSPACE} AND id = 'chat-rollback'`;
    await sql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, su_agent_chat_id)
      VALUES (${WORKSPACE}, 'chat-rollback')`;

    await sql.unsafe(MIGRATION);

    expect(await classOf('chat-rollback')).toBe('legacy-owned-loop');
  });

  it('exposes the column through the per-harness view every reader goes through', async () => {
    await insertUnstampedChat('chat-view');
    await sql`UPDATE harness_shared.agent_chats_consolidated
                 SET su_runtime_class = 'su-session'
               WHERE workspace_id = ${WORKSPACE} AND id = 'chat-view'`;
    const [row] = await sql<Array<{ su_runtime_class: string | null }>>`
      SELECT su_runtime_class FROM harness_papercusp.agent_chats WHERE id = 'chat-view'`;
    expect(row?.su_runtime_class).toBe('su-session');
  });

  it('keeps the harness view writable with its CHECK OPTION and column defaults', async () => {
    // The view is replaced to widen its column list, and a careless replacement
    // silently drops the ALTER VIEW defaults (transcript/created_at/…) and the
    // WITH CHECK OPTION. Both only show up on a WRITE, which is why this asserts
    // an insert through the view rather than reading catalog metadata.
    await sql`
      INSERT INTO harness_papercusp.agent_chats (id, workspace_id, role)
      VALUES ('chat-through-view', ${WORKSPACE}, 'operator')`;
    const [row] = await sql<
      Array<{ harness_slug: string; transcript: unknown; created_at: string }>
    >`SELECT harness_slug, transcript, created_at
        FROM harness_shared.agent_chats_consolidated WHERE id = 'chat-through-view'`;
    expect(row?.harness_slug).toBe(HARNESS);
    expect(row?.transcript).toEqual([]);
    expect(Number(row?.created_at)).toBeGreaterThan(0);

    // WITH CHECK OPTION: a row that would fall outside the view's own filter is
    // refused rather than being written somewhere the view can never read back.
    await expect(
      sql`INSERT INTO harness_papercusp.agent_chats (id, workspace_id, harness_slug, role)
          VALUES ('chat-wrong-harness', ${WORKSPACE}, 'some-other-harness', 'operator')`,
    ).rejects.toThrow();
  });
});
