/**
 * work-items-claim-issue-scope-reread.integration.test.ts — EI-6480.
 *
 * `work_items:claim_next` intermittently MISSED ("ready but a peer raced you (retry)") while
 * unclaimed, unblocked, open issue-family candidates verifiably existed. Root cause: the
 * issue tier of the claim ladder (`claimNextIssueWorkItem`) claims a row with an atomic
 * `UPDATE … RETURNING` scoped to `issueWs = issuesScopeWorkspace()` captured ONCE, then
 * RE-READ the just-claimed row to build its `WorkItem`. The re-read used the bare
 * `getIssue(id)`, which re-derives `issuesScopeWorkspace()` a SECOND time — and that value
 * can drift between the two calls (its flag cache self-heals on a 3s TTL, flipping
 * `default` ⇄ the active workspace). On a drift the re-read looked in the WRONG workspace,
 * found nothing, and returned `null` — so the claim path returned null WHILE the row was
 * already `taken_by`-set: a LEAKED claim reported to the caller as a spurious retryable race.
 *
 * The fix: re-read in the SAME captured workspace the row was claimed in
 * (`getIssueInWorkspace(issueWs, id)`), immune to scope re-derivation drift; and, defensively,
 * if that exact re-read still misses (a genuine anomaly, never a race) RELEASE the claim and
 * throw — so a fault is loud, not disguised as "retry".
 *
 * This proves against real Postgres (testcontainer; Docker required):
 *   • the fix PRIMITIVE — `getIssueInWorkspace(ws, id)` reads the EXACT workspace passed,
 *     finding a row that the scope-re-deriving `getIssue(id)` would miss (the leak mechanism);
 *   • END-TO-END — with the claim's captured workspace DRIFTED away from `getIssue`'s
 *     re-derived scope, `claimNextWorkItem` still returns the claimed item (not a false miss)
 *     and the row is claimed exactly once. This test FAILS against the pre-fix `getIssue` re-read.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-issue-scope-reread.integration.test.ts
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
// Drift the workspace scope the CLAIM PATH captures (work-items.ts imports this symbol) away
// from the scope the module-internal `getIssue` re-derives. Overriding only the EXPORT leaves
// issues-engineer's own internal `issuesScopeWorkspace()` (used by the real `getIssue`) intact
// at its flag-OFF default ('default') — exactly the two-derivations-disagree state EI-6480 hit
// in production. `getIssueInWorkspace` (the fix) is left REAL: it takes the workspace as a
// parameter and never calls `issuesScopeWorkspace`, so it is immune to this drift.
const CLAIM_WS = 'ws-drift';
vi.mock('./issues-engineer', async () => {
  const actual = await vi.importActual<typeof import('./issues-engineer')>('./issues-engineer');
  return { ...actual, issuesScopeWorkspace: () => CLAIM_WS };
});

const wi = await import('./work-items');
const ie = await import('./issues-engineer');

const H = 'papercup';
let db: FreshPgDb;

/** An issue-family (bug/change/task) row in the work_items BASE, in an EXPLICIT workspace. */
async function seedIssueInWorkspace(
  id: string,
  workspaceId: string,
  opts: { status?: string; takenBy?: string | null; createdTs?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${workspaceId}, ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-issue-scope-reread');
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
  // Issue tier ON (self-select over bug/change/task); inline readiness (no maintained sidecar).
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('EI-6480 — issue-claim re-read is workspace-exact, not scope-re-deriving', () => {
  it('getIssueInWorkspace reads the EXACT workspace; bare getIssue (re-derived scope) misses a cross-workspace row', async () => {
    // The issue lives in CLAIM_WS; the module-internal scope (flag OFF) is 'default'.
    await seedIssueInWorkspace('EI-scope', CLAIM_WS);

    // The scope-re-deriving read looks in 'default' and MISSES — this null is exactly what
    // leaked the claim + misreported a race in the pre-fix claim path.
    expect(await ie.getIssue('EI-scope')).toBeNull();

    // The workspace-exact read (the fix) finds the row regardless of the derived scope.
    const exact = await ie.getIssueInWorkspace(CLAIM_WS, 'EI-scope');
    expect(exact?.id).toBe('EI-scope');
    expect(exact?.kind).toBe('bug');
  });

  it('claim_next SERVES an open issue even when the captured claim scope has drifted from getIssue’s re-derived scope (no leaked claim, no false miss)', async () => {
    // Row is in CLAIM_WS — the scope claimNextIssueWorkItem captures (issuesScopeWorkspace mock).
    // getIssue's own re-derivation would be 'default' (drift) and would MISS it → the pre-fix
    // path returned null while the row stayed claimed. The fix re-reads in CLAIM_WS and returns it.
    await seedIssueInWorkspace('EI-serve', CLAIM_WS, { createdTs: 100 });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(got?.id).toBe('EI-serve'); // NOT a null miss — the pre-fix getIssue re-read returned null here
    expect(got?.family).toBe('issue');
    expect(got?.assignee).toBe('w1');

    // Claimed exactly once, and to w1 — the mutation is neither leaked nor lost.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${CLAIM_WS} AND feature_id = 'EI-serve'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].taken_by).toBe('w1');

    // Pool now genuinely empty ⇒ a subsequent claim is a real (null) miss, not a spurious one.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w2' })).toBeNull();
  });
});
