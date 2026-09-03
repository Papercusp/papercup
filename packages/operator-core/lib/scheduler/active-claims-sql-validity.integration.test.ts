/**
 * active-claims-sql-validity.integration.test.ts
 *
 * WI-7132 · plan silent-wrong-answers-2026-08-01 · authority D-106, D-115,
 * D-137. THE FIRST PRODUCTION ADOPTER of `validateManyByPrepare` — until this
 * file, every statement that validator had ever judged was hand-written in its
 * own fixture, which is the plan's own subject reproduced inside the plan's own
 * remedy (EI-22238479367433132).
 *
 * ── WHY THIS QUERY ──────────────────────────────────────────────────────────
 * `getActiveClaimsForBee` is the incident's own lineage: EI-11796/EI-12141
 * traced a mocked suite that matched this query's SQL by substring, the shape
 * changed from a `COUNT(*) AS active_claims` aggregate to a row list, the
 * matcher stopped matching, and the mock silently returned `[]` for a query it
 * was supposed to fake a held claim for. It is also structurally the common
 * case: a complete SELECT whose `status NOT IN ${sql([...])}` interpolation is
 * a FRAGMENT, not a bind.
 *
 * ── WHAT THIS SUITE ASSERTS, AND WHY NOT THE OBVIOUS THING ──────────────────
 * The obvious adopter assertion is `report.unjudged === 0`. It is
 * UNSATISFIABLE here and would be a permanent, unfixable red: a composed
 * statement cannot be judged at all until someone splices the fragment's own
 * text back in (postgres-lib internals; strictly harder, deliberately not done
 * in WI-7132). An adopter given an unfixable red reverts the wiring, and the
 * guard then reaches nothing — the failure mode WI-2141982 names explicitly.
 *
 * So this suite asserts what is TRUE:
 *   1. the real query is classified `composed`, NOT `untypeable` — the
 *      regression that made the hole invisible, pinned from the code side;
 *   2. the run over that query alone is `vacuous`, stated OUT LOUD, because
 *      zero findings there means zero coverage;
 *   3. CALIBRATION: the same pipeline, same database, judges an unbroken query
 *      valid and the incident's own broken query invalid — so the green in (1)
 *      is a measurement, not an instrument that says nothing about everything.
 *
 * ⚠ When fragment splicing lands, (1) and (2) MUST be inverted rather than
 * deleted: the query becomes judgeable, `vacuous` becomes false, and this file
 * is where that is noticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBranchedSqlMock } from '../testing/sql-mock';
import { formatCoverage, validateManyByPrepare } from '../testing/sql-prepare-validation';
import { getActiveClaimsForBee } from './claim-spec-store';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('active-claims-sql-validity');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

/**
 * Drive the REAL production function against the branched mock. No `vi.mock`
 * boundary: `getActiveClaimsForBee` takes an `sqlOverride`, so the mock IS the
 * database handle the production code composes against — nothing about the
 * query is restated here, which is the whole point.
 */
async function captureActiveClaimsQuery() {
  const branches = createBranchedSqlMock([
    { label: 'catch-all', match: () => true, respond: () => [] },
  ]);
  await getActiveClaimsForBee(
    { cupId: 'su-test-bee', workspaceId: 'papercusp-workspace' },
    branches.handler as unknown as Parameters<typeof getActiveClaimsForBee>[1],
  );
  return branches;
}

describe('ADOPTER — the incident-lineage query, captured from a mocked handle', () => {
  it('recognises the fragment interpolation instead of rendering it as a bind', async () => {
    const branches = await captureActiveClaimsQuery();

    // The production query is the one COMPLETE statement in the capture; the
    // other call is the `sql([...statuses])` value-helper the fragment came
    // from, which is not a statement at all.
    const statement = branches.capturedQueries.find((q) => /^\s*SELECT/i.test(q.sql));
    expect(statement, `captured: ${JSON.stringify(branches.capturedSql)}`).toBeDefined();

    expect(statement!.composed).toBe(true);
    expect(statement!.fragmentArgs).toBeGreaterThanOrEqual(1);
    // The erasure is VISIBLE in the text rather than disguised as `$n`. This is
    // the difference between a report a reader can act on and one that reads as
    // an ordinary parameterised query.
    expect(statement!.sql).toContain('sql-fragment');

    // The marker lands EXACTLY where the fragment was — `status NOT IN
    // ${sql([...ALL_TERMINAL_STATUSES])}` — and nowhere else. Without this, a
    // detector that marked the wrong interpolation would still satisfy every
    // assertion above.
    expect(statement!.sql).toMatch(/status NOT IN \/\* sql-fragment: text not captured \*\//);
    // POSITIVE CONTROL for the line above: the scalar binds in the SAME
    // statement must still render as placeholders. A detector that simply
    // marked everything would pass the assertions above and fail here.
    expect(statement!.sql).toMatch(/taken_by = \$\d/);
    expect(statement!.fragmentArgs).toBe(1);
  });

  it('classifies it `composed` — never the tolerated `untypeable` that hid the hole', async () => {
    const branches = await captureActiveClaimsQuery();
    const report = await validateManyByPrepare(db.sql, branches.capturedForValidation);

    const statement = report.results.find((r) => /^\s*SELECT/i.test(r.sql));
    expect(statement?.verdict).toBe('composed');
    // The precise regression this pins: before the capture carried a
    // faithfulness flag, this statement reached PREPARE, Postgres raised 42P18,
    // and the checker called it `untypeable` — a TOLERATED non-finding. Green
    // over SQL it had never parsed.
    expect(statement?.verdict).not.toBe('untypeable');
    expect(statement?.note).toMatch(/not PREPAREd/i);

    // No finding — and the report says out loud that this means nothing.
    expect(report.invalid).toHaveLength(0);
    expect(report.composed).toBeGreaterThanOrEqual(1);
    expect(report.judged).toBe(0);
    expect(report.vacuous).toBe(true);
    expect(formatCoverage(report)).toMatch(/NOTHING WAS CHECKED/);
  });

  it('CALIBRATION — the same pipeline and database do judge, and do find the incident', async () => {
    // Without this, the green above would be indistinguishable from a checker
    // that has stopped measuring anything.
    const report = await validateManyByPrepare(db.sql, [
      {
        sql: 'SELECT feature_id FROM harness_shared.work_items WHERE taken_by = $1',
        label: 'sound',
      },
      {
        // The incident's own shape: a narrowly-projected derived table whose
        // ORDER BY reaches a base column.
        sql: `SELECT t.feature_id
                FROM (SELECT feature_id FROM harness_shared.work_items) t
               ORDER BY t.payload`,
        label: 'incident',
      },
    ]);

    expect(report.judged).toBe(2);
    expect(report.vacuous).toBe(false);
    expect(report.invalid.map((r) => r.label)).toEqual(['incident']);
    expect(formatCoverage(report)).not.toMatch(/NOTHING WAS CHECKED/);
  });
});
