/**
 * goal-plan-fleet-obligation-detector-2026-08-27 P-003 — the plan-fleet leg's
 * REAL delivery, end to end, against a real migrated Postgres.
 *
 * The sibling `goal-plan-fleet-cohort.integration.test.ts` proves the real cohort
 * JOIN but stubs all three delivery seams; the unit suite
 * (`goal-drain-fleet-watchdog.plan-fleet-delivery.test.ts`) exercises the
 * production defaults but mocks `openEscalation` and `emitAwaitedEvent`. This
 * file closes the gap between them: `runGoalDrainFleetSweepOnce` runs with the
 * PRODUCTION `escalatePlanFleet` / `emitPlanFleet` / `notifyPlanFleetHolders`,
 * so every row the sweep writes — the deduped escalation, both parkable event
 * fires, and the directed message to the goal's holder — lands in real tables
 * and is read back from them.
 *
 * Stubbed (inputs, never outputs): the goals/holder read, the session-liveness
 * oracle, and the kill-switch flag read. `@papercusp/db-org` is pointed at the
 * per-run test database, exactly as `events/await/wake-on-message.integration.test.ts`
 * does.
 *
 * Schema: the real head schema via `createOrgTestDb()` — never inline DDL.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-plan-fleet-delivery-p003' }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => h.ws, backgroundWorkspaceIds: () => [h.ws] };
});

const { PgCoordLog } = await import('@papercusp/coordination/event-log');
const { configureCoordLog, resetCoordLog } = await import('../agent-tools/coordination/log');
const engine = await import('../events/await/engine');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { DEFAULT_CLAIM_SPEC, validateClaimSpec } = await import('../scheduler/claim-spec');
const { runGoalDrainFleetSweepOnce } = await import('./goal-drain-fleet-watchdog');

import type { OrgTestDb } from '../../test/_org-test-db';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { ClaimSpec } from '../scheduler/claim-spec';
import type { GoalDrainFleetSweepDeps, GoalDrainRowLike } from './goal-drain-fleet-watchdog';

const WS = h.ws;
const H = 'papercusp-p003-delivery';
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
const LIVE = ['su-dha', 'su-dhh', 'su-dlead', 'su-dwork'];
const resolveLiveness = vi.fn(async (ids: string[]) => new Map(ids.filter((id) => LIVE.includes(id)).map((id) => [id, live(id)])));

/** g-da = leg A (started plan, no targeting fleet). g-dh = healthy control (live member claim). */
const GOALS: GoalDrainRowLike[] = ['a', 'h'].map((k) => ({
  goalId: `g-d${k}`,
  workspaceId: WS,
  title: `delivery goal ${k}`,
  createdAtMs: Date.now(), // inside the kickoff grace: the DRAIN leg stays silent, only the plan leg speaks
  drainFleet: null,
}));
const HOLDERS = GOALS.map((g) => ({ goalId: g.goalId, workspaceId: WS, ownerId: `su-dh${g.goalId.slice(3)}`, setAtMs: Date.now() }));

function planSpec(planSlug: string): ClaimSpec {
  const spec = { ...DEFAULT_CLAIM_SPEC, view: { ...DEFAULT_CLAIM_SPEC.view, filter: { field: 'plan', op: '=', value: planSlug } } } as ClaimSpec;
  expect(validateClaimSpec(spec).ok).toBe(true);
  return spec;
}

async function seedPlan(goalId: string, planSlug: string, items: Array<[string, string]>) {
  await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, goal_id, op_status, archived)
            VALUES (${WS}, ${H}, ${planSlug}, ${goalId}, 'started', false)`;
  let seq = 1;
  for (const [itemId, status] of items) {
    await sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, status)
              VALUES (${WS}, ${H}, ${planSlug}, ${itemId}, ${seq++}, ${status})`;
  }
}

async function seedHealthyFleet(fleetSlug: string, planSlug: string, leader: string, worker: string) {
  await sql`INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, owner, leader_owner_id)
            VALUES (${WS}, ${fleetSlug}, ${Date.now()}, ${leader}, ${leader})`;
  await sql`INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec)
            VALUES (${WS}, ${`fleet:${fleetSlug}`}, ${sql.json(planSpec(planSlug) as unknown as postgres.JSONValue)})`;
  for (const ownerId of [leader, worker]) {
    await sql`INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, fleet_slug, heartbeat_at)
              VALUES (${ownerId}, ${ownerId}, ${WS}, 'test', ${fleetSlug}, now())`;
  }
  await sql`INSERT INTO harness_shared.plan_item_claims (workspace_id, harness_slug, plan_slug, item_id, owner, intent, expires_ts)
            VALUES (${WS}, ${H}, ${planSlug}, 'P-001', ${worker}, 'p003 delivery fixture', now() + interval '20 minutes')`;
}

/** Inputs only — every delivery seam is left at its production default. */
function inputDeps(): Partial<GoalDrainFleetSweepDeps> {
  return {
    readGoals: vi.fn(async () => ({ goals: GOALS, holders: HOLDERS })),
    resolveLiveness,
    flagEnabled: vi.fn(async () => true),
    // the DRAIN leg is out of scope here (and silent inside the kickoff grace) — pinned below
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
  };
}

async function planFleetEscalations() {
  const rows = await sql<{ body: Record<string, unknown> }[]>`
    SELECT body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${WS} AND surface = 'escalations'`;
  return rows.map((r) => r.body).filter((b) => JSON.stringify(b).includes('goal-plan-fleet-obligation'));
}

/**
 * The per-key fire latch is written under `DEFAULT_COORD_WORKSPACE`, NOT the emit's
 * `workspaceId` (events/await/store.ts `eventsWs()`, a known single-namespace design —
 * WI-3575). Filtering on WS here reads a confident empty set, so scope by the
 * fixture-unique key instead (the database is per-run and disposable).
 */
async function goalFires() {
  return sql<{ event_key: string; last_fired_by: string | null; last_payload: Record<string, unknown> | null; fire_count: string }[]>`
    SELECT event_key, last_fired_by, last_payload, fire_count::text AS fire_count
      FROM harness_shared.event_key_fires
     WHERE event_key LIKE 'goal:%g-d%'
     ORDER BY event_key`;
}

async function messagesTo(ownerId: string) {
  const rows = await sql<{ body: Record<string, unknown> }[]>`
    SELECT body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${WS} AND surface = 'messages'`;
  return rows
    .map((r) => r.body)
    .filter((b) => Array.isArray((b as { to?: unknown }).to) && ((b as { to: string[] }).to).includes(ownerId));
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
  await seedPlan('g-da', 'pda-missing', [['P-001', 'todo'], ['P-002', 'done']]);
  await seedPlan('g-dh', 'pdh-healthy', [['P-001', 'wip']]);
  await seedHealthyFleet('fdh', 'pdh-healthy', 'su-dlead', 'su-dwork');
}, 300_000);

afterAll(async () => {
  await db?.cleanup();
}, 120_000);

beforeEach(() => {
  // delivery narrates through console.warn (pump, fail-soft latches) — expected noise
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  configureCoordLog(new PgCoordLog({ getSql: () => sql as never, ensureSchema: async () => {}, workspaceId: WS }));
  // no production host discovery from inside a test: the wake is asserted at the ledger, not a socket
  engine.setAutoPumpEnabledForTests(false);
});

afterEach(() => {
  engine.setAutoPumpEnabledForTests(true);
  resetCoordLog();
  vi.restoreAllMocks();
});

describe('plan-fleet leg — production delivery into real tables', () => {
  it('leg A writes ONE deduped escalation, both parkable fires, and one message to the goal holder; the healthy goal writes nothing', async () => {
    const deps = inputDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ scanned: 2, escalated: 0, planFleetEscalated: 1 });
    expect(deps.escalate).not.toHaveBeenCalled();

    const escalations = await planFleetEscalations();
    expect(escalations).toHaveLength(1);
    const esc = JSON.stringify(escalations[0]);
    expect(esc).toContain(`${WS}:g-da:started-plan-no-live-targeting-fleet:pda-missing`);
    expect(esc).toContain("fleet:launch-on-plan { plan: 'pda-missing' }");
    expect(esc).not.toContain('pdh-healthy');

    const fires = await goalFires();
    expect(fires.map((f) => f.event_key)).toEqual(['goal:plan-fleet-missing:g-da', 'goal:plan-placement:g-da']);
    for (const f of fires) {
      expect(f.last_fired_by).toBe('goal-drain-fleet-watchdog');
      expect(f.last_payload).toMatchObject({
        goalId: 'g-da',
        reason: 'started-plan-no-live-targeting-fleet',
        planSlug: 'pda-missing',
        openItemCount: 1,
        liveHolders: ['su-dha'],
      });
    }

    const toHolder = await messagesTo('su-dha');
    expect(toHolder).toHaveLength(1);
    expect(JSON.stringify(toHolder[0])).toContain("Goal 'g-da': started plan 'pda-missing'");
    expect(await messagesTo('su-dhh')).toHaveLength(0); // the healthy goal's holder is never woken
  });

  it('a second sweep over the SAME condition coalesces: no second escalation, no second holder message, fires re-latch', async () => {
    const res = await runGoalDrainFleetSweepOnce(sql, inputDeps());
    expect(res).toMatchObject({ planFleetEscalated: 1 });
    expect(await planFleetEscalations()).toHaveLength(1);
    expect(await messagesTo('su-dha')).toHaveLength(1); // holder woken only on a NEW episode (D-004)
    const fires = await goalFires();
    expect(fires.map((f) => [f.event_key, f.fire_count])).toEqual([
      ['goal:plan-fleet-missing:g-da', '2'],
      ['goal:plan-placement:g-da', '2'],
    ]);
  });
});
