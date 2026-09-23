/**
 * R6's deterministic obligation plane, not a manual rubric grade or LLM trial.
 * The review remains an assertion; plan coverage here is controlled fixture evidence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { readAgentObligationAgenda } from './agent-obligation-reader';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const OWNER = `su-review-verdict-${RUN}`;
const GOAL = `review-verdict-${RUN}`;
const HARNESS = `zzz-review-verdict-${RUN}`;
const SLUG = `checkout-retry-${RUN}`;
const PLAN = `plan:${HARNESS}/${SLUG}`;
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Checkout retry contract', body: 'Document the checkout retry contract.', status: 'active',
    killCriterion: 'A zero-idea review hides an uncovered need or invents new-plan demand.' });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated R6 obligation-plane fixture', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
  const content = `---\ntitle: Checkout retry contract\nslug: ${SLUG}\nstatus: ready\n---\n\n## Build\n\n- **P-001** \`todo\` Document the checkout retry contract\n`;
  await seedPlan(fx.admin, WS, HARNESS, SLUG, content);
  const index = deriveIndexFromContent(content);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${index.title}, status = ${index.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, index);
    expect((await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
      workspaceId: WS, goalId: GOAL, property: 'worklist', value: [PLAN], expectedVersion: 0,
      actorId: OWNER, provenance: 'agent-edit',
    })).ok).toBe(true);
  });
}, 150_000);

afterEach(async () => {
  if (fx) await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

async function record(disposition: 'existing-plans-sufficient' | 'plan-needed') {
  const result = await recordTool.handler(ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, planRefs: [PLAN], evidenceRefs: [`goal:${GOAL}`, PLAN],
    rationale: disposition === 'plan-needed'
      ? 'The existing plan covers documenting retries, but not reconciliation.'
      : 'The existing plan covers the goal outcome of documenting the retry contract.',
    ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Reconcile failed payments.' } : {}),
  } }), { isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function agenda() {
  return (await readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Real mode/goal/portfolio/tick/authority/obligation reads. Unrelated admission
    // and final acceptance are controlled, so this is not launch or closure proof.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [],
      ownerReport: async () => null,
      planAcceptance: async () => ({ satisfied: true, buildProvenance: { sha: null, version: 'fixture' } }),
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal: null, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  })).agenda;
}

describe('R6 public review-to-obligation verdicts', () => {
  it('review.sufficient: zero new ideas creates no planning penalty while execution remains due', async () => {
    await record('existing-plans-sufficient');
    const rows = await fx.admin`SELECT ideas_routed, detail FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ideas_routed: 0, detail: { goalReview: { planRefs: [PLAN] } } });
    const result = await agenda();
    expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
    expect(result.primary[0]).toMatchObject({ family: 'plan-placement', status: 'due', action: { targetRef: PLAN } });
  }, 90_000);

  it('review.missing.evidence: no scoped review leaves the review obligation due', async () => {
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(0);
    const result = await agenda();
    expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({ status: 'due' });
    expect(result.primary.some((r) => r.family === 'planning-needed')).toBe(true);
  }, 90_000);

  it('a malformed record remains an attributed measurement gap, not proved neglect', async () => {
    await record('existing-plans-sufficient');
    expect((await agenda()).evaluations.find((r) => r.family === 'planning-needed')?.status).toBe('satisfied');
    // Controlled corrupt/legacy record, not a way to bypass the production writer.
    await fx.admin`UPDATE harness_shared.scout_ticks SET detail = jsonb_set(detail, '{goalReview,evidenceRefs}', '[]'::jsonb)
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await agenda();
      expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({
        status: 'unknown', measurementFailure: { code: 'canonical-goal-planning-read-failed' },
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(
        'Latest scoped goal review is invalid; absence is not established.',
      ));
    } finally {
      warning.mockRestore();
    }
  }, 90_000);

  it('review.neglected: recording the need alone does not clear its follow-through obligation', async () => {
    await record('plan-needed');
    const result = await agenda();
    const planning = result.evaluations.find((r) => r.family === 'planning-needed');
    expect(planning).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(planning?.reason).toContain('Reconcile failed payments.');
    // No claim of two elapsed decision opportunities or a manual fail rating.
    expect(result.primary[0]?.family).toBe('plan-placement');
  }, 90_000);
});
