/** P-007: the advertised complete-agenda recovery must reach the real GOAL reader. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../../_baseline-coord-fixture';
import { setMode } from '../../../modes/store';
import * as obligationReader from '../../../agent-obligation-reader';
import * as goalSettings from '../../../goal-launch-settings';
import { formatAgentObligationLine } from '../../../agent-obligations';
import {
  buildTurnStartOrientationBlock,
  ORIENTATION_CURSOR_SURFACE,
  type OrientationDeps,
} from '../../../turn-start-orientation';
import orientTool from './orient';
// Production boot registers compound folds before serving coord:orient.
import '../../fleet/assignments';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-orient-obligations-${RUN}`;
const GOAL = `orient-obligations-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

afterEach(() => vi.restoreAllMocks());

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
  await fx.admin`DELETE FROM harness_shared.coord_read_cursors WHERE owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function readOrientation() {
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
  return (result as { data: { obligations: obligationReader.AgentObligationBrief; goalPortfolio: goalSettings.GoalPortfolioBrief | null } }).data;
}

describe('GOAL-holder complete agenda recovery through coord:orient', () => {
  it('keeps an omitted real agenda unseen until a full warm delivery and re-delivers after a cold boundary', async () => {
    const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await readOrientation();
    const canonical = await read.mock.results[0].value;
    const brief = obligationReader.projectAgentTurnStartObligationBrief(canonical.agenda);
    const actionLines = brief.projection.text.split('\n').filter(Boolean);
    expect(actionLines.length, JSON.stringify({
      receipt: brief.projection.receipt,
      primary: canonical.agenda.primary.map((entry: obligationReader.AgentObligationBrief['evaluations'][number]) => ({
        ruleId: entry.ruleId, status: entry.status, chars: formatAgentObligationLine(entry).length,
      })),
    })).toBeGreaterThan(0);
    expect(brief.evaluations.some((entry) => entry.scope.goalId === GOAL)).toBe(true);
    let epoch = 1;
    // Unrelated orientation sources are stable; the agenda, projection, final
    // composer and PostgreSQL cursor are the production path under test.
    const deps: OrientationDeps = {
      held: async () => [],
      inbox: async () => ({ count: 3, newest: [] }),
      announcedGates: async () => [],
      openAsks: async () => null,
      loopArmed: async () => true,
      loopFireWithheld: async () => false,
      improvementTriage: async () => null,
      executableFrontier: async () => null,
      obligations: async () => brief,
      neverDropFacts: async () => [],
      toolSurface: async () => null,
      carryBlindWindow: async () => null,
      contextEpoch: async () => epoch,
    };
    const deliver = (budgetChars: number) => buildTurnStartOrientationBlock({
      ownerId: OWNER, workspaceId: WS, budgetChars, deps,
    });
    const cursor = async () => {
      const rows = await fx.admin`
        SELECT committed, pending FROM harness_shared.coord_read_cursors
        WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}
      `;
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    expect(await deliver(40)).toBe('');
    expect((await cursor()).pending).toBeNull();
    const crowded = await deliver(200);
    expect(crowded.length).toBeLessThanOrEqual(200);
    expect(crowded).toContain(brief.detailRef);
    expect(actionLines.some((line) => !crowded.includes(line))).toBe(true);
    expect((await cursor()).pending.obligations).not.toBe(brief.sourceGeneration);

    // Exercise the emitted recovery door in the same actual goal/owner scope.
    const recovered = await readOrientation();
    expect(recovered.obligations.evaluations.map((entry) => entry.id)).toEqual(
      canonical.agenda.evaluations.map((entry: { id: string }) => entry.id),
    );
    expect(recovered.obligations.evaluations.some((entry) => entry.scope.goalId === GOAL)).toBe(true);
    const warm = await deliver(2_000);
    for (const line of actionLines) expect(warm).toContain(line);
    expect((await cursor()).pending.obligations).toBe(brief.sourceGeneration);
    expect(await deliver(2_000)).toBe('');
    expect((await cursor()).committed.obligations).toBe(brief.sourceGeneration);
    epoch += 1;
    const cold = await deliver(2_000);
    for (const line of actionLines) expect(cold).toContain(line);
    expect(await deliver(2_000)).toBe('');
  }, 90_000);

  it('returns the canonical full agenda from the production handler', async () => {
    // Observe the real read without replacing it. A second read can legitimately
    // have a different timeout/generation, so compare delivery to its own source.
    const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = await readOrientation();
    expect(data.obligations, 'the recovery target must expose an agenda, not an absent/null fold').toBeTruthy();
    const obligations = data.obligations as obligationReader.AgentObligationBrief;
    expect(obligations.evaluations.length).toBeGreaterThan(0);
    expect(obligations.evaluations.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);
    expect(obligations.detailRef).toBe('coord:orient for the complete obligation agenda');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, ownerId: OWNER, goalId: GOAL }));
    const canonical = await read.mock.results[0].value;
    expect(obligations.evaluations).toEqual(canonical.agenda.evaluations);
    expect(obligations.primary).toEqual(canonical.agenda.primary);
    expect(obligations.evaluations.map((entry) => entry.ruleId)).toEqual(
      expect.arrayContaining(['goal-plan-placement', 'goal-owner-report']),
    );
    for (const entry of obligations.evaluations.filter((entry) => entry.status === 'unknown')) {
      expect(entry.measurementFailure?.detail).toBeTruthy();
      expect(entry.measurementFailure?.retry).toBeTruthy();
    }
    for (const [warning] of warnings.mock.calls) {
      expect(String(warning)).toMatch(/^\[bounded-timeout\] agent-obligations:/);
      expect(canonical.degradedSources.length).toBeGreaterThan(0);
      expect(obligations.evaluations.some((entry) => entry.status === 'unknown')).toBe(true);
    }
  }, 90_000);

  it('preserves a failed portfolio read as unknown and recovers through the same scoped tool', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = `P007 controlled portfolio read failure ${RUN}`;
    const portfolio = vi.spyOn(goalSettings, 'readGoalPortfolioBrief').mockRejectedValueOnce(new Error(failure));
    const failed = await readOrientation();
    expect(portfolio).toHaveBeenCalledWith({ workspaceId: WS, goalId: GOAL });
    const placement = failed.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
    expect(placement?.status).toBe('unknown');
    expect(placement?.measurementFailure?.detail).toContain(failure);
    expect(placement?.measurementFailure?.retry).toBeTruthy();
    expect(placement?.scope).toMatchObject({ workspaceId: WS, ownerId: OWNER, goalId: GOAL });
    expect(failed.obligations.detailRef).toBe('coord:orient for the complete obligation agenda');

    portfolio.mockRestore();
    const recovered = await readOrientation();
    expect(recovered.goalPortfolio).toBeTruthy();
    const recoveredPlacement = recovered.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
    expect(recoveredPlacement?.scope).toEqual(placement?.scope);
    expect(recoveredPlacement?.measurementFailure?.detail ?? '').not.toContain(failure);
    for (const [warning] of warnings.mock.calls) {
      expect(String(warning)).toMatch(/^\[bounded-timeout\] (?:agent-obligations:|orient:goalPortfolio)/);
    }
  }, 90_000);
});
