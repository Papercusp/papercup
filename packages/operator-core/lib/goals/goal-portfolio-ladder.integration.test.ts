import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readGoalPortfolioBrief } from '../goal-launch-settings';
import { GOAL_OWNER_REPORT_FIELD, GOAL_OWNER_REPORT_SCHEMA_VERSION } from '../goal-owner-report';

const WS = 'ws-goal-ladder-p019';
const GOAL = 'goal-ladder-p019';
let db: OrgTestDb;

beforeAll(async () => { db = await createOrgTestDb(); }, 300_000);
afterAll(async () => { if (db) await db.cleanup(); }, 120_000);

describe('canonical GOAL portfolio ladder (real Postgres)', () => {
  it('joins a live pot link, exact plan goal stamp and source-plan work item into one typed verdict', async () => {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.goals
        (workspace_id, id, install_slug, title, status, standing, properties, metadata)
      VALUES (${WS}, ${GOAL}, 'papercusp', 'Ladder goal', 'active', true,
              ${sql.json({ worklist: { value: ['plan:papercusp/alpha'] } })}, ${sql.json({})})`;
    await sql`
      INSERT INTO harness_shared.goal_pots
        (workspace_id, goal_id, harness_slug, role, kill_criterion)
      VALUES (${WS}, ${GOAL}, 'papercusp', 'owner', 'stop if the plan no longer serves this goal')`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id)
      VALUES (${WS}, 'papercusp', 'alpha', 'Alpha', 'active', ${GOAL})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, source_plan_slug,
         source_plan_item_ids, goal_id)
      VALUES (${WS}, 'papercusp', 'WI-ladder', 'task', 'open', 'alpha', ARRAY['P-001'], ${GOAL})`;

    const read = () => readGoalPortfolioBrief({
      workspaceId: WS, goalId: GOAL, sql,
      launch: {
        goalBrief: {
          title: 'Ladder goal', body: null, killCriterion: null, budgetCents: null,
          budgetWindowSec: null, standing: true,
        },
        settings: null, budget: null,
        ceilings: { maxAgents: 12, maxPerFleet: 5 },
        headcount: { total: 0, fleet: 0 },
      },
    });
    const healthy = await read();
    expect(healthy?.attribution).toMatchObject({
      status: 'healthy', checked: { pots: 1, plans: 1, workItems: 1 }, issues: [],
    });
    expect(healthy?.pots[0]).toMatchObject({
      harness: 'papercusp', role: 'owner', killCriterion: 'stop if the plan no longer serves this goal',
    });

    await sql`UPDATE harness_shared.goals
      SET launch_settings = ${sql.json({ intendedParallelPlanFleets: 2 })}
      WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    const liveWidth = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL, sql });
    expect(liveWidth?.launch).toMatchObject({ intendedParallelPlanFleets: 2 });
    expect(liveWidth?.launch.ceilings).toEqual({ maxAgents: 12, maxPerFleet: 5 });

    await sql`UPDATE harness_shared.work_items SET goal_id = NULL
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    expect((await read())?.attribution?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-ladder' }),
    ]));
  }, 60_000);

  it('builds the owner report from exact goal evidence and the watchdog report watermark', async () => {
    const sql = db.adminSql;
    const goal = 'goal-report-p021';
    const owner = 'su-report-p021';
    const t0 = '2026-09-25T19:00:00.000Z';
    const t1 = '2026-09-25T19:30:00.000Z';
    const t2 = '2026-09-25T20:00:00.000Z';
    const t3 = '2026-09-25T20:15:00.000Z';
    await sql`
      INSERT INTO harness_shared.goals
        (workspace_id, id, install_slug, title, status, standing, created_at, properties, metadata)
      VALUES (${WS}, ${goal}, 'papercusp', 'Report goal', 'active', true, ${t0}::timestamptz,
              ${sql.json({ worklist: { value: ['plan:papercusp/report-alpha'] } })}, ${sql.json({})})`;
    await sql`
      INSERT INTO harness_shared.agent_modes
        (workspace_id, owner_id, axis_key, mode, subject, set_by, set_at)
      VALUES (${WS}, ${owner}, 'goal', 'goal', ${goal}, 'test', ${t0}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${WS}, 'messages', 'p021-real-report', ${sql.json({
        from: owner, to: ['human'],
        [GOAL_OWNER_REPORT_FIELD]: {
          schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION, goalId: goal,
          moved: 'previous report', cost: 'measured', ownerWalled: 'none', killed: 'none',
        },
      })}, ${t1}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${WS}, 'escalations', 'p021-unrelated-ping', ${sql.json({
        from: owner, body: 'Routine note without a four-field goal report',
      })}, ${t3}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id, updated_at)
      VALUES (${WS}, 'papercusp', 'report-alpha', 'Report alpha', 'shipped', ${goal}, ${t2}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, closed_ts)
      VALUES (${WS}, 'papercusp', 'WI-report-done', 'task', 'done', ${goal}, ${Date.parse(t2)}, ${Date.parse(t2)})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, payload)
      VALUES (${WS}, 'papercusp', 'WI-report-wall', 'task', 'open', ${goal}, ${Date.parse(t2)},
              ${sql.json({ needsOwnerAction: true, ownerAsk: 'provide the domain credential' })})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, payload)
      VALUES (${WS}, 'papercusp', 'WI-report-old-wall', 'task', 'done', ${goal}, ${Date.parse(t0)},
              ${sql.json({ needsOwnerAction: true, ownerAsk: 'obsolete approval' })})`;
    await sql`
      INSERT INTO harness_shared.goal_pots
        (workspace_id, goal_id, harness_slug, role, kill_criterion, removed_at)
      VALUES (${WS}, ${goal}, 'papercusp', 'owner', 'stop if the work is no longer useful', ${t2}::timestamptz)`;

    const read = (artifactReads: Array<{ ref: string; readAt: string }> = []) => readGoalPortfolioBrief({
      workspaceId: WS, goalId: goal, sql, now: new Date(t3), reportArtifactReads: artifactReads,
      launch: {
        goalBrief: { title: 'Report goal', body: null, killCriterion: 'stop if done',
          budgetCents: 1000, budgetWindowSec: null, standing: true },
        settings: null,
        budget: { budgetCents: 1000, spentCents: 340, spentCentsAt: t2,
          spentCentsSource: 'goal-lineage-rollup', unmeasuredPricedSpend: false },
        ceilings: { maxAgents: 12, maxPerFleet: 5 },
        headcount: { total: 0, fleet: 0 },
      },
    });
    const unread = await read();
    expect(unread?.continuity.lastOwnerReportAt).toBe(t1);
    expect(unread?.reporting?.cadence?.lastReportAt).toBe(t1);
    expect(unread?.reporting?.draft.fields.cost).toContain('340c / 1000c; coverage=measured; source=goal-lineage-rollup');
    expect(unread?.reporting?.draft.fields.ownerWalled).toContain('WI-report-wall: provide the domain credential');
    expect(unread?.reporting?.draft.fields.ownerWalled).not.toContain('obsolete approval');
    expect(unread?.queue.needsHuman).toBe(1);
    expect(unread?.reporting?.draft.fields.killed).toContain('pot:papercusp');
    expect(unread?.reporting?.draft.fields.moved).toContain('completion unverified (artifact unread)');
    expect(unread?.reporting?.draft.unreadArtifacts).toEqual(expect.arrayContaining([
      'plan:papercusp/report-alpha', 'work-item:WI-report-done',
    ]));

    const verified = await read([
      { ref: 'plan:papercusp/report-alpha', readAt: t3 },
      { ref: 'work-item:WI-report-done', readAt: t3 },
    ]);
    expect(verified?.reporting?.draft.unreadArtifacts).toEqual([]);
    expect(verified?.reporting?.draft.fields.moved).toContain('artifact work-item:WI-report-done read');
  }, 90_000);
});
