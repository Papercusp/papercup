import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { parseExecutionPlanRebind, readExecutionPlanRebind, rebindMemberExecutionPlan } from './execution-plan-rebind';
import type { ResolvedFleetMemberTarget } from './member-target';
import { normalizeControlAnchorState } from '../coordination/control-anchor';

let db: FreshPgDb;
const WS = 'private-plan-rebind', OWNER = 'su-member', LEADER = 'su-leader';
const target = { callerId: LEADER, memberOwnerId: OWNER, workspaceId: WS, slug: 'fleet',
  fleet: { leaderOwnerId: LEADER }, invokedAs: 'leader' } as ResolvedFleetMemberTarget;
const input = { workItemId: 'EI-held', harness: 'project', expectedPlanSlug: 'draft', reason: 'leader assigns repair' };

beforeAll(async () => {
  db = await createFreshPgDb('planrebind');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.agent_fleets (workspace_id text, fleet_slug text, leader_owner_id text);
    CREATE TABLE harness_shared.fleet_membership_events (id bigint, workspace_id text, owner_id text, fleet_slug text);
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text, current_plan_slug text, control_state jsonb, harness_slug text);
    CREATE TABLE harness_shared.adv_sessions (coord_owner_id text, workspace_id text, plan_slug text, ended_at timestamptz);
    CREATE TABLE harness_shared.work_items (workspace_id text,harness_slug text,feature_id text,taken_by text,
      status text,plan_slug text,plan_line_id text,source_plan_slug text,payload jsonb);
  `);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql.unsafe(`TRUNCATE harness_shared.agent_fleets,harness_shared.fleet_membership_events,
    harness_shared.session_briefs,harness_shared.adv_sessions,harness_shared.work_items`);
  await db.sql`INSERT INTO harness_shared.agent_fleets VALUES (${WS},'fleet',${LEADER})`;
  await db.sql`INSERT INTO harness_shared.fleet_membership_events VALUES (1,${WS},${OWNER},'fleet')`;
  await db.sql`INSERT INTO harness_shared.session_briefs (owner_id,workspace_id,current_plan_slug,control_state) VALUES (${OWNER},${WS},NULL,
    '{"lifecycle":{"shutdown":{"by":"human","at":"before"}},"scope":{"plan":null}}'::jsonb)`;
  await db.sql`INSERT INTO harness_shared.adv_sessions VALUES (${OWNER},${WS},'draft',NULL)`;
  await db.sql`INSERT INTO harness_shared.work_items VALUES (${WS},'project','EI-held',${OWNER},'open',NULL,NULL,NULL,'{}')`;
});

describe('leader execution-plan rebinding', () => {
  it('clears the spawn binding with a read-back audit receipt that survives respawn and normalization', async () => {
    const result = await rebindMemberExecutionPlan(target, input, db.sql);
    expect(result).toMatchObject({ ok: true, receipt: { actorId: LEADER, targetId: OWNER,
      previousPlanSlug: 'draft', planSlug: null, workItemId: 'EI-held', reason: input.reason,
      supersededPlanSlugs: ['draft'] } });
    expect((await db.sql`SELECT plan_slug FROM harness_shared.adv_sessions`)[0].plan_slug).toBeNull();
    // A managed host can re-stamp its old launch plan. The owner-keyed receipt
    // remains the authority across that native-process boundary.
    await db.sql`UPDATE harness_shared.adv_sessions SET plan_slug='draft'`;
    const receipt = await readExecutionPlanRebind(db.sql, OWNER, WS);
    expect(receipt).toEqual(result.receipt);
    expect(await readExecutionPlanRebind(db.sql, OWNER, 'foreign')).toBeNull();
    const [{ control_state: control }] = await db.sql`SELECT control_state FROM harness_shared.session_briefs`;
    expect(control.lifecycle.shutdown).toEqual({ by: 'human', at: 'before' });
    const normalized = normalizeControlAnchorState({ modes: [], stack: [], loop: { active: false },
      route: { kind: 'self' }, scope: { workspace: WS, harness: 'project', plan: null, items: [] },
      lifecycle: control.lifecycle } as never);
    expect(normalized.lifecycle?.executionPlanBinding).toEqual(receipt);
  });

  it('binds to the target item plan, and refuses stale expected plans on later changes', async () => {
    await db.sql`UPDATE harness_shared.work_items SET plan_slug='next-plan',plan_line_id='P-001'`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok: true, receipt: { planSlug: 'next-plan' } });
    expect((await db.sql`SELECT harness_slug,control_state FROM harness_shared.session_briefs`)[0])
      .toMatchObject({harness_slug:'project',control_state:{scope:{plan:'next-plan',harness:'project'}}});
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok: false, error: 'plan_rebind_expected_plan_mismatch' });
    expect(await rebindMemberExecutionPlan(target,{...input,expectedPlanSlug:'next-plan'},db.sql)).toMatchObject({ ok: true });
  });

  it('preserves displaced launch history but refuses an unexpected new session plan', async () => {
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ok:true});
    await db.sql`UPDATE harness_shared.adv_sessions SET plan_slug='draft'`;
    expect(await rebindMemberExecutionPlan(target,{...input,expectedPlanSlug:null},db.sql))
      .toMatchObject({ok:true,receipt:{planSlug:null,supersededPlanSlugs:['draft']}});
    await db.sql`UPDATE harness_shared.session_briefs SET current_plan_slug='new-plan'`;
    expect(await rebindMemberExecutionPlan(target,{...input,expectedPlanSlug:null},db.sql))
      .toMatchObject({ok:false,error:'plan_rebind_expected_plan_mismatch'});
  });

  it('refuses self-approval, generic owner-pane authority, and changed leadership without writing', async () => {
    expect(await rebindMemberExecutionPlan({...target,callerId:OWNER},input,db.sql)).toMatchObject({ ok:false });
    expect(await rebindMemberExecutionPlan({...target,fleet:{leaderOwnerId:'other'} as never,invokedAs:'owner'},input,db.sql))
      .toMatchObject({ ok:false,error:'plan_rebind_requires_distinct_fleet_leader' });
    await db.sql`UPDATE harness_shared.agent_fleets SET leader_owner_id='other'`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok:false,error:'plan_rebind_leader_changed' });
    expect(await readExecutionPlanRebind(db.sql,OWNER,WS)).toBeNull();
  });

  it('refuses a moved member, a foreign/terminal item, and a held admission', async () => {
    await db.sql`UPDATE harness_shared.fleet_membership_events SET fleet_slug='other'`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok:false,error:'plan_rebind_membership_changed' });
    await db.sql`UPDATE harness_shared.fleet_membership_events SET fleet_slug='fleet'`;
    await db.sql`UPDATE harness_shared.work_items SET taken_by='other'`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok:false });
    await db.sql`UPDATE harness_shared.work_items SET taken_by=${OWNER},status='done'`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok:false });
    await db.sql`UPDATE harness_shared.work_items SET status='open',payload='{"admissionHold":{"screeningDeferred":true}}'::jsonb`;
    expect(await rebindMemberExecutionPlan(target,input,db.sql)).toMatchObject({ ok:false });
    expect(await readExecutionPlanRebind(db.sql,OWNER,WS)).toBeNull();
  });

  it('fails closed for malformed or foreign-target receipts', () => {
    expect(() => parseExecutionPlanRebind({planSlug:null},OWNER)).toThrow('invalid_execution_plan_rebind');
  });
});
