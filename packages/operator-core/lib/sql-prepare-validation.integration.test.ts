/**
 * sql-prepare-validation.integration.test.ts
 *
 * WI-2141982 · the surviving half of P-018/WI-7132 · plan
 * silent-wrong-answers-2026-08-01, authority D-106 (why statement-counting was
 * refuted) and D-115 (why this shape is shippable, and why it is ONE shared
 * suite rather than a per-suite hook).
 *
 * THE CLASS: a query that returns a well-formed, plausible, WRONG answer with
 * no signal that it is wrong. A MOCKED suite never sends its SQL anywhere, so
 * nothing ever parses it; the incident's `column "t.payload" does not exist`
 * sat behind a fake that cheerfully stubbed a row set for it.
 *
 * ── WHY ONE SHARED SUITE (D-115) ────────────────────────────────────────────
 * PREPARE is parse+plan only: no execution, no writes, therefore NO isolation
 * requirement. It needs a schema-loaded database, not one per suite. Measured:
 * ~0.5ms/statement. The per-suite hook the original spec suspected would pay a
 * testcontainer boot 375 times to buy nothing.
 *
 * ── WHY THERE ARE PERMANENT CONTROLS IN HERE ────────────────────────────────
 * A guard that has never failed is a guard nobody has tested. Per the repo's
 * mutation-probe policy the cheapest tier that fits is a deliberately-wrong
 * implementation kept PERMANENTLY beside the real one — no tree mutation, no
 * sweep race, no restore step.
 *
 * Here the deliberately-wrong implementation is A REAL BUG, not a synthetic
 * one: `sql-mock.ts`'s `queryTextOf` is `strings.join(' ')`, which DELETES
 * every interpolation. If anyone "simplifies" `reassembleSql` back to that (the
 * single most likely future regression, since the two functions sit in sibling
 * files and look interchangeable), the joined-form control below stops being
 * INVALID and this suite fails.
 *
 * ⚠ FALSE REDS ARE THE FAILURE MODE THIS GUARD MUST AVOID — WI-2141982 says so
 * explicitly: a guard that emits false reds gets ignored, then deleted. Hence
 * the tolerance tests: an untypeable parameter and a non-preparable statement
 * head must BOTH come back tolerated, never as findings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBranchedSqlMock } from './testing/sql-mock';
import {
  classifyPrepareError,
  formatInvalid,
  isPreparable,
  reassembleSql,
  validateManyByPrepare,
  validateSqlByPrepare,
} from './testing/sql-prepare-validation';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('sql-prepare-validation');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

/**
 * The literal segments of
 *   sql`SELECT feature_id FROM harness_shared.work_items
 *        WHERE harness_slug = ${h} AND status = ${s}`
 * exactly as a tagged template hands them to a mocked `sql` function.
 */
const PARAMETERISED_TEMPLATE = [
  'SELECT feature_id FROM harness_shared.work_items WHERE harness_slug = ',
  ' AND status = ',
  '',
];

describe('reassembleSql — the placeholder-preserving form', () => {
  it('rebuilds $1..$n, one per interpolation', () => {
    expect(reassembleSql(PARAMETERISED_TEMPLATE)).toBe(
      'SELECT feature_id FROM harness_shared.work_items WHERE harness_slug = $1 AND status = $2',
    );
  });

  it('leaves a template with no interpolations untouched', () => {
    expect(reassembleSql(['SELECT 1'])).toBe('SELECT 1');
  });

  it('PREPAREs clean against the real schema', async () => {
    const r = await validateSqlByPrepare(db.sql, reassembleSql(PARAMETERISED_TEMPLATE));
    expect(r.verdict).toBe('valid');
  });
});

describe('PERMANENT CONTROL — the joined form (sql-mock queryTextOf) must NOT be valid SQL', () => {
  /**
   * `queryTextOf`, reproduced verbatim from sql-mock.ts. This is the real bug
   * the helper exists to route around; keeping a copy here means a future
   * "simplification" of reassembleSql back to a join is caught by an assertion
   * rather than by the fleet gate hours later.
   */
  const joined = (strings: readonly string[]) => strings.join(' ');

  it('deletes every placeholder, so the text no longer parses', async () => {
    const text = joined(PARAMETERISED_TEMPLATE);
    expect(text).not.toContain('$1');

    const r = await validateSqlByPrepare(db.sql, text, { label: 'joined-form' });
    expect(r.verdict).toBe('invalid');
  });

  it('discriminates: the SAME template is valid reassembled and invalid joined', async () => {
    const [good, bad] = await Promise.all([
      validateSqlByPrepare(db.sql, reassembleSql(PARAMETERISED_TEMPLATE)),
      validateSqlByPrepare(db.sql, joined(PARAMETERISED_TEMPLATE)),
    ]);
    // If these two ever agree, the checker has stopped measuring anything.
    expect([good.verdict, bad.verdict]).toEqual(['valid', 'invalid']);
  });
});

describe("CONTROL — the incident's own error class is caught at parse time", () => {
  it('reports a nonexistent column as invalid, with no execution and no fixture', async () => {
    const r = await validateSqlByPrepare(
      db.sql,
      'SELECT t.nonexistent_col FROM harness_shared.work_items t WHERE t.harness_slug = $1',
      { label: 'incident-shape' },
    );
    expect(r.verdict).toBe('invalid');
    expect(r.error).toMatch(/nonexistent_col/);
  });

  it('reports the incident shape itself — a narrowly-projected derived table whose ORDER BY reaches a base column', async () => {
    const r = await validateSqlByPrepare(
      db.sql,
      `SELECT t.feature_id
         FROM (SELECT feature_id FROM harness_shared.work_items) t
        ORDER BY t.payload`,
      { label: 'derived-table-order-by' },
    );
    expect(r.verdict).toBe('invalid');

    // POSITIVE CONTROL for the line above: the same query ordered by a column
    // the derived table DOES project must be valid. Without this, a checker
    // that simply failed everything would pass the assertion above.
    const control = await validateSqlByPrepare(
      db.sql,
      `SELECT t.feature_id
         FROM (SELECT feature_id FROM harness_shared.work_items) t
        ORDER BY t.feature_id`,
    );
    expect(control.verdict).toBe('valid');
  });
});

describe('TOLERANCE — the narrow cases that must never be reported as findings', () => {
  it('classifies an untypeable parameter as untypeable, not invalid', async () => {
    const r = await validateSqlByPrepare(
      db.sql,
      'SELECT 1 FROM harness_shared.work_items WHERE $1 IS NULL',
      { label: 'untypeable-param' },
    );
    expect(r.verdict).toBe('untypeable');
    expect(r.error).toMatch(/could not determine data type/i);
  });

  it('accepts the same query once the parameter is cast — the documented repair', async () => {
    const r = await validateSqlByPrepare(
      db.sql,
      'SELECT 1 FROM harness_shared.work_items WHERE $1::text IS NULL',
    );
    expect(r.verdict).toBe('valid');
  });

  it('classifies a non-preparable statement head as unpreparable, not invalid', async () => {
    const r = await validateSqlByPrepare(db.sql, 'TRUNCATE harness_shared.work_items', {
      label: 'fixture-truncate',
    });
    // Postgres reports this as a syntax error; misclassifying it as `invalid`
    // would red-pin every suite whose fixture truncates a table.
    expect(r.verdict).toBe('unpreparable');
  });

  it('recognises the preparable heads, CTEs included', () => {
    expect(isPreparable('  -- lead comment\n  WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isPreparable('/* block */ SELECT 1')).toBe(true);
    expect(isPreparable('SET search_path = public')).toBe(false);
  });

  it('classifies by SQLSTATE first, so a localised message cannot mislead it', () => {
    expect(classifyPrepareError('a message in another language', '42P18')).toBe('untypeable');
    expect(classifyPrepareError('column "x" does not exist', '42703')).toBe('invalid');
  });
});

describe('ADOPTER — SQL captured from a branched sql-mock is validated', () => {
  /**
   * Drives `createBranchedSqlMock` exactly as a mocked suite does (the two live
   * adopters are in scheduler/, the incident's own module), then hands its
   * `capturedSql` to the validator. This is the whole point: the suite never
   * touched a database, and its SQL still got parsed.
   */
  async function runMockedQueries(templates: readonly string[][]) {
    const branches = createBranchedSqlMock([
      { label: 'catch-all', match: () => true, respond: () => [] },
    ]);
    for (const t of templates) await branches.handler(t, 'arg-a', 'arg-b');
    return branches;
  }

  it('captures the parameterised form, not the placeholder-deleted one', async () => {
    const branches = await runMockedQueries([PARAMETERISED_TEMPLATE]);
    expect(branches.capturedSql).toEqual([
      'SELECT feature_id FROM harness_shared.work_items WHERE harness_slug = $1 AND status = $2',
    ]);
  });

  it('reports zero findings for a suite whose queries are all sound', async () => {
    const branches = await runMockedQueries([
      PARAMETERISED_TEMPLATE,
      ['SELECT count(*) FROM harness_shared.work_items WHERE item_kind = ', ''],
      ["SELECT feature_id FROM harness_shared.work_items WHERE payload->'_ei'->>'severity' = ", ''],
      ['SELECT feature_id FROM harness_shared.work_items WHERE created_ts > ', ''],
    ]);

    const report = await validateManyByPrepare(
      db.sql,
      branches.capturedSql.map((sql, i) => ({ sql, label: `q${i}` })),
    );

    expect(formatInvalid(report)).toBe('');
    expect(report.invalid).toHaveLength(0);
    // NOT VACUOUS: assert the statements were actually judged. A corpus that
    // was entirely `unpreparable`/`untypeable` would also report zero findings
    // — a well-formed-looking wrong answer of exactly this plan's kind.
    expect(report.counts.valid).toBe(4);
    expect(report.unjudged).toBe(0);
  });

  it('CALIBRATION — the same path catches a broken query, so the green above means something', async () => {
    const branches = await runMockedQueries([
      PARAMETERISED_TEMPLATE,
      // The incident, issued through a mock that happily stubs a row set for it.
      ['SELECT t.payload FROM (SELECT feature_id FROM harness_shared.work_items) t WHERE t.feature_id = ', ''],
    ]);

    const report = await validateManyByPrepare(
      db.sql,
      branches.capturedSql.map((sql, i) => ({ sql, label: `q${i}` })),
    );

    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]?.label).toBe('q1');
    expect(formatInvalid(report)).toMatch(/payload/);
    expect(report.counts.valid).toBe(1);
  });

  it('captures a query no branch matched, so an uncovered query is still checkable', async () => {
    const branches = createBranchedSqlMock(
      [{ label: 'never-matches', match: () => false, respond: () => [] }],
      { onUnmatched: 'empty' },
    );
    await branches.handler(PARAMETERISED_TEMPLATE, 'a', 'b');
    expect(branches.capturedSql).toHaveLength(1);

    const r = await validateSqlByPrepare(db.sql, branches.capturedSql[0]!);
    expect(r.verdict).toBe('valid');
  });

  it('resetHits clears the capture buffer, so a beforeEach cannot leak queries across tests', async () => {
    const branches = await runMockedQueries([PARAMETERISED_TEMPLATE]);
    expect(branches.capturedSql).toHaveLength(1);
    branches.resetHits();
    expect(branches.capturedSql).toHaveLength(0);
  });
});
