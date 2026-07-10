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
 * fleet-deltas-leader-primitives-2026-07-10 P-006 (EI-8993) extended the hold to BOTH
 * families: the feature claim floor (claimFloorsWhereSql) now honors _claimHold too, and
 * `opts.by`/`opts.reason` stamp held_open_by/held_open_reason (the named HOLD-OPEN
 * setWorkItemState's terminal guard enforces — see work-items-lifecycle.integration.test.ts).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • setWorkItemClaimHold sets/clears payload._claimHold on an issue-family row;
 *   • it applies to a FEATURE-family row too (P-006), stamping held_open_by/reason;
 *   • claimNextWorkItem's issue tier SKIPS a held item and serves an unheld one instead;
 *   • claimNextWorkItem's FEATURE tier likewise skips a held feature (P-006 floor);
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
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
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
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // harness_features_consolidated is a VIEW over work_items (see _work-items-schema.ts) —
  // TRUNCATE only works on real tables, and truncating work_items already clears the view.
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
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

  it('applies to a FEATURE-family item too, stamping held_open_by/reason (P-006)', async () => {
    await seedFeature('F-hold-1');
    const res = await wi.setWorkItemClaimHold('F-hold-1', true, { harness: H, by: 'leader-1', reason: 'release gate' });
    expect(res).toMatchObject({ id: 'F-hold-1', hold: true, applicable: true });
    // The view has no payload column — the stamp lands on the work_items BASE row.
    expect(await readPayload('F-hold-1')).toMatchObject({
      _claimHold: true,
      held_open_by: 'leader-1',
      held_open_reason: 'release gate',
    });
    expect(wi.readWorkItemHeldOpenBy(await readPayload('F-hold-1'))).toEqual({ by: 'leader-1', reason: 'release gate' });
  });

  it('clearing the hold removes ALL hold keys (_claimHold + held_open_by/reason/at), keeping siblings', async () => {
    await seedIssue('WI-hold-3');
    await wi.setWorkItemClaimHold('WI-hold-3', true, { harness: H, by: 'leader-1', reason: 'gating' });
    const payload = await readPayload('WI-hold-3');
    expect(payload).toMatchObject({ _claimHold: true, held_open_by: 'leader-1', held_open_reason: 'gating' });
    expect(payload).toHaveProperty('held_open_at');
    await wi.setWorkItemClaimHold('WI-hold-3', false, { harness: H });
    const cleared = await readPayload('WI-hold-3');
    for (const k of ['_claimHold', 'held_open_by', 'held_open_reason', 'held_open_at']) {
      expect(cleared).not.toHaveProperty(k);
    }
    expect(wi.readWorkItemHeldOpenBy(cleared)).toBeNull();
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

  it('the FEATURE tier likewise skips a held feature and serves the unheld one (P-006 floor)', async () => {
    await seedFeature('F-held', { createdTs: 100 });
    await wi.setWorkItemClaimHold('F-held', true, { harness: H, by: 'leader-1', reason: 'release gate' });
    await seedFeature('F-open', { createdTs: 200 });

    // Oldest-first would normally serve F-held (createdTs:100) — the P-006 floor must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-f1' });
    expect(got?.id).toBe('F-open');

    // The held feature was NEVER claimed by the self-select path…
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'F-held'`;
    expect(rows[0]?.taken_by).toBeNull();

    // …but clearing the hold makes it self-selectable again.
    await wi.setWorkItemClaimHold('F-held', false, { harness: H });
    const next = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-f2' });
    expect(next?.id).toBe('F-held');
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
