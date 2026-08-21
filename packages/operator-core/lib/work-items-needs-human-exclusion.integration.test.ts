/**
 * work-items-needs-human-exclusion.integration.test.ts — post-migration-864
 * compatibility behavior for the historical `payload.needsHuman` key.
 *
 * Migration 864 replaced the ambiguous payload flag with typed owner-action and agent-review
 * destinations. The legacy key remains readable and may still mirror stored status, but an OPEN
 * row carrying it is ordinary claimable work. Stored status='needs-human' remains the lifecycle
 * park and payload.needsOwnerAction remains the typed owner-capability admission floor.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-needs-human-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload) : null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-needs-human');
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
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claimNextWorkItem admits a legacy needsHuman:true OPEN issue after migration 864', () => {
  it('serves the legacy-tagged item normally when it is oldest', async () => {
    await seedIssue('EI-human', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-real', { createdTs: 200 });

    // The legacy payload key is no longer a floor, so ordinary oldest-first ordering applies.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('EI-human');

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toMatchObject({ id: 'WI-real' });
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-human'`;
    expect(rows[0]?.taken_by).toBe('bee-1');
  });

  it('a needsHuman row is STILL directly claimable by id (the floor only gates self-select)', async () => {
    await seedIssue('EI-human-direct', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    const claimed = await wi.claimWorkItem('EI-human-direct', 'inspector', { harness: H });
    expect(claimed?.id).toBe('EI-human-direct');
    expect(claimed?.assignee).toBe('inspector');
  });

  it('needsHuman:false is NOT excluded', async () => {
    await seedIssue('WI-not-human', { kind: 'change', createdTs: 100, payload: { needsHuman: false } });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-not-human');
  });

  it('a row with no payload at all is NOT excluded (NULL-safe)', async () => {
    await seedIssue('WI-no-payload', { kind: 'change', createdTs: 100, payload: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-no-payload');
  });
});

describe('diagnoseClaimNextMiss counts a legacy needsHuman OPEN row as ordinary work', () => {
  it('reports the row pending and ready instead of a false drain', async () => {
    await seedIssue('EI-human-diag', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1);
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });

  it('counts both a plain row and a legacy-tagged row', async () => {
    await seedIssue('EI-human-diag-2', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(2);
    expect(diag.readyUnclaimed).toBe(2);
    expect(diag.drained).toBe(false);
  });
});

// WI-5689: setWorkItemStateWithAliasInfo's needs-human auto-gate genuinely persists
// payload.needsHuman (mergeIssuePayload does a real `COALESCE(payload,'{}') || patch` UPDATE
// ... RETURNING), but the `workItem` snapshot echoed back to the caller was captured BEFORE
// that write and never refreshed — so a caller reading the response saw the STALE pre-merge
// payload (needsHuman still false) even though the DB row was already correct. Reported
// live as a second "silent no-op" repro on the SAME work-item as the update.ts sibling bug
// (which — unlike this one — genuinely never wrote at all). Proves both halves: the DB
// write really lands, AND the echoed response now reflects it (not stale).
describe('setWorkItemStateWithAliasInfo needs-human auto-gate echoes the FRESH payload, not a stale pre-merge snapshot (WI-5689)', () => {
  it('the returned workItem.payload.needsHuman is true in the SAME call that set the state', async () => {
    await seedIssue('EI-echo-1', { kind: 'change', status: 'open', createdTs: 100, payload: {} });

    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-1', 'needs-human', { harness: H, by: 'tester' });

    expect(res.appliedState).toBe('needs-human');
    // The bug: this used to be `false`/`undefined` (the pre-merge snapshot) despite the
    // DB write already having landed underneath it.
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBe(true);
    expect(res.aliasNote).toMatch(/stored status='needs-human'.*compatibility mirror/);
  });

  it('matches what is actually persisted in Postgres (not just a locally-patched echo)', async () => {
    await seedIssue('EI-echo-2', { kind: 'change', status: 'open', createdTs: 100, payload: {} });
    await wi.setWorkItemStateWithAliasInfo('EI-echo-2', 'needs-human', { harness: H, by: 'tester' });

    const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
      SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-echo-2'`;
    expect(rows[0]?.payload?.needsHuman).toBe(true);

    // A follow-up read via getWorkItem (what work_items:get / work_items:set_state's
    // response ultimately re-derives from) agrees with the echoed value above.
    const fetched = await wi.getWorkItem('EI-echo-2', H);
    expect((fetched?.payload as Record<string, unknown> | undefined)?.needsHuman).toBe(true);
  });

  it('a non-issue-family transition (e.g. plain wip) never calls the auto-gate / re-fetch at all', async () => {
    await seedIssue('EI-echo-3', { kind: 'change', status: 'open', createdTs: 100, payload: { marker: 'untouched' } });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-3', 'wip', { harness: H, by: 'tester' });
    expect(res.appliedState).toBe('wip');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.marker).toBe('untouched');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });
});
