/** Independent P002 intent oracles; optional subject is a copy-out mutant, never an in-tree edit. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { compileGoalPlanPlacement, type GoalPortfolioBrief } from './goal-launch-settings';
import { goalPlanningPortfolioFingerprint, type GoalPlanningReview } from './goal-planning-review';
import type { GoalPlanningProviderInput } from './agent-obligation-providers';

const subject: typeof import('./agent-obligation-providers') = process.env.PAPERCUSP_GOAL_OBLIGATION_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_OBLIGATION_PROBE).href)
  : await import('./agent-obligation-providers');
const NOW = '2026-09-23T10:00:00.000Z';
const base = { workspaceId: 'fixture', ownerId: 'su-goal', goalId: 'goal-local', observedAt: NOW, sourceGeneration: 'measured-input' };

function portfolio(populated = false, ready = true): GoalPortfolioBrief {
  const placement = compileGoalPlanPlacement({ plan: { harness: 'fixture', slug: 'existing', ambiguousMatches: 1 },
    status: ready ? 'ready' : 'draft', itemStatuses: ['todo'], actionableItemId: 'P-001', source: {}, now: new Date(NOW) });
  return {
    schemaVersion: 1, assembledAt: NOW,
    goal: { id: base.goalId, title: 'Goal', body: 'Recover checkout', status: 'active', standing: true, parentId: null, killCriterion: null },
    worklist: populated ? [{ ref: 'plan:fixture/existing', ordinal: 1, harness: 'fixture', slug: 'existing', title: 'Existing',
      status: ready ? 'ready' : 'draft', next: { id: 'P-001', text: 'Implement recovery', phase: 'Build', blockedBy: [] },
      counts: { todo: 1, wip: 0, blocked: 0, needsHuman: 0, done: 0 }, ambiguousMatches: 1, placement }] : [],
    pots: [], drainFleet: { slug: null, exists: false, controlState: null, leaderOwnerId: null, live: 0, working: 0 },
    queue: { total: 0, terminal: 0, inFlight: 0, blocked: 0, needsHuman: 0, claimable: 0, claimabilityScope: 'none' },
    launch: { settings: null, ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null } },
    budget: { budgetCents: null, spentCents: null, unmeasuredPricedSpend: false, spentCentsAt: null,
      spentCentsSource: null, budgetWindowSec: null },
    tripwires: [], pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null }, priorities: [], degradedReasons: [],
  };
}

function input(p = portfolio(), disposition: GoalPlanningReview['disposition'] = 'plan-needed'): GoalPlanningProviderInput {
  return { ...base, read: { status: 'known', value: {
    portfolio: p, reviewIntervalMs: 3_600_000,
    review: { schemaVersion: 1, goalId: base.goalId, disposition, rationale: 'Review of the named fixture outcome.',
      evidenceRefs: ['goal:goal-local'], planRefs: ['plan:fixture/existing'],
      ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover checkout' } : {}),
      portfolioFingerprint: goalPlanningPortfolioFingerprint(p), reviewedAt: NOW },
    authorities: { fixture: { allowed: true, reason: 'caller-goal-owns-pot', ownerGoalId: base.goalId, ownerGoalTitle: 'Goal' } },
  } } };
}
function known(i: GoalPlanningProviderInput) {
  if (i.read.status !== 'known') throw new Error('Expected known fixture');
  return i.read.value;
}

describe('P002 goal planning behavioral falsifiers', () => {
  it.each([false, true])('requires planning for an uncovered outcome with populated=%s', (populated) => {
    const row = subject.goalPlanningObligation(input(portfolio(populated)));
    expect(row).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(row.reason).toContain('Recover checkout');
  });
  it('does not manufacture new-plan demand after a supported sufficient review', () => {
    expect(subject.goalPlanningObligation(input(portfolio(true), 'existing-plans-sufficient'))).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
  });
  it('reviews the standing frontier after terminal work instead of declaring the goal finished', () => {
    const p = portfolio(true);
    // Controlled terminal-placement input; this is not a claim of plan-closure integration.
    p.worklist[0]!.placement.state = 'terminal';
    const i = input(p); known(i).review = null;
    const row = subject.goalPlanningObligation(i);
    expect(row.status).toBe('due');
    expect(row.action?.summary).toContain('standing goal frontier');
  });
  it.each(['caller-goal-owns-pot', 'no-active-owner'] as const)('permits guarded reuse when authority is %s', (reason) => {
    const i = input(portfolio(), 'adopt-plan');
    known(i).authorities.fixture = { allowed: true, reason, ownerGoalId: reason === 'no-active-owner' ? null : base.goalId, ownerGoalTitle: null };
    const row = subject.goalPlanningObligation(i);
    expect(row).toMatchObject({ status: 'due', action: { kind: 'continue', targetRef: 'plan:fixture/existing' } });
    expect(row.action?.summary).toMatch(/not a clone.*ownership, CAS, budget and admission/);
  });
  it('never instructs local adoption when another active goal owns the candidate', () => {
    const i = input(portfolio(), 'adopt-plan');
    known(i).authorities.fixture = { allowed: false, reason: 'different-active-goal-owns-pot', ownerGoalId: 'foreign', ownerGoalTitle: 'Other' };
    const row = subject.goalPlanningObligation(i);
    expect(row).toMatchObject({ status: 'due', action: { kind: 'report' } });
    expect(row.reason).toContain('foreign');
    expect(row.action?.summary).toContain('do not adopt or duplicate');
  });
  it.each([true, false])('keeps existing plan work ahead of new planning, executable=%s', (ready) => {
    const p = portfolio(true, ready);
    const agenda = subject.buildAgentObligationAgenda({ goalPlanning: input(p), planPlacement: {
      ...base, read: { status: 'known', value: { portfolio: p, evidenceRef: 'fixture:placement', alert: null,
        launch: { goalId: base.goalId, settings: null, goalBrief: null, effective: {}, ceilings: p.launch.ceilings,
          headcount: p.launch.headcount, budget: null, refusal: null, degraded: false, degradedReasons: [] } } },
    } }, NOW);
    expect(agenda.primary[0]).toMatchObject({ family: 'plan-placement', status: ready ? 'due' : 'blocked' });
    expect(agenda.primary[0]?.action?.tool).toBe(ready ? 'fleet:launch-on-plan' : undefined);
    expect(agenda.primary.findIndex((r) => r.family === 'planning-needed')).toBeGreaterThan(0);
  });
});
