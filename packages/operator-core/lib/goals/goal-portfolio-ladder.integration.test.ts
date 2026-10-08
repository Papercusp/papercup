import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readGoalPortfolioBrief } from '../goal-launch-settings';
import { GOAL_OWNER_REPORT_FIELD, GOAL_OWNER_REPORT_SCHEMA_VERSION } from '../goal-owner-report';
import { applyGoalPropertyWrite } from '../typed-properties-db';

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

    // WI-10005269: a federation-owned (origin='remote') unstamped row cannot be stamped by any
    // local verb, so it must be reported as `remoteOwned`, never as an actionable issue — and the
    // local unstamped row must keep failing the ladder (the split is by origin, not a blanket skip).
    await sql`UPDATE harness_shared.work_items SET goal_id = ${GOAL}
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, source_plan_slug,
         source_plan_item_ids, goal_id, origin)
      VALUES (${WS}, 'papercusp', 'WI-ladder-remote', 'task', 'open', 'alpha', ARRAY['P-002'], NULL, 'remote')`;
    const remoteOnly = (await read())?.attribution;
    expect(remoteOnly).toMatchObject({
      status: 'healthy', issues: [], remoteOwned: ['WI-ladder-remote'],
      checked: { pots: 1, plans: 1, workItems: 2 },
    });
    await sql`UPDATE harness_shared.work_items SET goal_id = NULL
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    const mixed = (await read())?.attribution;
    expect(mixed?.status).toBe('incomplete');
    expect(mixed?.issues).toEqual([
      expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-ladder' }),
    ]);
    expect(mixed?.remoteOwned).toEqual(['WI-ladder-remote']);
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
          spentCentsSource: 'goal-lineage-rollup', unmeasuredPricedSpend: false,
          interactiveUsageFreshnessStatus: null, interactiveUsageLastIngestedAtMs: null },
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

describe('opt-in active workspace plan pool (P-003, real Postgres)', () => {
  const declaration = {
    worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both', collection: {
      source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
      selectable: true, defaultSelected: true,
    } },
    worklist_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
  };
  const stored = (value: unknown) => ({ value, version: 7, edited_at: '2026-10-08T01:00:00.000Z',
    edited_by: 'original-owner', provenance: 'owner-edit' });
  async function fixture(name: string) {
    const workspace = `ws-p003-${name}`;
    const goal = `goal-p003-${name}`;
    const sql = db.adminSql;
    const properties = { worklist: stored(['plan:p003/two', 'plan:p003/one']) };
    await sql`INSERT INTO harness_shared.goals
      (workspace_id, id, install_slug, title, status, property_schema, properties)
      VALUES (${workspace}, ${goal}, 'p003', 'Private discovery fixture', 'active',
        ${sql.json(declaration)}, ${sql.json(properties)})`;
    await sql`INSERT INTO harness_shared.goal_pots
      (workspace_id, goal_id, harness_slug, role, kill_criterion)
      VALUES (${workspace}, ${goal}, 'p003', 'owner', 'Stop when this private test finishes')`;
    const plan = async (slug: string, status = 'active', harness = 'p003', planGoal: string | null = null,
      planWorkspace = workspace) => {
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id)
        VALUES (${planWorkspace}, ${harness}, ${slug}, ${slug}, ${status}, ${planGoal})`;
      await sql`INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, item_text, status, seq)
        VALUES (${planWorkspace}, ${harness}, ${slug}, 'P-001', 'Private ready work', 'todo', 1)`;
    };
    await plan('one');
    await plan('two');
    const read = () => readGoalPortfolioBrief({ workspaceId: workspace, goalId: goal, sql, claimability: 'skip',
      launch: { goalBrief: { title: 'Private discovery fixture', body: null, killCriterion: 'Stop when done',
        budgetCents: null, budgetWindowSec: null, standing: false }, settings: null, budget: null,
        ceilings: { maxAgents: 12, maxPerFleet: 5 }, headcount: { total: 0, fleet: 0 } } });
    const policy = (value: unknown, expectedVersion = 0) => sql.begin((tx) =>
      applyGoalPropertyWrite(tx as unknown as typeof sql, { workspaceId: workspace, goalId: goal,
        property: 'worklist_policy', value, expectedVersion, actorId: 'private-owner', provenance: 'owner-edit' }));
    return { workspace, goal, sql, plan, read, policy, properties };
  }

  it('discovers newly active plans after saved order without changing any stored worklist or attribution', async () => {
    const fx = await fixture('append');
    await fx.plan('pending', 'draft');
    await fx.plan('foreign', 'active', 'p003', null, 'different-workspace');
    expect((await fx.read())?.worklist.map((p) => p.ref)).toEqual(['plan:p003/two', 'plan:p003/one']);
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'active'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'pending'`;
    const refreshed = await fx.read();
    expect(refreshed?.degradedReasons.filter((r) => r.includes('portfolio read failed'))).toEqual([]);
    expect(refreshed?.worklist.map((p) => [p.ref, p.selected])).toEqual([
      ['plan:p003/two', true], ['plan:p003/one', true], ['plan:p003/pending', true],
    ]);
    expect(refreshed?.collection).toEqual({ source: 'active-workspace-plans', policyVersion: 0, available: true });
    expect(refreshed?.attribution?.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unstamped-plan' }),
    ]));
    const [goal] = await fx.sql`SELECT properties FROM harness_shared.goals
      WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    expect(goal.properties).toEqual(fx.properties);
    const plans = await fx.sql`SELECT goal_id FROM harness_shared.harness_plans WHERE workspace_id = ${fx.workspace}`;
    expect(plans.every((p) => p.goal_id === null)).toBe(true);
  });

  it('persisted reorder/exclusion controls the next placement and survives deactivation and reactivation', async () => {
    const fx = await fixture('policy');
    await fx.plan('new');
    expect(await fx.policy({ order: ['plan:p003/one', 'plan:p003/two'], excluded: ['plan:p003/one'] }))
      .toMatchObject({ ok: true, entry: { version: 1 } });
    const before = await fx.read();
    expect(before?.worklist.map((p) => p.ref)).toEqual(['plan:p003/one', 'plan:p003/two', 'plan:p003/new']);
    expect(before?.worklist[0]).toMatchObject({ selected: false, placement: { reconciliation: { toolCall: null } } });
    expect(before?.worklist.find((p) => p.placement.reconciliation.toolCall)?.ref).toBe('plan:p003/two');
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'draft'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'new'`;
    expect((await fx.read())?.worklist.map((p) => p.ref)).not.toContain('plan:p003/new');
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'active'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'new'`;
    const reactivated = await fx.read();
    expect(reactivated?.worklist[0]).toMatchObject({ ref: 'plan:p003/one', selected: false });
    expect(reactivated?.collection?.policyVersion).toBe(1);
    expect(await fx.policy({ order: ['plan:p003/one', 'plan:p003/two'], excluded: [] }, 1))
      .toMatchObject({ ok: true, entry: { version: 2 } });
    expect((await fx.read())?.worklist.find((p) => p.placement.reconciliation.toolCall)?.ref).toBe('plan:p003/one');
  });

  it('keeps peer claims and other-goal ownership intact and distinguishes qualified equal-slug plans', async () => {
    const fx = await fixture('ownership');
    await fx.plan('one', 'active', 'other-harness');
    await fx.plan('owned', 'active', 'p003', 'different-goal');
    await fx.sql`INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES (${fx.workspace}, 'p003', 'two', 'P-001', 'peer-source-owner', now() + interval '1 hour')`;
    const before = await fx.sql`SELECT owner, expires_ts FROM harness_shared.plan_item_claims
      WHERE workspace_id = ${fx.workspace}`;
    const result = await fx.read();
    expect(result?.worklist.filter((p) => p.slug === 'one').map((p) => [p.ref, p.ambiguousMatches])).toEqual([
      ['plan:p003/one', 1], ['plan:other-harness/one', 1],
    ]);
    expect(result?.worklist.find((p) => p.slug === 'owned')).toMatchObject({ selected: true,
      placement: { state: 'blocked', reconciliation: { action: 'none', toolCall: null,
        reason: expect.stringContaining('another goal') } } });
    expect(await fx.sql`SELECT owner, expires_ts FROM harness_shared.plan_item_claims
      WHERE workspace_id = ${fx.workspace}`).toEqual(before);
    const [owned] = await fx.sql`SELECT goal_id FROM harness_shared.harness_plans
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'owned'`;
    expect(owned.goal_id).toBe('different-goal');
  });

  it('a corrupt owner policy disables new placement visibly instead of treating it as an empty policy', async () => {
    const fx = await fixture('unavailable');
    await fx.sql`UPDATE harness_shared.goals SET properties = properties ||
      ${fx.sql.json({ worklist_policy: { ...stored({ order: [], excluded: [] }), provenance: 'agent-edit' } })}
      WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    const result = await fx.read();
    expect(result?.collection).toMatchObject({ available: false, reason: expect.stringContaining('not owner-authored') });
    expect(result?.worklist).toHaveLength(2);
    expect(result?.worklist.every((p) => p.selected === false && p.placement.reconciliation.toolCall === null)).toBe(true);
    expect(result?.degradedReasons).toEqual(expect.arrayContaining([expect.stringContaining('selection unavailable')]));
  });
});
