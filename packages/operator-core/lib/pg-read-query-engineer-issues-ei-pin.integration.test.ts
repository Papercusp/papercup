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
import { readFileSync } from 'node:fs';
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

/**
 * P-010. The advisory was only ONE carrier of the falsified claim.
 *
 * The same sentence — "on the engineer_issues VIEW the nested severity path is
 * NULL for every row" — was ALSO hand-copied into surfaces that reach agents
 * directly, and each drifted independently when migration 1096 landed:
 *   - issues:list tool guidance, shipped into every agent's context;
 *   - the scheduler's severity-accessor rationale;
 *   - the CLAUDE.md prose corpus.
 * Three copies of one fact, none derived from the view, all wrong for a month.
 * Fixing the three without a guard just resets the clock until a fourth appears.
 *
 * The guard is deliberately NOT "this phrase may never appear": correcting the
 * record REQUIRES narrating the old claim ("...was NULL for every row; migration
 * 1096 stopped the subtraction"). So it demands that any surface still carrying
 * the dead-path sentence also carry the retraction marker that dates it. A fresh
 * copy of the claim, written by someone who does not know about 1096, has no such
 * marker and fails here.
 */
const AGENT_FACING_SEVERITY_SURFACES = [
  './agent-tools/issues/list.ts',
  './scheduler/get-next.ts',
  './doc-projection/claude-md-corpus.generated.md',
] as const;

/** A present-or-past assertion that the nested path resolves to nothing. */
const DEAD_PATH_CLAIM = /NULL for (?:\*\*)?(?:every|EVERY)(?:\*\*)? row/;

function readSurface(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

/** Does this body assert the dead path about `_ei` severity at all? */
function claimsTheDeadPath(body: string): boolean {
  return DEAD_PATH_CLAIM.test(body) && /_ei/.test(body) && /severity/i.test(body);
}

/**
 * How close the retraction marker has to sit to the claim it dates.
 *
 * ⚠ Judged PER OCCURRENCE, not per file — and that distinction is not
 * hypothetical. The first cut of this guard asked only whether `1096` appeared
 * ANYWHERE in the file, and it passed `agent-tools/issues/list.ts` while a
 * FOURTH stale copy of the claim sat in that same file's header comment: the
 * corrected line further down carried the marker and immunised the whole file.
 * A guard whose scope is wider than the claim it checks reports "clean" for the
 * wrong reason, which is this plan's subject reproduced inside its own fix.
 */
const DATED_WINDOW = 400;

/** Byte offsets of dead-path claims that carry no nearby retraction marker. */
function staleClaimOffsets(body: string): number[] {
  if (!claimsTheDeadPath(body)) return [];
  const out: number[] = [];
  for (const m of body.matchAll(new RegExp(DEAD_PATH_CLAIM.source, 'g'))) {
    const at = m.index ?? 0;
    const near = body.slice(Math.max(0, at - DATED_WINDOW), at + DATED_WINDOW);
    if (!/1096/.test(near)) out.push(at);
  }
  return out;
}

/**
 * STALE = asserts the dead path without dating it against the migration that
 * falsified it. This is the whole predicate; the file scan and the controls
 * below both go through it, so the controls genuinely exercise what runs.
 */
function isStaleSeverityClaim(body: string): boolean {
  return staleClaimOffsets(body).length > 0;
}

describe('agent-facing severity guidance agrees with the live view (P-010)', () => {
  it('carries no undated dead-path claim while the view resolves the path', async () => {
    const subtracts = subtractsEi(await viewDefOf('harness_shared.engineer_issues'));
    // Guard is meaningful only in the post-1096 world; the next test covers the other.
    expect(subtracts).toBe(false);

    const undated = AGENT_FACING_SEVERITY_SURFACES.filter((rel) =>
      isStaleSeverityClaim(readSurface(rel)),
    );

    expect(
      undated,
      'These agent-facing surfaces still tell readers that ' +
        "payload->'_ei'->>'severity' is NULL for every row on engineer_issues, but the " +
        'live view no longer subtracts the `_ei` blob, so the path resolves. Either ' +
        'correct the claim or date it against migration 1096.',
    ).toEqual([]);
  });

  it('CONTROL: flags a freshly-written stale claim, and clears a dated one', () => {
    // Proving falsifiability WITHOUT mutating the shared tree (a copy-out probe
    // cannot reach these surfaces: the scan reads them by real repo path, and a
    // git-sync sweep can commit an in-tree mutant even when nothing goes wrong).
    // These two literals are what a fourth copy of the bug would look like, and
    // what its correction looks like, so the predicate is exercised in both
    // directions on every run rather than once by hand.
    const freshlyStale =
      "severity is a real column here. Do NOT reach for payload->'_ei'->>'severity' " +
      'against this view — it is NULL for every row.';
    const dated =
      "payload->'_ei'->>'severity' was NULL for every row until migration 1096 " +
      'restored the `_ei` blob; read the severity column.';

    expect(isStaleSeverityClaim(freshlyStale), 'the exact sentence P-010 removed must be caught').toBe(true);
    expect(isStaleSeverityClaim(dated), 'a correction that narrates the old claim must NOT be caught').toBe(false);

    // REGRESSION CONTROL for the bug this guard had on its first cut: a file
    // that dates ONE claim must not thereby immunise a second, undated one far
    // away. This is the shape that let a fourth stale copy through.
    const datedThenStaleElsewhere = `${dated}\n${'filler. '.repeat(120)}\n${freshlyStale}`;
    expect(
      isStaleSeverityClaim(datedThenStaleElsewhere),
      'a dated claim elsewhere in the same file must not immunise an undated one',
    ).toBe(true);
  });

  it('CALIBRATION: the phrase this guard keys on still occurs in the real surfaces', () => {
    // Without this, the assertion above passes trivially the day someone rewords
    // the sentence out of DEAD_PATH_CLAIM's reach: an empty `undated` list would
    // then mean "the regex matches nothing", not "no surface is stale" — the
    // zero-work false green this whole plan is about. At least one surface must
    // still be matched, so the detector is demonstrably live.
    const matched = AGENT_FACING_SEVERITY_SURFACES.filter((rel) =>
      DEAD_PATH_CLAIM.test(readSurface(rel)),
    );
    expect(
      matched.length,
      'DEAD_PATH_CLAIM matched no surface at all, so the staleness check above is ' +
        'vacuous. Re-point the pattern at however the dead-path claim is now worded.',
    ).toBeGreaterThan(0);
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
