/**
 * work_items terminal attribution — REAL-PG guard for migration 726 (WI-7057).
 *
 * WHAT THIS CLASS OF BUG LOOKS LIKE. A federated op from a peer that never
 * learned an item's completion attribution carries terminal_owner /
 * terminal_completion_ref / authority / terminal_reason as NULL. The hyperbee
 * projection's upsert assigned all four unconditionally from EXCLUDED, so once
 * such an op won the LWW guard it NULLED a populated LOCAL completion record.
 * Measured live 2026-08-02: 306 local rows lost their completion attribution
 * while keeping payload._completionEvidence, which is the only reason the loss
 * was provable at all.
 *
 * WHY REAL PG. The behaviour lives entirely in a BEFORE trigger, and the
 * regression it guards arrives through an `ON CONFLICT ... DO UPDATE`. Neither
 * is observable from a mocked writer — a mock proves the projection was ASKED
 * to write NULLs, which is exactly what it should still be allowed to do; the
 * only question that matters is what Postgres KEPT. Same reasoning as the
 * sibling migration-698 guard in work-items-closed-ts.integration.test.ts.
 *
 * WHAT IT PINS
 *   1. the rule — a NULL never clears a populated triple while the row stays
 *      terminal;
 *   2. THE POSITIVE CONTROL — an incoming non-NULL still WINS. Without this,
 *      the trigger could be freezing attribution permanently (breaking genuine
 *      re-completion and the fed_apply_wins LWW resolution) and every
 *      preservation assertion below would still pass. This is the assertion
 *      that distinguishes "preserve" from "freeze";
 *   3. reopen semantics — terminal -> non-terminal DOES clear, because a stale
 *      completer on a reopened item is worse than an absent one;
 *   4. THE REGRESSION REPRODUCTION — the real projection's upsert shape
 *      (ON CONFLICT DO UPDATE SET ... = EXCLUDED.*), not just a hand-written
 *      UPDATE. The bug arrived through that statement, so the guard has to
 *      exercise it; a test that only issues plain UPDATEs would have passed
 *      against the broken code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const WS = 'ws-terminal-attribution';
const SLUG = 'papercusp';

/**
 * The CANONICAL live-shape fixture (test/_work-items-schema.ts), not a hand-rolled
 * table. That module exists precisely because ~36 integration tests each rolled
 * their own `work_items` DDL and drifted from the migrations one column at a time;
 * reusing it means this guard cannot rot the same way. It provisions the table,
 * both family views, and the engineer_issues INSTEAD OF trigger.
 */
const BASE_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

describe('work_items terminal attribution preservation (migration 726)', () => {
  let db: FreshPgDb;
  let sql: FreshPgDb['sql'];

  beforeAll(async () => {
    db = await createFreshPgDb('termattr');
    sql = db.sql;
    await sql.unsafe(BASE_DDL);
    await applyMigrationsForTest(
      sql,
      [
        '698-work-items-closed-ts.sql',
        '721-work-items-lane-generated-column.sql',
        '725-payload-object-shape-guard-and-plan-item-stamp-index.sql',
        '726-preserve-terminal-attribution-on-federated-write.sql',
      ],
      { label: 'work-items-terminal-attribution' },
    );
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** Seed an item already carrying a complete, populated completion record. */
  async function seedCompleted(id: string, status = 'done') {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts,
         terminal_owner, terminal_completion_ref, authority, terminal_reason)
      VALUES (${WS}, ${SLUG}, ${id}, 'bug', ${status}, ${'t-' + id}, ${Date.now()}, ${Date.now()},
              'su-original-completer', 'ref-original', 'committed', 'resolved')`;
    return id;
  }

  async function read(id: string) {
    const [row] = await sql<
      {
        status: string;
        title: string | null;
        terminal_owner: string | null;
        terminal_completion_ref: string | null;
        authority: string | null;
        terminal_reason: string | null;
        updated_ts: number | null;
      }[]
    >`
      SELECT status, title, terminal_owner, terminal_completion_ref, authority, terminal_reason, updated_ts
        FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG} AND feature_id = ${id}`;
    return row;
  }

  // -------------------------------------------------------------------------
  // 1. The rule.
  // -------------------------------------------------------------------------
  it('does NOT clear a populated completion record when a write carries NULLs and the row stays terminal', async () => {
    await seedCompleted('wi-preserve');
    await sql`
      UPDATE harness_shared.work_items
         SET terminal_owner = NULL, terminal_completion_ref = NULL,
             authority = NULL, terminal_reason = NULL, updated_ts = ${Date.now()}
       WHERE harness_slug = ${SLUG} AND feature_id = 'wi-preserve'`;

    const row = await read('wi-preserve');
    expect(row.terminal_owner).toBe('su-original-completer');
    expect(row.terminal_completion_ref).toBe('ref-original');
    expect(row.authority).toBe('committed');
    expect(row.terminal_reason).toBe('resolved');
  });

  it('preserves across every terminal -> terminal transition, not just done -> done', async () => {
    for (const [from, to] of [
      ['done', 'resolved'],
      ['resolved', 'closed'],
      ['closed', 'dropped'],
      ['dropped', 'deprecated'],
    ] as const) {
      const id = `wi-t-${from}-${to}`;
      await seedCompleted(id, from);
      await sql`
        UPDATE harness_shared.work_items
           SET status = ${to}, terminal_owner = NULL, terminal_completion_ref = NULL, authority = NULL
         WHERE harness_slug = ${SLUG} AND feature_id = ${id}`;
      const row = await read(id);
      expect(row.status).toBe(to);
      expect(row.terminal_owner, `${from} -> ${to} lost terminal_owner`).toBe('su-original-completer');
      expect(row.authority, `${from} -> ${to} lost authority`).toBe('committed');
    }
  });

  // -------------------------------------------------------------------------
  // 2. THE POSITIVE CONTROL — preserve, not freeze.
  //
  // Every assertion above passes just as happily against a trigger that pins
  // these columns permanently. That would silently break genuine re-completion
  // AND the fed_apply_wins LWW resolution, which decides populated-vs-populated
  // conflicts and must remain untouched. This is the only test that can tell
  // the two implementations apart.
  // -------------------------------------------------------------------------
  it('lets an incoming NON-NULL attribution win — the trigger preserves, it does not freeze', async () => {
    await seedCompleted('wi-overwrite');
    await sql`
      UPDATE harness_shared.work_items
         SET terminal_owner = 'su-new-completer', terminal_completion_ref = 'ref-new',
             authority = 'proposed', terminal_reason = 'done'
       WHERE harness_slug = ${SLUG} AND feature_id = 'wi-overwrite'`;

    const row = await read('wi-overwrite');
    expect(row.terminal_owner).toBe('su-new-completer');
    expect(row.terminal_completion_ref).toBe('ref-new');
    expect(row.authority).toBe('proposed');
    expect(row.terminal_reason).toBe('done');
  });

  it('preserves each column INDEPENDENTLY — a partial op keeps only what it omits', async () => {
    await seedCompleted('wi-partial');
    // Carries an owner but no ref/authority: the owner must win, the other two
    // must survive. A blanket all-or-nothing guard would fail this.
    await sql`
      UPDATE harness_shared.work_items
         SET terminal_owner = 'su-new-completer', terminal_completion_ref = NULL, authority = NULL
       WHERE harness_slug = ${SLUG} AND feature_id = 'wi-partial'`;

    const row = await read('wi-partial');
    expect(row.terminal_owner).toBe('su-new-completer');
    expect(row.terminal_completion_ref).toBe('ref-original');
    expect(row.authority).toBe('committed');
  });

  // -------------------------------------------------------------------------
  // 3. Reopen still clears.
  // -------------------------------------------------------------------------
  it('DOES clear the completion record on a genuine reopen (terminal -> non-terminal)', async () => {
    await seedCompleted('wi-reopen');
    await sql`
      UPDATE harness_shared.work_items
         SET status = 'open', terminal_owner = NULL, terminal_completion_ref = NULL,
             authority = NULL, terminal_reason = NULL
       WHERE harness_slug = ${SLUG} AND feature_id = 'wi-reopen'`;

    const row = await read('wi-reopen');
    expect(row.status).toBe('open');
    expect(row.terminal_owner).toBeNull();
    expect(row.terminal_completion_ref).toBeNull();
    expect(row.authority).toBeNull();
    expect(row.terminal_reason).toBeNull();
  });

  it('leaves a non-terminal -> non-terminal write completely alone', async () => {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts)
      VALUES (${WS}, ${SLUG}, 'wi-open', 'bug', 'open', 't', ${Date.now()}, ${Date.now()})`;
    await sql`
      UPDATE harness_shared.work_items SET status = 'in_progress'
       WHERE harness_slug = ${SLUG} AND feature_id = 'wi-open'`;

    const row = await read('wi-open');
    expect(row.status).toBe('in_progress');
    expect(row.terminal_owner).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. THE REGRESSION REPRODUCTION.
  //
  // This is the statement that actually caused WI-7057: the hyperbee
  // projection's upsert (applyEngineerIssueOp, sync/hyperbee/projections/
  // engineer-issues.ts), which assigns all four columns from EXCLUDED
  // unconditionally. Reproducing the real shape matters — a BEFORE UPDATE
  // trigger firing on the DO UPDATE branch of an upsert is precisely the
  // interaction under test, and a guard built only from plain UPDATEs would
  // never have exercised it.
  // -------------------------------------------------------------------------
  it('survives the real federated upsert: ON CONFLICT DO UPDATE SET ... = EXCLUDED.* carrying NULLs', async () => {
    await seedCompleted('wi-fed');

    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts,
         terminal_owner, terminal_completion_ref, authority, terminal_reason)
      VALUES (${WS}, ${SLUG}, 'wi-fed', 'bug', 'done', 'peer-copy', ${Date.now()}, ${Date.now()},
              NULL, NULL, NULL, NULL)
      ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
        title                   = EXCLUDED.title,
        status                  = EXCLUDED.status,
        updated_ts              = EXCLUDED.updated_ts,
        terminal_owner          = EXCLUDED.terminal_owner,
        terminal_completion_ref = EXCLUDED.terminal_completion_ref,
        terminal_reason         = EXCLUDED.terminal_reason,
        authority               = EXCLUDED.authority`;

    const row = await read('wi-fed');
    // The peer's op still lands everything it legitimately carries. `title` is
    // the load-bearing assertion: the seeded row was 't-wi-fed' and the peer op
    // carries 'peer-copy', so this is what proves the statement actually took the
    // DO UPDATE branch. Without it, an upsert that silently no-opped would make
    // every preservation assertion below vacuously true.
    expect(row.title).toBe('peer-copy');
    expect(row.status).toBe('done');
    // ...but it must NOT have destroyed the local completion record.
    expect(row.terminal_owner).toBe('su-original-completer');
    expect(row.terminal_completion_ref).toBe('ref-original');
    expect(row.authority).toBe('committed');
    expect(row.terminal_reason).toBe('resolved');
  });
});
