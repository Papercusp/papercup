/** P-007: the advertised complete-agenda recovery must reach the real GOAL reader. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../../_baseline-coord-fixture';
import { setMode } from '../../../modes/store';
import { readAgentObligationAgenda } from '../../../agent-obligation-reader';
import orientTool from './orient';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-orient-obligations-${RUN}`;
const GOAL = `orient-obligations-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, {
    id: GOAL,
    installSlug: 'papercusp',
    workspaceId: WS,
    title: 'Complete agenda recovery integration',
    body: 'A controlled goal used only in the isolated PostgreSQL fixture.',
    killCriterion: 'The recovery tool omits the complete obligation agenda.',
    status: 'active',
  });
  const mode = await setMode({
    workspaceId: WS,
    ownerId: OWNER,
    modeId: 'goal',
    subject: GOAL,
    enabled: true,
    reason: 'P-007 isolated production-consumer test',
    setBy: OWNER,
    sql: fx.admin,
  });
  expect(mode.ok).toBe(true);
}, 150_000);

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

describe('GOAL-holder complete agenda recovery through coord:orient', () => {
  it('returns the canonical full agenda from the production handler', async () => {
    const result = await orientTool.handler(
      {
        mode: 'monitor',
        harness: 'papercusp',
        claimableLimit: 0,
        memoryLimit: 0,
        includeFleet: false,
        includeInbox: false,
        includePlanEvents: false,
        includeCatchup: false,
        includeRecipes: false,
      },
      {
        isSuperuser: true,
        uiClientId: OWNER,
        workspaceId: WS,
        harnessSlug: 'papercusp',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
      } as never,
    );
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.obligations, 'the recovery target must expose an agenda, not an absent/null fold').toBeTruthy();
    const obligations = data.obligations as {
      primary: unknown[];
      evaluations: Array<{ obligationId: string; status: string }>;
      detailRef: string;
    };
    expect(obligations.evaluations.length).toBeGreaterThan(0);
    expect(obligations.detailRef).toBe('coord:orient for the complete obligation agenda');
    const canonical = await readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER, goalId: GOAL });
    expect(obligations.evaluations.map((entry) => entry.obligationId).sort()).toEqual(
      canonical.agenda.evaluations.map((entry) => entry.obligationId).sort(),
    );
  }, 90_000);
});
