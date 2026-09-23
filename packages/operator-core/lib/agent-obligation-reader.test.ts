import { describe, expect, it, vi } from 'vitest';
import { goalPlanningPortfolioFingerprint } from './goal-planning-review';

import {
  PLAN_CONTEXT_MAX,
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
    budget: {
      budgetCents: null,
      spentCents: null,
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: null,
      budgetWindowSec: null,
    },
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
    goalPlanning: vi.fn(async () => ({ review: {
      schemaVersion: 1 as const, goalId: 'goal-1', disposition: 'existing-plans-sufficient' as const,
      rationale: 'No uncovered outcome in this generic reader fixture.', evidenceRefs: ['goal:goal-1'], planRefs: [],
      portfolioFingerprint: goalPlanningPortfolioFingerprint(portfolio()), reviewedAt: NOW.toISOString(),
    }, authorities: {} })),
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
        dueAt: '2026-09-05T18:45:00.000Z',
        standing: true,
        obligation: 'overdue',
        instruction: 'report now',
      }),
    ),
    planAcceptance: vi.fn(
      async (): Promise<PlanAcceptanceGateVerdict> => ({
        buildProvenance: { sha: null, version: 'test' },
        satisfied: false,
        code: 'acceptance_rubric_missing',
        message: 'author the rubric',
      }),
    ),
    // Injected rather than left to the default dep: the real one reads
    // harness_shared.owner_directives, so omitting it would make every case
    // below depend on a live database AND silently add an `unknown`
    // owner-directive row to the agenda each fixture is asserting on.
    // The owner-directive family has its own suite
    // (agent-obligation-owner-directives.test.ts); here it is deliberately
    // empty so these cases keep measuring the goal/plan providers.
    ownerDirectives: vi.fn(async () => []),
    waitingOn: vi.fn(async () => []),
    ...overrides,
  };
}

describe('shared agent obligation reader', () => {
  it('delivers a bounded goal action with exact identity and source revision despite a long outcome', async () => {
    const p = portfolio();
    const uncoveredOutcome = 'An evidenced missing recovery path. '.repeat(80);
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ ownerReport: async () => null, goalPlanning: async () => ({
        review: { schemaVersion: 1, goalId: 'goal-1', disposition: 'plan-needed',
          rationale: 'Existing plans do not cover this outcome.', evidenceRefs: ['work-item:WI-gap'], planRefs: [],
          uncoveredOutcome, portfolioFingerprint: goalPlanningPortfolioFingerprint(p), reviewedAt: NOW.toISOString() },
        authorities: {},
      }) }) });
    const obligation = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
    const brief = projectAgentTurnStartObligationBrief(read.agenda);
    expect(brief.projection.receipt.entriesDelivered).toBe(1);
    expect(brief.projection.receipt.entriesOmitted).toBe(0);
    expect(brief.projection.text.length).toBeLessThanOrEqual(400);
    expect(brief.projection.text).toContain(obligation.id);
    expect(brief.projection.text).toContain(obligation.ruleRevision);
    expect(brief.projection.text).toContain(obligation.sourceGeneration);
    expect(brief.projection.text).toContain('verify real claims');
    expect(obligation.reason).toContain(uncoveredOutcome);
  });

  it('prints source identity even when the ordinary goal action already fits the sink', async () => {
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ ownerReport: async () => null, goalPlanning: async () => ({ review: null, authorities: {} }) }) });
    const obligation = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
    const text = projectAgentTurnStartObligationBrief(read.agenda).projection.text;
    expect(text).toContain(obligation.id);
    expect(text).toContain(obligation.ruleRevision);
    expect(text).toContain(obligation.sourceGeneration);
  });

  it('delivers recorded uncovered needs from the planning reader', async () => {
    const p = portfolio();
    const goalPlanning = vi.fn(async () => ({ review: {
      schemaVersion: 1 as const, goalId: 'goal-1', disposition: 'plan-needed' as const,
      rationale: 'Failure recovery is uncovered.', evidenceRefs: ['work-item:WI-gap'], planRefs: [],
      uncoveredOutcome: 'Recover failed checkout', portfolioFingerprint: goalPlanningPortfolioFingerprint(p),
      reviewedAt: NOW.toISOString(),
    }, authorities: {} }));
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ goalPlanning }) });
    expect(goalPlanning).toHaveBeenCalledWith('ws', 'su-goal', 'goal-1');
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')).toMatchObject({
      status: 'due', applicableDemand: 1, action: { kind: 'continue' },
    });
  });
  it('keeps failed planning reads unknown while unrelated obligations remain available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ goalPlanning: vi.fn(async () => { throw new Error('review ledger unavailable'); }) }) });
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')?.status).toBe('unknown');
    expect(read.agenda.evaluations.some((row) => row.family === 'owner-report')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('review ledger unavailable'));
    warn.mockRestore();
  });
  it.each(['paused', 'achieved', 'killed'])('does not deliver stale reporting work for a %s goal', async (status) => {
    const stopped = portfolio();
    stopped.goal.status = status;
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => stopped) }),
    });
    expect(read.agenda.primary).toEqual([]);
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')?.status).toBe('not-applicable');
    expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).toBe('');
  });

  it('does not revive a stopped goal when its review ledger fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stopped = portfolio(); stopped.goal.status = 'paused';
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ goalPortfolio: async () => stopped,
        goalPlanning: async () => { throw new Error('stopped review unavailable'); } }) });
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')?.status).toBe('not-applicable');
    expect(read.agenda.primary).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped review unavailable'));
    warn.mockRestore();
  });

  it.each([null, 'unrecognized'])('does not turn lifecycle %s into a reporting duty', async (status) => {
    const unknown = portfolio();
    unknown.goal.status = status;
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW, planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => unknown) }),
    });
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')).toMatchObject({
      status: 'unknown', action: { kind: 'inspect' },
    });
  });

  it('keeps a mismatched portfolio unknown in the consumed reporting agenda', async () => {
    const wrong = portfolio();
    wrong.goal.id = 'other-goal';
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW, planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => wrong) }),
    });
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')).toMatchObject({
      status: 'unknown', action: { kind: 'inspect' },
    });
    expect(read.degradedSources).not.toEqual([]);
    expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).not.toContain('[DUE]');
  });

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
      ['planning-needed', 'satisfied'],
      // P-006: the owner-directive family is assembled UNCONDITIONALLY, so an
      // empty queue is reported as a measured not-applicable rather than as the
      // class being absent — those two must never render identically.
      ['owner-directive', 'not-applicable'],
      // 'due', not 'blocked': D-009 ruling 3 split `graderGap` into `isDelegable`
      // (grader only) and `isActionable` (grader OR author repair). This fixture's
      // gate code is `acceptance_rubric_missing`, which is AUTHOR-owned, so the
      // author can act this second. Rendering it `[BLOCKED]` told the one agent
      // who CAN act that it cannot — which is the defect that ruling removed.
      ['independent-verification', 'due'],
      // P-011: same unconditional-assembly contract as owner-directive above. A
      // session waiting on nothing must report a MEASURED not-applicable; if the
      // family were assembled only when rows exist, "no wait" and "the read never
      // ran" would render identically — and the silent-expire await this class
      // exists to surface is exactly what would vanish into that gap.
      ['waiting-on', 'not-applicable'],
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

  it.each(['goal', 'plan'] as const)('keeps failed %s scope discovery visibly unknown', async (scope) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = await readAgentObligationAgenda({
        workspaceId: 'ws',
        ownerId: 'su-goal',
        now: NOW,
        deps: deps({
          goalSubject: vi.fn(async () => {
            if (scope === 'goal') throw new Error('goal scope unavailable');
            return null;
          }),
          planSlugs: vi.fn(async () => {
            if (scope === 'plan') throw new Error('plan scope unavailable');
            return [];
          }),
        }),
      });

      expect(read.degradedSources.length).toBeGreaterThan(0);
      expect(read.agenda.primary).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unknown' })]));
      expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).toContain('UNKNOWN');
    } finally {
      warn.mockRestore();
    }
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
    expect(state.obligations?.projection.receipt.entriesOmitted).toBe(0);
    expect(state.obligations?.projection.receipt.entriesDelivered).toBe(read.agenda.primary.length);
    expect(state.obligations!.projection.text.length).toBeLessThanOrEqual(400);
    for (const entry of read.agenda.primary) {
      expect(state.obligations!.projection.text).toContain(entry.action?.summary ?? entry.clearsWhen.summary);
    }
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

describe('P-026 / D-012 item 2: the acceptance obligation covers the delegated worklist', () => {
  function worklistPlan(
    slug: string,
    closure: GoalPortfolioBrief['worklist'][number]['placement']['closure'],
    ordinal = 1,
  ): GoalPortfolioBrief['worklist'][number] {
    return {
      ref: `plan:papercusp/${slug}`,
      ordinal,
      harness: 'papercusp',
      slug,
      title: slug,
      status: 'awaiting-acceptance',
      next: null,
      counts: { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 3 },
      ambiguousMatches: 0,
      placement: {
        state: closure?.state === 'closed' ? 'terminal' : 'awaiting-closure',
        activeLane: null,
        fleet: null,
        launchTransaction: null,
        reconciliation: { consistent: true, action: 'none', reason: 'none', toolCall: null },
        closure,
      },
    };
  }

  function closure(
    state: 'closed' | 'open' | 'partial' | 'unknown',
  ): NonNullable<GoalPortfolioBrief['worklist'][number]['placement']['closure']> {
    return {
      state,
      evidenceSatisfied: state === 'closed',
      reportOutstandingOnly: false,
      reason: `closure is ${state}`,
    };
  }

  function withWorklist(entries: GoalPortfolioBrief['worklist']): GoalPortfolioBrief {
    const brief = portfolio();
    brief.worklist = entries;
    return brief;
  }

  async function read(brief: GoalPortfolioBrief, overrides: Partial<AgentObligationReaderDeps> = {}) {
    return readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-holder',
      now: NOW,
      deps: deps({ goalPortfolio: vi.fn(async () => brief), ...overrides }),
    });
  }

  it('raises an acceptance obligation for a plan the holder delegated and never declared on', async () => {
    const result = await read(withWorklist([worklistPlan('delegated-plan', closure('open'))]));

    // The holder declared itself on plan-a only; before D-012 item 2 the
    // delegated plan carried no acceptance obligation at all.
    expect(result.planSlugs).toEqual(['plan-a', 'delegated-plan']);
    expect(result.agenda.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'independent-verification',
          scope: expect.objectContaining({ planSlug: 'delegated-plan' }),
        }),
      ]),
    );
  });

  it('drops a worklist plan whose closure is already closed', async () => {
    const result = await read(
      withWorklist([worklistPlan('closed-plan', closure('closed')), worklistPlan('open-plan', closure('open'), 2)]),
    );

    expect(result.planSlugs).toEqual(['plan-a', 'open-plan']);
  });

  it.each(['open', 'partial', 'unknown'] as const)(
    'keeps a worklist plan whose closure is %s in scope',
    async (state) => {
      const result = await read(withWorklist([worklistPlan('p', closure(state))]));
      expect(result.planSlugs).toContain('p');
    },
  );

  it('keeps an in-flight plan (closure null) in scope — null is never a reading of closed', async () => {
    const result = await read(withWorklist([worklistPlan('in-flight', null)]));
    expect(result.planSlugs).toContain('in-flight');
  });

  it('does not re-add the plan the holder already declared on', async () => {
    const result = await read(withWorklist([worklistPlan('plan-a', closure('open'))]));

    expect(result.planSlugs).toEqual(['plan-a']);
  });

  it('spends the existing cost bound on plans awaiting closure before plans still in flight', async () => {
    // Ten candidates for seven remaining slots (plan-a takes the first), with
    // the in-flight plans deliberately placed FIRST in worklist order: if the
    // cap were spent in raw order the awaiting-closure plans — P-026's whole
    // population — would be the ones dropped.
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => worklistPlan(`in-flight-${i}`, null, i + 1)),
      ...Array.from({ length: 5 }, (_, i) => worklistPlan(`awaiting-${i}`, closure('open'), i + 6)),
    ];

    const result = await read(withWorklist(entries));

    expect(result.planSlugs).toHaveLength(PLAN_CONTEXT_MAX);
    expect(result.planSlugs.slice(0, 6)).toEqual([
      'plan-a',
      'awaiting-0',
      'awaiting-1',
      'awaiting-2',
      'awaiting-3',
      'awaiting-4',
    ]);
    expect(result.planSlugs).not.toContain('in-flight-2');
  });

  it('reads the worklist acceptance gates WITHOUT delaying the other canonical reads', async () => {
    // The worklist slugs are only knowable after the portfolio resolves, so the
    // reader chains off that promise instead of awaiting it. A refactor that
    // "simplifies" this into `await portfolioPromise` before building the rest
    // of the wave serialises every read below behind the portfolio, which is
    // exactly what this case fails on.
    let releasePortfolio: () => void = () => {};
    const portfolioGate = new Promise<void>((resolve) => {
      releasePortfolio = resolve;
    });
    const started: string[] = [];
    const brief = withWorklist([worklistPlan('delegated-plan', closure('open'))]);

    const pending = read(brief, {
      goalPortfolio: vi.fn(async () => {
        started.push('portfolio');
        await portfolioGate;
        return brief;
      }),
      goalLaunch: vi.fn(async () => {
        started.push('launch');
        return launch();
      }),
      planFleet: vi.fn(async (): Promise<GoalPlanFleetObservation> => {
        started.push('fleet');
        return { status: 'known', alert: null, applicablePlanCount: 0 };
      }),
      waitingOn: vi.fn(async () => {
        started.push('waiting-on');
        return [];
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(expect.arrayContaining(['portfolio', 'launch', 'fleet', 'waiting-on']));

    releasePortfolio();
    const result = await pending;
    expect(result.planSlugs).toContain('delegated-plan');
  });
});
