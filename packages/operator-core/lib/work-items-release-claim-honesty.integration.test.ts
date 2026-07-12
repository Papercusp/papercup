/**
 * work-items-release-claim-honesty.integration.test.ts —
 * session-death-claim-release-2026-07-11 P-003 (HONEST non-force release), against a
 * REAL fully-migrated Postgres.
 *
 * EI-9807 originally reported ALL FOUR non-force write verbs (release/update/claim/
 * set_state) silently returning ok:true while no-oping on a peer's live claim. The
 * leader's own follow-up correction (post on EI-9807) narrowed this: WI-4198 had
 * already made `work_items:release` honest (compare-and-release via `expectedAssignee`,
 * refusing with `not_holder` instead of a silent no-op) and `work_items:claim` already
 * refuses a live conflict via `classifyClaimFailure` (claim_conflict, not ok:true).
 * `work_items:update` has no assignee-editing capability at all (EI-6060 rejects the
 * state/status footguns explicitly), so it is moot for this concern.
 *
 * What was MISSING — and what this file proves against real ledgers, not mocks — is
 * end-to-end regression coverage for the exact two-ledger scenario the plan calls out:
 * a non-holder's non-force release/claim must be refused honestly, and an ACTUAL
 * holder's release must clear BOTH the work-item lease (taken_by/assignee) and the
 * coordination claim ledger (work_item_claims) — the two ledgers EI-9807 found
 * diverging on WI-4070. `release.test.ts`/`claim.test.ts` already pin the tool
 * handlers' CONTRACT with `releaseWorkItem`/`claimWorkItem` mocked; this file proves
 * those underlying `work-items.ts` functions actually deliver that contract against a
 * live database, for BOTH work-item families (feature + issue).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const hoisted = vi.hoisted(() => ({ sql: null as unknown }));
const WS = 'ws-release-claim-honesty-test';
const HARNESS = 'papercup';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: hoisted.sql }),
}));
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeWorkspaceId: () => WS,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: async () => true,
}));

const { releaseWorkItem, claimWorkItem, getWorkItem, classifyClaimFailure } = await import('./work-items');
const { acquireClaimLocal, getClaim } = await import('./work-item-claims');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  hoisted.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.work_item_claims WHERE workspace_id = ${WS}`;
});

async function seedFeature(id: string, takenBy: string | null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, updated_ts)
    VALUES
      (${WS}, ${HARNESS}, ${id}, ${id}, 'todo', 'feature', ${takenBy}, ${takenBy ? sql`now()` : null}, ${Date.now()})`;
}

async function featureTakenBy(id: string): Promise<string | null> {
  const [row] = await sql<{ taken_by: string | null }[]>`
    SELECT taken_by FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return row?.taken_by ?? null;
}

async function seedIssue(id: string, assignee: string | null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, state, assignee, assigned_at, updated_at)
    VALUES
      (${WS}, ${id}, ${`harness:${HARNESS}`}, ${id}, 'open', ${assignee}, ${assignee ? sql`now()` : null}, now())`;
}

async function issueAssignee(id: string): Promise<string | null> {
  const [row] = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE workspace_id = ${WS} AND issue_id = ${id}`;
  return row?.assignee ?? null;
}

describe('P-003: work_items:release honesty (non-force) — real two-ledger DB', () => {
  it('non-holder non-force release is refused (returns null; getWorkItem/classify tells release.ts to report not_holder) — taken_by UNCHANGED', async () => {
    await seedFeature('F-HELD-1', 'su-holder');

    // The tool (release.ts) calls releaseWorkItem with expectedAssignee = the CALLER's
    // identity. A non-holder caller's expectedAssignee never matches taken_by, so the
    // atomic compare-and-release UPDATE matches 0 rows -> null, exactly the signal
    // release.ts uses to report the honest `not_holder` (never a bare ok:true no-op).
    const result = await releaseWorkItem('F-HELD-1', { harness: HARNESS, expectedAssignee: 'su-non-holder' });

    expect(result).toBeNull();
    expect(await featureTakenBy('F-HELD-1')).toBe('su-holder'); // untouched — never silently cleared
    // release.ts's re-read + classify path would now render this as `not_holder` + holder.
    const current = await getWorkItem('F-HELD-1', HARNESS);
    expect(current?.assignee).toBe('su-holder');
  });

  it('the ACTUAL holder releasing clears BOTH ledgers — the lease (taken_by) AND the coordination claim (work_item_claims)', async () => {
    await seedFeature('F-HELD-2', 'su-holder-2');
    await acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-HELD-2', owner: 'su-holder-2' });
    expect(await getClaim(WS, HARNESS, 'F-HELD-2')).not.toBeNull(); // sanity: the claim ledger row exists

    const result = await releaseWorkItem('F-HELD-2', { harness: HARNESS, expectedAssignee: 'su-holder-2' });

    expect(result).not.toBeNull();
    expect(await featureTakenBy('F-HELD-2')).toBeNull(); // lease cleared
    expect(await getClaim(WS, HARNESS, 'F-HELD-2')).toBeNull(); // EI-9807's second ledger reconciled too — no divergence left behind
  });

  it('issue-family: non-holder non-force release refused, actual holder release clears assignee', async () => {
    await seedIssue('EI-HELD-1', 'su-issue-holder');

    const refused = await releaseWorkItem('EI-HELD-1', { expectedAssignee: 'su-someone-else' });
    expect(refused).toBeNull();
    expect(await issueAssignee('EI-HELD-1')).toBe('su-issue-holder');

    const released = await releaseWorkItem('EI-HELD-1', { expectedAssignee: 'su-issue-holder' });
    expect(released).not.toBeNull();
    expect(await issueAssignee('EI-HELD-1')).toBeNull();
  });

  it('a force release (no expectedAssignee) clears any holder — the leader/reaper override path stays unrestricted at this layer (the TOOL layer gates who may pass force)', async () => {
    await seedFeature('F-HELD-3', 'su-holder-3');
    const result = await releaseWorkItem('F-HELD-3', { harness: HARNESS }); // no expectedAssignee = force semantics
    expect(result).not.toBeNull();
    expect(await featureTakenBy('F-HELD-3')).toBeNull();
  });
});

describe('P-003: work_items:claim honesty (non-force) — real two-ledger DB', () => {
  it('a non-holder claiming a LIVE-held item never steals it: the compare-and-claim UPDATE matches 0 rows, taken_by unchanged, and classifyClaimFailure reports a conflict (never ok:true)', async () => {
    await seedFeature('F-LIVE-CLAIM-1', 'su-live-holder');

    const claimed = await claimWorkItem('F-LIVE-CLAIM-1', 'su-thief', { harness: HARNESS });

    expect(claimed).toBeNull(); // never silently "succeeds" while leaving taken_by pointed at the real holder
    expect(await featureTakenBy('F-LIVE-CLAIM-1')).toBe('su-live-holder');

    const current = await getWorkItem('F-LIVE-CLAIM-1', HARNESS);
    const failure = classifyClaimFailure(current, 'su-thief');
    expect(failure).toMatchObject({ reason: 'conflict', holder: 'su-live-holder' });
  });

  it('the SAME agent re-claiming its own held item succeeds (a legitimate re-claim / heartbeat-style refresh, not a steal)', async () => {
    await seedFeature('F-LIVE-CLAIM-2', 'su-holder-4');
    const claimed = await claimWorkItem('F-LIVE-CLAIM-2', 'su-holder-4', { harness: HARNESS });
    expect(claimed).not.toBeNull();
    expect(await featureTakenBy('F-LIVE-CLAIM-2')).toBe('su-holder-4');
  });

  it('claiming a genuinely UNCLAIMED item succeeds outright', async () => {
    await seedFeature('F-FREE-1', null);
    const claimed = await claimWorkItem('F-FREE-1', 'su-new-claimer', { harness: HARNESS });
    expect(claimed).not.toBeNull();
    expect(await featureTakenBy('F-FREE-1')).toBe('su-new-claimer');
  });

  it('issue-family: a non-holder cannot silently steal a live-held issue either', async () => {
    await seedIssue('EI-LIVE-CLAIM-1', 'su-issue-live-holder');
    const claimed = await claimWorkItem('EI-LIVE-CLAIM-1', 'su-issue-thief');
    expect(claimed).toBeNull();
    expect(await issueAssignee('EI-LIVE-CLAIM-1')).toBe('su-issue-live-holder');
  });
});
