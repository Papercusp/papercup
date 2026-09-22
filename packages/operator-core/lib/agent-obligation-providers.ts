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
import { orientationRowExcerpt } from './owner-directives';
import type { GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief } from './goal-launch-settings';
import type { GoalPlanFleetAlert } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import type { PlanAcceptanceGateCode, PlanAcceptanceGateVerdict } from './plan-acceptance-gate';

export const PLAN_PLACEMENT_OBLIGATION_REVISION = 'goal-plan-placement-v3';
export const OWNER_REPORT_OBLIGATION_REVISION = 'goal-owner-report-v1';
export const INDEPENDENT_VERIFICATION_OBLIGATION_REVISION = 'plan-independent-verification-v1';
export const OWNER_DIRECTIVE_OBLIGATION_REVISION = 'owner-directive-disposition-v1';

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

/**
 * Who owns the repair for each acceptance-gate refusal code.
 *
 * generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 D-009: this was
 * TWO hand-maintained `Set<PlanAcceptanceGateCode>`s (GRADER_GAP_CODES /
 * AUTHOR_REPAIR_CODES). A code in NEITHER silently fell through to
 * `causalRank: 2` — the DOWNSTREAM-symptom tier — while usually being upstream
 * author work, so it was ranked below the very repairs that unblock it and read
 * as nobody's work. Seven of the union's 23 codes had drifted into that hole,
 * including `acceptance_bar_contract_not_ready`, the single most common real
 * acceptance stall in this repo.
 *
 * An exhaustive `Record` is the fix rather than a test: TypeScript now REFUSES TO
 * COMPILE when a code is added to `PlanAcceptanceGateCode` and left unclassified,
 * so the hole cannot reopen silently (derived-truth ladder rung 1 — derive, don't
 * hand-maintain). Adding a code here is a deliberate ownership decision, which is
 * exactly the moment it should be made.
 *
 * - `grader`    — waiting on an INDEPENDENT GRADER. Yields `status:'due'` plus a
 *                 `delegate` action, i.e. it may recruit/wake a peer.
 * - `author`    — waiting on the plan's OWN author. Upstream (`causalRank: 0`), so
 *                 it outranks any downstream symptom. NEVER recruits a peer.
 * - `unmeasured`— the gate could not MEASURE the plan (a read/lineage failure). Not
 *                 a repair anyone owns; it needs a retry or a fixed instrument, and
 *                 must not be dressed up as either party's work.
 * - `not-here`  — deliberately handled EARLIER in this provider and never reaching
 *                 classification (see `gradeable` for `plan_items_unfinished`).
 *
 * ⛔ Do NOT reclassify a contract code (`acceptance_bar_*`) as `grader` to make a
 * stall look actionable. `acceptance-bar-lifecycle-evaluator.ts` deliberately keeps
 * recruitment to {acceptance_ungraded, self_graded_only} so a malformed rubric
 * cannot spawn agents, and it RENDERS that promise to the user in the refusal text
 * ("These repairs are the plan author's alone — do not recruit or wake a peer for
 * them."). Widening it here would make that rendered sentence a lie.
 */
const GATE_CODE_OWNERSHIP: Record<
  PlanAcceptanceGateCode,
  'grader' | 'author' | 'unmeasured' | 'not-here'
> = {
  // --- waiting on an independent grader -------------------------------------
  acceptance_ungraded: 'grader',
  self_graded_only: 'grader',

  // --- waiting on the plan's own author -------------------------------------
  acceptance_rubric_missing: 'author',
  acceptance_rubric_ambiguous: 'author',
  acceptance_rubric_unvetted: 'author',
  acceptance_rubric_revision_unreadable: 'author',
  acceptance_rubric_vetted_after_grading: 'author',
  acceptance_not_recorded: 'author',
  acceptance_rejected: 'author',
  acceptance_unaudited: 'author',
  audit_coverage_stale: 'author',
  audit_citations_unresolved: 'author',
  requirement_unrealized: 'author',
  ephemeral_deliverable_unbacked: 'author',
  spec_proof_stale: 'author',
  spec_clause_unproven: 'author',
  // D-009: these four were UNCLASSIFIED and are author work. The bar-contract pair
  // in particular is the repo's most frequent acceptance stall, so leaving it at
  // the downstream rank actively mis-ordered the agenda against the fix.
  acceptance_bar_contract_not_ready: 'author',
  acceptance_bar_not_met: 'author',
  design_evidence_unsatisfied: 'author',

  // --- the gate could not measure the plan ----------------------------------
  // A failed measurement is not a repair. Ranking these as author work would send
  // someone to "fix" a plan whose state was never actually read.
  acceptance_lineage_unreadable: 'unmeasured',
  design_evidence_unavailable: 'unmeasured',
  spec_coverage_unavailable: 'unmeasured',

  // --- never reaches classification -----------------------------------------
  // `gradeable` short-circuits this to a 'not-applicable' obligation well above.
  plan_items_unfinished: 'not-here',
};

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
  const ownership = code ? GATE_CODE_OWNERSHIP[code] : undefined;
  /**
   * D-009 ruling 3 — the TWO independent questions one `graderGap` boolean used to
   * conflate. They are not the same question, and collapsing them forced a false
   * choice: either an author-owned stall renders `[BLOCKED]` (telling the one agent
   * who CAN act that it cannot), or contract codes get reclassified as grader gaps
   * and a malformed rubric starts spawning graders. Split, both stay true.
   *
   * - `isDelegable`  — may this recruit/wake a LINEAGE-INDEPENDENT PEER? `grader` only.
   *                    This is the safety-bearing half; widening it is what
   *                    `acceptance-bar-lifecycle-evaluator.ts` promises never happens.
   * - `isActionable` — can SOMEONE act on this right now? Strictly wider: author
   *                    repair qualifies, because the plan's own author can start it
   *                    this second. This is the visibility half, and it recruits
   *                    nobody.
   *
   * `unmeasured` satisfies NEITHER: a failed measurement is not work, so it stays
   * `blocked` and takes an `inspect` action rather than being dressed up as a repair
   * the author owes (the pre-split code told them to "repair" a gate read that never
   * happened).
   */
  const isDelegable = ownership === 'grader';
  const authorRepair = ownership === 'author';
  const isActionable = isDelegable || authorRepair;
  return defineAgentObligation({
    ...common,
    title: isDelegable
      ? `Plan ${input.planSlug} needs an independent grader`
      : authorRepair
        ? `Plan ${input.planSlug} needs author repair before independent certification`
        : `Plan ${input.planSlug} cannot yet be independently certified`,
    // A plan can cycle back to the same refusal code/rubric after a revision.
    // Include the canonical source generation so a fired old episode never
    // suppresses the new revision's material-change watch.
    episode: `${code ?? 'gate-unknown'}:${gate.rubricId ?? 'no-rubric'}:${input.sourceGeneration}`,
    status: isActionable ? 'due' : 'blocked',
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

/**
 * One undispositioned owner directive, reduced to what a class-B row needs.
 *
 * Deliberately NOT `OwnerDirectiveRow`: the obligation contract must not take a
 * dependency on the directive store's full column set, and a caller (or a test)
 * must be able to feed this provider without a database. `excerpt` is the
 * caller's already-budgeted VERBATIM text — `ownerDirectiveExcerpt` produces it,
 * and this provider never re-truncates or paraphrases it.
 */
export interface OwnerDirectiveObligationRow {
  id: number;
  /**
   * `pending` — hook-captured, awaiting promote/dismiss.
   * `open` — a promoted/recorded standing directive awaiting disposition.
   * Terminal states (`dismissed`/`done`/`declined`) are not obligations and
   * must be filtered out by the reader, never represented here.
   */
  state: 'pending' | 'open';
  /** VERBATIM owner text, budgeted by the caller. Never a paraphrase. */
  excerpt: string;
  /** The row's own created_at — a stable row fact, never an observation clock. */
  recordedAt: string;
  recordedBy: string;
  /**
   * True when the UserPromptSubmit provenance hook captured the turn, which is
   * the only mechanism here that CLASSIFIES a turn as OWNER (interactive).
   * False means an agent asserted the owner said it via `orders:record` — real
   * evidence, but not proof, so it is represented as `owner-candidate`.
   * Conflating the two is exactly how a note-to-self becomes an owner directive.
   */
  capturedByHook: boolean;
}

export interface OwnerDirectivesProviderInput extends ProviderBase {
  read: ProviderRead<OwnerDirectiveObligationRow[]>;
}

/** The disposition verb each state is cleared by. One row per state, no default. */
const OWNER_DIRECTIVE_DISPOSITION: Record<
  OwnerDirectiveObligationRow['state'],
  { title: string; summary: string; tool: string; clearsWhen: string }
> = {
  pending: {
    title: 'Pending owner turn awaits promote-or-dismiss',
    // `summary` is spent once PER ROW in a 3-row/400-char sink, so it carries the
    // disposition VERB and nothing else; the prose that used to live here was
    // identical on every row and cost a whole third row (measured: 133-char rows,
    // 2 of 3 delivered, the third dropped on the character cap).
    summary: 'promote or dismiss: orders:resolve-pending',
    tool: 'orders:resolve-pending',
    clearsWhen: 'the row leaves `pending` via promotion or a reasoned dismissal',
  },
  open: {
    title: 'Open owner directive awaits disposition',
    summary: 'carry out, then close: orders:disposition',
    tool: 'orders:disposition',
    clearsWhen: 'the row is dispositioned done or declined',
  },
};

function ownerDirectiveCommon(input: OwnerDirectivesProviderInput) {
  return {
    ruleId: 'owner-directive-disposition',
    ruleRevision: OWNER_DIRECTIVE_OBLIGATION_REVISION,
    family: 'owner-directive' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId },
    responsibleOwnerId: input.ownerId,
    // An owner directive is the highest-precedence standing obligation an agent
    // carries: it OUTRANKS the loop agenda, so it sorts ahead of every
    // policy-sourced duty rather than competing with them on priority alone.
    causalRank: 0,
    sourceGeneration: input.sourceGeneration,
  };
}

/**
 * Owner directives → class-B obligation rows (P-006 of plan
 * `turn-start-memory-two-class-2026-09-21`).
 *
 * ONE OBLIGATION PER DIRECTIVE, because each carries its own id, its own
 * verbatim excerpt, its own disposition verb and its own recovery pointer — the
 * uniform class-B row shape. A single aggregate obligation would collapse them
 * into a count, which is the shape an agent can acknowledge without acting on
 * any individual directive.
 *
 * The rows stay `due` until dispositioned, which is what makes them re-inject
 * every turn under the P-002 discharge contract instead of clearing on delivery.
 */
export function ownerDirectiveObligations(input: OwnerDirectivesProviderInput): AgentObligation[] {
  const common = ownerDirectiveCommon(input);
  if (input.read.status === 'unknown') {
    return [
      defineAgentObligation({
        ...common,
        title: 'Owner-directive state is unavailable',
        episode: `unknown:${input.sourceGeneration}`,
        status: 'unknown',
        priority: 'high',
        authority: policyAuthority('owner-directives:listOwnerDirectives', OWNER_DIRECTIVE_OBLIGATION_REVISION),
        reason: input.read.failure.detail,
        applicableDemand: 0,
        evidence: [],
        action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'orders:list { state: "pending" }' },
        clearsWhen: {
          id: 'owner-directive-queue-readable',
          summary: 'the pending/open directive queue is readable again',
          evidenceKind: 'state',
          sourceRef: 'harness_shared.owner_directives',
        },
        measurementFailure: input.read.failure,
      }),
    ];
  }
  const rows = input.read.value;
  if (rows.length === 0) {
    return [
      defineAgentObligation({
        ...common,
        title: 'No undispositioned owner directive applies',
        episode: `none:${input.sourceGeneration}`,
        status: 'not-applicable',
        priority: 'normal',
        authority: policyAuthority('owner-directives:listOwnerDirectives', OWNER_DIRECTIVE_OBLIGATION_REVISION),
        reason: 'the canonical directive queue holds no pending or open row for this workspace',
        applicableDemand: 0,
        evidence: [
          evidence(
            `owner-directives:${input.workspaceId}`,
            input.observedAt,
            input.sourceGeneration,
            'empty pending/open queue',
          ),
        ],
        clearsWhen: {
          id: 'owner-directive-queue-empty',
          summary: 'no pending or open directive exists',
          evidenceKind: 'state',
          sourceRef: 'harness_shared.owner_directives',
        },
      }),
    ];
  }
  const observedMs = Date.parse(input.observedAt);
  return rows.map((row) => {
    const disposition = OWNER_DIRECTIVE_DISPOSITION[row.state];
    const excerpt = orientationRowExcerpt(row.excerpt);
    // The pointer is load-bearing ONLY when text was actually budgeted away: a
    // directive rendered WHOLE has nothing to recover, so spending 22 of a
    // 400-char sink's chars on it would cost a whole other directive its row.
    // Same rule renderOwnerDirectiveRow already applies in the block renderer.
    // `endsWith('…')` catches an excerpt ALREADY truncated upstream by
    // ownerDirectiveExcerpt, where the row's own cut was a no-op.
    const truncated = excerpt !== row.excerpt.trim() || excerpt.endsWith('…');
    const fullTextRef = `orders:get #${row.id}`;
    const recordedMs = Date.parse(row.recordedAt);
    const ageMs =
      Number.isFinite(observedMs) && Number.isFinite(recordedMs) ? Math.max(0, observedMs - recordedMs) : undefined;
    return defineAgentObligation({
      ...common,
      // The UNIFORM ROW (P-002): { id, short verbatim, disposition verb,
      // recovery pointer }. id + verbatim go in the TITLE because the title is
      // the only field that renders at BOTH detail levels — `reason` is dropped
      // at the narrow `action` detail, which is precisely the turn-start sink
      // where telling two pending directives apart matters most.
      title: `Owner directive #${row.id}: "${excerpt}"`,
      // The row id alone is the episode: the SAME undispositioned directive must
      // produce the SAME obligation id on every turn, or a warm-turn dedup would
      // read a re-render as a brand-new obligation and the row would churn.
      episode: `${row.state}:${row.id}`,
      status: 'due',
      priority: 'critical',
      authority: row.capturedByHook
        ? { kind: 'owner', sourceRef: `owner-directive:${row.id}`, turnOrigin: 'owner-typed' }
        : { kind: 'owner-candidate', sourceRef: `owner-directive:${row.id}`, turnOrigin: 'unknown' },
      reason: `owner directive #${row.id}: "${row.excerpt}"`,
      applicableDemand: 1,
      evidence: [
        evidence(
          `owner-directive:${row.id}`,
          row.recordedAt,
          input.sourceGeneration,
          `recorded by ${row.recordedBy}${row.capturedByHook ? ' via the provenance hook' : ' via orders:record'}`,
        ),
      ],
      action: {
        kind: 'repair',
        summary: disposition.summary,
        tool: disposition.tool,
        args: { id: row.id },
        // The RECOVERY POINTER: the excerpt above is budgeted, so the full
        // verbatim owner turn must stay one addressable call away. Both fields
        // come from ONE expression so they cannot drift — `targetRef` is the
        // unconditional structured pointer for programmatic consumers, while
        // `recoveryRef` is RENDERED and so is spent only when text was
        // actually cut.
        targetRef: fullTextRef,
        ...(truncated ? { recoveryRef: fullTextRef } : {}),
      },
      clearsWhen: {
        id: `owner-directive-dispositioned:${row.id}`,
        summary: disposition.clearsWhen,
        evidenceKind: 'state',
        sourceRef: `owner-directive:${row.id}`,
      },
      ...(ageMs == null ? {} : { ageMs }),
    });
  });
}

export function buildAgentObligationAgenda(
  inputs: {
    planPlacement?: PlanPlacementProviderInput;
    ownerReport?: OwnerReportProviderInput;
    independentVerification?: IndependentVerificationProviderInput[];
    ownerDirectives?: OwnerDirectivesProviderInput;
  },
  evaluatedAt: string,
): AgentObligationAgenda {
  const obligations = [
    ...(inputs.planPlacement ? [planPlacementObligation(inputs.planPlacement)] : []),
    ...(inputs.ownerReport ? [ownerReportObligation(inputs.ownerReport)] : []),
    ...(inputs.independentVerification ?? []).map(independentVerificationObligation),
    ...(inputs.ownerDirectives ? ownerDirectiveObligations(inputs.ownerDirectives) : []),
  ];
  return evaluateAgentObligations(obligations, evaluatedAt);
}
