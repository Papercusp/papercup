/**
 * Canonical adapters from existing policy writers into agent-obligations-v1.
 * No SQL, liveness derivation, scorecard interpretation, or new persistence
 * belongs here: callers pass the authoritative writer outputs unchanged.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 (P-003, D-010/D-011).
 */
import {
  defineAgentObligation,
  evaluateAgentObligations,
  goalPlanPlacementChangedKey,
  planAcceptanceChangedKey,
  type AgentObligation,
  type AgentObligationAgenda,
  type AgentObligationEvidence,
  type AgentObligationMeasurementFailure,
} from './agent-obligations';
import type { GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief } from './goal-launch-settings';
import type { GoalPlanFleetAlert } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import type { PlanAcceptanceGateCode, PlanAcceptanceGateVerdict } from './plan-acceptance-gate';

export const PLAN_PLACEMENT_OBLIGATION_REVISION = 'goal-plan-placement-v3';
export const OWNER_REPORT_OBLIGATION_REVISION = 'goal-owner-report-v1';
export const INDEPENDENT_VERIFICATION_OBLIGATION_REVISION = 'plan-independent-verification-v1';

interface ProviderBase {
  workspaceId: string;
  ownerId: string;
  observedAt: string;
  sourceGeneration: string;
}

interface ProviderUnknown {
  status: 'unknown';
  failure: AgentObligationMeasurementFailure;
}

interface ProviderKnown<T> {
  status: 'known';
  value: T;
}

export type ProviderRead<T> = ProviderKnown<T> | ProviderUnknown;

function policyAuthority(sourceRef: string, revision: string) {
  return { kind: 'policy' as const, sourceRef, revision };
}

function evidence(
  ref: string,
  observedAt: string,
  sourceRevision: string,
  note: string,
  effect?: string,
): AgentObligationEvidence {
  return {
    ref,
    observedAt,
    freshness: 'current',
    sourceRevision,
    note,
    ...(effect ? { effect } : {}),
  };
}

export interface PlanPlacementProviderInput extends ProviderBase {
  goalId: string;
  read: ProviderRead<{
    /** The ordered, canonical goal/worklist/placement projection. */
    portfolio: GoalPortfolioBrief | null;
    /** The exact launch-boundary resolution for the intended launch count. */
    launch: GoalLaunchResolution | null;
    /** The live cohort classifier corroborates the richer placement receipt. */
    alert: GoalPlanFleetAlert | null;
    /** Evidence ref for the exact joined cohort/classifier observation. */
    evidenceRef: string;
    /** Time since the last verified placement effect, when the caller can measure it. */
    ageMs?: number;
  }>;
}

type GoalPortfolioPlan = GoalPortfolioBrief['worklist'][number];

function placementNote(placement: GoalPlanPlacement): string {
  const fleet = placement.fleet
    ? `fleet=${placement.fleet.slug}; leader=${placement.fleet.leaderOwnerId ?? 'unknown'}; ` +
      `leaderLive=${placement.fleet.leaderLive}; liveMembers=${placement.fleet.liveMembers}; ` +
      `target=${placement.fleet.target ?? 'unknown'}`
    : 'fleet=none';
  const lane = placement.activeLane
    ? `lane=${placement.activeLane.itemId}; laneOwner=${placement.activeLane.ownerId}; ` +
      `laneOwnerFleet=${placement.activeLane.ownerFleet ?? 'none'}; laneHolderLive=${placement.activeLane.holderLive}`
    : 'lane=none';
  const transaction = placement.launchTransaction
    ? `launchTransaction=${placement.launchTransaction.transactionId ?? 'unknown'}:${placement.launchTransaction.state ?? 'unknown'}; ` +
      `retryOwners=${placement.launchTransaction.retryOwnerIds.join(',') || 'none'}; ` +
      `next=${placement.launchTransaction.nextAction ?? 'none'}`
    : 'launchTransaction=none';
  return (
    `placement=${placement.state}; reconciliation=${placement.reconciliation.action}; ` +
    `${fleet}; ${lane}; ${transaction}`
  );
}

function launchNote(launch: GoalLaunchResolution): string {
  const budget = launch.budget
    ? `budget=${launch.budget.spentCents ?? 'unknown'}/${launch.budget.budgetCents ?? 'undeclared'}; ` +
      `budgetSource=${launch.budget.spentCentsSource ?? 'unmarked'}; ` +
      `budgetObservedAt=${launch.budget.spentCentsAt ?? 'unknown'}`
    : 'budget=not-applicable';
  return (
    `${budget}; headcount=${launch.headcount.total}; fleetHeadcount=${launch.headcount.fleet ?? 'not-scoped'}; ` +
    `ceilings=${launch.ceilings.maxAgents ?? 'unlimited'}/${launch.ceilings.maxPerFleet ?? 'unlimited'}; ` +
    `profileKeys=${Object.keys(launch.effective).sort().join(',') || 'none'}; ` +
    `refusal=${launch.refusal?.reason ?? 'none'}; degraded=${launch.degradedReasons.join(' | ') || 'none'}`
  );
}

function placementEvidence(input: PlanPlacementProviderInput, plan?: GoalPortfolioPlan): AgentObligationEvidence[] {
  if (input.read.status === 'unknown') return [];
  const { portfolio, launch, alert, evidenceRef } = input.read.value;
  return [
    evidence(
      evidenceRef,
      input.observedAt,
      input.sourceGeneration,
      alert ? `${alert.reason}:${alert.planSlug}` : 'canonical live plan/fleet cohort has no alert',
    ),
    ...(portfolio
      ? [
          evidence(
            `goal-portfolio:${input.goalId}:${portfolio.assembledAt}`,
            portfolio.assembledAt,
            input.sourceGeneration,
            plan ? `${plan.ref}; ${placementNote(plan.placement)}` : 'canonical portfolio contains no applicable plan',
          ),
        ]
      : []),
    ...(launch
      ? [
          evidence(
            `goal-launch-resolution:${input.goalId}:${input.sourceGeneration}`,
            input.observedAt,
            input.sourceGeneration,
            launchNote(launch),
          ),
        ]
      : []),
  ];
}

function unknownPlacement(
  input: PlanPlacementProviderInput,
  args: {
    title: string;
    code: string;
    detail: string;
    retry: string;
    applicableDemand: number;
    plan?: GoalPortfolioPlan;
  },
): AgentObligationInputShape {
  return {
    title: args.title,
    episode: `unknown:${args.code}:${input.sourceGeneration}`,
    status: 'unknown',
    reason: args.detail,
    causalRank: 0,
    applicableDemand: args.applicableDemand,
    evidence: placementEvidence(input, args.plan),
    action: { kind: 'inspect', summary: args.retry, targetRef: args.plan?.ref ?? `goal:${input.goalId}` },
    measurementFailure: { code: args.code, detail: args.detail, retry: args.retry },
  };
}

type AgentObligationInputShape = Pick<
  AgentObligation,
  | 'title'
  | 'episode'
  | 'status'
  | 'reason'
  | 'causalRank'
  | 'applicableDemand'
  | 'evidence'
  | 'action'
  | 'measurementFailure'
>;

export function planPlacementObligation(input: PlanPlacementProviderInput): AgentObligation {
  const scope = { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId };
  const common = {
    ruleId: 'goal-plan-placement',
    ruleRevision: PLAN_PLACEMENT_OBLIGATION_REVISION,
    family: 'plan-placement' as const,
    scope,
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority(
      'goal-launch-settings+system-health/goal-drain-fleet-watchdog',
      PLAN_PLACEMENT_OBLIGATION_REVISION,
    ),
    priority: 'high' as const,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      id: 'goal-plan-placement-consistent-and-launch-admissible',
      summary:
        'every non-terminal goal worklist plan has a consistent independently led placement and its launch boundary is admissible',
      evidenceKind: 'state' as const,
      sourceRef: 'GoalPortfolioBrief.worklist[].placement+resolveGoalLaunch+classifyGoalPlanFleetCoverage',
    },
    changeSignal: {
      event: goalPlanPlacementChangedKey(input.goalId),
      cancellationRef: `goal:${input.goalId}`,
    },
    boundary: {
      boundary: 'fleet:launch-on-plan',
      refusalCode: 'goal-plan-placement-prerequisite',
      enforcement: 'required' as const,
      // resolveGoalLaunch intentionally fails open on unreadable ceilings while
      // reporting degradation. Admission and operation must preserve that same
      // policy rather than creating a stricter second launch gate here.
      unknown: 'allow-with-warning' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Plan placement evidence is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      causalRank: 0,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'readGoalPlanFleetCohort' },
      measurementFailure: input.read.failure,
    });
  }
  const { portfolio, launch, alert, ageMs } = input.read.value;
  if (!portfolio) {
    return defineAgentObligation({
      ...common,
      title: 'No active goal portfolio currently needs plan placement',
      episode: `no-portfolio:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical portfolio reader found no goal row in scope',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }

  if (portfolio.goal.id !== input.goalId) {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal portfolio scope does not match',
        code: 'goal-portfolio-scope-mismatch',
        detail: `portfolio goal ${portfolio.goal.id} differs from requested goal ${input.goalId}`,
        retry: 're-read the portfolio for the requested goal before planning placement',
        applicableDemand: 0,
      }),
    });
  }
  const goalStatus = portfolio.goal.status;
  if (goalStatus === 'paused' || goalStatus === 'achieved' || goalStatus === 'killed') {
    return defineAgentObligation({
      ...common,
      // Historical relationships remain readable; they cannot arm a wake
      // that asks a stopped goal's holder to resume placement.
      changeSignal: undefined,
      title: `Goal ${input.goalId} is ${goalStatus}`,
      episode: `inactive:${goalStatus}:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical goal lifecycle does not authorize plan placement',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }
  if (goalStatus !== 'active') {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal lifecycle is unresolved',
        code: 'goal-lifecycle-unresolved',
        detail: `canonical goal status is ${goalStatus ?? 'unknown'}`,
        retry: 'resolve the canonical goal lifecycle before planning placement',
        applicableDemand: 0,
      }),
    });
  }

  const applicablePlans = portfolio.worklist.filter((plan) => plan.placement.state !== 'terminal');
  const actionablePlans = applicablePlans.filter((plan) => !plan.placement.reconciliation.consistent);
  // Preserve canonical worklist ordering among feasible next actions. A
  // blocked earlier plan is not a prerequisite for an independent later one.
  // Retain the blocker as the fallback when no placement can advance.
  const selected =
    actionablePlans.find((plan) => plan.placement.state === 'unplaced' || plan.placement.state === 'admitting') ??
    actionablePlans[0];
  const portfolioReadFailure = portfolio.degradedReasons.find((reason) => /portfolio read failed/i.test(reason));
  if (portfolioReadFailure) {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal portfolio placement state is unavailable',
        code: 'goal-portfolio-read-degraded',
        detail: portfolioReadFailure,
        retry: 're-read GoalPortfolioBrief before inferring plan demand or placement',
        applicableDemand: applicablePlans.length,
      }),
    });
  }

  if (applicablePlans.length === 0) {
    return defineAgentObligation({
      ...common,
      title: 'No non-terminal goal plan currently needs placement',
      episode: `none:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical worklist is empty or every worklist plan is terminal',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }

  if (alert) {
    const alertPlan = portfolio.worklist.find((plan) => plan.slug === alert.planSlug);
    if (!alertPlan || alertPlan.placement.reconciliation.consistent || alertPlan.placement.state === 'terminal') {
      const observed = alertPlan
        ? `${alert.planSlug} is ${alertPlan.placement.state}/${alertPlan.placement.reconciliation.action}`
        : `${alert.planSlug} is absent from the canonical goal worklist`;
      return defineAgentObligation({
        ...common,
        ...unknownPlacement(input, {
          title: 'Canonical plan-placement writers disagree',
          code: 'plan-placement-writer-conflict',
          detail: `the live cohort emitted ${alert.reason}, but ${observed}`,
          retry: 'refresh GoalPortfolioBrief and the goal plan-fleet cohort in one evaluation window',
          applicableDemand: applicablePlans.length,
          plan: alertPlan,
        }),
      });
    }
  }

  if (!selected) {
    const covered = applicablePlans.map((plan) =>
      evidence(
        `goal-plan-placement:${plan.ref}:${portfolio.assembledAt}`,
        portfolio.assembledAt,
        input.sourceGeneration,
        placementNote(plan.placement),
        'live independently led fleet, live lane holder, and consistent placement observed',
      ),
    );
    return defineAgentObligation({
      ...common,
      title: 'Goal worklist plans have live independent placement',
      // assembledAt is an observation clock, not a policy generation. Keeping
      // it out of identity prevents an unchanged satisfied placement from
      // becoming a brand-new obligation episode on every turn.
      episode: `covered:${input.sourceGeneration}`,
      status: 'satisfied',
      reason: 'every non-terminal worklist plan is working or independently led with a consistent canonical receipt',
      causalRank: 0,
      applicableDemand: applicablePlans.length,
      evidence: [...placementEvidence(input, applicablePlans[0]), ...covered],
      ...(ageMs == null ? {} : { ageMs }),
    });
  }

  const placement = selected.placement;
  const toolCall = placement.reconciliation.toolCall;
  const needsLaunch = toolCall !== null;
  if (needsLaunch && (!launch || launch.goalId !== input.goalId)) {
    return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Launch feasibility for ${selected.slug} is unavailable`,
        code: 'goal-launch-resolution-missing',
        detail: launch
          ? `resolveGoalLaunch returned goal ${launch.goalId ?? 'none'} for placement goal ${input.goalId}`
          : 'the placement requires a launch but no resolveGoalLaunch receipt was supplied',
        retry: 'run resolveGoalLaunch for the exact fleet/count immediately before placement',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
  }

  if (needsLaunch && launch?.degraded) {
    const detail = launch.degradedReasons.join('; ') || 'resolveGoalLaunch reported degraded evidence';
    return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Launch evidence for ${selected.slug} is degraded`,
        code: 'goal-launch-resolution-degraded',
        detail,
        retry: 'refresh budget provenance, headcount, and resolveGoalLaunch before treating placement as due',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
  }

  if (needsLaunch && launch?.refusal) {
    const refusal = launch.refusal;
    return defineAgentObligation({
      ...common,
      title:
        refusal.reason === 'goal_budget_exceeded'
          ? `Goal budget blocks placement of ${selected.slug}`
          : `Goal headcount ceiling blocks placement of ${selected.slug}`,
      scope: { ...scope, planSlug: selected.slug },
      episode: `refused:${refusal.reason}:${refusal.current}:${refusal.limit}:${refusal.requested}`,
      status: 'blocked',
      reason: refusal.message,
      causalRank: 0,
      applicableDemand: applicablePlans.length,
      evidence: placementEvidence(input, selected),
      action: {
        kind: 'repair',
        summary:
          refusal.reason === 'goal_budget_exceeded'
            ? 'restore verified budget headroom or wind the goal down before launching'
            : 'free verified live-agent headroom or revise the declared ceiling before launching',
        targetRef: `goal:${input.goalId}`,
      },
      ...(ageMs == null ? {} : { ageMs }),
    });
  }

  const baseAction = {
    summary: placement.reconciliation.reason,
    targetRef: selected.ref,
    ...(toolCall ? { tool: toolCall.tool, args: toolCall.args } : {}),
  };
  const isUnplaced = placement.state === 'unplaced';
  const isAdmitting = placement.state === 'admitting';
  return defineAgentObligation({
    ...common,
    title: isUnplaced
      ? `Place goal plan ${selected.slug}`
      : isAdmitting
        ? `Finish verified placement of ${selected.slug}`
        : `Repair goal plan placement for ${selected.slug}`,
    scope: { ...scope, planSlug: selected.slug },
    episode: `${placement.reconciliation.action}:${selected.slug}:${placement.launchTransaction?.transactionId ?? input.sourceGeneration}`,
    status: isUnplaced ? 'due' : isAdmitting ? 'in-progress' : 'blocked',
    reason: placement.reconciliation.reason,
    causalRank: isUnplaced ? 1 : 0,
    applicableDemand: applicablePlans.length,
    evidence: placementEvidence(input, selected),
    action: isUnplaced
      ? {
          ...baseAction,
          kind: 'delegate',
          summary: `launch the independently led fleet for ${selected.slug} with the canonical transaction arguments`,
        }
      : isAdmitting
        ? { ...baseAction, kind: 'continue', continuesCurrentWork: true }
        : {
            ...baseAction,
            kind: 'repair',
          },
    ...(ageMs == null ? {} : { ageMs }),
  });
}

export interface OwnerReportProviderInput extends ProviderBase {
  goalId: string;
  read: ProviderRead<GoalOwnerReportObligation | null>;
}

export function ownerReportObligation(input: OwnerReportProviderInput): AgentObligation {
  const common = {
    ruleId: 'goal-owner-report',
    ruleRevision: OWNER_REPORT_OBLIGATION_REVISION,
    family: 'owner-report' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId },
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority('system-health/goal-owner-report-watchdog', OWNER_REPORT_OBLIGATION_REVISION),
    priority: 'high' as const,
    causalRank: 1,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      id: 'canonical-owner-report-delivery',
      summary: 'a complete report is delivered on one of the canonical owner-facing rails',
      evidenceKind: 'delivery' as const,
      sourceRef: 'makeReadGoalModeOwners:three-source-report-union',
    },
    boundary: {
      boundary: 'goal-owner-report',
      refusalCode: 'goal-owner-report-incomplete',
      enforcement: 'required' as const,
      unknown: 'allow-with-warning' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Owner-report state is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'readGoalOwnerReportObligation' },
      measurementFailure: input.read.failure,
    });
  }
  const report = input.read.value;
  if (!report) {
    return defineAgentObligation({
      ...common,
      title: 'No active goal reporting contract applies',
      episode: `none:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical reader found no active goal-mode holder row',
      applicableDemand: 0,
      evidence: [evidence(`goal:${input.goalId}`, input.observedAt, input.sourceGeneration, 'no applicable owner row')],
    });
  }
  const reportRef = `goal-owner-report:${input.goalId}:${report.lastReportAt ?? 'baseline'}`;
  // The watchdog owns the exact reference+floor boundary. Reconstructing it
  // from rounded display minutes made an unchanged episode's deadline drift by
  // up to a minute on every read, continually replacing its durable await.
  const dueAt = report.dueAt;
  if (report.obligation === 'not-due') {
    if (!report.lastReportAt) {
      return defineAgentObligation({
        ...common,
        title: 'Owner report is not due yet',
        episode: `grace:${dueAt}`,
        status: 'not-applicable',
        reason: report.instruction,
        applicableDemand: 0,
        evidence: [evidence(reportRef, input.observedAt, input.sourceGeneration, 'inside initial reporting window')],
        changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
      });
    }
    return defineAgentObligation({
      ...common,
      title: 'Owner reporting cadence is current',
      episode: `reported:${report.lastReportAt}`,
      status: 'satisfied',
      reason: report.instruction,
      applicableDemand: 0,
      evidence: [
        evidence(
          reportRef,
          report.lastReportAt,
          input.sourceGeneration,
          'canonical owner-facing delivery',
          'owner report delivered inside the applicable cadence',
        ),
      ],
      lastSatisfiedAt: report.lastReportAt,
      changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
    });
  }
  return defineAgentObligation({
    ...common,
    title: report.obligation === 'overdue' ? 'Owner report is overdue' : 'Owner report is due now',
    episode: `due:${report.lastReportAt ?? 'baseline'}:${report.floorMin}`,
    status: 'due',
    reason: report.instruction,
    applicableDemand: 1,
    evidence: [evidence(reportRef, input.observedAt, input.sourceGeneration, report.obligation)],
    action: {
      kind: 'report',
      summary: 'send MOVED / COST / OWNER-WALLED / KILLED on a canonical owner-facing rail now',
      tool: 'coord:send',
      args: { to: ['human'] },
    },
    dueAt,
    ageMs: Math.max(0, report.ageMin * 60_000),
    changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
  });
}

const GRADER_GAP_CODES = new Set<PlanAcceptanceGateCode>(['acceptance_ungraded', 'self_graded_only']);
const AUTHOR_REPAIR_CODES = new Set<PlanAcceptanceGateCode>([
  'acceptance_rubric_missing',
  'acceptance_rubric_ambiguous',
  'acceptance_rubric_unvetted',
  'acceptance_rubric_revision_unreadable',
  'acceptance_rubric_vetted_after_grading',
  'acceptance_not_recorded',
  'acceptance_rejected',
  'acceptance_unaudited',
  'audit_coverage_stale',
  'audit_citations_unresolved',
  'requirement_unrealized',
  'ephemeral_deliverable_unbacked',
  'spec_proof_stale',
  'spec_clause_unproven',
]);

export interface IndependentVerificationProviderInput extends ProviderBase {
  planSlug: string;
  read: ProviderRead<{
    gate: PlanAcceptanceGateVerdict;
    evidenceRef: string;
    reviewAgeMs?: number;
    /** False before implementation/audit/rubric makes independent review applicable. */
    gradeable: boolean;
  } | null>;
}

export function independentVerificationObligation(input: IndependentVerificationProviderInput): AgentObligation {
  const common = {
    ruleId: 'plan-independent-verification',
    ruleRevision: INDEPENDENT_VERIFICATION_OBLIGATION_REVISION,
    family: 'independent-verification' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, planSlug: input.planSlug },
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority('plan-acceptance-gate', INDEPENDENT_VERIFICATION_OBLIGATION_REVISION),
    priority: 'high' as const,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      id: 'admissible-independent-acceptance',
      summary: 'the current plan/rubric revision has an admissible independent grade and author verdict',
      evidenceKind: 'verdict' as const,
      sourceRef: 'evaluatePlanAcceptanceGate',
    },
    changeSignal: {
      event: planAcceptanceChangedKey(input.planSlug),
      cancellationRef: `plan:${input.planSlug}`,
    },
    boundary: {
      boundary: 'plans:ship',
      refusalCode: 'plan-independent-verification-required',
      enforcement: 'required' as const,
      unknown: 'refuse' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Independent-verification state is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      causalRank: 2,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'evaluatePlanAcceptanceGate' },
      measurementFailure: input.read.failure,
    });
  }
  const observed = input.read.value;
  if (!observed || !observed.gradeable) {
    return defineAgentObligation({
      ...common,
      title: `Plan ${input.planSlug} is not ready for independent verification`,
      episode: `not-gradeable:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'implementation, completion audit, or acceptance rubric prerequisites are not complete',
      causalRank: 2,
      applicableDemand: 0,
      evidence: [evidence(`plan:${input.planSlug}`, input.observedAt, input.sourceGeneration, 'not gradeable')],
    });
  }
  const { gate, evidenceRef, reviewAgeMs } = observed;
  if (gate.satisfied) {
    return defineAgentObligation({
      ...common,
      title: `Plan ${input.planSlug} has independent acceptance`,
      episode: `accepted:${gate.rubricId ?? 'no-rubric'}:${input.sourceGeneration}`,
      status: 'satisfied',
      reason: 'the canonical ship gate is satisfied',
      causalRank: 2,
      applicableDemand: 1,
      evidence: [
        evidence(
          evidenceRef,
          input.observedAt,
          input.sourceGeneration,
          gate.gradedBy ? `graded by ${gate.gradedBy}` : 'accepted by canonical gate',
          'current admissible independent acceptance verdict observed',
        ),
      ],
      ...(reviewAgeMs == null ? {} : { ageMs: reviewAgeMs }),
    });
  }
  const code = gate.code;
  const graderGap = Boolean(code && GRADER_GAP_CODES.has(code));
  const authorRepair = Boolean(code && AUTHOR_REPAIR_CODES.has(code));
  return defineAgentObligation({
    ...common,
    title: graderGap
      ? `Plan ${input.planSlug} needs an independent grader`
      : `Plan ${input.planSlug} cannot yet be independently certified`,
    // A plan can cycle back to the same refusal code/rubric after a revision.
    // Include the canonical source generation so a fired old episode never
    // suppresses the new revision's material-change watch.
    episode: `${code ?? 'gate-unknown'}:${gate.rubricId ?? 'no-rubric'}:${input.sourceGeneration}`,
    status: graderGap ? 'due' : 'blocked',
    reason: gate.message ?? `plan acceptance gate refused with ${code ?? 'an unknown code'}`,
    // Author-owned audit/rubric/spec repair is a prerequisite to asking an
    // independent grader to act. Keep it in the upstream tier so a downstream
    // due symptom cannot outrank the work that makes grading possible.
    causalRank: authorRepair ? 0 : 2,
    applicableDemand: 1,
    evidence: [evidence(evidenceRef, input.observedAt, input.sourceGeneration, code ?? 'gate-refused')],
    action: graderGap
      ? {
          kind: 'delegate',
          summary: `route ${input.planSlug} to a lineage-independent acceptance grader`,
          targetRef: input.planSlug,
        }
      : {
          kind: 'repair',
          summary: `repair ${code ?? 'the unreadable acceptance prerequisite'} before requesting a grader`,
          targetRef: input.planSlug,
          continuesCurrentWork: code === 'plan_items_unfinished',
        },
    ...(reviewAgeMs == null ? {} : { ageMs: reviewAgeMs }),
  });
}

export function buildAgentObligationAgenda(
  inputs: {
    planPlacement?: PlanPlacementProviderInput;
    ownerReport?: OwnerReportProviderInput;
    independentVerification?: IndependentVerificationProviderInput[];
  },
  evaluatedAt: string,
): AgentObligationAgenda {
  const obligations = [
    ...(inputs.planPlacement ? [planPlacementObligation(inputs.planPlacement)] : []),
    ...(inputs.ownerReport ? [ownerReportObligation(inputs.ownerReport)] : []),
    ...(inputs.independentVerification ?? []).map(independentVerificationObligation),
  ];
  return evaluateAgentObligations(obligations, evaluatedAt);
}
