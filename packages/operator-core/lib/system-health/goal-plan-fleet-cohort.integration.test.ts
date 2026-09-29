/**
 * goal-plan-fleet-obligation-detector-2026-08-27 P-003 — the plan-fleet leg
 * against a REAL Postgres (bounded fixture).
 *
 * The unit suites inject the cohort. This file proves the parts they cannot:
 * the REAL `readGoalPlanFleetCohort` join (started/archived plan filter,
 * non-terminal items, TTL-backed claims, claim-spec targeting, fleet-membership
 * claim attribution) and the REAL `makeResolveFleetLiveness` fleet/member read,
 * composed through `runGoalDrainFleetSweepOnce`. Only the session oracle
 * (`resolveLiveness`), the goals/holder read and the delivery seams are stubbed.
 *
 * Schema: the real head schema via `createOrgTestDb()` — never inline DDL (see
 * goal-holder-respawn.integration.test.ts for why hand-rolled fixtures drift).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, type ClaimSpec } from '../scheduler/claim-spec';
import {
  makeResolveFleetLiveness,
  readGoalPlanFleetCohort,
  runGoalDrainFleetSweepOnce,
  type GoalDrainFleetSweepDeps,
  type GoalDrainRowLike,
  type GoalPlanFleetAlert,
} from './goal-drain-fleet-watchdog';

const WS = 'ws-plan-fleet-p003';
const H = 'papercusp-p003';
let db: OrgTestDb;
let sql: postgres.Sql;

const live = (ownerId: string): LivenessVerdict => ({
  ownerId,
  sessionState: 'live',
  wakeable: true,
  liveTurn: true,
  confirmLiveness: null,
  heartbeatFresh: true,
});

/** su-wu (fleet fu's only worker) is deliberately ABSENT: an unresolved verdict is UNKNOWN. */
const LIVE = ['su-ha', 'su-hb', 'su-hh', 'su-hu', 'su-hx', 'su-hd', 'su-wb', 'su-wh', 'su-lead-b', 'su-lead-h', 'su-outsider'];
const resolveLiveness = vi.fn(async (ids: string[]) => new Map(ids.filter((id) => LIVE.includes(id)).map((id) => [id, live(id)])));

const GOALS: GoalDrainRowLike[] = ['a', 'b', 'h', 'u', 'x', 'd'].map((k) => ({
  goalId: `g-${k}`,
  workspaceId: WS,
  title: `goal ${k}`,
  createdAtMs: Date.now(), // inside the kickoff grace: the DRAIN leg stays silent, only the plan leg speaks
  drainFleet: null,
}));
const HOLDERS = GOALS.map((g) => ({ goalId: g.goalId, workspaceId: WS, ownerId: `su-h${g.goalId.slice(2)}`, setAtMs: Date.now() }));

function planSpec(planSlug: string): ClaimSpec {
  const spec = { ...DEFAULT_CLAIM_SPEC, view: { ...DEFAULT_CLAIM_SPEC.view, filter: { field: 'plan', op: '=', value: planSlug } } } as ClaimSpec;
  expect(validateClaimSpec(spec).ok).toBe(true); // precondition: the reader drops invalid specs
  return spec;
}

/** `opStatus` is harness_plans_op_status_check's domain: NULL (never started) | started | paused | done. */
async function seedPlan(
  goalId: string,
  planSlug: string,
  items: Array<[string, string]>,
  opts: { opStatus?: 'started' | 'paused' | 'done' | null; archived?: boolean } = {},
) {
  const opStatus = opts.opStatus === undefined ? 'started' : opts.opStatus;
  await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, goal_id, op_status, archived)
            VALUES (${WS}, ${H}, ${planSlug}, ${goalId}, ${opStatus}, ${opts.archived ?? false})`;
  let seq = 1;
  for (const [itemId, status] of items) {
    await sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, status)
              VALUES (${WS}, ${H}, ${planSlug}, ${itemId}, ${seq++}, ${status})`;
  }
}

async function seedFleet(fleetSlug: string, planSlug: string, leader: string, members: string[]) {
  await sql`INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, owner, leader_owner_id)
            VALUES (${WS}, ${fleetSlug}, ${Date.now()}, ${leader}, ${leader})`;
  await sql`INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec)
            VALUES (${WS}, ${`fleet:${fleetSlug}`}, ${sql.json(planSpec(planSlug) as unknown as postgres.JSONValue)})`;
  for (const ownerId of [leader, ...members]) {
    await sql`INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, fleet_slug, heartbeat_at)
              VALUES (${ownerId}, ${ownerId}, ${WS}, 'test', ${fleetSlug}, now())`;
  }
}

async function claim(planSlug: string, itemId: string, owner: string, ttlSec: number) {
  await sql`INSERT INTO harness_shared.plan_item_claims (workspace_id, harness_slug, plan_slug, item_id, owner, intent, expires_ts)
            VALUES (${WS}, ${H}, ${planSlug}, ${itemId}, ${owner}, 'p003 fixture', now() + ${`${ttlSec} seconds`}::interval)
            ON CONFLICT ON CONSTRAINT plan_item_claims_pkey
            DO UPDATE SET owner = EXCLUDED.owner, expires_ts = EXCLUDED.expires_ts`; // one claim row per item
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  // g-a / leg A: a started plan with one open item and NO targeting fleet (the done item must not count).
  await seedPlan('g-a', 'pa-missing', [['P-001', 'todo'], ['P-002', 'done']]);
  // g-b / leg B: a live targeting fleet whose only claim on the plan EXPIRED; a LIVE claim by a
  // NON-member must not be attributed to the fleet either.
  await seedPlan('g-b', 'pb-unclaimed', [['P-001', 'todo'], ['P-002', 'todo']]);
  await seedFleet('fb', 'pb-unclaimed', 'su-lead-b', ['su-wb']);
  await claim('pb-unclaimed', 'P-001', 'su-wb', -60);
  await claim('pb-unclaimed', 'P-002', 'su-outsider', 1200);
  // g-h / healthy control: live targeting fleet with a live member claim.
  await seedPlan('g-h', 'ph-healthy', [['P-001', 'wip']]);
  await seedFleet('fh', 'ph-healthy', 'su-lead-h', ['su-wh']);
  await claim('ph-healthy', 'P-001', 'su-wh', 1200);
  // g-u / unknown control: the targeting fleet's only worker has no verdict.
  await seedPlan('g-u', 'pu-unknown', [['P-001', 'todo']]);
  await seedFleet('fu', 'pu-unknown', 'su-lead-u', ['su-wu']);
  // g-x / out-of-scope control: archived, never-started (NULL) and paused plans are never judged.
  await seedPlan('g-x', 'px-archived', [['P-001', 'todo']], { archived: true });
  await seedPlan('g-x', 'px-unstarted', [['P-001', 'todo']], { opStatus: null });
  await seedPlan('g-x', 'px-paused', [['P-001', 'todo']], { opStatus: 'paused' });
  // g-d / completed control: a started plan whose items are all terminal.
  await seedPlan('g-d', 'pd-done', [['P-001', 'done'], ['P-002', 'dropped']]);
}, 300_000);

afterAll(async () => {
  await db?.cleanup();
}, 120_000);

describe('plan-fleet leg over a real Postgres cohort', () => {
  it('the real cohort read joins items, specs, membership and live claims correctly', async () => {
    const cohort = await readGoalPlanFleetCohort(sql, GOALS, makeResolveFleetLiveness(sql, resolveLiveness));
    expect(cohort.status).toBe('known');
    const bySlug = new Map(cohort.plans.map((p) => [p.planSlug, p]));
    expect([...bySlug.keys()].sort()).toEqual(['pa-missing', 'pb-unclaimed', 'pd-done', 'ph-healthy', 'pu-unknown']);
    expect(bySlug.get('pa-missing')).toMatchObject({ itemIds: ['P-001'], targetingFleets: [] });
    expect(bySlug.get('pb-unclaimed')!.targetingFleets).toEqual([{ fleetSlug: 'fb', liveness: 'alive', liveClaimItemIds: [] }]);
    expect(bySlug.get('ph-healthy')!.targetingFleets).toEqual([{ fleetSlug: 'fh', liveness: 'alive', liveClaimItemIds: ['P-001'] }]);
    expect(bySlug.get('pu-unknown')!.targetingFleets).toEqual([{ fleetSlug: 'fu', liveness: 'unknown', liveClaimItemIds: [] }]);
    expect(bySlug.get('pd-done')!.itemIds).toEqual([]);
  });

  it('the sweep alarms exactly leg A (g-a) and leg B (g-b); healthy, unknown, out-of-scope and completed goals stay silent', async () => {
    const deps: Partial<GoalDrainFleetSweepDeps> = {
      readGoals: vi.fn(async () => ({ goals: GOALS, holders: HOLDERS })),
      resolveLiveness,
      flagEnabled: vi.fn(async () => true),
      escalate: vi.fn(async () => {}),
      emitDrainDead: vi.fn(async () => {}),
      escalatePlanFleet: vi.fn(async () => ({ opened: true })),
      emitPlanFleet: vi.fn(async () => {}),
      notifyPlanFleetHolders: vi.fn(async () => {}),
    };
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ scanned: GOALS.length, escalated: 0, planFleetEscalated: 2 });
    const alerts = (deps.escalatePlanFleet as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as GoalPlanFleetAlert);
    expect(alerts.map((a) => [a.goalId, a.reason, a.planSlug]).sort()).toEqual([
      ['g-a', 'started-plan-no-live-targeting-fleet', 'pa-missing'],
      ['g-b', 'started-plan-targeting-fleet-zero-live-claims', 'pb-unclaimed'],
    ]);
    // the woken holder is the goal's own live holder, not a fleet member or an outsider
    const woken = (deps.notifyPlanFleetHolders as ReturnType<typeof vi.fn>).mock.calls.map((c) => [
      (c[0] as GoalPlanFleetAlert).goalId,
      (c[0] as GoalPlanFleetAlert).liveHolders,
    ]);
    expect(woken.sort()).toEqual([['g-a', ['su-ha']], ['g-b', ['su-hb']]]);
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('control flip: a live MEMBER claim on the plan clears leg B on the next sweep', async () => {
    await claim('pb-unclaimed', 'P-001', 'su-wb', 1200);
    const escalatePlanFleet = vi.fn(async (_alert: GoalPlanFleetAlert) => ({ opened: true }));
    await runGoalDrainFleetSweepOnce(sql, {
      readGoals: vi.fn(async () => ({ goals: GOALS, holders: HOLDERS })),
      resolveLiveness,
      flagEnabled: vi.fn(async () => true),
      escalate: vi.fn(async () => {}),
      emitDrainDead: vi.fn(async () => {}),
      escalatePlanFleet,
      emitPlanFleet: vi.fn(async () => {}),
      notifyPlanFleetHolders: vi.fn(async () => {}),
    });
    expect(escalatePlanFleet.mock.calls.map((c) => (c[0] as GoalPlanFleetAlert).goalId)).toEqual(['g-a']);
  });
});
