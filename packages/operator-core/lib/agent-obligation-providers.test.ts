import { describe, expect, it } from 'vitest';
import {
  buildAgentObligationAgenda,
  independentVerificationObligation,
  ownerReportObligation,
  planPlacementObligation,
  type IndependentVerificationProviderInput,
  type OwnerReportProviderInput,
  type PlanPlacementProviderInput,
} from './agent-obligation-providers';
import type { GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief } from './goal-launch-settings';

const NOW = '2026-09-05T20:00:00.000Z';
const base = { workspaceId: 'ws', ownerId: 'su-goal', observedAt: NOW, sourceGeneration: 'rev-42' };
const failure = { code: 'read-failed', detail: 'canonical writer timed out', retry: 'retry the canonical writer' };

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
    ['blocked', verifyInput(known(gate(false, 'acceptance_rubric_missing'))), 'repair'],
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
