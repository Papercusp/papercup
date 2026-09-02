/**
 * pg-read-query-engineer-issues-ei-pin.integration.test.ts
 *
 * P-005 of plan silent-wrong-answers-2026-08-01 · parent WI-6674.
 *
 * WHAT THIS PINS — AND WHY IT IS NOT THE DUAL-ACCESSOR GUARD AGAIN.
 * engineer-issues-severity-dual-accessor.integration.test.ts asserts what the
 * VIEW does. This file asserts that the ADVISORY CODE AGREES WITH THE VIEW.
 * That is a separate claim, nothing checked it, and it was measurably FALSE for
 * the window between migration 1096 landing (2026-09-02 17:05Z) and this fix.
 *
 * THE FAILURE IT EXISTS TO CATCH.
 * SILENT_NULL_PATH_TRAPS in pg-read-query.ts carried a HARDCODED description of
 * a relation's shape: that the engineer_issues VIEW "subtracts the blob
 * (`payload - '_ei'`) ... so the path resolves to NULL for EVERY row". That is
 * code-describing metadata, and CLAUDE.md's derived-truth ladder is explicit
 * that such a value must be DERIVED, PINNED or ATTESTED — never hand-maintained,
 * because it WILL drift. It drifted: migration 1096 stopped the subtraction, so
 * dev:pg_query began telling every caller that a query returning 166,795 correct
 * rows "matches ZERO rows, which reads exactly like 'there are none'".
 *
 * ⚠ AND WHY THE EXISTING UNIT TESTS DID NOT CATCH IT — the part worth keeping.
 * pg-read-query.test.ts asserted the advisory against hardcoded SQL STRINGS. It
 * therefore pinned the claim to ITSELF and never to a database, so it stayed
 * green the entire time the claim was false. A guard that cannot observe the
 * thing it describes cannot detect drift in it. That is exactly the plan's own
 * subject — a well-formed, confident, wrong answer — reproduced inside the
 * mechanism built to prevent it.
 *
 * BIDIRECTIONAL BY CONSTRUCTION.
 * A one-way assertion ("no trap is registered") would silently become wrong the
 * moment someone restores the subtraction. So this fails BOTH ways:
 *   view subtracts `_ei`      + no advisory  → FAIL (a real trap went unguarded)
 *   view projects full payload + an advisory → FAIL (the advisory is false)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { buildSilentNullPathAdvisory } from './pg-read-query';

let db: FreshPgDb;

/** The canonical shape the retired trap used to fire on. */
const EI_NESTED_PATH_SQL =
  "SELECT count(*) FROM harness_shared.engineer_issues WHERE payload->'_ei'->>'severity' = 'critical'";

/**
 * Does this view definition subtract the `_ei` blob from its payload projection?
 *
 * Deliberately a narrow regex over pg_get_viewdef rather than a hand-written
 * belief about the view. Postgres renders the operator as `payload - '_ei'::text`,
 * and the parenthesised source form `(payload - '_ei')` also matches.
 */
function subtractsEi(viewDef: string): boolean {
  return /payload\s*-\s*'_ei'/i.test(viewDef);
}

async function viewDefOf(relation: string): Promise<string> {
  const [row] = await db.sql<{ def: string }[]>`
    SELECT pg_get_viewdef(${relation}::regclass, true) AS def`;
  return row!.def;
}

beforeAll(async () => {
  db = await createFreshPgDb('pg-read-query-engineer-issues-ei-pin');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);

  // CONTROL, kept permanently beside the real view (the repo's mutation-probe
  // policy: a deliberately-wrong implementation, never a mutation of the tree).
  // This reproduces the pre-1096 projection so `subtractsEi` can be shown to
  // SEPARATE the two states instead of merely returning false for everything.
  await db.sql.unsafe(`
    CREATE VIEW harness_shared.engineer_issues_pre1096 AS
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

describe('the _ei detector is falsifiable before anything is concluded from it', () => {
  it('reports TRUE on the pre-1096 control projection', async () => {
    // Without this the whole file could pass because `subtractsEi` never
    // matches anything — four green assertions from a broken instrument.
    expect(subtractsEi(await viewDefOf('harness_shared.engineer_issues_pre1096'))).toBe(true);
  });

  it('reports FALSE on the current view', async () => {
    expect(subtractsEi(await viewDefOf('harness_shared.engineer_issues'))).toBe(false);
  });
});

describe('SILENT_NULL_PATH_TRAPS agrees with the live engineer_issues view', () => {
  it('registers a trap if and only if the view actually subtracts _ei', async () => {
    const subtracts = subtractsEi(await viewDefOf('harness_shared.engineer_issues'));
    const advisory = buildSilentNullPathAdvisory(EI_NESTED_PATH_SQL);

    if (subtracts) {
      expect(
        advisory,
        'The engineer_issues view subtracts `_ei`, so payload->\'_ei\' is NULL for every ' +
          'row — but pg-read-query.ts registers no always-NULL trap for it. Re-add the ' +
          'entry to SILENT_NULL_PATH_TRAPS, or agents get a confident zero with no warning.',
      ).toContain('always-NULL accessor');
    } else {
      expect(
        advisory,
        'The engineer_issues view projects the FULL payload, so payload->\'_ei\' resolves ' +
          'correctly — but pg-read-query.ts still emits an always-NULL advisory claiming it ' +
          'matches ZERO rows. That advisory is false; retire the SILENT_NULL_PATH_TRAPS entry.',
      ).toBeNull();
    }
  });

  it('the text claim matches the BEHAVIOUR, not just the view source', async () => {
    // pg_get_viewdef is itself only a description. Ground it: write a row and
    // read severity both ways. A regex agreeing with a stale advisory would
    // still be two descriptions agreeing with each other and not with Postgres.
    await db.sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, body, state, kind, severity)
      VALUES ('default', 'WI-900', 'harness:papercup', 'a critical bug', '', 'open', 'bug', 'critical')`;

    const [row] = await db.sql`
      SELECT count(*) FILTER (WHERE payload->'_ei'->>'severity' = 'critical') AS via_payload,
             count(*) FILTER (WHERE severity = 'critical')                    AS via_column
        FROM harness_shared.engineer_issues`;

    const nestedPathResolves = Number(row.via_payload) === Number(row.via_column);
    const advisory = buildSilentNullPathAdvisory(EI_NESTED_PATH_SQL);

    expect(
      nestedPathResolves,
      'The nested path disagreed with the severity column on the current view — the ' +
        'dual-accessor bug is back; see engineer-issues-severity-dual-accessor.integration.test.ts.',
    ).toBe(true);
    expect(
      advisory,
      'Postgres resolves payload->\'_ei\'->>\'severity\' on this view, yet the advisory ' +
        'still warns that it cannot. The hardcoded claim has drifted from the database.',
    ).toBeNull();
  });
});

describe('the retirement did not disarm the registry for other relations', () => {
  it("still flags work_items payload->'_ei'->>'lane', which IS still always-NULL", () => {
    // Calibration for the two toBeNull() expectations above: if removing the
    // engineer_issues entry had broken buildSilentNullPathAdvisory itself, they
    // would pass for entirely the wrong reason.
    expect(
      buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'lane' <> 'observation'",
      ),
    ).toContain('always-NULL accessor');
  });
});
