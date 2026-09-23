/** Real review writer -> scoped tick reader -> obligation provider, on isolated PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { defaultAgentObligationReaderDeps, readAgentObligationAgenda } from './agent-obligation-reader';
import { recordScoutTick } from './scout/tick-ledger';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-planning-${RUN}`;
const GOAL = `goal-planning-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Planning obligation integration', body: 'Recover failed checkout', status: 'active',
    killCriterion: 'Uncovered needs do not reach the obligation agenda.' });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated planning reader integration', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
}, 150_000);
afterEach(async () => {
  await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' IN (${OWNER}, ${`${OWNER}-noise`})`;
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function record(disposition: 'plan-needed' | 'existing-plans-sufficient') {
  const args = ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, rationale: 'Fixture review of checkout recovery.', evidenceRefs: [`goal:${GOAL}`],
    ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover failed checkout' } : {}),
  } });
  const result = await recordTool.handler(args, {
    isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function planning() {
  const read = await readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Only unrelated sources are stubbed. Goal mode, portfolio, review and ownership use production reads.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [],
      ownerReport: async () => null,
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal: null, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  });
  return read.agenda.evaluations.find((row) => row.family === 'planning-needed');
}

describe('production planning-needed consumer', () => {
  it('turns a goal-local uncovered outcome into an actionable obligation without Blender input', async () => {
    await record('plan-needed');
    const obligation = await planning();
    expect(obligation).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(obligation?.action?.summary).toContain('Recover failed checkout');
    expect(obligation?.action?.summary).toContain('verify real claims');
  }, 90_000);
  it('allows a supported zero-idea review, then invalidates it on changed outcomes', async () => {
    await record('existing-plans-sufficient');
    expect((await planning())?.status).toBe('satisfied');
    await fx.admin`UPDATE harness_shared.goals SET body = 'A changed outcome' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    try { expect((await planning())?.status).toBe('due'); }
    finally { await fx.admin`UPDATE harness_shared.goals SET body = 'Recover failed checkout' WHERE workspace_id = ${WS} AND id = ${GOAL}`; }
  }, 90_000);
  it('filters other owners before LIMIT rather than hiding this goal review behind newer noise', async () => {
    await record('plan-needed');
    await recordScoutTick({ workspaceId: WS, installSlug: 'papercusp', origin: 'su-ideate', status: 'ran',
      detail: { owner: `${OWNER}-noise`, goalReview: { goalId: GOAL, disposition: 'invalid-other-owner' } } });
    const read = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(read.review?.disposition).toBe('plan-needed');
  }, 90_000);
});
