import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readGoalPortfolioBrief } from '../goal-launch-settings';

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

    await sql`UPDATE harness_shared.work_items SET goal_id = NULL
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    expect((await read())?.attribution?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-ladder' }),
    ]));
  }, 60_000);
});
