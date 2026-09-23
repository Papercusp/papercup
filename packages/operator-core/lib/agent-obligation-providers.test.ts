import { describe, expect, it } from 'vitest';
import {
  GATE_CODE_OWNERSHIP,
  buildAgentObligationAgenda,
  independentVerificationObligation,
  ownerReportObligation,
  planPlacementObligation,
  goalPlanningObligation,
  type GoalPlanningProviderInput,
  waitingOnObligations,
  type IndependentVerificationProviderInput,
  type OwnerReportProviderInput,
  type PlanAcceptanceGateCodeOwnership,
  type PlanPlacementProviderInput,
  type WaitingOnObligationRow,
  type WaitingOnProviderInput,
} from './agent-obligation-providers';
import type { GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief } from './goal-launch-settings';
import { compileGoalPlanPlacement } from './goal-launch-settings';
import { goalPlanningPortfolioFingerprint, type GoalPlanningReview } from './goal-planning-review';

const NOW = '2026-09-05T20:00:00.000Z';
const base = { workspaceId: 'ws', ownerId: 'su-goal', observedAt: NOW, sourceGeneration: 'rev-42' };
const failure = { code: 'read-failed', detail: 'canonical writer timed out', retry: 'retry the canonical writer' };

describe('scope-aware goal planning obligations', () => {
  function input(disposition: GoalPlanningReview['disposition'] = 'plan-needed', populated = true): GoalPlanningProviderInput {
    const value = portfolio(populated ? [worklistPlan(placement('working', 'none'))] : []);
    return { ...base, goalId: 'goal-1', read: { status: 'known', value: {
      portfolio: value, reviewIntervalMs: 60 * 60_000,
      review: { schemaVersion: 1, goalId: 'goal-1', disposition,
        rationale: 'Measured missing recovery coverage.', evidenceRefs: ['work-item:WI-fixture'],
        planRefs: [], ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover failed checkout' } : {}),
        portfolioFingerprint: goalPlanningPortfolioFingerprint(value), reviewedAt: NOW },
      authorities: { papercusp: { allowed: true, reason: 'caller-goal-owns-pot', ownerGoalId: 'goal-1', ownerGoalTitle: 'Goal' } },
    } } };
  }
  function known(value: GoalPlanningProviderInput) {
    if (value.read.status !== 'known') throw new Error('test requires known source');
    return value.read.value;
  }
  it.each([true, false])('exposes an uncovered outcome with populated worklist=%s', (populated) => {
    expect(goalPlanningObligation(input('plan-needed', populated))).toMatchObject({
      family: 'planning-needed', status: 'due', applicableDemand: 1,
      action: { kind: 'continue' },
    });
    expect(goalPlanningObligation(input('plan-needed', populated)).action?.summary).toContain('Recover failed checkout');
  });
  it('accepts a current supported sufficient-plan review without an idea quota', () => {
    expect(goalPlanningObligation(input('existing-plans-sufficient'))).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
  });
  it('reviews the standing frontier instead of equating terminal plans with goal completion', () => {
    const value = input(); const state = known(value);
    state.portfolio!.worklist = [worklistPlan(placement('terminal', 'none'))];
    state.review = null;
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'due', action: { kind: 'inspect' } });
    expect(goalPlanningObligation(value).action?.summary).toContain('frontier');
  });
  it('does not turn a failed source read into no demand', () => {
    expect(goalPlanningObligation({ ...base, goalId: 'goal-1', read: { status: 'unknown', failure } })).toMatchObject({ status: 'unknown', measurementFailure: failure });
  });
  it.each(['paused', 'achieved', 'killed'])('does not resume a %s goal', (status) => {
    const value = input(); known(value).portfolio!.goal.status = status;
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'not-applicable' });
    expect(goalPlanningObligation(value).action).toBeUndefined();
  });
  it('refreshes a review when outcomes changed, not when observation clocks changed', () => {
    const value = input('existing-plans-sufficient'); const state = known(value);
    state.portfolio!.assembledAt = '2026-09-05T20:01:00Z';
    expect(goalPlanningObligation(value).status).toBe('satisfied');
    state.portfolio!.goal.body = 'New outcome';
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'due', action: { kind: 'inspect' } });
  });
  it('makes periodic review due even when planning inputs are unchanged', () => {
    const value = input('existing-plans-sufficient'); value.observedAt = '2026-09-05T21:01:00Z';
    expect(goalPlanningObligation(value).status).toBe('due');
  });
  it('routes other-goal plans instead of offering local adoption', () => {
    const value = input('adopt-plan'); const state = known(value);
    state.review!.planRefs = ['plan:papercusp/foreign'];
    state.authorities.papercusp = { allowed: false, reason: 'different-active-goal-owns-pot', ownerGoalId: 'goal-other', ownerGoalTitle: 'Other' };
    expect(goalPlanningObligation(value).action?.summary).toMatch(/route.*goal-other/i);
    expect(goalPlanningObligation(value).action?.tool).toBeUndefined();
  });
  it('permits nonduplicating adoption in an unowned harness but retains CAS and launch guards', () => {
    const value = input('adopt-plan'); const state = known(value);
    state.review!.planRefs = ['plan:papercusp/reuse'];
    state.authorities.papercusp = { allowed: true, reason: 'no-active-owner', ownerGoalId: null, ownerGoalTitle: null };
    expect(goalPlanningObligation(value).action?.summary).toMatch(/adopt.*CAS/i);
    expect(goalPlanningObligation(value).action?.summary).toContain('budget');
  });
  it('keeps unresolved candidate ownership unknown', () => {
    const value = input('adopt-plan'); known(value).review!.planRefs = ['plan:unknown/candidate'];
    expect(goalPlanningObligation(value).status).toBe('unknown');
  });
  it('puts executable existing-plan staffing ahead of planning', () => {
    const planning = input();
    const p = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    const agenda = buildAgentObligationAgenda({ goalPlanning: planning, planPlacement: planInput({ status: 'known', value: {
      portfolio: p, launch: launch(), alert: null, evidenceRef: 'placement:fixture',
    } }) }, NOW);
    expect(agenda.primary[0]?.family).toBe('plan-placement');
    expect(agenda.primary.some((row) => row.family === 'planning-needed' && row.status === 'due')).toBe(true);
  });
});

function planInput(value: PlanPlacementProviderInput['read']): PlanPlacementProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function reportInput(value: OwnerReportProviderInput['read']): OwnerReportProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function verifyInput(value: IndependentVerificationProviderInput['read']): IndependentVerificationProviderInput {
  return { ...base, planSlug: 'plan-a', read: value };
}

const planAlert = (
  reason: 'started-plan-no-live-targeting-fleet' | 'started-plan-targeting-fleet-zero-live-claims',
) => ({
  goalId: 'goal-1',
  workspaceId: 'ws',
  title: 'Goal',
  reason,
  planSlug: 'plan-a',
  harnessSlug: 'papercusp',
  itemIds: ['P-001'],
  targetingFleets: [],
  liveHolders: ['su-goal'],
});

function placement(
  state: GoalPlanPlacement['state'],
  action: GoalPlanPlacement['reconciliation']['action'],
  overrides: Partial<GoalPlanPlacement> = {},
): GoalPlanPlacement {
  const launchAction =
    action === 'launch-plan-fleet' ||
    action === 'launch-spawned-leader' ||
    action === 'resume-partial-launch' ||
    action === 'restore-spawned-leader';
  const base: GoalPlanPlacement = {
    state,
    // P-026 / D-012: these fixtures exercise placement states, not closure, so
    // no closure reading was taken. `null` says exactly that — it is never a
    // way to spell "closed".
    closure: null,
    fleet:
      state === 'unplaced'
        ? null
        : {
            slug: 'plan-a-fleet',
            controlState: 'active',
            leaderOwnerId: 'su-independent',
            leaderLive: true,
            liveMembers: 2,
            target: 2,
          },
    activeLane:
      state === 'unplaced'
        ? null
        : {
            itemId: 'P-001',
            ownerId: 'su-member',
            ownerFleet: 'plan-a-fleet',
            holderLive: true,
            expiresAt: '2026-09-05T21:00:00.000Z',
          },
    launchTransaction:
      state === 'admitting'
        ? {
            transactionId: 'tx-partial',
            state: 'partial',
            retryOwnerIds: ['su-retry'],
            nextAction: 'retry only the unverified canary identity',
          }
        : state === 'working' || state === 'independently-led'
          ? { transactionId: 'tx-verified', state: 'verified', retryOwnerIds: [], nextAction: null }
          : null,
    reconciliation: {
      consistent: action === 'none',
      action,
      reason: action === 'none' ? 'canonical placement is consistent' : `canonical repair: ${action}`,
      toolCall: launchAction
        ? {
            tool: 'fleet:launch-on-plan',
            args: {
              name: 'plan-a-fleet',
              plan: 'plan-a',
              harness: 'papercusp',
              leader: 'spawn',
              headless: true,
            },
          }
        : null,
    },
  };
  return {
    ...base,
    ...overrides,
    reconciliation: { ...base.reconciliation, ...overrides.reconciliation },
  };
}

function worklistPlan(value: GoalPlanPlacement, slug = 'plan-a'): GoalPortfolioBrief['worklist'][number] {
  return {
    ref: `plan:papercusp/${slug}`,
    ordinal: 1,
    harness: 'papercusp',
    slug,
    title: 'Plan A',
    status: value.state === 'terminal' ? 'done' : 'active',
    next: value.state === 'terminal' ? null : { id: 'P-001', text: 'Do the work', phase: 'Build', blockedBy: [] },
    counts: {
      todo: value.state === 'terminal' ? 0 : 1,
      wip: 0,
      blocked: 0,
      needsHuman: 0,
      done: value.state === 'terminal' ? 1 : 0,
    },
    ambiguousMatches: 1,
    placement: value,
  };
}

function portfolio(worklist: GoalPortfolioBrief['worklist'], degradedReasons: string[] = []): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt: NOW,
    goal: {
      id: 'goal-1',
      title: 'Goal',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist,
    pots: [{ harness: 'papercusp', role: 'owner', note: null }],
    drainFleet: {
      slug: 'goal-fleet',
      exists: true,
      controlState: 'active',
      leaderOwnerId: 'su-goal',
      live: 1,
      working: 1,
    },
    queue: {
      total: worklist.length,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 1,
      claimabilityScope: 'issue-family',
    },
    launch: { settings: null, ceilings: { maxAgents: 10, maxPerFleet: 5 }, headcount: { total: 2, fleet: 0 } },
    budget: {
      budgetCents: 10_000,
      spentCents: 2_500,
      unmeasuredPricedSpend: false,
      spentCentsAt: '2026-09-05T19:55:00.000Z',
      spentCentsSource: 'goal-pots-rollup',
      budgetWindowSec: null,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: [],
    degradedReasons,
  };
}

function launch(overrides: Partial<GoalLaunchResolution> = {}): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    goalBrief: null,
    effective: { carry: 'warm' },
    ceilings: { maxAgents: 10, maxPerFleet: 5 },
    headcount: { total: 2, fleet: 0 },
    budget: {
      budgetCents: 10_000,
      spentCents: 2_500,
      unmeasuredPricedSpend: false,
      spentCentsAt: '2026-09-05T19:55:00.000Z',
      spentCentsSource: 'goal-pots-rollup',
    },
    refusal: null,
    degraded: false,
    degradedReasons: [],
    ...overrides,
  };
}

function knownPlacement(value: {
  portfolio: GoalPortfolioBrief | null;
  launch: GoalLaunchResolution | null;
  alert?: ReturnType<typeof planAlert> | null;
  evidenceRef: string;
  ageMs?: number;
}): PlanPlacementProviderInput['read'] {
  return { status: 'known', value: { alert: null, ...value } };
}

describe('frozen provider matrix: plan placement (6 opportunities)', () => {
  const unplaced = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
  const working = worklistPlan(placement('working', 'none'));
  const led = worklistPlan(placement('independently-led', 'none'), 'plan-b');
  const partial = worklistPlan(placement('admitting', 'resume-partial-launch'));
  const budgetRefusal = launch({
    refusal: {
      reason: 'goal_budget_exceeded',
      limit: 10_000,
      current: 10_500,
      requested: 2,
      currentScope: 'inside-goal-pots:authoritative',
      message: 'verified goal budget is exhausted',
    },
  });

  it.each([
    [
      'due',
      planInput(
        knownPlacement({
          portfolio: portfolio([unplaced]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:1',
        }),
      ),
      'delegate',
    ],
    [
      'blocked',
      planInput(
        knownPlacement({
          portfolio: portfolio([unplaced]),
          launch: budgetRefusal,
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:2',
        }),
      ),
      'repair',
    ],
    [
      'satisfied',
      planInput(knownPlacement({ portfolio: portfolio([working, led]), launch: launch(), evidenceRef: 'cohort:3' })),
      undefined,
    ],
    [
      'not-applicable',
      planInput(knownPlacement({ portfolio: portfolio([]), launch: budgetRefusal, evidenceRef: 'cohort:4' })),
      undefined,
    ],
    ['unknown', planInput({ status: 'unknown', failure }), 'inspect'],
    [
      'in-progress',
      planInput(
        knownPlacement({
          portfolio: portfolio([partial]),
          launch: launch(),
          alert: planAlert('started-plan-targeting-fleet-zero-live-claims'),
          evidenceRef: 'cohort:recovery',
          ageMs: 9_000,
        }),
      ),
      'continue',
    ],
  ] as const)('%s', (status, input, action) => {
    const result = planPlacementObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('plan placement preserves canonical launch evidence', () => {
  it.each(['paused', 'achieved', 'killed'])('never restarts a %s goal with unfinished plans', (status) => {
    const stopped = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    stopped.goal.status = status;
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: stopped, launch: launch(), evidenceRef: 'cohort:stopped' })),
    );

    expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
    expect(result.action).toBeUndefined();
    expect(result.changeSignal).toBeUndefined();
    expect(buildAgentObligationAgenda({ planPlacement: planInput(
      knownPlacement({ portfolio: stopped, launch: launch(), evidenceRef: 'cohort:stopped' }),
    ) }, NOW).primary).toEqual([]);
  });

  it.each([null, 'unrecognized'])('keeps unresolved goal lifecycle %s unknown', (status) => {
    const unresolved = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    unresolved.goal.status = status;
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: unresolved, launch: launch(), evidenceRef: 'cohort:lifecycle' })),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      action: { kind: 'inspect' },
      measurementFailure: { code: 'goal-lifecycle-unresolved' },
    });
    expect(result.action?.tool).toBeUndefined();
  });

  it('does not turn a different goal portfolio into placement instructions', () => {
    const wrong = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    wrong.goal.id = 'other-goal';
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: wrong, launch: launch(), evidenceRef: 'cohort:wrong-goal' })),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      action: { kind: 'inspect' },
      measurementFailure: { code: 'goal-portfolio-scope-mismatch' },
    });
    expect(result.action?.tool).toBeUndefined();
  });

  it('advances an eligible plan past a blocked predecessor and clears only on canonical placement effect', () => {
    const compile = (slug: string, source: unknown = {}) => compileGoalPlanPlacement({
      plan: { harness: 'papercusp', slug, ambiguousMatches: 1 },
      status: 'ready',
      itemStatuses: ['todo'],
      actionableItemId: slug === 'waiting-plan' ? null : 'P-001',
      source,
      now: new Date(NOW),
    });
    const waiting = worklistPlan(compile('waiting-plan'), 'waiting-plan');
    const eligible = worklistPlan(compile('ready-plan'), 'ready-plan');
    const observe = (plans: GoalPortfolioBrief['worklist']) => planPlacementObligation(
      planInput(knownPlacement({ portfolio: portfolio(plans), launch: launch(), evidenceRef: 'cohort:progress' })),
    );

    expect(observe([waiting, eligible])).toMatchObject({
      status: 'due',
      scope: { planSlug: 'ready-plan' },
      action: { kind: 'delegate', args: { plan: 'ready-plan' } },
    });
    // A declaration/empty transaction cannot clear the required placement.
    expect(observe([eligible]).status).toBe('due');
    const working = worklistPlan(compile('ready-plan', {
      claims: [{ itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'ready-fleet', holderLive: true }],
      fleet: {
        slug: 'ready-fleet', leaderOwnerId: 'su-independent', leaderLive: true,
        liveMembers: 1, target: 1, launchTransaction: { state: 'verified' },
      },
    }), 'ready-plan');
    expect(observe([working]).status).toBe('satisfied');
    expect(observe([working]).action).toBeUndefined();
    // The already-owned plan stays untouched; its independent wait is still visible.
    expect(observe([waiting, working])).toMatchObject({
      status: 'blocked',
      scope: { planSlug: 'waiting-plan' },
      action: { kind: 'repair', targetRef: waiting.ref },
    });
  });

  it('uses the portfolio transaction tool call, including spawned leadership, unchanged', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:launch',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'due',
      action: {
        kind: 'delegate',
        tool: 'fleet:launch-on-plan',
        args: { name: 'plan-a-fleet', plan: 'plan-a', harness: 'papercusp', leader: 'spawn', headless: true },
      },
    });
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('headcount=2');
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('budgetSource=goal-pots-rollup');
  });

  it('keeps a degraded budget/headcount read explicit and never turns it into due work', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
          launch: launch({
            budget: {
              budgetCents: 10_000,
              spentCents: null,
              unmeasuredPricedSpend: false,
              spentCentsAt: null,
              spentCentsSource: null,
            },
            degraded: true,
            degradedReasons: ['budget ceiling not enforced — no platform spend snapshot'],
          }),
          evidenceRef: 'cohort:degraded',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'goal-launch-resolution-degraded' },
      boundary: { unknown: 'allow-with-warning' },
    });
    expect(result.applicableDemand).toBe(1);
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('budget=unknown/10000');
  });

  it('reports a classifier/portfolio disagreement as unknown rather than choosing a writer', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('working', 'none'))]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:conflict',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'plan-placement-writer-conflict' },
    });
  });

  it('does not intervene for a terminal-only portfolio even when launches would be refused', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('terminal', 'none'))]),
          launch: launch({
            refusal: {
              reason: 'goal_max_agents',
              limit: 5,
              current: 5,
              requested: 1,
              currentScope: 'live-agents-in-goal',
              message: 'no headroom',
            },
          }),
          evidenceRef: 'cohort:terminal',
        }),
      ),
    );

    expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
    expect(result.action).toBeUndefined();
  });
});

describe('frozen provider matrix: owner reporting (6 opportunities)', () => {
  const report = (obligation: 'overdue' | 'due-now' | 'not-due', lastReportAt: string | null = null) => ({
    lastReportAt,
    ageMin: obligation === 'overdue' ? 75 : 20,
    floorMin: 60,
    dueInMin: obligation === 'overdue' ? -15 : obligation === 'due-now' ? 3 : 40,
    dueAt:
      obligation === 'overdue'
        ? '2026-09-05T18:45:00.000Z'
        : obligation === 'due-now'
          ? '2026-09-05T19:03:00.000Z'
          : '2026-09-05T19:40:00.000Z',
    standing: true,
    obligation,
    instruction: obligation,
  });

  it.each([
    ['due', reportInput({ status: 'known', value: report('overdue') }), 'report'],
    ['due', reportInput({ status: 'known', value: report('due-now') }), 'report'],
    ['satisfied', reportInput({ status: 'known', value: report('not-due', '2026-09-05T19:40:00.000Z') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: report('not-due') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: null }), undefined],
    ['unknown', reportInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = ownerReportObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('frozen provider matrix: independent verification (6 opportunities)', () => {
  const gate = (
    satisfied: boolean,
    code?: NonNullable<Parameters<typeof independentVerificationObligation>[0]['read']> extends never ? never : string,
  ) => ({
    buildProvenance: { sha: null, version: 'test' },
    satisfied,
    ...(code ? { code: code as never } : {}),
    message: code ? `refused: ${code}` : 'accepted',
    rubricId: 'acceptance-plan-a',
    gradedBy: satisfied ? 'su-independent' : null,
  });
  const known = (g: ReturnType<typeof gate>, gradeable = true): IndependentVerificationProviderInput['read'] => ({
    status: 'known',
    value: { gate: g, evidenceRef: `gate:${g.code ?? 'pass'}`, reviewAgeMs: 3_600_000, gradeable },
  });

  it.each([
    ['due', verifyInput(known(gate(false, 'acceptance_ungraded'))), 'delegate'],
    ['due', verifyInput(known(gate(false, 'self_graded_only'))), 'delegate'],
    // D-009 ruling 3: author repair is DUE, not blocked. The author can start it
    // this second, so `[BLOCKED]` was telling the only agent who could act that it
    // could not. It is `repair`, never `delegate` — visibility recruits nobody.
    ['due', verifyInput(known(gate(false, 'acceptance_rubric_missing'))), 'repair'],
    // A failed MEASUREMENT is not work: nobody owns a repair for a gate read that
    // never happened, so it stays blocked and asks to be re-read.
    ['blocked', verifyInput(known(gate(false, 'acceptance_lineage_unreadable'))), 'inspect'],
    ['satisfied', verifyInput(known(gate(true))), undefined],
    ['not-applicable', verifyInput(known(gate(false, 'plan_items_unfinished'), false)), undefined],
    ['unknown', verifyInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = independentVerificationObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });

  it('mints a fresh episode when the same gate code recurs on a new source generation', () => {
    const read = known(gate(false, 'acceptance_ungraded'));
    const first = independentVerificationObligation(verifyInput(read));
    const second = independentVerificationObligation({ ...verifyInput(read), sourceGeneration: 'generation-2' });
    expect(first.id).not.toBe(second.id);
  });

  /**
   * D-009 ruling 3, the safety half. Driven over EVERY key of GATE_CODE_OWNERSHIP —
   * derived from the Record itself, so a code added later is covered automatically
   * rather than silently escaping a hand-listed fixture.
   *
   * The invariant that must never break: making author-owned work VISIBLE (`due`)
   * must not make it DELEGABLE. `acceptance-bar-lifecycle-evaluator.ts` renders a
   * user-facing promise that a contract refusal "does NOT recruit a grader … do not
   * recruit or wake a peer for them"; if this test ever fails, that rendered sentence
   * has become a lie.
   */
  const ownershipCodes = Object.entries(GATE_CODE_OWNERSHIP) as [
    keyof typeof GATE_CODE_OWNERSHIP,
    PlanAcceptanceGateCodeOwnership,
  ][];

  it('covers the whole gate-code union (calibration: the derived population is non-trivial)', () => {
    // Without this, a Record that somehow enumerated nothing would make every
    // assertion below pass VACUOUSLY — the it.each would simply run zero cases.
    expect(ownershipCodes.length).toBeGreaterThanOrEqual(20);
    expect(ownershipCodes.filter(([, owner]) => owner === 'grader')).toHaveLength(2);
  });

  it.each(ownershipCodes)('%s (%s) routes by ownership, and only a grader gap delegates', (code, owner) => {
    const result = independentVerificationObligation(verifyInput(known(gate(false, code))));

    // THE safety invariant: delegation is reachable from `grader` and nothing else.
    expect(result.action?.kind === 'delegate').toBe(owner === 'grader');

    // The visibility half: actionable is strictly WIDER than delegable.
    expect(result.status).toBe(owner === 'grader' || owner === 'author' ? 'due' : 'blocked');

    // Author repair stays upstream so it cannot be outranked by a downstream symptom.
    expect(result.causalRank).toBe(owner === 'author' ? 0 : 2);

    // A failed measurement is never dressed up as somebody's repair.
    if (owner === 'unmeasured') expect(result.action?.kind).toBe('inspect');
  });

  /**
   * R-1's falsifier, verbatim: "Drive one plan to an `acceptance_ungraded` verdict
   * twice … and count its plan-acceptance obligations after each pass; any count
   * other than one falsifies R-1 on P-002."
   */
  it.each(['acceptance_ungraded', 'acceptance_bar_contract_not_ready'] as const)(
    'reconciles a repeat %s verdict into exactly one obligation instead of a second',
    (code) => {
      const read = known(gate(false, code));
      const pass = () =>
        buildAgentObligationAgenda({ independentVerification: [verifyInput(read)] }, NOW).primary.filter(
          (entry) => entry.family === 'independent-verification',
        );

      expect(pass()).toHaveLength(1);
      // Same verdict, same source generation — a reconciliation, not a new episode.
      const [first] = pass();
      const [second] = pass();
      expect(pass()).toHaveLength(1);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('due');

      // Both passes agree, so the agenda must not flag a provider conflict.
      expect(
        buildAgentObligationAgenda(
          { independentVerification: [verifyInput(read), verifyInput(read)] },
          NOW,
        ).conflicts,
      ).toEqual([]);
    },
  );
});

describe('shared agenda composition', () => {
  it('returns one deterministic generation and ranks author repair ahead of grader dispatch', () => {
    const agenda = buildAgentObligationAgenda(
      {
        ownerReport: reportInput({
          status: 'known',
          value: {
            lastReportAt: null,
            ageMin: 75,
            floorMin: 60,
            dueInMin: -15,
            dueAt: '2026-09-05T18:45:00.000Z',
            standing: true,
            obligation: 'overdue',
            instruction: 'report now',
          },
        }),
        independentVerification: [
          verifyInput({
            status: 'known',
            value: {
              gate: {
                buildProvenance: { sha: null, version: 'test' },
                satisfied: false,
                code: 'acceptance_rubric_missing',
                message: 'author the rubric',
              },
              evidenceRef: 'gate:missing-rubric',
              gradeable: true,
            },
          }),
        ],
      },
      NOW,
    );
    expect(agenda.evaluations).toHaveLength(2);
    expect(agenda.primary[0]?.family).toBe('independent-verification');
    expect(agenda.sourceGeneration).toMatch(/^[a-f0-9]{20}$/);
  });

  it('never mistakes unknown or no-demand cases for due work', () => {
    const agenda = buildAgentObligationAgenda(
      {
        planPlacement: planInput({ status: 'unknown', failure }),
        ownerReport: reportInput({ status: 'known', value: null }),
      },
      NOW,
    );
    expect(agenda.evaluations.map((entry) => entry.status).sort()).toEqual(['not-applicable', 'unknown']);
    expect(agenda.evaluations.some((entry) => entry.status === 'due')).toBe(false);
  });
});

describe('frozen provider matrix: waiting-on (P-011)', () => {
  const waitingInput = (read: WaitingOnProviderInput['read']): WaitingOnProviderInput => ({ ...base, read });
  const awaitRow = (over: Partial<Extract<WaitingOnObligationRow, { kind: 'event-await' }>> = {}) =>
    ({
      kind: 'event-await' as const,
      key: 'work-item:done:WI-10002222',
      timeoutAt: '2026-09-05T21:00:00.000Z',
      onTimeout: 'wake' as const,
      ...over,
    }) satisfies WaitingOnObligationRow;

  it('reports a failed read as unknown rather than as "waiting on nothing"', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'unknown', failure }));
    // The reassuring reading is the dangerous one: a read that FAILED must never
    // render as an empty wait list, or a silently-expiring await disappears.
    expect(row!.status).toBe('unknown');
    expect(row!.applicableDemand).toBe(0);
    expect(row!.reason).toBe(failure.detail);
    expect(row!.action?.targetRef).toBe('events:status');
  });

  it('reports a genuinely empty wait as not-applicable, not as absence of measurement', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'known', value: [] }));
    expect(row!.status).toBe('not-applicable');
    expect(row!.priority).toBe('low');
    expect(row!.applicableDemand).toBe(0);
  });

  it('carries the awaited key VERBATIM in the title, which is the only field the narrow sink renders', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }));
    expect(row!.title).toContain('work-item:done:WI-10002222');
    expect(row!.reason).toContain('work-item:done:WI-10002222');
    // A hand-retyped key does not rendezvous — so the key must survive the hop
    // into evidence too, where a successor recovers it.
    expect(row!.evidence[0]!.ref).toBe('event-await:work-item:done:WI-10002222');
  });

  it('ranks a SILENTLY-expiring await above a waking one and says so in the title', () => {
    const [waking] = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }));
    const [expiring] = waitingOnObligations(
      waitingInput({ status: 'known', value: [awaitRow({ onTimeout: 'expire' })] }),
    );
    expect(waking!.priority).toBe('normal');
    expect(waking!.title).not.toContain('expires SILENTLY');
    // At the deadline a `wake` row still gets a turn; an `expire` row lapses with
    // NO turn, so nothing in the session ever mentions it again.
    expect(expiring!.priority).toBe('high');
    expect(expiring!.title).toContain('expires SILENTLY');
  });

  it('keys the episode on the await itself, so a re-render on a new generation is not a new obligation', () => {
    const first = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }))[0]!;
    const second = waitingOnObligations({
      ...waitingInput({ status: 'known', value: [awaitRow()] }),
      sourceGeneration: 'rev-43',
      observedAt: '2026-09-05T20:30:00.000Z',
    })[0]!;
    // Same parked await, later turn: the SAME obligation, or a warm-turn dedup
    // reads every re-render as brand-new and the row churns forever.
    expect(second.episode).toBe(first.episode);
    expect(second.id).toBe(first.id);
  });

  it('names WHAT a queued lock is behind — holder, intent and expiry — not merely THAT it is queued', () => {
    const [row] = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          {
            kind: 'lock-queue',
            path: 'packages/operator-core/lib/agent-obligations.ts',
            holder: 'su-peer',
            holderIntent: 'rewriting the obligation union',
            holderExpiresAt: '2026-09-05T20:10:00.000Z',
          },
        ],
      }),
    );
    expect(row!.title).toContain('su-peer');
    expect(row!.reason).toContain('rewriting the obligation union');
    expect(row!.reason).toContain('2026-09-05T20:10:00.000Z');
    expect(row!.action?.tool).toBe('locks:queue');
    expect(row!.action?.args).toEqual({ paths: ['packages/operator-core/lib/agent-obligations.ts'] });
  });

  it('keeps a row whose holder could not be resolved, rather than dropping the wait itself', () => {
    const [row] = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          {
            kind: 'lock-queue',
            path: 'packages/operator-core/lib/x.ts',
            holder: 'unknown holder',
            holderIntent: null,
            holderExpiresAt: null,
          },
        ],
      }),
    );
    // One unresolvable FIELD must never suppress the row: the ticket is queued
    // either way, and a dropped row hides the wait completely.
    expect(row!.status).toBe('blocked');
    expect(row!.applicableDemand).toBe(1);
    expect(row!.dueAt).toBeUndefined();
  });

  it('emits one row per wait, so two concurrent waits are both visible', () => {
    const rows = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          awaitRow(),
          awaitRow({ key: 'plan-item:done:turn-start-memory-two-class-2026-09-21:P-011', timeoutAt: null }),
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.episode)).size).toBe(2);
    expect(rows[1]!.reason).toContain('no deadline');
    expect(rows[1]!.dueAt).toBeUndefined();
  });
});
