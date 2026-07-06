/**
 * assignments.integration.test.ts — the harness_shared.fleet_assignment view +
 * listFleetAssignments reader + the fleet_assignment NOTIFY change-feed against
 * REAL Postgres (state-not-chat-fleet-state-2026-06-05, P-001/P-002/P-005/P-006).
 *
 * Uses the baseline-schema DB (the full migration set incl. 165), through the
 * modules' OWN getOrgPg()/getHarnessAdminUrl() handles via the coord fixture.
 *
 * The two load-bearing invariants:
 *   1. CLAIM-PRIMARY (D-002): a live lease whose holder has no/stale presence
 *      surfaces as orphaned=true — never silently dropped.
 *   2. Change-feed precision (D-003): meaningful changes notify; heartbeat-only
 *      presence bumps and lease renewals do NOT (they'd fire per tool call).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { listFleetAssignments, groupByAgent, orphanedClaims } from './assignments';
import { recordedLiveOwnerIds } from '../adv-sessions';
import { reorderWorkItem } from '../work-items';
import { onFleetAssignmentChange, _stopForTests, type FleetAssignmentChange } from '../fleet-assignment-bus';

// getWorkItem (used by reorderWorkItem) scopes its feature lookup by activeWorkspaceId()
// (F-B3 workspace-data-isolation-leaks). Every row here is seeded under WS='default', but
// nothing in this isolated test sets the process-global active workspace — so the lookup
// filtered the wrong workspace and an existing-but-unassigned row read as 'not found'
// (intermittently, on whatever global state a sibling test leaked into the worker). Pin
// the active workspace to the seed workspace so the lookup sees the seeded rows.
vi.mock('../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'default' };
});

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'default';

async function truncateAll(): Promise<void> {
  await admin`TRUNCATE harness_shared.coord_presence`;
  await admin`TRUNCATE harness_shared.plan_item_claims`;
  await admin`TRUNCATE harness_shared.plan_item_assignments`;
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE feature_id LIKE 'FA-TEST-%'`;
  await admin`DELETE FROM harness_shared.engineer_issues WHERE issue_id LIKE 'FA-TEST-%'`;
  await admin`DELETE FROM harness_shared.spawned_agents WHERE spawn_id LIKE 'fa-test-%'`;
}

/** A nursery row (EI-311 alias-liveness leg) — cup:spawn's three identity
 *  aliases: spawn_id == session_owner (s-…), plus the per-invocation run_id. */
async function seedSpawn(
  spawnId: string,
  opts: { runId?: string; status?: string; heartbeatAgeSeconds?: number } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id,
       status, session_owner, heartbeat_at)
    VALUES (${spawnId}, ${WS}, 'demo', 'operator', 'cup', ${opts.runId ?? `${spawnId}-run`},
            ${opts.status ?? 'running'}, ${spawnId},
            now() - ${`${opts.heartbeatAgeSeconds ?? 0} seconds`}::interval)
  `;
}

async function seedPresence(
  ownerId: string,
  opts: { ageSeconds?: number; intent?: string; planSlug?: string | null; workspaceId?: string } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, intent, current_plan_slug, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${opts.workspaceId ?? WS}, 'test', ${opts.intent ?? ''},
            ${opts.planSlug ?? null}, now() - ${`${opts.ageSeconds ?? 0} seconds`}::interval)
  `;
}

async function seedPlanClaim(
  owner: string,
  opts: { plan?: string; item?: string; ttlSec?: number; ownerName?: string | null; workspaceId?: string } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_name, intent, expires_ts)
    VALUES (${opts.workspaceId ?? WS}, 'all', ${opts.plan ?? 'plan-x'}, ${opts.item ?? 'P-001'},
            ${owner}, ${opts.ownerName ?? null}, 'testing',
            now() + ${`${opts.ttlSec ?? 1200} seconds`}::interval)
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
  await truncateAll();
}, 120_000);

afterAll(async () => {
  await truncateAll().catch(() => {});
  await _stopForTests();
  await fx.dispose();
});

beforeEach(async () => {
  await truncateAll();
});

describe('fleet_assignment view + reader (P-001/P-002)', () => {
  it('EI-8106: running nursery aliases are positive recorded-live evidence during bootstrap', async () => {
    await seedSpawn('fa-test-bootstrap', { runId: 'fa-test-bootstrap-run' });
    await seedSpawn('fa-test-stale', { heartbeatAgeSeconds: 1200 });

    const live = await recordedLiveOwnerIds([
      'fa-test-bootstrap',
      'fa-test-bootstrap-run',
      'fa-test-stale',
      'missing-owner',
    ]);

    expect(live.has('fa-test-bootstrap')).toBe(true);
    expect(live.has('fa-test-bootstrap-run')).toBe(true);
    expect(live.has('fa-test-stale')).toBe(false);
    expect(live.has('missing-owner')).toBe(false);
  });

  it('unifies presence, plan-item claims, and work-item claims in one read', async () => {
    await seedPresence('su-live', { intent: 'building', planSlug: 'plan-x' });
    await seedPlanClaim('su-live', { plan: 'plan-x', item: 'P-007' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, source_plan_slug)
      VALUES (${WS}, 'demo', 'FA-TEST-1', 'a feature', 'todo', 'su-live', now(), 'plan-x')
    `;
    await admin`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, state, assignee)
      VALUES (${WS}, 'FA-TEST-EI1', 'an issue', 'open', 'su-live')
    `;

    const rows = await listFleetAssignments({ workspaceId: WS });
    const sources = rows.map((r) => r.source).sort();
    expect(sources).toEqual(['plan_item_claim', 'presence', 'work_item_claim', 'work_item_claim']);

    const grouped = groupByAgent(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].agentId).toBe('su-live');
    expect(grouped[0].alive).toBe(true);
    expect(grouped[0].claims).toHaveLength(3);
    expect(grouped[0].declaredUnclaimed).toBe(false); // plan-x is backed by a claim
  });

  it('CLAIM-PRIMARY: a live lease with a stale/absent holder is orphaned, not dropped', async () => {
    // Stale holder (presence row 20 min old — beyond the 10-min alive window).
    await seedPresence('su-stale', { ageSeconds: 20 * 60 });
    await seedPlanClaim('su-stale', { plan: 'plan-a', item: 'P-001' });
    // Absent holder (no presence row at all — crashed agent).
    await seedPlanClaim('su-gone', { plan: 'plan-b', item: 'P-002' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const orphans = orphanedClaims(rows);
    expect(orphans.map((o) => o.agentId).sort()).toEqual(['su-gone', 'su-stale']);
    const gone = orphans.find((o) => o.agentId === 'su-gone');
    expect(gone?.holderPresent).toBe(false);
    const stale = orphans.find((o) => o.agentId === 'su-stale');
    expect(stale?.holderPresent).toBe(true);
    expect(stale?.holderAlive).toBe(false);
  });

  it('terminal work-items and lapsed leases drop out (activeOnly default)', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-DONE', 'done feature', 'done', 'su-x', now())
    `;
    // A lapsed lease (expired 100s ago, unreclaimed).
    await seedPlanClaim('su-x', { plan: 'plan-l', item: 'P-009', ttlSec: -100 });

    const rows = await listFleetAssignments({ workspaceId: WS });
    expect(rows.filter((r) => r.source !== 'presence')).toHaveLength(0);

    // include_lapsed surfaces the expired lease (flagged inactive).
    const all = await listFleetAssignments({ workspaceId: WS, activeOnly: false });
    const lapsed = all.find((r) => r.itemId === 'P-009');
    expect(lapsed?.claimActive).toBe(false);
  });

  it('filters: by plan ("who\'s on P"), by agent ("what is X doing"), by workspace', async () => {
    await seedPresence('su-a', { planSlug: 'plan-x' });
    await seedPlanClaim('su-a', { plan: 'plan-x', item: 'P-001' });
    await seedPlanClaim('su-b', { plan: 'plan-y', item: 'P-002' });
    await seedPresence('su-other-ws', { workspaceId: 'other' });

    const onPlanX = await listFleetAssignments({ workspaceId: WS, plan: 'plan-x' });
    expect(onPlanX.every((r) => r.planSlug === 'plan-x')).toBe(true);
    expect(new Set(onPlanX.map((r) => r.agentId))).toEqual(new Set(['su-a']));

    const agentB = await listFleetAssignments({ workspaceId: WS, agent: 'su-b' });
    expect(agentB).toHaveLength(1);
    expect(agentB[0].itemId).toBe('P-002');

    const scoped = await listFleetAssignments({ workspaceId: WS });
    expect(scoped.some((r) => r.agentId === 'su-other-ws')).toBe(false);
  });

  it('surfaces the declared-but-unclaimed smell (D-002)', async () => {
    await seedPresence('su-talk', { planSlug: 'plan-z', intent: 'on plan-z (allegedly)' });
    const grouped = groupByAgent(await listFleetAssignments({ workspaceId: WS }));
    expect(grouped[0].declaredUnclaimed).toBe(true);
  });

  // ── EI-311: nursery alias liveness (migration 225) ──────────────────────────
  // A spawned bee's claim can key to ANY of its identity aliases (spawn_id ==
  // session_owner, or the run_id a degraded bee self-identified by), and a
  // short-lived bee may never write a presence row at all — the nursery's
  // process heartbeat is its liveness.

  it("EI-311: a claim keyed to a RUNNING spawn's run_id reads alive, not orphaned (the WI-122 repro)", async () => {
    await seedSpawn('fa-test-bee', { runId: 'opspawn-fa-test-bee' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-EI311', 'bee work', 'open', 'opspawn-fa-test-bee', now())
    `;
    const rows = await listFleetAssignments({ workspaceId: WS });
    const claim = rows.find((r) => r.workItemId === 'FA-TEST-EI311');
    expect(claim?.holderPresent).toBe(true);
    expect(claim?.holderAlive).toBe(true);
    expect(claim?.orphaned).toBe(false);
  });

  it('EI-311: spawn_id-keyed claims join the nursery too; presence wins when both exist', async () => {
    // spawn_id-keyed claim, no presence row → nursery liveness carries it.
    await seedSpawn('fa-test-bee2');
    await seedPlanClaim('fa-test-bee2', { plan: 'plan-n', item: 'P-031' });
    // The same owner ALSO has a presence row (declared intent) → presence's
    // richer fields (intent) must win over the nursery synthetic row.
    await seedSpawn('fa-test-bee3');
    await seedPresence('fa-test-bee3', { intent: 'declared via coord' });
    await seedPlanClaim('fa-test-bee3', { plan: 'plan-n', item: 'P-032' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const viaNursery = rows.find((r) => r.itemId === 'P-031');
    expect(viaNursery?.holderAlive).toBe(true);
    expect(viaNursery?.orphaned).toBe(false);
    const viaPresence = rows.find((r) => r.itemId === 'P-032');
    expect(viaPresence?.holderAlive).toBe(true);
    expect(viaPresence?.holderIntent).toBe('declared via coord');
  });

  it('EI-311: a FINISHED or stale-heartbeat spawn still orphans its claims', async () => {
    await seedSpawn('fa-test-done', { runId: 'opspawn-fa-test-done', status: 'done' });
    await seedPlanClaim('opspawn-fa-test-done', { plan: 'plan-n', item: 'P-033' });
    await seedSpawn('fa-test-stale', { heartbeatAgeSeconds: 20 * 60 });
    await seedPlanClaim('fa-test-stale', { plan: 'plan-n', item: 'P-034' });

    const rows = await listFleetAssignments({ workspaceId: WS });
    const done = rows.find((r) => r.itemId === 'P-033');
    expect(done?.holderPresent).toBe(false); // finished spawn emits no holder row
    expect(done?.orphaned).toBe(true);
    const stale = rows.find((r) => r.itemId === 'P-034');
    expect(stale?.holderPresent).toBe(true); // running but heartbeat stale
    expect(stale?.holderAlive).toBe(false);
    expect(stale?.orphaned).toBe(true);
  });
});

describe('per-assignee work-list: reorder + projection (local-hive P-020/P-021/D-008)', () => {
  // Seed a bee holding a mix of feature + issue work-items, then exercise the
  // reorder_work_item SQL fn (via the engine) + the fleet_assignment rank surfacing.
  async function seedBeeQueue(): Promise<void> {
    await seedPresence('su-bee', { intent: 'working its list' });
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, created_ts, ts, updated_ts)
      VALUES
        (${WS}, 'demo', 'FA-TEST-F1', 'feature one', 'todo', 'feature', 'su-bee', now(), 1, 1, 1),
        (${WS}, 'demo', 'FA-TEST-F2', 'feature two', 'todo', 'feature', 'su-bee', now(), 2, 2, 2),
        (${WS}, 'demo', 'FA-TEST-F3', 'feature three', 'todo', 'feature', 'su-bee', now(), 3, 3, 3)
    `;
    await admin`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, kind, state, assignee, assigned_at)
      VALUES (${WS}, 'FA-TEST-B1', 'harness:demo', 'a blocking bug', 'bug', 'open', 'su-bee', now())
    `;
  }

  it('reorder places items at a rank (insert-at-rank, peers shift) across both families', async () => {
    await seedBeeQueue();
    // Bee self-sequences its initial list 0..3 (default writer 'bee').
    await reorderWorkItem('FA-TEST-F1', 0);
    await reorderWorkItem('FA-TEST-F2', 1);
    await reorderWorkItem('FA-TEST-F3', 2);
    const seeded = await reorderWorkItem('FA-TEST-B1', 3);
    expect('error' in seeded).toBe(false);

    // Queen injects the bug to head-of-line (writer 'queen' — the propose/dispose audit).
    const moved = await reorderWorkItem('FA-TEST-B1', 0, { writer: 'mug' });
    if ('error' in moved) throw new Error(moved.error);
    expect(moved.rank).toBe(0);
    expect(moved.writer).toBe('mug');
    expect(moved.queue.map((q) => q.id)).toEqual(['FA-TEST-B1', 'FA-TEST-F1', 'FA-TEST-F2', 'FA-TEST-F3']);
  });

  it('rejects ranking an unassigned item', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, ts, updated_ts)
      VALUES (${WS}, 'demo', 'FA-TEST-UNASSIGNED', 'nobody owns me', 'todo', 'feature', 1, 1, 1)
    `;
    const res = await reorderWorkItem('FA-TEST-UNASSIGNED', 0);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/unassigned/);
  });

  it('the projection surfaces doing/queued/load with rank_writer through the view', async () => {
    await seedBeeQueue();
    await reorderWorkItem('FA-TEST-F1', 0);
    await reorderWorkItem('FA-TEST-F2', 1);
    await reorderWorkItem('FA-TEST-F3', 2);
    await reorderWorkItem('FA-TEST-B1', 0, { writer: 'mug' }); // Queen head-of-line

    const rows = await listFleetAssignments({ workspaceId: WS, agent: 'su-bee' });
    // every work-item row carries its rank + writer off the view
    const wiRows = rows.filter((r) => r.source === 'work_item_claim');
    expect(wiRows.length).toBe(4);
    const head = wiRows.find((r) => r.assigneeRank === 0);
    expect(head?.workItemId).toBe('FA-TEST-B1');
    expect(head?.rankWriter).toBe('mug');

    const grouped = groupByAgent(rows);
    const bee = grouped.find((g) => g.agentId === 'su-bee')!;
    expect(bee.load).toBe(4);
    expect(bee.doing?.id).toBe('FA-TEST-B1'); // head-of-line
    expect(bee.doing?.rankWriter).toBe('mug');
    expect(bee.queued.map((q) => q.id)).toEqual(['FA-TEST-B1', 'FA-TEST-F1', 'FA-TEST-F2', 'FA-TEST-F3']);
  });
});

describe('fleet_assignment change-feed (P-005/P-006)', () => {
  const received: FleetAssignmentChange[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    received.length = 0;
    unsubscribe = onFleetAssignmentChange((c) => received.push(c));
    // Let the lazy LISTEN connection establish before triggering writes.
    await vi.waitFor(async () => {
      await admin`SELECT 1`;
    });
    await new Promise((r) => setTimeout(r, 150));
  });

  afterEach(async () => {
    unsubscribe?.();
    await _stopForTests();
  });

  it('claim acquire → wake; lease renewal → silent; release → wake', async () => {
    await seedPlanClaim('su-feed', { plan: 'plan-f', item: 'P-001' });
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'plan_item_claim' && c.agentId === 'su-feed')).toBe(true);
    });

    received.length = 0;
    // Renewal: only the lease timestamps move — must NOT notify.
    await admin`
      UPDATE harness_shared.plan_item_claims
      SET expires_ts = now() + interval '40 minutes', last_activity_ts = now()
      WHERE owner = 'su-feed'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    await admin`DELETE FROM harness_shared.plan_item_claims WHERE owner = 'su-feed'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'plan_item_claim')).toBe(true);
    });
  });

  it('presence intent change → wake; heartbeat-only bump → silent', async () => {
    await seedPresence('su-pulse', { intent: 'first' });
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'presence' && c.agentId === 'su-pulse')).toBe(true);
    });

    received.length = 0;
    await admin`UPDATE harness_shared.coord_presence SET heartbeat_at = now() WHERE owner_id = 'su-pulse'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    await admin`UPDATE harness_shared.coord_presence SET intent = 'second' WHERE owner_id = 'su-pulse'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'presence' && c.agentId === 'su-pulse')).toBe(true);
    });
  });

  it('work-item claim scalar change → wake (features + issues); status churn → silent', async () => {
    await admin`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at)
      VALUES (${WS}, 'demo', 'FA-TEST-FEED', 'feed feature', 'todo', 'feature', 'su-wf', now())
    `;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'work_item_claim' && c.agentId === 'su-wf')).toBe(true);
    });

    received.length = 0;
    // Status churn without a claim change must NOT fire the assignment feed.
    await admin`
      UPDATE harness_shared.harness_features_consolidated
      SET status = 'validating' WHERE feature_id = 'FA-TEST-FEED'`;
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);

    // Release (taken_by → NULL) fires, attributed to the OLD holder.
    await admin`
      UPDATE harness_shared.harness_features_consolidated
      SET taken_by = NULL WHERE feature_id = 'FA-TEST-FEED'`;
    await vi.waitFor(() => {
      expect(received.some((c) => c.source === 'work_item_claim' && c.agentId === 'su-wf')).toBe(true);
    });
  });
});
