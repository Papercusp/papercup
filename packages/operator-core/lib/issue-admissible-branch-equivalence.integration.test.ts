/**
 * WI-37827 — `issueAdmissibleWhereSql`'s two column forms are ONE definition.
 *
 * The function returns the row-intrinsic admissibility predicate in either a bare
 * (`origin`, unaliased table form) or an `ei.`-prefixed (topic-JOINed subquery form)
 * shape, selected by `aliased`. Measured before this file landed: the two hand-written
 * texts were 1128 and 1074 chars, and the aliased one with every `ei.` stripped was
 * BYTE-IDENTICAL to the unaliased one — 18 prefixes of difference and nothing else.
 * Every floor was therefore stated twice and had to be edited twice; WI-37774 added
 * three floors to both branches by hand for exactly that reason, and WI-37761 is a
 * floor that reached one representation of this predicate and not another.
 *
 * ── WHY THIS TEST IS SHAPED THE WAY IT IS ──────────────────────────────────────────
 * The tempting guard is a SOURCE-TEXT test: regex the two template literals out of
 * issues-engineer.ts and assert `aliased.replaceAll('ei.','') === unaliased`. That is
 * rejected on purpose. It passes today and stops meaning anything the moment the
 * branches are composed at runtime rather than written out — i.e. it goes false-green
 * exactly when the dedup this item asks for lands. A guard that cannot see its own
 * drift is worse than no guard (same direction-gap this repo rejected on 2026-08-10
 * for the composition-rig; fact `composition-rig-drift-guard-direction-gap`).
 *
 * So this is a RUNTIME EQUIVALENCE test: it seeds rows sitting on each side of every
 * floor, evaluates the ACTUAL fragment each branch returns against real Postgres, and
 * asserts the two admit exactly the same id set. It is behavioural, so it holds
 * whether the predicate is two literals, one prefix-parameterised builder, or anything
 * later — and it passes BOTH before and after the dedup, which is what makes the dedup
 * safe to do at all. Same sanctioned agreement-test pattern as
 * `work-items-advertise-claim-floor-parity.integration.test.ts`.
 *
 * ⚠ ANTI-VACUITY IS ASSERTION-LEVEL, NOT A SEPARATE CASE. Two empty sets are equal, so
 * "the branches agree" alone is satisfiable by a fixture that seeded nothing, a floor
 * that excluded everything, or a probe that errored into emptiness. Every case below
 * therefore asserts the EXACT admitted id set — a named control that must survive and
 * a floor row that must not — so an all-empty or all-admitted result fails instead of
 * passing quietly.
 *
 * SCOPE: this file guards the two column forms of ONE function against each other. It
 * deliberately does NOT touch the boundary between the TS claim path and the queryable
 * SQL SSOT (`work_item_claim_floors` / `work_items_claimable`), which plan decision
 * D-003 + memory fact ea2d0dd6 require to stay physically separate — merging those
 * would regress federation own-node recovery and drop floor-11's own-lease exemption.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const eng = await import('./issues-engineer');

const H = 'papercup';
const WS = 'default';
const ACTIVE_PLAN = 'plan-running';
const IDLE_PLAN = 'plan-shipped';
let db: FreshPgDb;

interface SeedOpts {
  title?: string;
  payload?: Record<string, unknown>;
  origin?: string;
  createdBy?: string;
  terminalOwner?: string;
  terminalCompletionRef?: string;
  authority?: string;
}

async function seedIssue(id: string, opts: SeedOpts = {}) {
  // `created_by` is not a column — the engineer_issues view derives it from
  // payload->'_ei'->>'created_by', so it has to be seeded through the payload.
  const payload: Record<string, unknown> = { ...(opts.payload ?? {}) };
  if (opts.createdBy) payload._ei = { created_by: opts.createdBy };
  const hasPayload = Object.keys(payload).length > 0;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       payload, origin, terminal_owner, terminal_completion_ref, authority)
    VALUES (${H}, ${id}, 'bug', ${opts.title ?? `title ${id}`}, 'open', ${null},
       ${WS}, 0, 0,
       ${hasPayload ? db.sql.json(payload as unknown as Parameters<typeof db.sql.json>[0]) : null},
       ${opts.origin ?? 'local'},
       ${opts.terminalOwner ?? null}, ${opts.terminalCompletionRef ?? null}, ${opts.authority ?? null})`;
}

/**
 * Evaluate the REAL fragment the function returns, in the column form the branch is
 * written for: the unaliased one against the bare view, the aliased one against the
 * `ei.`-aliased shape its call sites (the topic-JOINed count branches) actually use.
 */
async function admittedBy(aliased: boolean): Promise<string[]> {
  const rows = aliased
    ? await db.sql<{ issue_id: string }[]>`
        SELECT ei.issue_id
          FROM harness_shared.engineer_issues ei
         WHERE ei.workspace_id = ${WS}
           AND ${eng.issueAdmissibleWhereSql(db.sql, true)}
         ORDER BY ei.issue_id`
    : await db.sql<{ issue_id: string }[]>`
        SELECT issue_id
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${WS}
           AND ${eng.issueAdmissibleWhereSql(db.sql, false)}
         ORDER BY issue_id`;
  return rows.map((r) => r.issue_id);
}

/** Both admitted sets, plus the assertion that they ARE the same set. */
async function agreedAdmittedIds(): Promise<string[]> {
  const unaliased = await admittedBy(false);
  const aliased = await admittedBy(true);
  // THE POINT OF THIS FILE: the column form must not change which rows are admitted.
  expect(aliased).toEqual(unaliased);
  return unaliased;
}

/** Rows every floor must REFUSE — one per floor, in the order they appear in the SQL. */
const REFUSED: { floor: string; id: string; seed: SeedOpts }[] = [
  { floor: 'federated (origin != local)', id: 'WI-REMOTE', seed: { origin: 'remote' } },
  { floor: 'observation lane', id: 'WI-OBS', seed: { payload: { lane: 'observation' } } },
  {
    floor: 'replication-liveness detector filer',
    id: 'WI-DETECTOR',
    seed: { createdBy: 'system:replication-liveness' },
  },
  { floor: 'claim hold', id: 'WI-HOLD', seed: { payload: { _claimHold: true } } },
  { floor: 'routed to a human', id: 'WI-HUMAN', seed: { payload: { needsHuman: true } } },
  { floor: 'loop-wake marker', id: 'WI-WAKE', seed: { title: 'Loop wake #9775: continue papercusp drain' } },
  { floor: 'AUTO-loop marker', id: 'WI-AUTO', seed: { title: 'AUTO loop iteration: delta rollout contract' } },
  {
    floor: 'terminally completed (owner + completion ref)',
    id: 'WI-DONE-REF',
    seed: { terminalOwner: 'su-someone', terminalCompletionRef: 'WI-DONE-REF#completion' },
  },
  {
    floor: 'terminally completed (owner + authority)',
    id: 'WI-DONE-AUTH',
    seed: { terminalOwner: 'su-someone', authority: 'committed' },
  },
  {
    floor: 'ACTIVE external blocker',
    id: 'WI-BLOCKED',
    seed: { payload: { externalBlockers: [{ ref: 'mac-rig-vm', kind: 'runtime', status: 'active' }] } },
  },
  {
    floor: 'reserved to an ACTIVELY-driven plan lane',
    id: 'WI-PLAN-ACTIVE',
    seed: { payload: { plan_item: { plan_slug: ACTIVE_PLAN, item_id: 'P-001' } } },
  },
  {
    floor: 'reserved by a LIVE plan-item lease',
    id: 'WI-PLAN-LEASED',
    seed: { payload: { plan_item: { plan_slug: IDLE_PLAN, item_id: 'P-LEASED' } } },
  },
];

/**
 * NEAR-MISS rows every floor must ADMIT. Over-exclusion is the dual defect — a fleet
 * idling while claimable work exists — and a branch that over-excludes is just as much
 * a divergence as one that under-excludes, so the equivalence is asserted on these too.
 *
 * (No `origin IS NULL` case: the fixture's work_items.origin is NOT NULL DEFAULT 'local',
 * so that leg of the OR is unreachable from here. It is covered by the `origin = 'local'`
 * row above admitting, which is the same branch of the same predicate.)
 */
const ADMITTED: { control: string; id: string; seed: SeedOpts }[] = [
  { control: 'a plain local row', id: 'WI-CLEAN', seed: {} },
  { control: 'a non-observation lane', id: 'WI-LANE-OK', seed: { payload: { lane: 'bug' } } },
  { control: 'some other filer', id: 'WI-FILER-OK', seed: { createdBy: 'su-someone' } },
  { control: '_claimHold explicitly false', id: 'WI-HOLD-OFF', seed: { payload: { _claimHold: false } } },
  { control: 'needsHuman explicitly false', id: 'WI-HUMAN-OFF', seed: { payload: { needsHuman: false } } },
  {
    // Guards against "fixing" the marker floors into substring matches, which would
    // swallow legitimate work — e.g. a bug report ABOUT the loop-wake markers.
    control: 'a title merely MENTIONING a loop wake (prefix-anchored, not substring)',
    id: 'WI-ABOUT',
    seed: { title: 'Stale "Loop wake #" rows are advertised but unclaimable' },
  },
  {
    control: 'a BARE terminal_owner (neither ref nor authority) is not a real completion',
    id: 'WI-BARE-OWNER',
    seed: { terminalOwner: 'su-someone' },
  },
  {
    control: 'a RESOLVED external blocker',
    id: 'WI-CLEARED',
    seed: { payload: { externalBlockers: [{ ref: 'mac-rig-vm', status: 'resolved' }] } },
  },
  { control: 'an EMPTY externalBlockers array', id: 'WI-EMPTY-BLOCKERS', seed: { payload: { externalBlockers: [] } } },
  {
    control: 'a plan_item on an idle plan whose lease has EXPIRED',
    id: 'WI-PLAN-FREE',
    seed: { payload: { plan_item: { plan_slug: IDLE_PLAN, item_id: 'P-EXPIRED' } } },
  },
];

beforeAll(async () => {
  db = await createFreshPgDb('issue-admissible-branch-equivalence');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.harness_plans, harness_shared.plan_item_claims`;
  // The plan-lane floor reads BOTH an active plan and a live item lease, so both
  // fixtures are always present and the seeded rows choose which one they land on.
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
    VALUES (${WS}, ${H}, ${ACTIVE_PLAN}, 'active'), (${WS}, ${H}, ${IDLE_PLAN}, 'shipped')`;
  await db.sql`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
    VALUES (${WS}, ${H}, ${IDLE_PLAN}, 'P-LEASED',  'su-holder', now() + interval '1 hour'),
           (${WS}, ${H}, ${IDLE_PLAN}, 'P-EXPIRED', 'su-holder', now() - interval '1 hour')`;
});

describe('WI-37827: both column forms of issueAdmissibleWhereSql enforce every floor identically', () => {
  it.each(REFUSED)('$floor — refused by BOTH column forms', async ({ id, seed }) => {
    await seedIssue('WI-CONTROL');
    await seedIssue(id, seed);
    // Exact set, not `.not.toContain`: this simultaneously proves the floor fired on the
    // seeded row AND that it did not swallow the control, so neither an empty result nor
    // an excludes-everything predicate can satisfy it.
    expect(await agreedAdmittedIds()).toEqual(['WI-CONTROL']);
  });

  it.each(ADMITTED)('$control — admitted by BOTH column forms', async ({ id, seed }) => {
    await seedIssue(id, seed);
    expect(await agreedAdmittedIds()).toEqual([id]);
  });

  it('with EVERY case seeded at once, the two forms admit exactly the same id set', async () => {
    for (const c of [...REFUSED, ...ADMITTED]) await seedIssue(c.id, c.seed);
    const expected = ADMITTED.map((c) => c.id).sort();
    // The whole-population form of the per-case tests above: any floor present in one
    // column form and absent (or differently written) in the other moves an id across
    // this boundary, in whichever direction, and fails naming it.
    expect(await agreedAdmittedIds()).toEqual(expected);
  });

  it('the probe really is evaluating the predicate (positive control: without it, nothing is withheld)', async () => {
    // Guards the guard. If both probes silently degraded to something vacuous — a
    // predicate that errored into TRUE, a fixture that stopped seeding — every assertion
    // above could still pass. This pins that the seeded population is genuinely LARGER
    // than the admitted one, i.e. the predicate is doing work.
    for (const c of [...REFUSED, ...ADMITTED]) await seedIssue(c.id, c.seed);
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = ${WS}`;
    expect(n).toBe(REFUSED.length + ADMITTED.length);
    expect((await agreedAdmittedIds()).length).toBe(ADMITTED.length);
    expect(REFUSED.length).toBeGreaterThan(0);
  });
});
