/** Canonical PG writers -> portfolio receipt; no paid/native agent is spawned. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { readGoalPortfolioBrief } from './goal-launch-settings';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { createFleetIfAbsent, setFleetHeadcountTarget, setFleetLeader, setFleetLaunchTransaction } from './agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from './agent-tools/coordination/presence';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import { setClaimSpec } from './scheduler/claim-spec-store';
import { acquireClaim } from './plan-items/claims';
import { createWorkItem } from './work-items';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const HARNESS = `zzz-placement-${RUN}`;
const PLAN = `plan-${RUN}`;
const GOAL = `goal-${RUN}`;
const FLEET = `fleet-${RUN}`;
const HOLDER = `su-holder-${RUN}`;
const LEADER = `su-leader-${RUN}`;
const MEMBER = `su-member-${RUN}`;
const OUTSIDER = `su-outsider-${RUN}`;
const OWNERS = [HOLDER, LEADER, MEMBER, OUTSIDER];
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Placement claim fixture', body: 'Productive delegated plan execution', status: 'active',
    killCriterion: 'A launch receipt is confused with a member claim.' });
  expect((await setMode({ workspaceId: WS, ownerId: HOLDER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'P003 isolated PG claim proof', setBy: HOLDER, sql: fx.admin })).ok).toBe(true);
  // Lifecycle eligibility is an explicit fixture input; this does not attest plan activation.
  const body = `---\ntitle: Productive plan\nslug: ${PLAN}\nstatus: ready\n---\n\n## Build\n\n- **P-001** \`wip\` Implement the outcome\n`;
  await seedPlan(fx.admin, WS, HARNESS, PLAN, body);
  const idx = deriveIndexFromContent(body);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${idx.title}, status = ${idx.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN }, idx);
    const written = await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
      workspaceId: WS, goalId: GOAL, property: 'worklist', value: [`plan:${HARNESS}/${PLAN}`],
      expectedVersion: 0, actorId: HOLDER, provenance: 'agent-edit',
    });
    expect(written.ok).toBe(true);
  });
}, 150_000);

beforeEach(async () => {
  for (const ownerId of OWNERS) await heartbeatPresence({ ownerId, ownerLabel: ownerId,
    source: 'omp-hook-session', workspaceId: WS, userId: null });
  expect((await createFleetIfAbsent({ workspaceId: WS, fleetSlug: FLEET,
    leaderOwnerId: LEADER, title: 'Plan fleet fixture' }, fx.admin)).created).toBe(true);
  await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
    config: { plan: PLAN, harness: HARNESS, agent: 'codex', model: 'gpt-6-sol', effort: 'xhigh', supervise: false }, sql: fx.admin });
  await setPresenceFleet(WS, LEADER, FLEET, 'leader', fx.admin);
  await setPresenceFleet(WS, MEMBER, FLEET, 'member', fx.admin);
  await setPresenceFleet(WS, OUTSIDER, `${FLEET}-other`, 'member', fx.admin);
  expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
    spec: { ...DEFAULT_CLAIM_SPEC, specId: 'fixture-plan', view: { filter: { field: 'plan', op: '=', value: PLAN } } },
  }, fx.admin)).ok).toBe(true);
  expect(await setFleetLaunchTransaction({ workspaceId: WS, fleetSlug: FLEET, sql: fx.admin,
    transaction: { version: 1, transactionId: 'fixture-verified-launch', launcherOwnerId: HOLDER,
      requestedAt: Date.now(), updatedAt: Date.now(), state: 'verified', requestedMemberIds: [MEMBER],
      openedMemberIds: [MEMBER], verifiedMemberIds: [MEMBER], workerReadyMemberIds: [],
      failed: [], waves: [], recovery: { retryOwnerIds: [], nextAction: 'verify member pickup' } },
  })).toBe(true);
}, 90_000);

afterEach(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.plan_item_claims WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${`fleet:${FLEET}`}`;
  await fx.admin`DELETE FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
  await fx.admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.fleet_membership_events WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${HOLDER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${HOLDER}`;
  await fx.admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

async function lease(owner = MEMBER, itemId = 'P-001') {
  const result = await acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN,
    itemId, owner, intent: 'Isolated claimed plan work', ttlSec: 1200 });
  expect(result.ok).toBe(true);
  return result;
}
async function claimedWork(owner = MEMBER, planSlug = PLAN, itemId = 'P-001') {
  // Canonical atomic create+claim writer, rather than inserting a fabricated taken_by row.
  const work = await createWorkItem({ workspaceId: WS, harness: HARNESS, kind: 'task',
    title: `Placement claim ${owner}`, summary: 'Isolated P003 verification work',
    createdBy: LEADER, assignee: owner, sourcePlanSlug: planSlug, sourcePlanItemIds: [itemId] });
  const rows = await fx.admin`SELECT feature_id, harness_slug, status, taken_by, source_plan_slug, source_plan_item_ids
    FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${work.id}`;
  expect(rows).toMatchObject([{ feature_id: work.id, harness_slug: HARNESS, taken_by: owner,
    source_plan_slug: planSlug, source_plan_item_ids: [itemId] }]);
  return work;
}
async function placement() {
  const p = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL });
  expect(p).not.toBeNull();
  expect(p!.degradedReasons.filter((r) => /portfolio read failed/.test(r))).toEqual([]);
  expect(p!.worklist).toHaveLength(1);
  return p!.worklist[0]!.placement;
}

describe('canonical delegated-member claim receipt', () => {
  it('keeps a verified launch without a member claim admitting and preserves the one fleet', async () => {
    expect(await placement()).toMatchObject({ state: 'admitting', activeLane: null, reconciliation: { consistent: false, toolCall: null } });
    expect((await createFleetIfAbsent({ workspaceId: WS, fleetSlug: FLEET, leaderOwnerId: LEADER }, fx.admin)).created).toBe(false);
    const fleets = await fx.admin`SELECT fleet_slug FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
    expect(fleets).toHaveLength(1);
    expect((await placement()).reconciliation.toolCall).toBeNull();
  });
  it('only reports working after the real member work-item claim and matching TTL lease both exist', async () => {
    await lease();
    expect((await placement()).state).not.toBe('working');
    const work = await claimedWork();
    expect(await placement()).toMatchObject({ state: 'working', activeLane: { ownerId: MEMBER, workItemId: work.id },
      fleet: { leaderOwnerId: LEADER, planScoped: true }, reconciliation: { consistent: true, action: 'none' } });
  });
  it('does not count the leader claimed work item and lease as independent member pickup', async () => {
    await lease(LEADER); await claimedWork(LEADER);
    expect(await placement()).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
  });
  it('does not count another fleet member even when the claimed work item and lease match', async () => {
    await lease(OUTSIDER); await claimedWork(OUTSIDER);
    expect((await placement()).state).not.toBe('working');
  });
  it('requires the work item to name the same plan and item as the lease', async () => {
    await lease(); await claimedWork(MEMBER, `${PLAN}-other`);
    expect((await placement()).state).not.toBe('working');
    await claimedWork(MEMBER, PLAN, 'P-999');
    expect((await placement()).state).not.toBe('working');
    await claimedWork();
    expect((await placement()).state).toBe('working');
  });
  it('rechecks the current positive filter rather than trusting the launch transaction', async () => {
    await lease(); await claimedWork();
    expect((await placement()).state).toBe('working');
    expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
      spec: { ...DEFAULT_CLAIM_SPEC, specId: 'wrong-lane', view: { filter: { field: 'plan', op: '=', value: 'different-plan' } } },
    }, fx.admin)).ok).toBe(true);
    expect(await placement()).toMatchObject({ state: 'blocked', reconciliation: { consistent: false, toolCall: null } });
  });
  it('does not treat the current GOAL holder as the independent leader', async () => {
    await lease(); await claimedWork();
    await setFleetLeader(WS, FLEET, HOLDER, fx.admin);
    expect((await placement()).state).toBe('blocked');
  });
  it('drops working when the member lease expires without instructing a duplicate launch', async () => {
    await lease(); await claimedWork();
    expect((await placement()).state).toBe('working');
    await fx.admin`UPDATE harness_shared.plan_item_claims SET expires_ts = now() - interval '1 second'
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(await placement()).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
  });
});
