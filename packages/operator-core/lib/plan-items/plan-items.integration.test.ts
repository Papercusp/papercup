/**
 * plan-items.integration.test.ts — real-Postgres tests for the plan-item
 * assignment + claim + liveness surface (plan-item-assignment-claim-liveness-2026-06-04).
 *
 * Exercises migrations 140 (assignments + agent-names + work-groups) and 141 (leased
 * claims) end-to-end against a throwaway PG. The plan-source dependency
 * (resolvePlanScope / readPlanBySlug → registry / withWorkspace) is mocked so the
 * stores are tested in isolation; a small mock plan controls item-existence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) =>
        !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  plans: new Map<string, { items: { id: string; status: string }[] }>(),
}));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

vi.mock('../agent-tools/plans/source', () => ({
  resolvePlanScope: async (opts?: { workspaceId?: string; harnessSlug?: string }) => ({
    workspaceId: opts?.workspaceId ?? 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  }),
  readPlanBySlug: async (slug: string) => {
    const p = h.plans.get(slug);
    if (!p) return null;
    return {
      archived: false,
      parsed: { items: p.items.map((i) => ({ id: i.id, storedStatus: i.status })) },
      row: { items: p.items },
    };
  },
}));

const names = await import('./agent-names');
const asg = await import('./assignments');
const claims = await import('./claims');
const liveness = await import('./liveness');
const wg = await import('./work-group');

const WS = 'default';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';
const ctxA = { isSuperuser: true, uiClientId: 'sess-A' } as const;
const ctxB = { isSuperuser: true, uiClientId: 'sess-B' } as const;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('plan-items');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
  // EI-9515: claims.ts's activity-grace check (D-00x) queries
  // harness_shared.agent_activity (migration 143) — added after this test's
  // migration list was last updated, so it was never applied here and every
  // claim-store test failed with `relation "harness_shared.agent_activity"
  // does not exist`.
  await db.sql.unsafe(readMigration('143-agent-activity.sql')).simple();
  // Minimal contributors table for the shared-ness heuristic (subset of baseline cols).
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.contributors (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      github_user_id bigint NOT NULL,
      github_username text NOT NULL DEFAULT ''
    )`).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_assignments,
                       harness_shared.agent_names,
                       harness_shared.agent_name_sessions,
                       harness_shared.plan_work_group_members,
                       harness_shared.plan_item_claims,
                       harness_shared.contributors`;
  liveness.resetHarnessSharedResolver();
  h.plans.clear();
  h.plans.set(PLAN, { items: [{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'todo' }, { id: 'P-003', status: 'todo' }] });
});

describe('agent-names registry + adoption (D-006)', () => {
  it('register → adopt → resolve the calling session’s name', async () => {
    await names.registerAgentName(WS, 'builder-1', 'user-x');
    expect(await names.agentNameOwner(WS, 'builder-1')).toBe('user-x');

    await names.adoptAgentName(WS, 'sess-A', 'builder-1', 'user-x');
    expect(await names.resolveAdoptedName(WS, 'sess-A')).toBe('builder-1');
    expect(await names.resolveAdoptedName(WS, 'sess-Z')).toBeNull();
  });

  it('requireActingName: explicit > adopted; throws when neither', async () => {
    await names.adoptAgentName(WS, 'sess-A', 'builder-1', 'user-x');
    expect(await names.requireActingName(ctxA, WS)).toBe('builder-1');
    expect(await names.requireActingName(ctxA, WS, 'override-name')).toBe('override-name');
    await expect(names.requireActingName(ctxB, WS)).rejects.toThrow(/no agent-name/);
  });

  it('bestEffortOwnerUser falls back to the session ownerId (no per-user identity yet)', () => {
    expect(names.bestEffortOwnerUser(ctxA)).toBe('sess-A');
    expect(names.bestEffortOwnerUser({ isPowerUser: true, uiClientId: 'pus-1', userId: 'real-user' })).toBe('real-user');
  });
});

describe('assignment store (D-001/D-002)', () => {
  it('assign validates the item exists in the plan', async () => {
    await expect(
      asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-999', assigneeName: 'builder-1', assignedByUser: 'user-x' }),
    ).rejects.toThrow(/not found/);
    const a = await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    expect(a.assigneeName).toBe('builder-1');
    expect(a.releasedTs).toBeNull();
  });

  it('reassign wins (LWW); unassign soft-releases; getAssignment returns only active', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-2', assignedByUser: 'user-x' });
    expect((await asg.getAssignment(WS, HARNESS, PLAN, 'P-001'))?.assigneeName).toBe('builder-2');

    const released = await asg.unassignItem(WS, HARNESS, PLAN, 'P-001');
    expect(released?.releasedTs).not.toBeNull();
    expect(await asg.getAssignment(WS, HARNESS, PLAN, 'P-001')).toBeNull();
    // Unassigning again returns null (nothing active).
    expect(await asg.unassignItem(WS, HARNESS, PLAN, 'P-001')).toBeNull();
  });

  it('my-items lists active assignments by name across plans', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-003', assigneeName: 'builder-2', assignedByUser: 'user-x' });
    const mine = await asg.listAssignmentsForName(WS, 'builder-1');
    expect(mine.map((a) => a.itemId).sort()).toEqual(['P-001', 'P-002']);
  });

  it('Claimable-capability adapter conforms (assign/release/getAssignee via ObjectRef)', async () => {
    const store = new asg.PlanItemClaimableStore(WS);
    const ref = asg.planItemRef(HARNESS, PLAN, 'P-001');
    await store.claim(ref, 'builder-7');
    expect(await store.getAssignee(ref)).toBe('builder-7');
    await store.release(ref);
    expect(await store.getAssignee(ref)).toBeNull();
  });
});

describe('claim lease store (D-001/D-003 mechanics)', () => {
  it('acquire a free item; a second owner is refused while it is live', async () => {
    const r1 = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1' });
    expect(r1.ok).toBe(true);
    const r2 = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-B', ownerName: 'builder-2' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.conflict.owner).toBe('sess-A');
  });

  it('re-acquire by the SAME owner extends (idempotent)', async () => {
    const r1 = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A' });
    const r2 = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A' });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.claim.owner).toBe('sess-A');
  });

  it('a LAPSED claim is stolen by a new owner; the old owner cannot heartbeat it back', async () => {
    const r1 = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A' });
    expect(r1.ok).toBe(true);
    const oldClaimId = r1.ok ? r1.claim.claimId : '';
    // Simulate lapse (no sleep): push expiry into the past.
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = now() - interval '5 seconds' WHERE item_id = 'P-001'`;
    expect((await claims.getClaim(WS, HARNESS, PLAN, 'P-001'))?.expired).toBe(true);

    const steal = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-B' });
    expect(steal.ok).toBe(true);

    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', oldClaimId, 'sess-A', 'activity');
    expect(hb.renewed).toBe(false);
    expect(hb.held).toBe(false);
  });

  it('availability mode: any heartbeat renews; release frees the item', async () => {
    const r = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', livenessMode: 'availability' });
    expect(r.ok).toBe(true);
    const claimId = r.ok ? r.claim.claimId : '';
    const keep = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', claimId, 'sess-A', 'keepalive');
    expect(keep.renewed).toBe(true); // availability renews on ANY heartbeat

    const released = await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', claimId, 'sess-A');
    expect(released).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).toBeNull();
  });

  it('activity mode: a keepalive does NOT renew (idle lapses); an activity does', async () => {
    const r = await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', livenessMode: 'activity' });
    const claimId = r.ok ? r.claim.claimId : '';
    const keep = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', claimId, 'sess-A', 'keepalive');
    expect(keep.renewed).toBe(false); // activity mode: keepalive is a no-op renewal
    expect(keep.held).toBe(true); // …but the claim is still held

    const act = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', claimId, 'sess-A', 'activity');
    expect(act.renewed).toBe(true);
  });

  it('releaseAllClaimsForOwner clears a session’s claims on end', async () => {
    await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A' });
    await claims.acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-A' });
    expect(await claims.releaseAllClaimsForOwner(WS, 'sess-A')).toBe(2);
  });
});

describe('liveness mode resolution (D-003)', () => {
  it('default heuristic: 1 contributor = LOCAL (availability); 2 = SHARED (activity)', async () => {
    await db.sql`INSERT INTO harness_shared.contributors (workspace_id, harness_slug, github_user_id, github_username) VALUES (${WS}, ${HARNESS}, 1, 'a')`;
    expect(await liveness.harnessLivenessMode(WS, HARNESS)).toBe('availability');
    await db.sql`INSERT INTO harness_shared.contributors (workspace_id, harness_slug, github_user_id, github_username) VALUES (${WS}, ${HARNESS}, 2, 'b')`;
    expect(await liveness.harnessLivenessMode(WS, HARNESS)).toBe('activity');
  });

  it('the shared-resolver seam overrides the heuristic (su-584a8 swap-in)', async () => {
    liveness.setHarnessSharedResolver(async () => true);
    expect(await liveness.harnessLivenessMode(WS, HARNESS)).toBe('activity');
  });
});

describe('claim policy coordinator (D-004/D-005)', () => {
  it('assigned item: only the assignee-name may claim — even when unclaimed', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    const refused = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-B', ownerName: 'builder-2', ownerUser: 'user-y' });
    expect(refused.status).toBe('refused');
    const ok = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1', ownerUser: 'user-x' });
    expect(ok.status).toBe('claimed');
    if (ok.status === 'claimed') expect(ok.viaAssignment).toBe(true);
  });

  it('lapse returns to the assignee: a lapsed assigned claim is NOT pulled by others, but re-claimed by the assignee (D-004)', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1', ownerUser: 'user-x' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = now() - interval '5 seconds' WHERE item_id = 'P-001'`;
    // Another agent still can't take it — the assignment anchors it.
    const other = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-B', ownerName: 'builder-2', ownerUser: 'user-y' });
    expect(other.status).toBe('refused');
    // The assignee re-claims (its still-assigned item).
    const re = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A2', ownerName: 'builder-1', ownerUser: 'user-x' });
    expect(re.status).toBe('claimed');
  });

  it('unassigned + no work-group: open pull (single-user/local)', async () => {
    const r = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-A', ownerName: 'puller', ownerUser: 'user-x' });
    expect(r.status).toBe('claimed');
    if (r.status === 'claimed') expect(r.viaAssignment).toBe(false);
  });

  it('unassigned + work-group declared: pull refused for non-members, allowed for members (D-005)', async () => {
    await wg.joinWorkGroup(WS, HARNESS, PLAN, 'user-member', 'puller');
    const refused = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-Z', ownerName: 'stranger', ownerUser: 'user-stranger' });
    expect(refused.status).toBe('refused');
    const ok = await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', owner: 'sess-M', ownerName: 'puller', ownerUser: 'user-member' });
    expect(ok.status).toBe('claimed');
  });
});

describe('merged view (assignment/claim drift coherence)', () => {
  it('classifies every plan item: pooled / assigned-idle / active / claimed-pooled', async () => {
    // P-001 assigned + claimed by assignee → active
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1', ownerUser: 'user-x' });
    // P-002 assigned, not claimed → assigned-idle
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', assigneeName: 'builder-2', assignedByUser: 'user-x' });
    // P-003 unassigned, claimed from pool → claimed-pooled
    await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-003', owner: 'sess-C', ownerName: 'puller', ownerUser: 'user-x' });

    const states = await liveness.mergedPlanItemStates(WS, HARNESS, PLAN);
    const byId = new Map(states.map((s) => [s.itemId, s.disposition]));
    expect(byId.get('P-001')).toBe('active');
    expect(byId.get('P-002')).toBe('assigned-idle');
    expect(byId.get('P-003')).toBe('claimed-pooled');
  });

  it('a lapsed claim reads as not-holding in the merged view (assigned-idle, not active)', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1', ownerUser: 'user-x' });
    await db.sql`UPDATE harness_shared.plan_item_claims SET expires_ts = now() - interval '5 seconds' WHERE item_id = 'P-001'`;
    const states = await liveness.mergedPlanItemStates(WS, HARNESS, PLAN);
    expect(states.find((s) => s.itemId === 'P-001')?.disposition).toBe('assigned-idle');
  });

  it('myItemsWithState pairs each assignment with its live claim', async () => {
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await asg.assignItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-002', assigneeName: 'builder-1', assignedByUser: 'user-x' });
    await liveness.claimPlanItem({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId: 'P-001', owner: 'sess-A', ownerName: 'builder-1', ownerUser: 'user-x' });
    const mine = await liveness.myItemsWithState(WS, 'builder-1');
    const byId = new Map(mine.map((m) => [m.assignment.itemId, m.disposition]));
    expect(byId.get('P-001')).toBe('active');
    expect(byId.get('P-002')).toBe('assigned-idle');
  });
});

describe('work-group membership (D-005)', () => {
  it('join / isMember / exists / leave', async () => {
    expect(await wg.workGroupExists(WS, HARNESS, PLAN)).toBe(false);
    await wg.joinWorkGroup(WS, HARNESS, PLAN, 'user-x', 'puller');
    expect(await wg.workGroupExists(WS, HARNESS, PLAN)).toBe(true);
    expect(await wg.isWorkGroupMember(WS, HARNESS, PLAN, 'user-x')).toBe(true);
    expect(await wg.isWorkGroupMember(WS, HARNESS, PLAN, 'user-y')).toBe(false);
    expect(await wg.leaveWorkGroup(WS, HARNESS, PLAN, 'user-x')).toBe(true);
    expect(await wg.workGroupExists(WS, HARNESS, PLAN)).toBe(false);
  });
});
