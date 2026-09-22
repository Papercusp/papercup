/** P-007: the advertised complete-agenda recovery must reach the real GOAL reader. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../../_baseline-coord-fixture';
import { setMode } from '../../../modes/store';
import * as obligationReader from '../../../agent-obligation-reader';
import * as goalSettings from '../../../goal-launch-settings';
import * as ownerReportHistory from '../../../system-health/goal-owner-report-watchdog';
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
  it.each(['paused', 'achieved', 'killed'])(
    'does not deliver a pre-stop reporting receipt after the canonical goal becomes %s',
    async (status) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      const readAgenda = obligationReader.readAgentObligationAgenda;
      vi.spyOn(obligationReader, 'readAgentObligationAgenda')
        .mockImplementation((input) => readAgenda({ ...input, now: dueAt }));
      const priorReport = await ownerReportHistory.readGoalOwnerReportObligation(fx.admin, {
        workspaceId: WS, ownerId: OWNER, goalId: GOAL,
      }, dueAt.getTime());
      expect(priorReport?.obligation).toBe('overdue');
      // Capture a real due receipt and reproduce the torn read: reporting
      // retains this pre-stop generation while the portfolio observes the stop.
      vi.spyOn(ownerReportHistory, 'readGoalOwnerReportObligation').mockResolvedValue(priorReport);
      const before = await readOrientation();
      expect(before.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report')?.status).toBe('due');
      await fx.admin`
        UPDATE harness_shared.goals SET status = ${status}
        WHERE workspace_id = ${WS} AND id = ${GOAL}
      `;
      try {
        const after = await readOrientation();
        expect(after.goalPortfolio?.goal.status).toBe(status);
        const report = after.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
        const placement = after.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
        expect(report?.status).toBe('not-applicable');
        expect(report?.action).toBeUndefined();
        expect(placement?.status).toBe('not-applicable');
        expect(placement?.changeSignal).toBeUndefined();
        expect(after.obligations.primary.filter((entry) => entry.scope.goalId === GOAL)).toEqual([]);
        const rows = await fx.admin`
          SELECT status FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}
        `;
        expect(rows[0]?.status).toBe(status);
      } finally {
        // Only the disposable fixture goal is restored for sibling tests.
        await fx.admin`
          UPDATE harness_shared.goals SET status = 'active'
          WHERE workspace_id = ${WS} AND id = ${GOAL}
        `;
      }
    }, 90_000,
  );

  it('keeps an omitted real agenda unseen until a full warm delivery and re-delivers after a cold boundary', async () => {
    // The newly enabled holder is initially inside the reporting grace period.
    // Advance the reader's supported clock, retaining its real PostgreSQL data
    // and provider evaluation, to exercise an actual due opportunity.
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const readAgenda = obligationReader.readAgentObligationAgenda;
    const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda')
      .mockImplementation((input) => readAgenda({ ...input, now: dueAt }));
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
      planDecisions: async () => undefined,
      // Lock transitions are unrelated to the agenda under test — undefined is
      // the silent value, so this fixture asserts no lock posture.
      lockTransitions: async () => undefined,
      held: async () => [],
      historyUpdates: async () => [],
      effortUpdates: async () => [],
      openChecks: async () => [],
      // Unrelated to the agenda under test — null keeps the verdict line silent.
      authorityVerdict: async () => null,
      inbox: async () => ({ count: 3, newest: [] }),
      announcedGates: async () => [],
      openAsks: async () => null,
      modes: async () => [],
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

    // P-002 CLASS-B RE-INJECT POLICY. A class-B row is discharged by
    // DISPOSITION, not by DELIVERY — so an identical next turn must RE-EMIT the
    // rows rather than fall silent. This assertion used to read `.toBe('')`,
    // which encoded exactly the one-shot behaviour P-002 replaced: the agenda
    // was committed as "seen" and an undispositioned owner directive never
    // reappeared.
    //
    // Note what is re-emitted: the ROW, not the whole block. Re-sending the
    // block would repeat unchanged held items/gates/facts and manufacture the
    // signal decay D-003 withdrew the triage line for.
    const reinjected = await deliver(2_000);
    for (const line of actionLines) expect(reinjected).toContain(line);
    // ...and it re-emits DESPITE the generation being committed, which is the
    // whole contract. Suppression itself is still guarded — the discharged
    // control lives in turn-start-class-b-reinject.test.ts, so a change that
    // made orientation unconditionally chatty fails THERE, not silently here.
    expect((await cursor()).committed.obligations).toBe(brief.sourceGeneration);

    epoch += 1;
    const cold = await deliver(2_000);
    for (const line of actionLines) expect(cold).toContain(line);
    const reinjectedAfterCold = await deliver(2_000);
    for (const line of actionLines) expect(reinjectedAfterCold).toContain(line);
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

  it('keeps unreadable report history unknown and executes its emitted recovery in the same scope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = `P007 controlled report-history read failure ${RUN}`;
    // This is the production three-rail history reader, shared by the handler
    // and obligation provider. Fail both reads, not whichever happens to race first.
    const history = vi.spyOn(ownerReportHistory, 'readGoalOwnerReportObligation')
      .mockRejectedValue(new Error(failure));
    const failed = await readOrientation();
    const report = failed.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
    expect(report?.status).toBe('unknown');
    expect(report?.scope).toMatchObject({ workspaceId: WS, ownerId: OWNER, goalId: GOAL });
    expect(report?.measurementFailure?.detail).toContain(failure);
    expect(report?.measurementFailure?.retry).toContain('readGoalOwnerReportObligation');
    expect(report?.action).toMatchObject({ kind: 'inspect', targetRef: 'readGoalOwnerReportObligation' });
    expect(failed.obligations.projection.text).toContain('UNKNOWN');

    history.mockRestore();
    // Resolve the emitted target, then actually execute it against the same
    // isolated PostgreSQL scope. A string-presence assertion alone is not recovery.
    const recoveryReaders = {
      readGoalOwnerReportObligation: ownerReportHistory.readGoalOwnerReportObligation,
    };
    const recovery = recoveryReaders[report!.action!.targetRef as keyof typeof recoveryReaders];
    expect(recovery).toBeTypeOf('function');
    const recoveredHistory = await recovery(fx.admin, {
      workspaceId: report!.scope.workspaceId,
      ownerId: report!.scope.ownerId!,
      goalId: report!.scope.goalId!,
    });
    expect(recoveredHistory?.obligation).toBe('not-due');
    expect(recoveredHistory?.lastReportAt).toBeNull();

    // The goal is genuinely within its initial reporting grace period. Its
    // measured no-demand must differ from the failed-history UNKNOWN above.
    const recovered = await readOrientation();
    const recoveredReport = recovered.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
    expect(recoveredReport?.scope).toEqual(report?.scope);
    expect(recoveredReport).toMatchObject({
      status: 'not-applicable',
      title: 'Owner report is not due yet',
      applicableDemand: 0,
    });
    expect(recoveredReport?.reason).toMatch(/^not due:/);
    expect(recoveredReport?.measurementFailure).toBeUndefined();
    expect(recoveredReport?.reason).not.toContain(failure);
  }, 90_000);
});
