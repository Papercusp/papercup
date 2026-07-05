/**
 * work-items-needs-human-exclusion.integration.test.ts — the issue-family
 * `payload.needsHuman:true` self-select exclusion (EI-7776).
 *
 * When the implement worker resolves an item with outcome `needs-human`,
 * `improvements:resolve` (resolve-core.ts) posts a diagnosis comment, sets
 * `payload.needsHuman:true`, and RELEASES the claim — but the issue-family status dialect has
 * no real terminal "needs human" state (`needs-human`/`blocked`/`wip` all collapse to `open`,
 * EI-450), so the row stayed fully self-selectable. `classifyImprovement` (policy.ts) already
 * keeps a needsHuman-flagged item out of the AUTOMATED improvement-dispatch tier, but that
 * check lives only in the improvement-dispatch path — `scheduler:get_next` /
 * `work_items:claim_next` (the generic backlog-drain self-select) never looked at `needsHuman`
 * at all, so a drain-loop bee re-claimed the SAME already-routed-to-a-human item, re-diagnosed
 * it from scratch, and re-posted the identical comment — confirmed live as EI-7592 being
 * independently "resolved" as the same false positive three times in one afternoon
 * (2026-07-05) before this floor existed.
 *
 * Mirrors work-items-observation-lane-exclusion.integration.test.ts's shape exactly (same D-005
 * floor pattern, applied to a different payload key):
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • claimNextWorkItem's issue tier SKIPS a needsHuman:true row and serves a real one instead
 *     — even when the needs-human row is oldest (would otherwise win the oldest-first steal);
 *   • a needsHuman row is STILL directly claimable BY ID (the floor only gates self-select);
 *   • diagnoseClaimNextMiss reports a needsHuman-ONLY backlog as DRAINED (pendingUnclaimed===0,
 *     drained===true) — a needs-human item is not work-queue material AT ALL, so a drainer
 *     facing only human-routed items must be told to idle, never "work exists, don't idle";
 *   • a real ready item alongside a needsHuman one counts fully (the needsHuman row neither
 *     shadows siblings nor inflates the pending/ready counts).
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

describe('claimNextWorkItem SKIPS a needsHuman:true issue (EI-7776)', () => {
  it('serves the real item, never the needs-human one, even when it is oldest', async () => {
    await seedIssue('EI-human', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-real', { createdTs: 200 });

    // Oldest-first would normally serve EI-human (createdTs:100) — the floor must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real');

    // Only one real candidate existed — it's now claimed, so the pool is genuinely dry.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    // The needs-human row was NEVER claimed by the self-select path.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-human'`;
    expect(rows[0]?.taken_by).toBeNull();
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

describe('diagnoseClaimNextMiss treats a needsHuman-only backlog as DRAINED (EI-7776)', () => {
  it('pendingUnclaimed === 0 and drained === true (idle is correct — NOT pending-but-gated)', async () => {
    // The distinguishing case vs _claimHold: a needs-human item is not work-queue material at
    // all, so it must NOT inflate the pool — a needsHuman-only queue reads drained, so a
    // drainer idles instead of hot-retrying an item it can never actually self-select.
    await seedIssue('EI-human-diag', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag', states: ['todo'] });
    expect(diag.pendingUnclaimed).toBe(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(true);
  });

  it('a real ready item alongside a needsHuman one counts fully (needsHuman neither shadows nor inflates)', async () => {
    await seedIssue('EI-human-diag-2', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag', states: ['todo'] });
    expect(diag.pendingUnclaimed).toBe(1); // ONLY the real item — the needs-human row is excluded
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });
});
