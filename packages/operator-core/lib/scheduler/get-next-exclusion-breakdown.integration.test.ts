/**
 * EI-13965 (DB-backed) — `aggregateIssueClaimExclusions`, the scoped-miss AGGREGATE
 * floor-exclusion breakdown for the BROAD-spec case `explainIssueClaimFloors` cannot cover
 * (no named ids to attribute per-row).
 *
 * Live incident (2026-07-17, curation-signals fleet): a member drained its lane and reported
 * "todo items visible in both bound plans but none match the spec" — the leader took ~6
 * queries to discover the pool was NOT empty, just stranded behind three DIFFERENT floors
 * (claim-hold, taken-by-outside-agents, plan-item-lane-guard release). A member with a broad
 * spec (kind/plan-scoped, no `id in [...]`) has no named ids for `explainIssueClaimFloors` to
 * attribute, so it got nothing actionable.
 *
 * The unit/integration siblings for `explainIssueClaimFloors` (get-next-miss-diagnosis.*)
 * pin the NAMED-id case; THIS test owns what only a real database can prove for the
 * BROAD case: that the one aggregate query actually counts each floor bucket correctly
 * against real rows, using the SAME exported exclusion-SQL fragments the claim path ANDs in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { FilterNode } from './claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  aggregateIssueClaimExclusions,
  listIssueClaimableRows,
  readIssueClaimability,
  readClaimSpecDelta,
  issueClaimCandidateSubquery,
  ALL_ISSUE_CLAIM_FLOORS_PASS,
} = await import('./get-next');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed an ISSUE-family row (bug/change/task) with an arbitrary payload + the broader
 *  taken/released stamps `aggregateIssueClaimExclusions` reads (beyond what
 *  get-next-miss-diagnosis.integration.test.ts's narrower seedIssue needs). */
async function seedIssue(
  id: string,
  payload: Record<string, unknown> | null,
  opts: { status?: string; takenBy?: string; lastReleasedBy?: string; lastReleasedAgoSec?: number } = {},
) {
  const status = opts.status ?? 'open';
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, title, payload, last_released_by, last_released_at)
    VALUES (${H}, ${id}, 'change', ${status}, ${opts.takenBy ?? null}, ${WS}, 0, 0, ${'t ' + id},
            ${payload ? db.sql.json(payload as postgres.JSONValue) : null}, ${opts.lastReleasedBy ?? null},
            ${
              opts.lastReleasedAgoSec !== undefined
                ? db.sql`now() - make_interval(secs => ${opts.lastReleasedAgoSec})`
                : null
            })`;
}

/** Seed a `blocks` edge: `blockerId` (an OPEN issue) blocks `blockedId`. Matches the bare
 *  `d.blocked_ref = wi.feature_id` / `bi.issue_id = d.blocker_ref` shape
 *  `aggregateIssueClaimExclusions`'s inline blocked-dep subquery reads. */
async function seedBlocks(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'issue', ${blockedId}, 'issue', ${blockerId}, 'blocks')`;
}

async function seedPlan(slug: string, status: 'active' | 'paused') {
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
    VALUES (${WS}, ${H}, ${slug}, ${status})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('get-next-exclusion-breakdown');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup?.();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('EI-13965 — aggregateIssueClaimExclusions counts each floor bucket for a broad (no-named-ids) spec', () => {
  it('reproduces the incident: a stranded pool broken down by claim-hold, taken, plan-lane, and blocked-dep', async () => {
    await seedPlan('live-plan', 'active');

    // The control: a clean, untaken, unfloored row — must be admissible (matched, excluded
    // under nothing). If this doesn't hold the rest of the assertions measure the wrong thing.
    await seedIssue('WI-9401', null);

    // The three floors from the live incident:
    await seedIssue('WI-9402', { _claimHold: true, held_open_by: 'su-other', held_open_reason: 'blocked' });
    await seedIssue('WI-9403', {}, { takenBy: 'su-outside-agent' });
    await seedIssue('WI-9404', { plan_item: { plan_slug: 'live-plan', item_id: 'P-001' } });

    // Every-day floors the aggregate must also carry correctly:
    await seedIssue('WI-9405', { needsHuman: true });
    await seedIssue('WI-9406', { lane: 'observation' });
    await seedIssue('WI-9407', {
      externalBlockers: [{ kind: 'event', ref: 'deploy:green', status: 'active', createdAt: '', updatedAt: '' }],
    });
    // A blocked-dep pair: WI-9409 is blocked by the still-open WI-9408.
    await seedIssue('WI-9408', null);
    await seedIssue('WI-9409', null);
    await seedBlocks('WI-9409', 'WI-9408');

    // Out of scope entirely — a different status must not enter `matched`.
    await seedIssue('WI-9410', null, { status: 'resolved' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });

    // matchedByFilter = every row in the claimable-status scope for this harness/workspace,
    // REGARDLESS of floor — WI-9410 (resolved) is the only one excluded from this count.
    // 9401..9409 = 9 rows (9408 is itself its own row too, though it's the BLOCKER not the
    // blocked one under test — it is untaken/unfloored so it is simultaneously admissible).
    expect(out.matchedByFilter).toBe(9);
    expect(out.excluded).toMatchObject({
      taken: 1, // WI-9403
      claimHold: 1, // WI-9402
      needsHuman: 1, // WI-9405
      observationLane: 1, // WI-9406
      externalBlocker: 1, // WI-9407
      planLaneReserved: 1, // WI-9404
      blockedDep: 1, // WI-9409 (blocked by open WI-9408)
    });
  });

  it('distinguishes "pool empty" (spec itself matches nothing) from "pool stranded" (floors)', async () => {
    await seedIssue('WI-9501', null);
    await seedIssue('WI-9502', { _claimHold: true });

    // A spec that matches nothing at all — the ACTUAL problem is the filter, not a floor.
    const noMatch = await aggregateIssueClaimExclusions(
      { field: 'title', op: 'glob', value: '*this-matches-nothing-seeded*' },
      { harness: H },
    );
    expect(noMatch.matchedByFilter).toBe(0);
    expect(noMatch.excluded).toMatchObject({ taken: 0, claimHold: 0 });

    // The unrestricted case over the same rows: the pool is NOT empty, one row is floored.
    const broad = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(broad.matchedByFilter).toBe(2);
    expect(broad.excluded.claimHold).toBe(1);
  });

  it('applies the release-cooldown floor only to the assignee that released it, within the window', async () => {
    // Released by a DIFFERENT assignee than the one asking — must NOT count as cooldown for us.
    await seedIssue('WI-9601', {}, { lastReleasedBy: 'su-someone-else', lastReleasedAgoSec: 5 });
    // Released by US, recently — DOES count.
    await seedIssue('WI-9602', {}, { lastReleasedBy: 'su-asking', lastReleasedAgoSec: 5 });
    // Released by US, long enough ago to clear the (default 300s) cooldown window.
    await seedIssue('WI-9603', {}, { lastReleasedBy: 'su-asking', lastReleasedAgoSec: 10_000 });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'su-asking' });
    expect(out.matchedByFilter).toBe(3);
    expect(out.excluded.cooldown).toBe(1);
  });

  it('an item taken by someone else counts ONLY under `taken`, never double-counted under another floor', async () => {
    // Taken AND would otherwise also read claim-held / needs-human — but `taken` short-
    // circuits every other bucket (each later floor is scoped to the UNTAKEN subset).
    await seedIssue('WI-9701', { _claimHold: true, needsHuman: true }, { takenBy: 'su-outside' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.matchedByFilter).toBe(1);
    expect(out.excluded).toMatchObject({ taken: 1, claimHold: 0, needsHuman: 0 });
  });
});

/**
 * WI-6673 — the claimable ROW projection must read severity from where it actually lives.
 *
 * Severity on `harness_shared.work_items` sits at `payload._ei.severity` (the migration-374
 * fold), NOT top level. The projection used to read the top-level key, which matched 1 of
 * 13,731 open issue-family rows — so every claimable row came back `severity: null`,
 * including genuine criticals, and a fleet leader reading the tool concluded severity was
 * simply not tracked on claimable work.
 *
 * This is the shape a unit test cannot catch and a quiescent read cannot either: the query
 * was VALID, returned the right ROWS in the right ORDER, and reported a well-formed `null`
 * for a field that had a value. Only a DB-backed assertion that a severity-BEARING row
 * projects its severity can fail when this regresses — which is why it lives here and not
 * beside the pure folds in admitted-composition.test.ts.
 */
describe('WI-6673 — listIssueClaimableRows projects severity from payload._ei, not top level', () => {
  it('projects the _ei severity for a row whose severity lives under the migration-374 fold', async () => {
    await seedIssue('WI-SEV-1', { _ei: { severity: 'critical' } });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    // The assertion that matters: NOT null. A regression here reports a well-formed
    // `severity: null` for a genuine critical — success-shaped, and wrong.
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-1', severity: 'critical' });
  });

  it('still reads a legacy TOP-LEVEL severity for rows that predate the fold', async () => {
    // The COALESCE fallback: pre-fold stragglers must not regress to null while we fix the
    // common case.
    await seedIssue('WI-SEV-2', { severity: 'major' });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-2', severity: 'major' });
  });

  it('prefers the _ei value when BOTH accessors are present (the fold is authoritative)', async () => {
    // A row carrying both must not be decided by accessor order changing underneath us.
    await seedIssue('WI-SEV-3', { severity: 'nit', _ei: { severity: 'critical' } });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-3', severity: 'critical' });
  });

  it('reports null only when the row genuinely carries no severity anywhere', async () => {
    // The honest null — pinned so "everything is null" and "this one has none" stay
    // distinguishable.
    await seedIssue('WI-SEV-4', { someOtherField: true });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-4', severity: null });
  });
});

/**
 * EI-18802055183255275 — DB-backed proof that `readIssueClaimability`'s materialize-once
 * temp-table path (introduced to stop redundant serial full scans of the candidate set —
 * see get-next.ts's `candidateFromSource`) returns IDENTICAL results to calling
 * `aggregateIssueClaimExclusions` / `listIssueClaimableRows` directly (the un-materialized,
 * per-caller-recomputed default path every OTHER test in this file already exercises against
 * this same real database). The mocked-pg unit tests in claimability-snapshot.test.ts pin the
 * TRANSACTION SHAPE (query counts) but stub every query to return zero rows, so they cannot
 * catch a real defect in the temp-table's column projection/typing against live Postgres —
 * only a real database can.
 */
describe('EI-18802055183255275 — readIssueClaimability (materialized temp-table path) agrees with the direct (unmaterialized) reads', () => {
  it('breakdown + rows + admitted composition from readIssueClaimability match the standalone calls, for a floor-stranded pool', async () => {
    await seedPlan('rc-plan', 'active');
    await seedIssue('WI-RC-1', null); // clean, claimable
    await seedIssue('WI-RC-2', { _claimHold: true }); // claim-hold floored
    await seedIssue('WI-RC-3', {}, { takenBy: 'su-outside' }); // taken
    await seedIssue('WI-RC-4', { _ei: { severity: 'critical' } }); // claimable, carries severity

    const direct = await aggregateIssueClaimExclusions(undefined, { harness: H });
    const directRows = await listIssueClaimableRows(undefined, { harness: H }, 20);

    const viaSnapshot = await readIssueClaimability(undefined, { harness: H }, { limit: 20 });

    expect(viaSnapshot.breakdown).toEqual(direct);
    // Row order is spec-rank-determined and deterministic for this fixed set — compare
    // directly rather than as a set, so an ordering regression in the materialized path
    // (e.g. a lost ORDER BY) would also be caught.
    expect(viaSnapshot.rows).toEqual(directRows);
    expect(viaSnapshot.rows.find((r) => r.id === 'WI-RC-4')).toMatchObject({ severity: 'critical' });
    expect(viaSnapshot.breakdown.matchedByFilter).toBe(4);
    expect(viaSnapshot.breakdown.claimable).toBe(2); // WI-RC-1, WI-RC-4
  });

  it('breakdownOnly:true still returns the SAME admitted composition as the unconditional full read (WI-6673 x EI-18802055183255275)', async () => {
    await seedIssue('WI-RC-10', { _ei: { severity: 'minor' } });
    await seedIssue('WI-RC-11', { _ei: { severity: 'major' } });

    const full = await readIssueClaimability(undefined, { harness: H }, { limit: 20 });
    const breakdownOnly = await readIssueClaimability(undefined, { harness: H }, { limit: 20, breakdownOnly: true });

    expect(breakdownOnly.rows).toEqual([]);
    expect(breakdownOnly.breakdown).toEqual(full.breakdown);
    expect(breakdownOnly.admitted).toEqual(full.admitted);
    expect(breakdownOnly.admitted.total).toBe(2);
  });

  it('sampleExcluded surfaces the SAME excluded ids the breakdown counts, through the materialized snapshot', async () => {
    await seedIssue('WI-RC-20', { needsHuman: true });
    await seedIssue('WI-RC-21', null);

    const out = await readIssueClaimability(undefined, { harness: H }, { limit: 20, sampleLimit: 5 });
    expect(out.breakdown.excluded.needsHuman).toBe(1);
    expect(out.sample?.needsHuman).toEqual(['WI-RC-20']);
  });
});

/**
 * agent-epistemics-2026-08-02 P-005 — DB-backed proof for `readClaimSpecDelta`, the
 * before/after read behind `scheduler:preview_spec_delta`.
 *
 * The mocked-pg unit suite (claim-spec-delta.test.ts) pins the TRANSACTION SHAPE — one
 * REPEATABLE READ txn, one floor materialization, three reads off it — but stubs every query
 * to return zero rows, so it cannot execute a line of the actual SQL. What only a real
 * database can prove is exactly what that shape makes non-obvious: the delta materializes the
 * candidate population decorated with TWO match columns (`spec_match` for the stored spec, a
 * second compiled filter as `proposed_match`) over the UNION of both sides' claimable states,
 * and both compiled filters must evaluate correctly against that derived table's columns.
 *
 * The load-bearing assertion is AGREEMENT: each side of a delta must equal what
 * `readIssueClaimability` reports for that spec ALONE. A delta that quietly disagrees with the
 * single-spec oracle is worse than no delta — it would send a leader to re-steer a lane on
 * numbers the claim door does not honor, which is the exact drift (a second SQL copy of the
 * floors) this design exists to prevent.
 */
describe('P-005 — readClaimSpecDelta: which items a proposed spec revision drops or picks up', () => {
  const sev = (s: string) => ({ _ei: { severity: s } });
  const CRIT_OR_MAJOR: FilterNode = { field: 'severity', op: 'in', value: ['critical', 'major'] };
  const CRIT_ONLY: FilterNode = { field: 'severity', op: '=', value: 'critical' };

  it('names the rows a NARROWING revision would drop, and agrees with the single-spec oracle on both sides', async () => {
    await seedIssue('WI-D-CRIT', sev('critical'));
    await seedIssue('WI-D-MAJ', sev('major'));
    await seedIssue('WI-D-MINOR', sev('minor'));
    await seedIssue('WI-D-TAKEN', sev('major'), { takenBy: 'su-outside' }); // floored on BOTH sides

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR },
      { filter: CRIT_ONLY },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.currentClaimable).toBe(2); // CRIT + MAJ (TAKEN is floored, MINOR is out of filter)
    expect(delta.proposedClaimable).toBe(1); // CRIT
    expect(delta.retained).toBe(1);
    expect(delta.newlyExcludedCount).toBe(1);
    expect(delta.newlyAdmittedCount).toBe(0);
    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-D-MAJ']);
    // Attribution: the filter moved it, not the states — the two have different fixes.
    expect(delta.newlyExcluded[0]).toMatchObject({ cause: 'filter', severity: 'major', status: 'open' });
    expect(delta.truncated).toEqual({ newlyExcluded: false, newlyAdmitted: false });

    // AGREEMENT with the single-spec oracle, per side. This is the anti-drift assertion.
    const current = await readIssueClaimability(CRIT_OR_MAJOR, { harness: H }, { limit: 20 });
    const proposed = await readIssueClaimability(CRIT_ONLY, { harness: H }, { limit: 20 });
    expect(delta.currentClaimable).toBe(current.breakdown.claimable);
    expect(delta.proposedClaimable).toBe(proposed.breakdown.claimable);
    // A floored row is invisible to the delta entirely — it was in neither lane, so it can be
    // neither a loss nor a gain.
    const moved = [...delta.newlyExcluded, ...delta.newlyAdmitted].map((r) => r.id);
    expect(moved).not.toContain('WI-D-TAKEN');
  });

  it('names the rows a WIDENING revision would pick up', async () => {
    await seedIssue('WI-W-CRIT', sev('critical'));
    await seedIssue('WI-W-MAJ', sev('major'));

    const delta = await readClaimSpecDelta(
      { filter: CRIT_ONLY },
      { filter: CRIT_OR_MAJOR },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.currentClaimable).toBe(1);
    expect(delta.proposedClaimable).toBe(2);
    expect(delta.newlyExcludedCount).toBe(0);
    expect(delta.newlyAdmitted.map((r) => r.id)).toEqual(['WI-W-MAJ']);
    expect(delta.newlyAdmitted[0]!.cause).toBe('filter');
  });

  it('treats a states-only revision as a first-class delta and attributes it to `states`', async () => {
    // The starvation shape this fleet has actually hit: an issue-family lane re-steered onto a
    // status token its rows do not carry. The filter is IDENTICAL on both sides, so a
    // filter-only diff would report "no change" for the most common way a lane starves.
    await seedIssue('WI-S-OPEN', null);
    await seedIssue('WI-S-FAILING', null, { status: 'failing' });

    const delta = await readClaimSpecDelta({ states: ['open'] }, { states: ['failing'] }, { harness: H }, {
      limit: 20,
    });

    expect(delta.currentClaimable).toBe(1);
    expect(delta.proposedClaimable).toBe(1);
    expect(delta.retained).toBe(0);
    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-S-OPEN']);
    expect(delta.newlyAdmitted.map((r) => r.id)).toEqual(['WI-S-FAILING']);
    expect(delta.newlyExcluded[0]!.cause).toBe('states');
    expect(delta.newlyAdmitted[0]!.cause).toBe('states');
  });

  it('attributes a row moved by BOTH dimensions to `both`', async () => {
    await seedIssue('WI-B-1', sev('major'), { status: 'failing' });

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR, states: ['failing'] },
      { filter: CRIT_ONLY, states: ['open'] },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-B-1']);
    expect(delta.newlyExcluded[0]!.cause).toBe('both');
  });

  it('reports an identical revision as a zero delta', async () => {
    await seedIssue('WI-N-1', sev('critical'));
    await seedIssue('WI-N-2', sev('major'));

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR },
      { filter: CRIT_OR_MAJOR },
      { harness: H },
      { limit: 20 },
    );

    expect(delta).toMatchObject({
      currentClaimable: 2,
      proposedClaimable: 2,
      retained: 2,
      newlyExcludedCount: 0,
      newlyAdmittedCount: 0,
      newlyExcluded: [],
      newlyAdmitted: [],
    });
  });

  it('keeps the COUNTS exact when the row lists are capped, and says so', async () => {
    // A capped list that silently under-reports the loss is how a leader green-lights a
    // revision that drops 40 items after seeing 2.
    for (let i = 0; i < 5; i += 1) await seedIssue(`WI-C-${i}`, sev('major'));

    const delta = await readClaimSpecDelta({ filter: CRIT_OR_MAJOR }, { filter: CRIT_ONLY }, { harness: H }, {
      limit: 2,
    });

    expect(delta.newlyExcludedCount).toBe(5);
    expect(delta.newlyExcluded).toHaveLength(2);
    expect(delta.truncated.newlyExcluded).toBe(true);
    expect(delta.truncated.newlyAdmitted).toBe(false);
  });
});
