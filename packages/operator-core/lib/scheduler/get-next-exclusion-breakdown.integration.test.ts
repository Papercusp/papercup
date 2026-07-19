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

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { aggregateIssueClaimExclusions } = await import('./get-next');

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
