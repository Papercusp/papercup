/** Production gap-review handler and canonical scope reads on isolated PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { setMode } from '../../modes/store';
import { parseGoalPlanningReview, readGoalPlanningReviewContext } from '../../goal-planning-review';
import recordTool, { ideatePassRecordArgs, type IdeatePassRecordResult } from './ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-goal-review-${RUN}`;
const UNBOUND = `su-goal-review-unbound-${RUN}`;
const GOAL = `goal-review-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, {
    id: GOAL, installSlug: 'papercusp', workspaceId: WS,
    title: 'Isolated goal review record',
    body: 'A controlled recording fixture with no product work to launch.',
    killCriterion: 'The review loses scope or recorded evidence.', status: 'active',
  });
  const mode = await setMode({
    workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'P008 isolated scope and persistence test', setBy: OWNER, sql: fx.admin,
  });
  expect(mode.ok).toBe(true);
}, 150_000);

afterEach(async () => {
  if (fx) await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' IN (${OWNER}, ${UNBOUND})`;
});

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function record(goalId = GOAL, owner = OWNER) {
  const args = ideatePassRecordArgs.parse({
    ideasFiled: 0,
    goalReview: {
      goalId, disposition: 'no-eligible-work',
      rationale: 'The isolated recording fixture has no product work requiring a new plan.',
      evidenceRefs: [`goal:${GOAL}`],
    },
  });
  const context: Parameters<typeof recordTool.handler>[1] = {
    isSuperuser: true, uiClientId: owner, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(),
  };
  const result = await recordTool.handler(args, context);
  const payload = JSON.parse(result.content[0].text) as IdeatePassRecordResult;
  return { result, payload };
}

describe('goal review production persistence', () => {
  it('persists a zero-idea review with canonical scope and a measured portfolio fingerprint', async () => {
    const before = await readGoalPlanningReviewContext(WS, OWNER);
    expect(before?.goalId).toBe(GOAL);
    const { payload } = await record();
    expect(payload.ok).toBe(true);
    const rows = await fx.admin`
      SELECT origin, ideas_routed, detail FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'su-ideate', ideas_routed: 0 });
    const persisted = parseGoalPlanningReview(rows[0].detail.goalReview);
    expect(persisted).toMatchObject({
      goalId: GOAL, disposition: 'no-eligible-work', evidenceRefs: [`goal:${GOAL}`],
      portfolioFingerprint: before?.portfolioFingerprint,
    });
    expect(payload).toMatchObject({ goalReview: persisted });
    expect(Number.isFinite(Date.parse(persisted!.reviewedAt))).toBe(true);
  }, 90_000);

  it('does not persist a review for a different goal', async () => {
    const { result, payload } = await record('another-goal');
    expect(payload).toMatchObject({ ok: false, reason: 'goal-review-scope-mismatch' });
    expect(result.isError).toBe(true);
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(0);
  }, 90_000);

  it('does not persist a review for a caller with no GOAL binding', async () => {
    const { payload } = await record(GOAL, UNBOUND);
    expect(payload).toMatchObject({ ok: false, reason: 'goal-review-unavailable' });
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${UNBOUND}`;
    expect(rows).toHaveLength(0);
  }, 90_000);

  it('keeps old evidence distinct when the goal outcome changes', async () => {
    const { payload } = await record();
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error('positive recording control failed');
    const original = payload.goalReview!.portfolioFingerprint;
    await fx.admin`UPDATE harness_shared.goals SET body = 'A newly uncovered goal outcome.' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    try {
      const changed = await readGoalPlanningReviewContext(WS, OWNER);
      expect(changed?.portfolioFingerprint).not.toBe(original);
      const rows = await fx.admin`SELECT detail FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
      expect(parseGoalPlanningReview(rows[0].detail.goalReview)?.portfolioFingerprint).toBe(original);
    } finally {
      await fx.admin`UPDATE harness_shared.goals SET body = 'A controlled recording fixture with no product work to launch.' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    }
  }, 90_000);
});
