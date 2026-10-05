/**
 * goal-holder-behavior-metrics.integration.test.ts — the plan-authorship count against
 * real Postgres (WI-10006048).
 *
 * A holder writes a plan either with plans:new or by routing an idea onto the plan rail
 * (blender:route-idea { rail:'plan' }), which creates the draft through
 * createScoutPlanDraft and never calls plans:new. The WOE rating once counted plans:new
 * alone, so holder su-a70547cc, who routed an idea into a plan on 2026-10-03, read as
 * having written none. A route call can also settle 'ok' while creating nothing (a
 * refusal, or an idempotent re-route onto an existing plan), so it counts only when a
 * plan row was created inside the call's own run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  readGoalDayCandidates,
  readHolderPlanToolCounts,
  ROUTED_PLAN_CLOCK_SLACK_MS,
} from './goal-holder-behavior-metrics';

const { createOrgTestDb } = await import('../test/_org-test-db');

const WS = 'ws-goal-holder-metrics';
const HARNESS = 'papercusp';
const GOAL = 'goal-holder-metrics-goal';
const OTHER_GOAL = 'goal-holder-metrics-other-goal';
const HOLDER = 'su-holder-under-test';
const PEER = 'su-peer-not-graded';
const WINDOW_START = '2026-10-03T07:00:00.000Z';
const WINDOW_END = '2026-10-03T09:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('goal-holder plan authorship (real PG)', () => {
  let db: OrgTestDb;

  async function invocation(row: {
    owner: string;
    tool: string;
    invokedAt: string;
    durationMs?: number;
    goalId?: string | null;
    status?: string;
    args?: Record<string, unknown>;
  }): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
         coord_owner_id, invoked_at, duration_ms, goal_id, args_json)
      VALUES (${WS}, ${HARNESS}, 'operator', ${row.tool}, 'su', 'spawn-test', 'window-test',
              ${row.status ?? 'ok'}, ${row.owner}, ${at(row.invokedAt)}, ${row.durationMs ?? 150},
              ${row.goalId === undefined ? GOAL : row.goalId}, ${db.adminSql.json((row.args ?? {}) as never)})`;
  }

  async function plan(slug: string, createdAt: string, goalId: string | null = GOAL): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, goal_id, created_at)
      VALUES (${WS}, ${HARNESS}, ${slug}, ${slug}, 'draft', ${goalId}, ${at(createdAt)})`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();

    // 1. A route-idea call that created its plan: the plan row lands inside the call's
    //    run, 147 ms before the JS-stamped settle time (the shape measured live 2026-10-03).
    await plan('routed-plan-created', '2026-10-03T08:08:20.996Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:08:21.143Z', durationMs: 158,
      args: { rail: 'plan', featureId: 'EI-1' },
    });

    // 2. A route-idea call that settled 'ok' but refused (no plan row anywhere near it).
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T07:30:00.000Z',
      args: { rail: 'plan', draft: { title: 'refused placeholder draft' } },
    });

    // 3. An idempotent re-route onto a plan created two days earlier: nothing new was written.
    await plan('routed-plan-existing', '2026-10-01T08:00:00.000Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:40:00.000Z',
      args: { rail: 'plan', featureId: 'EI-2' },
    });

    // 4. plans:new still counts on its own invocation.
    await invocation({ owner: HOLDER, tool: 'plans:new', invokedAt: '2026-10-03T08:20:00.000Z' });

    // 5. Starting and staffing plans.
    await invocation({ owner: HOLDER, tool: 'plans:start', invokedAt: '2026-10-03T08:25:00.000Z' });
    await invocation({ owner: HOLDER, tool: 'fleet:launch-on-plan', invokedAt: '2026-10-03T08:26:00.000Z' });

    // 6. A peer's route-idea plan for the same goal: a goal-day candidate, never the holder's.
    await plan('peer-routed-plan', '2026-10-03T08:50:00.050Z');
    await invocation({
      owner: PEER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:50:00.200Z', durationMs: 200,
      args: { rail: 'plan', draft: { title: 'peer idea' } },
    });

    // 7. A route-idea plan for a DIFFERENT goal: not a candidate for GOAL.
    await plan('other-goal-plan', '2026-10-03T08:55:00.000Z', OTHER_GOAL);
    await invocation({
      owner: PEER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:55:00.100Z', goalId: OTHER_GOAL,
      args: { rail: 'plan', draft: { title: 'other goal idea' } },
    });

    // 8. A failed route-idea call beside a real plan creation is still not counted.
    await plan('coincident-plan', '2026-10-03T08:58:00.000Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:58:00.100Z', status: 'error',
      args: { rail: 'plan' },
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('counts a route-idea call that created a plan as a plan the holder wrote', async () => {
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: WINDOW_START, windowEnd: WINDOW_END },
      { sql: db.adminSql },
    );
    // plans:new (4) + the route that created its plan (1). The refusal (2), the re-route
    // onto an old plan (3) and the errored call (8) wrote nothing; the peer's plan (6) is not the holder's.
    expect(counts).toEqual({ plansNew: 2, plansStarted: 1, planFleetLaunches: 1 });
  });

  it('a window holding only the route-idea plan reads one plan written, not zero (the 2026-10-03 miss)', async () => {
    const window = { start: at('2026-10-03T08:00:00.000Z'), end: at('2026-10-03T08:10:00.000Z') };
    // Positive control: the retired plans:new-only count reads this window as 0, so the
    // fixture reproduces the defect rather than passing for an unrelated reason.
    const [retired] = await db.adminSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.tool_invocations
       WHERE workspace_id = ${WS} AND coord_owner_id = ${HOLDER} AND status = 'ok'
         AND tool_name = 'plans:new' AND invoked_at BETWEEN ${window.start} AND ${window.end}`;
    expect(Number(retired?.n)).toBe(0);
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() },
      { sql: db.adminSql },
    );
    expect(counts.plansNew).toBe(1);
  });

  it('a plan created just outside the call run plus slack is not attributed to the call', async () => {
    const settle = '2026-10-03T08:45:00.000Z';
    const tooEarly = new Date(at(settle).getTime() - 150 - ROUTED_PLAN_CLOCK_SLACK_MS - 1_000).toISOString();
    await plan('plan-before-the-call', tooEarly);
    await invocation({ owner: HOLDER, tool: 'blender:route-idea', invokedAt: settle, durationMs: 150, args: { rail: 'plan' } });
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: '2026-10-03T08:44:00.000Z', windowEnd: '2026-10-03T08:46:00.000Z' },
      { sql: db.adminSql },
    );
    expect(counts.plansNew).toBe(0);
  });

  it('goal-day candidates count route-idea plans for the goal by any author, and only for that goal', async () => {
    const candidates = await readGoalDayCandidates(
      { workspaceId: WS, goalId: GOAL, at: at(WINDOW_END) },
      { sql: db.adminSql },
    );
    // holder route (1) + holder plans:new (4) + peer route (6). The other goal's plan (7) is excluded.
    expect(candidates.plansNew).toBe(3);
    const other = await readGoalDayCandidates(
      { workspaceId: WS, goalId: OTHER_GOAL, at: at(WINDOW_END) },
      { sql: db.adminSql },
    );
    expect(other.plansNew).toBe(1);
  });
});
