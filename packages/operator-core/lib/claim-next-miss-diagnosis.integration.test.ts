/**
 * claim-next-miss-diagnosis.integration.test.ts — EI-5919.
 *
 * `work_items:claim_next` returned a bare "no claimable work-item" for TWO very different
 * states, so a bee that followed "claim_next null ⇒ queue DRAINED ⇒ idle" idled on a
 * FULL-but-blocked backlog (the EI-5803 "fleet saturated with work still queued" signal).
 * The repro was: 40+ todo items existed, unclaimed, yet claim_next returned null — while a
 * direct `work_items:claim(id)` on one of them SUCCEEDED. That asymmetry is BY DESIGN (a
 * named claim bypasses the status/readiness floors self-select enforces), but the null was
 * indistinguishable from a genuinely drained queue.
 *
 * The fix: `diagnoseClaimNextMiss` (work-items.ts) — run only on a claim MISS — reports
 *   • drained          — true iff there is NO unclaimed claimable-status work at all.
 *   • pendingUnclaimed — the admissible unclaimed POOL (before readiness/affinity/redundancy).
 *   • readyUnclaimed   — of that pool, how many pass ALL claim_next floors.
 *
 * This test proves the three cases + the core asymmetry: an item claim_next refuses (blocked)
 * is reported drained:false / pendingUnclaimed:1, AND is directly claimable by id — exactly
 * the EI-5919 divergence, now diagnosable instead of silently idling.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/claim-next-miss-diagnosis.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedFeature(id: string, opts: { status?: string; takenBy?: string | null; createdTs?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'todo'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0)`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-next-miss-diagnosis');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  // Pin the INLINE readiness path (the reversible default) so the diagnosis is deterministic
  // without the maintained sidecar table.
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claim_next miss diagnosis — drained vs present-but-unclaimable (EI-5919)', () => {
  it('DRAINED: empty queue ⇒ drained:true, pendingUnclaimed:0', async () => {
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0 });
  });

  it('PRESENT-but-BLOCKED: claim_next misses, but the item exists and is DIRECTLY claimable — the EI-5919 divergence', async () => {
    // The only unclaimed todo is blocked by a non-terminal feature. claim_next (readiness
    // floor) refuses it; a direct claim(id) (named-assignment exception) takes it.
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');

    // claim_next hands out nothing (the blocked item is not self-selectable).
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    // The diagnosis says: NOT drained — 1 unclaimed item exists in the pool, 0 ready.
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag.drained).toBe(false);
    expect(diag.pendingUnclaimed).toBe(1);
    expect(diag.readyUnclaimed).toBe(0);

    // …and the SAME item is directly claimable by id (the divergence the bug reported).
    const claimed = await wi.claimWorkItem('F-blocked', 'w1', { harness: H });
    expect(claimed?.id).toBe('F-blocked');
  });

  it('READY-BUT-RACED: an unblocked item that a peer already took ⇒ drained:false, pendingUnclaimed:0 after it is claimed; drained flips true when the pool empties', async () => {
    await seedFeature('F-ready', { status: 'todo', createdTs: 100 });

    // Before any claim: it is both pending and ready.
    const before = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(before).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1 });

    // A peer self-selects it (claim_next succeeds — control that the happy path still works).
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'peer' });
    expect(got?.id).toBe('F-ready');

    // Now the queue is genuinely drained: the only item is claimed.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
    const after = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(after).toEqual({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0 });
  });

  it('BLOCKER GOES TERMINAL: the pending item becomes ready ⇒ readyUnclaimed rises and claim_next then serves it', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');

    // Blocked: present but not ready.
    let diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 0 });

    // Flip the blocker terminal ⇒ readiness satisfied.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status = 'passed' WHERE feature_id = 'F-blocker'`;
    diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1 });

    // claim_next now serves the newly-ready item.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(got?.id).toBe('F-blocked');
  });
});
