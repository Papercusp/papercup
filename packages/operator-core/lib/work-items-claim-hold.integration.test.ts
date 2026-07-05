/**
 * work-items-claim-hold.integration.test.ts — WI-2797: the issue-family "claim hold"
 * self-select exclusion.
 *
 * Issue-family work-items (bug/change/task) have only open|resolved|closed — no non-terminal
 * "parked" state — so an item that must NOT be opportunistically self-picked (e.g. "needs a
 * dedicated gateway-owning agent, do not pick up", the WI-652 ping-pong that motivated this)
 * had nowhere to go: it stayed `open` = perpetually top-of-pool claimable, and every
 * self-selecting agent that declined it just handed it back to the next one (the recurring
 * claim_next ping-pong). `payload._claimHold: true` is the fix: a scoped, additive,
 * no-migration tag (setWorkItemClaimHold) that removes an item from `claimNextIssueWorkItem`
 * self-select (and the matching `diagnoseClaimNextMiss` ready-count) while leaving it fully
 * visible/editable/commentable and still directly claimable BY ID.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • setWorkItemClaimHold sets/clears payload._claimHold on an issue-family row;
 *   • it is a no-op (`applicable:false`, no payload mutation) on a feature-family row;
 *   • claimNextWorkItem's issue tier SKIPS a held item and serves an unheld one instead;
 *   • a held item is STILL directly claimable by id (claimWorkItem bypasses the hold);
 *   • diagnoseClaimNextMiss reports a held-only backlog as pending-but-NOT-ready (genuinely
 *     gated — don't idle, but don't hot-retry either), never a false "drained" or a false race;
 *   • clearing the hold makes the item self-selectable again.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-hold.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
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

/** An issue-family (bug/change/task) row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload) : null})`;
}

async function seedFeature(id: string, opts: { createdTs?: number; status?: string } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'todo'}, NULL, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

async function readPayload(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return rows[0]?.payload ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-hold');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.harness_features_consolidated, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('setWorkItemClaimHold (WI-2797)', () => {
  it('sets payload._claimHold:true on an issue-family row', async () => {
    await seedIssue('WI-hold-1');
    const res = await wi.setWorkItemClaimHold('WI-hold-1', true, { harness: H });
    expect(res).toMatchObject({ id: 'WI-hold-1', hold: true, applicable: true });
    expect(await readPayload('WI-hold-1')).toMatchObject({ _claimHold: true });
  });

  it('clears payload._claimHold on hold:false (idempotent when already absent)', async () => {
    await seedIssue('WI-hold-2', { payload: { _claimHold: true, other: 'kept' } });
    const res = await wi.setWorkItemClaimHold('WI-hold-2', false, { harness: H });
    expect(res).toMatchObject({ id: 'WI-hold-2', hold: false, applicable: true });
    const payload = await readPayload('WI-hold-2');
    expect(payload).not.toHaveProperty('_claimHold');
    expect(payload).toMatchObject({ other: 'kept' }); // sibling payload keys survive the clear
  });

  it('is a no-op on a feature-family item (applicable:false, no payload mutation)', async () => {
    await seedFeature('F-hold-1');
    const res = await wi.setWorkItemClaimHold('F-hold-1', true, { harness: H });
    expect(res).toMatchObject({ applicable: false, hold: false });
    const rows = await db.sql<{ payload: unknown }[]>`
      SELECT payload FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${H} AND feature_id = 'F-hold-1'`;
    // harness_features_consolidated has no payload column in this DDL — the no-op path never
    // even attempts the work_items UPDATE, so nothing here was touched (still todo/unclaimed).
    expect(rows).toHaveLength(1);
  });

  it('returns null for an id that does not exist', async () => {
    expect(await wi.setWorkItemClaimHold('WI-nonexistent', true, { harness: H })).toBeNull();
  });
});

describe('claimNextWorkItem SKIPS a claim-held issue (WI-2797)', () => {
  it('serves the unheld item, never the held one, when both are otherwise ready', async () => {
    await seedIssue('WI-held', { createdTs: 100, payload: { _claimHold: true } });
    await seedIssue('WI-open', { createdTs: 200 });

    // Oldest-first would normally serve WI-held (createdTs:100) — the hold must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-open');

    // Only one unheld candidate existed — it's now claimed, so the pool is genuinely dry.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    // The held item was NEVER claimed by the self-select path.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-held'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('a held item is STILL directly claimable by id (the hold only excludes self-select)', async () => {
    await seedIssue('WI-held-direct', { createdTs: 100, payload: { _claimHold: true } });
    const claimed = await wi.claimWorkItem('WI-held-direct', 'bee-direct', { harness: H });
    expect(claimed?.id).toBe('WI-held-direct');
    expect(claimed?.assignee).toBe('bee-direct');
  });

  it('clearing the hold makes the item self-selectable again', async () => {
    await seedIssue('WI-unheld-later', { createdTs: 100, payload: { _claimHold: true } });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toBeNull();

    await wi.setWorkItemClaimHold('WI-unheld-later', false, { harness: H });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' });
    expect(got?.id).toBe('WI-unheld-later');
  });
});

describe('diagnoseClaimNextMiss reports a held-only backlog as pending-but-not-ready (WI-2797)', () => {
  it('pendingUnclaimed > 0, readyUnclaimed === 0 (genuinely gated, never a false race or false drained)', async () => {
    await seedIssue('WI-held-diag', { createdTs: 100, payload: { _claimHold: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag', states: ['todo'] });
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(false); // work exists — a caller must not treat this as an empty queue
  });

  it('an unheld ready item alongside a held one counts fully in readyUnclaimed (the hold does not shadow siblings)', async () => {
    await seedIssue('WI-held-diag-2', { createdTs: 100, payload: { _claimHold: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag', states: ['todo'] });
    expect(diag.readyUnclaimed).toBeGreaterThanOrEqual(1);
  });
});
