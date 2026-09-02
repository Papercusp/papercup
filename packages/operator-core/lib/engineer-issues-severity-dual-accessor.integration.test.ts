/**
 * engineer-issues-severity-dual-accessor.integration.test.ts
 *
 * P-003 of plan silent-wrong-answers-2026-08-01 · WI-6688 · parent WI-6674.
 *
 * THE CLASS: a query that returns a well-formed, plausible, WRONG answer with
 * no signal that it is wrong.
 *
 * Severity had TWO access paths across two relations and the wrong one was
 * silent. On harness_shared.work_items severity lives at
 * `payload->'_ei'->>'severity'`. On the harness_shared.engineer_issues
 * compatibility VIEW the `_ei` blob was exploded into real columns and then
 * SUBTRACTED from payload, so that same accessor resolved to NULL for every
 * row. Both queries were valid, both succeeded, neither warned, and
 *
 *   SELECT count(*) FROM harness_shared.engineer_issues
 *    WHERE payload->'_ei'->>'severity' = 'critical'
 *
 * returned 0 — which reads exactly like "there are no criticals" when there
 * were 50 (measured live 2026-09-02).
 *
 * Migration 1096 removes the divergence by projecting the full payload. This
 * file is the recurrence guard: if anyone re-introduces the subtraction, the
 * first two tests fail.
 *
 * WHY THERE IS A CONTROL VIEW IN HERE
 * A guard that has never failed is a guard nobody has tested. Per the repo's
 * mutation-probe policy, the cheapest tier that fits is a deliberately-wrong
 * implementation kept PERMANENTLY beside the real one — no tree mutation, no
 * sweep race, no restore step. `engineer_issues_subtracting` reproduces the
 * pre-1096 projection, and the control tests assert that the same predicates
 * DO fail against it. Without that, a future refactor could neuter these
 * assertions and they would keep reporting green.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('engineer-issues-severity-dual-accessor');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);

  // The CONTROL: the exact pre-1096 shape (payload minus the _ei blob), over
  // the same base rows. Everything else about it is identical, so a test that
  // passes here and fails there is measuring the projection and nothing else.
  await db.sql.unsafe(`
    CREATE VIEW harness_shared.engineer_issues_subtracting AS
      SELECT workspace_id,
             feature_id AS issue_id,
             COALESCE(payload->'_ei'->>'severity', 'minor') AS severity,
             (payload - '_ei') AS payload
        FROM harness_shared.work_items
       WHERE item_kind = ANY (ARRAY['bug','change','task'])`);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items`;
});

/** One critical + one major + one row whose severity IS the 'minor' default. */
async function seedSeverities() {
  await db.sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, kind, severity)
    VALUES ('default', 'WI-900', 'harness:papercup', 'a critical bug', '', 'open', 'bug', 'critical'),
           ('default', 'WI-901', 'harness:papercup', 'a major bug',    '', 'open', 'bug', 'major'),
           ('default', 'WI-902', 'harness:papercup', 'a minor bug',    '', 'open', 'bug', 'minor')`;
}

describe('engineer_issues severity dual-accessor (migration 1096 / WI-6688)', () => {
  it('the payload accessor and the severity COLUMN return the same answer', async () => {
    await seedSeverities();

    const [row] = await db.sql`
      SELECT count(*) FILTER (WHERE payload->'_ei'->>'severity' = 'critical') AS via_payload,
             count(*) FILTER (WHERE severity = 'critical')                    AS via_column
        FROM harness_shared.engineer_issues`;

    // The bug was via_payload=0 while via_column=1 — a confident "no criticals".
    expect(Number(row.via_payload)).toBe(1);
    expect(Number(row.via_column)).toBe(1);
  });

  it('every base row carrying _ei surfaces it through the view', async () => {
    await seedSeverities();

    const [row] = await db.sql`
      SELECT (SELECT count(*) FROM harness_shared.work_items
               WHERE item_kind = ANY (ARRAY['bug','change','task']) AND payload ? '_ei') AS base_with_ei,
             (SELECT count(*) FROM harness_shared.engineer_issues
               WHERE payload ? '_ei')                                                    AS view_with_ei`;

    expect(Number(row.base_with_ei)).toBe(3);
    expect(Number(row.view_with_ei)).toBe(Number(row.base_with_ei));
  });

  it('a round trip through the view does not corrupt or drop _ei', async () => {
    await seedSeverities();

    // The INSTEAD OF UPDATE trigger strips the caller's _ei and rebuilds it, so
    // reading payload back (now WITH _ei) and writing it again must be a no-op
    // for severity rather than a way to nest _ei inside itself.
    const [before] = await db.sql`
      SELECT payload FROM harness_shared.engineer_issues WHERE issue_id = 'WI-900'`;
    await db.sql`
      UPDATE harness_shared.engineer_issues
         SET payload = ${db.sql.json(before.payload as object)}
       WHERE issue_id = 'WI-900'`;

    const [after] = await db.sql`
      SELECT severity,
             payload->'_ei'->>'severity'          AS via_payload,
             payload->'_ei'->'_ei'->>'severity'   AS nested_ei
        FROM harness_shared.engineer_issues WHERE issue_id = 'WI-900'`;

    expect(after.severity).toBe('critical');
    expect(after.via_payload).toBe('critical');
    expect(after.nested_ei).toBeNull();
  });
});

describe('CONTROL — the same assertions must FAIL against the pre-1096 projection', () => {
  it('the payload accessor returns a confident ZERO when _ei is subtracted', async () => {
    await seedSeverities();

    const [row] = await db.sql`
      SELECT count(*) FILTER (WHERE payload->'_ei'->>'severity' = 'critical') AS via_payload,
             count(*) FILTER (WHERE severity = 'critical')                    AS via_column
        FROM harness_shared.engineer_issues_subtracting`;

    // This IS the bug, reproduced: a well-formed query, a plausible number, and
    // it disagrees with the column beside it.
    expect(Number(row.via_payload)).toBe(0);
    expect(Number(row.via_column)).toBe(1);
  });

  it('_ei reaches zero rows through the subtracting projection', async () => {
    await seedSeverities();

    const [row] = await db.sql`
      SELECT count(*) FROM harness_shared.engineer_issues_subtracting WHERE payload ? '_ei'`;

    expect(Number(row.count)).toBe(0);
  });

  it('the weaker "severity vs COALESCE(payload accessor)" check is only PARTIALLY falsifiable', async () => {
    await seedSeverities();

    // Recorded because it nearly shipped as this migration's post-condition.
    // The view defines severity as COALESCE(payload->'_ei'->>'severity','minor'),
    // so on a fully broken projection every row whose TRUE severity is the
    // default still compares equal. Here that hides 1 of 3 rows; live it hid
    // 44,430 of 166,626 (27%). On an all-'minor' corpus it would report a clean
    // pass against a view exposing nothing — the same failure mode as the bug.
    const [row] = await db.sql`
      SELECT count(*) FILTER (
               WHERE severity IS DISTINCT FROM COALESCE(payload->'_ei'->>'severity','minor')) AS flagged,
             count(*)                                                                          AS total
        FROM harness_shared.engineer_issues_subtracting`;

    expect(Number(row.total)).toBe(3);
    expect(Number(row.flagged)).toBe(2); // the 'minor' row escapes detection
  });
});
