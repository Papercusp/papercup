/**
 * work-item-lease-reaper.integration.test.ts — session-death-claim-release-2026-07-11
 * P-001 (the "backstop" schedule) against a REAL fully-migrated Postgres.
 *
 * Proves the fix for EI-9807/WI-4070: a work-item lease (`taken_by`/`assignee`) held by
 * a DEAD owner (no fresh coord_presence heartbeat, no running bee, no pending wake, not
 * on-desktop, no live psu-host) is force-released — and its stale coordination claim
 * ledger row (`work_item_claims`) is reconciled too — WITHOUT waiting on the owner's
 * adv_session ever getting marked `ended` (which the pre-existing
 * `gatherProtectedSessionOwners` `taken_by` leg would otherwise block forever for a
 * claim-holder — the exact circularity this fix breaks). Covers both work-item families
 * (feature via harness_features_consolidated, issue via engineer_issues), the grace-floor
 * boundary, dryRun, and the underlying `gatherProtectedSessionOwners` liveness toggle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
const WS = 'ws-lease-reap-test';
const HARNESS = 'papercup';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeWorkspaceId: () => WS,
}));
// Force the master flag ON regardless of the PG-backed override store — the flag
// defaults ON in production (libs/flags/src/types.ts), this just makes the test
// independent of that store's plumbing.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: async () => true,
}));

const { runWorkItemLeaseReap, gatherProtectedSessionOwners, gatherBusyOwners } = await import('./idle-session-reaper');
const { acquireClaimLocal, getClaim } = await import('./work-item-claims');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.work_item_claims WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.coord_presence`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

async function seedFeature(id: string, takenBy: string | null, takenAgoMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, updated_ts)
    VALUES
      (${WS}, ${HARNESS}, ${id}, ${id}, 'todo', 'feature', ${takenBy},
       ${takenBy ? sql`now() - make_interval(secs => ${Math.round(takenAgoMs / 1000)})` : null}, ${Date.now()})`;
}

async function featureTakenBy(id: string): Promise<string | null> {
  const [row] = await sql<{ taken_by: string | null }[]>`
    SELECT taken_by FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return row?.taken_by ?? null;
}

async function seedIssue(id: string, assignee: string | null, assignedAgoMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, state, assignee, assigned_at, updated_at)
    VALUES
      (${WS}, ${id}, ${`harness:${HARNESS}`}, ${id}, 'open', ${assignee},
       ${assignee ? sql`now() - make_interval(secs => ${Math.round(assignedAgoMs / 1000)})` : null}, now())`;
}

async function issueAssignee(id: string): Promise<string | null> {
  const [row] = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE workspace_id = ${WS} AND issue_id = ${id}`;
  return row?.assignee ?? null;
}

async function seedPresence(owner: string, ageMs: number, liveness: { host?: string; pid?: number } = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at, host, pid)
    VALUES (${owner}, now() - make_interval(secs => ${Math.round(ageMs / 1000)}), ${liveness.host ?? hostname()}, ${liveness.pid ?? null})
    ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at, host = EXCLUDED.host, pid = EXCLUDED.pid`;
}

async function seedLoop(owner: string, active = true): Promise<void> {
  const id = `loop-${owner}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, reschedule_interval_sec, target_owner_id, workspace_id)
    VALUES
      (${id}, ${HARNESS}, ${id}, 'api', '{}'::jsonb, 'system:loop-fire',
       ${active}, 60, ${owner}, ${WS})`;
}

const GRACE_MS = 600_000; // IDLE_SESSION_GRACE_MS (STALE_MS)

describe('runWorkItemLeaseReap (P-001 — the backstop schedule)', () => {
  it('force-releases a feature-family lease held by a DEAD owner, and reconciles its claim ledger', async () => {
    await seedFeature('F-DEAD-1', 'su-dead', 5 * GRACE_MS);
    await acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-DEAD-1', owner: 'su-dead' });

    const res = await runWorkItemLeaseReap({});

    expect(res.enabled).toBe(true);
    expect(res.reapedIds).toContain('F-DEAD-1');
    expect(res.reaped).toBeGreaterThanOrEqual(1);
    expect(res.ownersReconciled).toBeGreaterThanOrEqual(1);
    expect(await featureTakenBy('F-DEAD-1')).toBeNull();
    // The coordination claim ledger (the EI-9807 second ledger) is reconciled too.
    expect(await getClaim(WS, HARNESS, 'F-DEAD-1')).toBeNull();
  });

  it('NEVER releases a lease whose owner is LIVE (fresh coord_presence heartbeat) — a claim alone no longer self-protects, but a real heartbeat still does', async () => {
    await seedFeature('F-LIVE-1', 'su-live', 5 * GRACE_MS);
    await seedPresence('su-live', 1_000); // heartbeat 1s ago — well inside grace

    const res = await runWorkItemLeaseReap({});

    expect(res.reapedIds).not.toContain('F-LIVE-1');
    expect(await featureTakenBy('F-LIVE-1')).toBe('su-live');
  });

  it('releases an old lease immediately when a fresh local heartbeat carries a confirmed-dead PID', async () => {
    await seedFeature('F-PID-DEAD-1', 'su-pid-dead', 5 * GRACE_MS);
    await seedPresence('su-pid-dead', 1_000, { host: hostname(), pid: 999_999_999 });

    const res = await runWorkItemLeaseReap({});

    expect(res.reapedIds).toContain('F-PID-DEAD-1');
    expect(await featureTakenBy('F-PID-DEAD-1')).toBeNull();
  });

  it('NEVER releases a lease claimed within the grace floor, even with no heartbeat yet (its first beat may not have landed)', async () => {
    await seedFeature('F-FRESH-1', 'su-brand-new', 5_000); // claimed 5s ago

    const res = await runWorkItemLeaseReap({});

    expect(res.reapedIds).not.toContain('F-FRESH-1');
    expect(await featureTakenBy('F-FRESH-1')).toBe('su-brand-new');
  });

  it('force-releases an issue-family (bug/change) lease held by a DEAD owner', async () => {
    await seedIssue('EI-DEAD-1', 'su-dead-2', 5 * GRACE_MS);

    const res = await runWorkItemLeaseReap({});

    expect(res.reapedIds).toContain('EI-DEAD-1');
    expect(await issueAssignee('EI-DEAD-1')).toBeNull();
  });

  it('dryRun reports the would-release count without mutating anything', async () => {
    await seedFeature('F-DRY-1', 'su-dead-3', 5 * GRACE_MS);

    const res = await runWorkItemLeaseReap({ dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.reapedIds).toContain('F-DRY-1');
    expect(await featureTakenBy('F-DRY-1')).toBe('su-dead-3'); // untouched
  });

  it('a dead owner holding TWO leases gets both released and the ledger reconciled once per owner', async () => {
    await seedFeature('F-MULTI-1', 'su-multi', 5 * GRACE_MS);
    await seedFeature('F-MULTI-2', 'su-multi', 5 * GRACE_MS);

    const res = await runWorkItemLeaseReap({});

    expect(res.reapedIds).toEqual(expect.arrayContaining(['F-MULTI-1', 'F-MULTI-2']));
    expect(await featureTakenBy('F-MULTI-1')).toBeNull();
    expect(await featureTakenBy('F-MULTI-2')).toBeNull();
  });
});

describe('gatherProtectedSessionOwners includeClaimHolders toggle (the circularity break)', () => {
  it('DEFAULT (includeClaimHolders unset / true): a claim alone protects its holder — UNCHANGED session-reaper behavior', async () => {
    await seedFeature('F-CLAIM-PROTECT', 'su-claim-only', 5 * GRACE_MS);
    const protectedOwners = await gatherProtectedSessionOwners(sql, {});
    expect(protectedOwners.has('su-claim-only')).toBe(true);
  });

  it('includeClaimHolders:false: a claim ALONE no longer protects — this is what the lease reaper uses to judge true liveness', async () => {
    await seedFeature('F-CLAIM-NO-PROTECT', 'su-claim-only-2', 5 * GRACE_MS);
    const protectedOwners = await gatherProtectedSessionOwners(sql, { includeClaimHolders: false });
    expect(protectedOwners.has('su-claim-only-2')).toBe(false);
  });

  it('includeClaimHolders:false still protects via a genuine coord_presence heartbeat', async () => {
    await seedPresence('su-really-live', 1_000);
    const protectedOwners = await gatherProtectedSessionOwners(sql, { includeClaimHolders: false });
    expect(protectedOwners.has('su-really-live')).toBe(true);
  });

  it('an armed loop protects its same-owner driving claim between warm wakes, independently of claim-holder protection', async () => {
    const owner = 'su-warm-loop-owner';
    await seedFeature('F-WARM-LOOP-PROTECT', owner, 5 * GRACE_MS);
    // The recorded pid is affirmatively dead and the heartbeat is stale: this
    // proves the pid-confirmation pass cannot undo the loop-authority protection
    // merely because one native incarnation ended between warm wakes.
    await seedPresence(owner, 5 * GRACE_MS, { host: hostname(), pid: 999_999_999 });
    await seedLoop(owner);

    const protectedOwners = await gatherProtectedSessionOwners(sql, { includeClaimHolders: false });
    expect(protectedOwners.has(owner)).toBe(true);

    const kept = await runWorkItemLeaseReap({});
    expect(kept.reapedIds).not.toContain('F-WARM-LOOP-PROTECT');
    expect(await featureTakenBy('F-WARM-LOOP-PROTECT')).toBe(owner);

    await sql`UPDATE harness_shared.routines SET active = false WHERE target_owner_id = ${owner}`;
    const released = await runWorkItemLeaseReap({});
    expect(released.reapedIds).toContain('F-WARM-LOOP-PROTECT');
    expect(await featureTakenBy('F-WARM-LOOP-PROTECT')).toBeNull();
  });

  // WI-6638 side-finding (EI-19357343...): harness_features_consolidated is the
  // FEATURE-ONLY view (`WHERE item_kind <> ALL ('{bug,change,task}')`) — an
  // issue-family (bug/change/task) claim lives in engineer_issues.assignee and
  // was previously INVISIBLE to this leg, so a session holding a WI-/EI- claim
  // was never protected here. Same fixture shape as the feature-family test
  // above, proving parity across both families.
  it('an ISSUE-family (bug/change/task) claim alone protects its holder — same as feature-family', async () => {
    await seedIssue('EI-CLAIM-PROTECT', 'su-issue-claim-only', 5 * GRACE_MS);
    const protectedOwners = await gatherProtectedSessionOwners(sql, {});
    expect(protectedOwners.has('su-issue-claim-only')).toBe(true);
  });

  it('includeClaimHolders:false: an issue-family claim ALONE no longer protects either', async () => {
    await seedIssue('EI-CLAIM-NO-PROTECT', 'su-issue-claim-only-2', 5 * GRACE_MS);
    const protectedOwners = await gatherProtectedSessionOwners(sql, { includeClaimHolders: false });
    expect(protectedOwners.has('su-issue-claim-only-2')).toBe(false);
  });
});

describe('gatherBusyOwners issue-family parity (WI-6638 side-finding)', () => {
  it('a feature-family claim marks its holder busy (unchanged baseline)', async () => {
    await seedFeature('F-BUSY-1', 'su-busy-feature', 5 * GRACE_MS);
    const busy = await gatherBusyOwners(sql, {});
    expect(busy.has('su-busy-feature')).toBe(true);
  });

  it('an issue-family (bug/change/task) claim ALSO marks its holder busy — the fix', async () => {
    await seedIssue('EI-BUSY-1', 'su-busy-issue', 5 * GRACE_MS);
    const busy = await gatherBusyOwners(sql, {});
    expect(busy.has('su-busy-issue')).toBe(true);
  });

  it('an owner with no claim of either kind is not busy', async () => {
    const busy = await gatherBusyOwners(sql, {});
    expect(busy.has('su-nobody-claims-this')).toBe(false);
  });
});
