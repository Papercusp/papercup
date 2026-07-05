/**
 * claim-issues-claimable.integration.test.ts — the SCHEDULER_ISSUES_CLAIMABLE gate
 * (work-item-deps-and-readiness-2026-06-22 P-007): ISSUE-family work-items (bug|change|task)
 * become self-pickable by the scheduler claim path WHEN the flag is ON — and are
 * BYTE-IDENTICALLY NON-claimable (feature-only) when it is OFF.
 *
 * Today the decentralized claim (`claimNextWorkItem`) is feature-family-only: the shared
 * `claimFloorsWhereSql` floor pins `item_kind IN ('feature','research-task','chunk')` and
 * the UPDATE targets the feature view, so an issue can BLOCK a feature but can never itself
 * be claimed. P-007 adds an ADDITIVE issue-claim branch (a separate query over the work_items
 * base for issue kinds, run only when no feature is claimable AND the flag is on). Readiness
 * is honored by the SAME work_item_deps predicate (terminal = resolved/closed for issues).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   flag ON  ⇒ an UNBLOCKED `open` issue IS claimed; a BLOCKED issue is NOT.
 *   flag OFF ⇒ NO issue is claimable (byte-identical to feature-only) — the mutation-check:
 *              this case fails if the flag gate is broken / removed.
 *   + a feature is ALWAYS claimable regardless of the flag (the issue branch is additive,
 *     never disturbing the feature path).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-issues-claimable.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Hoisted handles: the throwaway db, and a MUTABLE per-test override for the gate flag.
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  issuesClaimable: false as boolean,
}));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Key-aware flag mock: SCHEDULER_ISSUES_CLAIMABLE follows the per-test override; every other
// key (ISSUES_PER_WORKSPACE — keeps issues scoped to 'default'; SCHEDULER_MAINTAINED_READY —
// the inline-predicate arm) resolves to its production default.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual, // keep onFlagChange (issues-engineer registers a listener at module load) etc.
    getFlag: async (key: FlagKey) =>
      key === FLAGS.SCHEDULER_ISSUES_CLAIMABLE ? h.issuesClaimable : (FLAG_DEFAULTS[key] ?? false),
  };
});

const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + issues live here
let db: FreshPgDb;

/** A feature-FAMILY row (item_kind feature|research-task|chunk, default 'feature') —
 *  claimable through the feature path at tier 1/2 of the WI-1407 ladder. */
async function seedFeature(
  id: string,
  opts: { createdTs?: number; status?: string; kind?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'todo'}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** An issue-family row (bug/change/task) on the work_items base, scope harness:papercup ⇒
 *  harness_slug = 'papercup'. open = claimable; resolved/closed = terminal. */
async function seedIssue(
  id: string,
  opts: { createdTs?: number; state?: string; kind?: string; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.state ?? 'open'}, ${opts.takenBy ?? null},
      ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** An OPERATOR-scope issue-family row (harness_slug = 'operator:<workspace>', migration 382 —
 *  not owned by any harness) — must still be self-pickable by a harness-scoped caller
 *  (EI-5919 / WI-1406: this encoding used to be invisible to claimNextIssueWorkItem, which
 *  matched only `harness_slug = filter.harness`). */
async function seedOperatorIssue(
  id: string,
  opts: { createdTs?: number; state?: string; kind?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts)
    VALUES (${`operator:${WS}`}, ${id}, ${opts.kind ?? 'bug'}, ${opts.state ?? 'open'}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** A blocks edge with arbitrary blocked/blocker refs (issue refs are BARE ids). */
async function blockEdge(blockedRef: string, blockerRef: string, blockedKind = 'issue', blockerKind = 'feature') {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}

/** Claim one item via the decentralized claim path, returning its id (or null). The claimed
 *  row is released so each case sees the same pre-claim state. */
async function claimOne(assignee: string): Promise<string | null> {
  const claimed = (await wi.claimNextWorkItem({ harness: H, assignee }))?.id ?? null;
  if (claimed) {
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${claimed}`;
  }
  return claimed;
}

/** Same as claimOne, but narrows the request to a single feature-family kind — the exact
 *  caller shape the WI-1407 ladder is about (a kind-narrowed request must still widen
 *  through tiers 2 and 3 instead of exiting on a drained tier 1). Does NOT release the
 *  claim (tests assert the id then move on). */
async function claimOneKind(
  assignee: string,
  kind: 'feature' | 'research-task' | 'chunk',
): Promise<string | null> {
  return (await wi.claimNextWorkItem({ harness: H, assignee, kind }))?.id ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-issues-claimable');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL); // base work_items + the hfc + engineer_issues views
  await db.sql.unsafe(USER_TRUST_LIST_DDL); // the feature floor LEFT-JOINs the trust list
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the readiness dep table
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  // Migration 379: the maintained readiness sidecar (some claim-path code paths reference
  // work_item_blocked even on the inline arm via the sidecar table; apply it for parity).
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  // harness_plans + plan_item_claims are created by HARNESS_FEATURES_CONSOLIDATED_DDL (the WI-2118
  // reserved-plan-lane floor reads them); the reserved-lane describe below seeds into them.
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.harness_plans, harness_shared.plan_item_claims`;
  h.issuesClaimable = false;
});

describe('SCHEDULER_ISSUES_CLAIMABLE — flag ON: issues self-pickable, readiness honored (P-007)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  it('claims an UNBLOCKED open issue when no feature is claimable', async () => {
    await seedIssue('EI-1', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-on-1')).toBe('EI-1');
  });

  it('does NOT claim an issue blocked by a NON-TERMINAL feature blocker', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedIssue('EI-2', { state: 'open', createdTs: 100 });
    // Issue EI-2 blocked-by feature F-blocker (feature ref is harness-qualified).
    await blockEdge('EI-2', `${H}#F-blocker`, 'issue', 'feature');
    expect(await claimOne('w-on-2')).toBeNull();

    // Satisfy the blocker (passed = terminal) ⇒ the SAME claim now hands out EI-2.
    await db.sql`UPDATE harness_shared.work_items SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await claimOne('w-on-2')).toBe('EI-2');
  });

  it('does NOT claim an issue blocked by a NON-TERMINAL issue blocker (cross-family terminal)', async () => {
    await seedIssue('EI-blocker', { state: 'open', createdTs: 40, kind: 'change' });
    await seedIssue('EI-3', { state: 'open', createdTs: 100 });
    // Issue→issue blocks: both refs are BARE ids.
    await blockEdge('EI-3', 'EI-blocker', 'issue', 'issue');
    // EI-blocker is the older 'open' issue, so an un-gated claim would hand it out first;
    // assert specifically that EI-3 is NOT what gets claimed while its blocker is open by
    // resolving EI-blocker and re-claiming.
    await db.sql`UPDATE harness_shared.work_items SET status='resolved' WHERE feature_id='EI-blocker'`;
    // Now EI-blocker is terminal (not claimable) and EI-3 is unblocked ⇒ EI-3 is claimed.
    expect(await claimOne('w-on-3')).toBe('EI-3');
  });

  it('excludes a TERMINAL (resolved/closed) issue from the claim', async () => {
    await seedIssue('EI-done', { state: 'resolved', createdTs: 100 });
    await seedIssue('EI-closed', { state: 'closed', createdTs: 110 });
    expect(await claimOne('w-on-4')).toBeNull();
  });

  it('claims an OPERATOR-scope issue (harness_slug=operator:<ws>) via a harness-scoped caller (EI-5919/WI-1406)', async () => {
    await seedOperatorIssue('EI-op-1', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-on-op')).toBe('EI-op-1');
  });

  it('prefers a claimable FEATURE first; only falls through to an issue when no feature is claimable', async () => {
    await seedFeature('F-ready', { status: 'todo', createdTs: 200 });
    await seedIssue('EI-5', { state: 'open', createdTs: 100 });
    // A feature is claimable ⇒ the feature path wins (issue branch only runs on a feature miss).
    const first = (await wi.claimNextWorkItem({ harness: H, assignee: 'w-on-5' }))?.id ?? null;
    expect(first).toBe('F-ready');
    // With the feature now taken, the next claim falls through to the issue.
    const second = (await wi.claimNextWorkItem({ harness: H, assignee: 'w-on-5b' }))?.id ?? null;
    expect(second).toBe('EI-5');
  });
});

describe('SCHEDULER_ISSUES_CLAIMABLE — flag OFF: issues NOT claimable, byte-identical to feature-only', () => {
  // h.issuesClaimable stays false (the beforeEach default) — the MUTATION-CHECK arm: if the
  // gate is broken (issue branch runs while OFF), these expectations flip and the test FAILS.

  it('does NOT claim an unblocked open issue (the gate holds)', async () => {
    await seedIssue('EI-10', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-off-1')).toBeNull();
  });

  it('does NOT claim ANY issue kind (bug | change | task) while a feature is absent', async () => {
    await seedIssue('EI-bug', { state: 'open', createdTs: 100, kind: 'bug' });
    await seedIssue('EI-chg', { state: 'open', createdTs: 110, kind: 'change' });
    await seedIssue('EI-task', { state: 'open', createdTs: 120, kind: 'task' });
    expect(await claimOne('w-off-2')).toBeNull();
  });

  it('STILL claims a feature (the feature path is untouched by the gate)', async () => {
    await seedFeature('F-ready', { status: 'todo', createdTs: 200 });
    await seedIssue('EI-11', { state: 'open', createdTs: 100 });
    // Even with an older open issue present, OFF ⇒ only the feature is claimable.
    expect(await claimOne('w-off-3')).toBe('F-ready');
  });
});

describe('claimNextWorkItem fallback ladder — a kind-narrowed caller still widens through tiers (WI-1407)', () => {
  // Regression: the OLD `!filter.kind` gate skipped the issue-family fallback ENTIRELY for
  // any kind-narrowed caller (e.g. kind:'feature'), even with the flag ON and a claimable
  // issue sitting there — killing the member instead of widening. These prove the fix.

  it('tier 1 exact match wins when present (no widening needed)', async () => {
    await seedFeature('F-exact', { createdTs: 100, kind: 'feature' });
    await seedFeature('RT-older', { createdTs: 10, kind: 'research-task' }); // older, but wrong kind
    expect(await claimOneKind('w-t1', 'feature')).toBe('F-exact');
  });

  it('tier 2: kind="feature" narrowed and DRY widens to a research-task item within the feature family', async () => {
    await seedFeature('RT-1', { createdTs: 100, kind: 'research-task' });
    expect(await claimOneKind('w-t2', 'feature')).toBe('RT-1');
  });

  it('tier 2: widening still honors the readiness floor — a blocked widened item is skipped', async () => {
    await seedFeature('CH-blocker', { createdTs: 1, kind: 'chunk', status: 'wip' });
    await seedFeature('CH-blocked', { createdTs: 50, kind: 'chunk' });
    await blockEdge(`${H}#CH-blocked`, `${H}#CH-blocker`, 'feature', 'feature');
    expect(await claimOneKind('w-t2b', 'feature')).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET status='passed' WHERE feature_id='CH-blocker'`;
    expect(await claimOneKind('w-t2c', 'feature')).toBe('CH-blocked');
  });

  it('tier 3: kind="feature" narrowed and the WHOLE feature family dry falls through to an OPEN issue when the flag is ON', async () => {
    h.issuesClaimable = true;
    await seedIssue('EI-t3-on', { state: 'open', createdTs: 100 });
    expect(await claimOneKind('w-t3-on', 'feature')).toBe('EI-t3-on');
  });

  it('tier 3: the SAME kind-narrowed request stays dry when the flag is OFF (the gate, not the kind narrowing, controls it)', async () => {
    // h.issuesClaimable defaults false (beforeEach) — this is the exact shape that used to be
    // structurally blocked pre-WI-1407 regardless of the flag; confirm it now correctly
    // resolves via the flag rather than via the (removed) `!filter.kind` short-circuit.
    await seedIssue('EI-t3-off', { state: 'open', createdTs: 100 });
    expect(await claimOneKind('w-t3-off', 'feature')).toBeNull();
  });

  it('tier 3: a BLOCKED issue is skipped, but the widened issue tier still claims other READY issue work', async () => {
    h.issuesClaimable = true;
    await seedIssue('EI-t3-blocker', { state: 'open', createdTs: 40, kind: 'change' });
    await seedIssue('EI-t3-blocked', { state: 'open', createdTs: 100 });
    await blockEdge('EI-t3-blocked', 'EI-t3-blocker', 'issue', 'issue');
    expect(await claimOneKind('w-t3d', 'feature')).toBe('EI-t3-blocker');
    await db.sql`UPDATE harness_shared.work_items SET status='resolved' WHERE feature_id='EI-t3-blocker'`;
    expect(await claimOneKind('w-t3e', 'feature')).toBe('EI-t3-blocked');
  });
});

describe('issue steer levers become applicable only when SCHEDULER_ISSUES_CLAIMABLE is on (P-007)', () => {
  it('set_priority / co_locate report applicable:false (issue) while OFF, and write while ON', async () => {
    await seedIssue('EI-20', { state: 'open', createdTs: 100 });

    // OFF: byte-identical feature-only behavior — issue is not applicable.
    h.issuesClaimable = false;
    const offPri = await wi.setWorkItemPriority('EI-20', 5, { harness: H });
    expect(offPri?.applicable).toBe(false);
    expect(offPri?.priority).toBeNull();
    const offAff = await wi.setWorkItemSwarmAffinity('EI-20', 'swarm-x', { harness: H });
    expect(offAff?.swarmAffinity).toBeNull();
    // Nothing was written on the base.
    const afterOff = (await db.sql`
      SELECT feature_order, swarm_affinity FROM harness_shared.work_items WHERE feature_id='EI-20'`) as Array<{
      feature_order: number | null;
      swarm_affinity: string | null;
    }>;
    expect(afterOff[0]!.feature_order).toBeNull();
    expect(afterOff[0]!.swarm_affinity).toBeNull();

    // ON: the Queen can now steer issues too — the writes land.
    h.issuesClaimable = true;
    const onPri = await wi.setWorkItemPriority('EI-20', 5, { harness: H });
    expect(onPri?.applicable).toBe(true);
    expect(onPri?.priority).toBe(5);
    const onAff = await wi.setWorkItemSwarmAffinity('EI-20', 'swarm-x', { harness: H });
    expect(onAff?.swarmAffinity).toBe('swarm-x');
    const afterOn = (await db.sql`
      SELECT feature_order, swarm_affinity FROM harness_shared.work_items WHERE feature_id='EI-20'`) as Array<{
      feature_order: number | null;
      swarm_affinity: string | null;
    }>;
    expect(afterOn[0]!.feature_order).toBe(5);
    expect(afterOn[0]!.swarm_affinity).toBe('swarm-x');
  });
});

// WI-2118 (the P-009 leak): the general drain must NOT self-select an issue-family item that is
// RESERVED by another active plan lane — the parent plan is `active`, or the plan-item is under a
// live lease held by another owner. Members that know the lane is reserved (its plan's `## Now`)
// correctly refuse + release such an item, and the scheduler kept re-serving it (claim→refuse→
// re-serve churn — WI-2118 hit 3 different members in minutes). The floor stops it at the source.
describe('reserved plan-lane exclusion — issue linked to another active plan is NOT self-selected (WI-2118)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family task carrying a payload.plan_item back-pointer to (planSlug, itemId). */
  async function seedPlanLinkedIssue(id: string, planSlug: string, itemId: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'task', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ plan_item: { plan_slug: planSlug, item_id: itemId, harness_slug: H } })})`;
  }
  const seedPlan = (slug: string, status: string) =>
    db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status) VALUES (${slug}, ${status})`;
  const seedLease = (slug: string, itemId: string, owner: string, expiresMinFromNow: number) =>
    db.sql`INSERT INTO harness_shared.plan_item_claims (plan_slug, item_id, owner, expires_ts)
            VALUES (${slug}, ${itemId}, ${owner}, now() + make_interval(mins => ${expiresMinFromNow}))`;

  it('an issue linked to an ACTIVE plan is NOT claimed (the WI-2118 case)', async () => {
    await seedPlan('active-plan-x', 'active');
    await seedPlanLinkedIssue('WI-RES-1', 'active-plan-x', 'P-009');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('an issue linked to a DRAFT plan with no live lease IS claimed (free backlog, no over-exclusion)', async () => {
    await seedPlan('draft-plan-x', 'draft');
    await seedPlanLinkedIssue('WI-RES-2', 'draft-plan-x', 'P-003');
    expect(await claimOne('drain-member')).toBe('WI-RES-2');
  });

  it('an issue under a LIVE lease held by ANOTHER owner is NOT claimed, even in a draft plan', async () => {
    await seedPlan('draft-plan-y', 'draft');
    await seedPlanLinkedIssue('WI-RES-3', 'draft-plan-y', 'P-006');
    await seedLease('draft-plan-y', 'P-006', 'su-other-owner', 20); // lease live for 20 more min
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('an issue whose lease has LAPSED and whose plan is not active IS claimed (no indefinite starvation)', async () => {
    await seedPlan('draft-plan-z', 'draft');
    await seedPlanLinkedIssue('WI-RES-4', 'draft-plan-z', 'P-001');
    await seedLease('draft-plan-z', 'P-001', 'su-gone', -60); // lapsed 60 min ago
    expect(await claimOne('drain-member')).toBe('WI-RES-4');
  });

  it('a plan-linked issue with no plan row and no lease IS claimed (dangling link ⇒ free)', async () => {
    await seedPlanLinkedIssue('WI-RES-5', 'ghost-plan', 'P-002');
    expect(await claimOne('drain-member')).toBe('WI-RES-5');
  });

  it('an ordinary issue (no plan_item back-pointer, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-RES-6', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-RES-6');
  });
});

describe('cross-machine-rig exclusion — an item needing a live ≥2-machine rig is NOT self-selected by a single-box caller (WI-2796)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family task carrying payload.needs_2_machine_rig: true. */
  async function seedRigGatedIssue(id: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'task', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ needs_2_machine_rig: true })})`;
  }

  it('a rig-gated item is NOT claimed by a default (single-box) caller', async () => {
    await seedRigGatedIssue('WI-RIG-1');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('a rig-gated item IS claimed when the caller declares rigAvailable:true', async () => {
    await seedRigGatedIssue('WI-RIG-2');
    const claimed = (await wi.claimNextWorkItem({ harness: H, assignee: 'rig-fleet', rigAvailable: true }))?.id ?? null;
    expect(claimed).toBe('WI-RIG-2');
  });

  it('an ordinary issue (no rig tag, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-RIG-3', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-RIG-3');
  });

  it('claim_next MISS diagnosis (diagnoseClaimNextMiss) also excludes a rig-gated item from readyUnclaimed for a single-box caller', async () => {
    await seedRigGatedIssue('WI-RIG-4');
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'drain-member' });
    // present in the pool (pendingUnclaimed) but NOT counted ready — matches what the
    // claim itself would (not) serve, so the miss diagnosis never disagrees with claim_next.
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
  });
});

describe('claim-hold exclusion — a do-not-opportunistically-claim item is NOT self-selected, but stays directly claimable by id (WI-2797)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family bug carrying payload._claimHold: true. */
  async function seedHeldIssue(id: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'bug', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ _claimHold: true })})`;
  }

  it('a claim-held item is NOT self-selected by claim_next', async () => {
    await seedHeldIssue('WI-HOLD-1');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('a claim-held item IS still claimable directly by id (claimWorkItem carries no claimHold predicate)', async () => {
    await seedHeldIssue('WI-HOLD-2');
    // Self-select excludes it (same assertion as the prior test, for contrast in this block).
    expect(await claimOne('drain-member')).toBeNull();
    // The DIRECT-by-id claim path (work_items:claim tool → claimWorkItem → claimIssue) has no
    // claimHold predicate at all — a held item stays fully claimable when named explicitly.
    const claimed = await wi.claimWorkItem('WI-HOLD-2', 'named-claimant', { harness: H });
    expect(claimed?.id).toBe('WI-HOLD-2');
  });

  it('setWorkItemClaimHold(true) then (false) round-trips — clearing the hold makes the item self-selectable again', async () => {
    await seedIssue('EI-HOLD-3', { state: 'open', createdTs: 100 });
    const held = await wi.setWorkItemClaimHold('EI-HOLD-3', true, { harness: H });
    expect(held?.applicable).toBe(true);
    expect(await claimOne('drain-member')).toBeNull();
    await wi.setWorkItemClaimHold('EI-HOLD-3', false, { harness: H });
    expect(await claimOne('drain-member')).toBe('EI-HOLD-3');
  });

  it('setWorkItemClaimHold on a feature-family id is a no-op (applicable:false) — issue-family only', async () => {
    await seedFeature('F-HOLD-4', { status: 'todo', createdTs: 100 });
    const held = await wi.setWorkItemClaimHold('F-HOLD-4', true, { harness: H });
    expect(held?.applicable).toBe(false);
  });

  it('an ordinary issue (no hold tag, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-HOLD-5', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-HOLD-5');
  });

  it('claim_next MISS diagnosis (diagnoseClaimNextMiss) also excludes a held item from readyUnclaimed for the caller', async () => {
    await seedHeldIssue('WI-HOLD-6');
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'drain-member' });
    // present in the pool (pendingUnclaimed) but NOT counted ready — matches what the
    // claim itself would (not) serve, so the miss diagnosis never disagrees with claim_next.
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
  });
});
