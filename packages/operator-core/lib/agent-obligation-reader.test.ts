import { describe, expect, it, vi } from 'vitest';

import {
  projectAgentObligationBrief,
  projectAgentTurnStartObligationBrief,
  readAgentObligationAgenda,
  readAgentGoalModeState,
  type AgentObligationReaderDeps,
} from './agent-obligation-reader';
import type { GoalLaunchResolution, GoalPortfolioBrief } from './goal-launch-settings';
import type { PlanAcceptanceGateVerdict } from './plan-acceptance-gate';
import type { GoalPlanFleetObservation } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';

const NOW = new Date('2026-09-05T20:00:00.000Z');

function portfolio(assembledAt = NOW.toISOString()): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt,
    goal: {
      id: 'goal-1',
      title: 'Goal',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist: [],
    pots: [],
    drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
    queue: {
      total: 0,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 0,
      claimabilityScope: 'issue-family',
    },
    launch: { settings: null, ceilings: { maxAgents: 10, maxPerFleet: 5 }, headcount: { total: 1, fleet: null } },
    budget: { budgetCents: null, spentCents: null, spentCentsAt: null, spentCentsSource: null, budgetWindowSec: null },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: [],
    degradedReasons: [],
  };
}

function launch(): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    goalBrief: null,
    effective: {},
    ceilings: { maxAgents: 10, maxPerFleet: 5 },
    headcount: { total: 1, fleet: null },
    budget: null,
    refusal: null,
    degraded: false,
    degradedReasons: [],
  };
}

function deps(overrides: Partial<AgentObligationReaderDeps> = {}): AgentObligationReaderDeps {
  return {
    goalSubject: vi.fn(async () => 'goal-1'),
    planSlugs: vi.fn(async () => ['plan-a']),
    goalPortfolio: vi.fn(async () => portfolio()),
    goalLaunch: vi.fn(async () => launch()),
    planFleet: vi.fn(
      async (): Promise<GoalPlanFleetObservation> => ({
        status: 'known',
        alert: null,
        applicablePlanCount: 0,
      }),
    ),
    ownerReport: vi.fn(
      async (): Promise<GoalOwnerReportObligation> => ({
        lastReportAt: null,
        ageMin: 75,
        floorMin: 60,
        dueInMin: -15,
        standing: true,
        obligation: 'overdue',
        instruction: 'report now',
      }),
    ),
    planAcceptance: vi.fn(
      async (): Promise<PlanAcceptanceGateVerdict> => ({
        satisfied: false,
        code: 'acceptance_rubric_missing',
        message: 'author the rubric',
      }),
    ),
    ...overrides,
  };
}

describe('shared agent obligation reader', () => {
  it('assembles all applicable canonical providers into one agenda', async () => {
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps(),
    });

    expect(read.goalId).toBe('goal-1');
    expect(read.planSlugs).toEqual(['plan-a']);
    expect(read.portfolio?.goal.id).toBe('goal-1');
    expect(read.agenda.evaluations.map((entry) => [entry.family, entry.status])).toEqual([
      ['owner-report', 'due'],
      ['plan-placement', 'not-applicable'],
      ['independent-verification', 'blocked'],
    ]);
    expect(read.agenda.primary[0]?.family).toBe('independent-verification');
    expect(read.degradedSources).toEqual([]);
  });

  it('turns a failed canonical source into explicit unknown instead of false no-demand', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps({
        goalPortfolio: vi.fn(async () => {
          throw new Error('portfolio unavailable');
        }),
      }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('goal-portfolio failed'));
    warn.mockRestore();
    const placement = read.agenda.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(placement).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'canonical-plan-placement-read-failed' },
    });
    expect(read.degradedSources.some((entry) => entry.includes('goal portfolio'))).toBe(true);
  });

  it('keeps the generation stable when only observation clocks change', async () => {
    const first = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps(),
    });
    const second = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: new Date('2026-09-05T20:01:00.000Z'),
      deps: deps({ goalPortfolio: vi.fn(async () => portfolio('2026-09-05T20:01:00.000Z')) }),
    });
    expect(second.agenda.sourceGeneration).toBe(first.agenda.sourceGeneration);
  });

  it('projects the same agenda with sink-specific caps and an omission receipt', async () => {
    const { agenda } = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps(),
    });
    const brief = projectAgentObligationBrief({
      agenda,
      sink: 'turn-start',
      detailRef: 'coord:orient',
      maxEntries: 1,
      maxChars: 400,
      maxEstimatedTokens: 100,
    });
    expect(brief.sourceGeneration).toBe(agenda.sourceGeneration);
    expect(brief.projection.receipt).toMatchObject({ entriesDelivered: 1, entriesOmitted: 1, bodyTruncated: true });
    expect(brief.detailRef).toBe('coord:orient');
  });

  it('gives the GUI the exact turn-start projection plus the portfolio that fed it', async () => {
    const sharedDeps = deps();
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: sharedDeps,
    });
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: deps(),
    });

    expect(state).toMatchObject({
      schemaVersion: 'agent-goal-mode-state-v1',
      status: 'known',
      ownerId: 'su-goal',
      portfolio: { goal: { id: 'goal-1' } },
    });
    expect(state.obligations).toEqual(projectAgentTurnStartObligationBrief(read.agenda));
    expect(state.obligations?.projection.receipt.sink).toBe('turn-start');
    expect(state.obligations?.projection.receipt.entriesOmitted).toBeGreaterThan(0);
  });

  it('keeps partial source failure visibly degraded with provider-owned unknown rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: deps({
        goalPortfolio: vi.fn(async () => {
          throw new Error('portfolio unavailable');
        }),
      }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('goal-portfolio failed'));
    warn.mockRestore();

    expect(state.status).toBe('degraded');
    expect(state.portfolio).toBeNull();
    expect(state.degradedReasons.join(' ')).toContain('goal portfolio');
    expect(state.obligations?.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'plan-placement', status: 'unknown' }),
      ]),
    );
  });

  it('reports missing attribution as unknown without touching canonical providers', async () => {
    const providerDeps = deps();
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: null,
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: providerDeps,
    });

    expect(state).toMatchObject({
      status: 'unknown',
      ownerId: null,
      obligations: null,
      unknown: { code: 'no-canonical-goal-holder' },
    });
    expect(providerDeps.goalPortfolio).not.toHaveBeenCalled();
    expect(providerDeps.planAcceptance).not.toHaveBeenCalled();
  });
});
