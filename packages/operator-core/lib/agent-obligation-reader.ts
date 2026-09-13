/**
 * One bounded, read-only assembly path for the obligation agenda consumed by
 * turn-start orientation and fleet:leader-brief.
 *
 * Canonical policy writers stay canonical: this module only schedules their
 * reads, turns failures into explicit ProviderRead unknowns, and evaluates the
 * shared contract. It owns no queue, reminder, liveness or acceptance state.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  agentObligationSourceGeneration,
  projectAgentObligationAgenda,
  type AgentObligationAgenda,
  type AgentObligationProjection,
} from './agent-obligations';
import {
  buildAgentObligationAgenda,
  type IndependentVerificationProviderInput,
  type OwnerReportProviderInput,
  type PlanPlacementProviderInput,
} from './agent-obligation-providers';
import type { GoalLaunchResolution, GoalPortfolioBrief } from './goal-launch-settings';
import type { PlanAcceptanceGateVerdict } from './plan-acceptance-gate';
import type { GoalPlanFleetObservation } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';

export const AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS = 900;

export interface AgentObligationReaderDeps {
  goalSubject: (workspaceId: string, ownerId: string) => Promise<string | null>;
  planSlugs: (workspaceId: string, ownerId: string) => Promise<string[]>;
  goalPortfolio: (workspaceId: string, goalId: string) => Promise<GoalPortfolioBrief | null>;
  goalLaunch: (input: {
    workspaceId: string;
    ownerId: string;
    fleetSlug: string | null;
    count: number;
  }) => Promise<GoalLaunchResolution>;
  planFleet: (workspaceId: string, goalId: string) => Promise<GoalPlanFleetObservation>;
  ownerReport: (
    workspaceId: string,
    ownerId: string,
    goalId: string,
    nowMs: number,
  ) => Promise<GoalOwnerReportObligation | null>;
  planAcceptance: (planSlug: string) => Promise<PlanAcceptanceGateVerdict>;
}

interface ReadOutcome<T> {
  value: T;
  degraded: boolean;
  reason?: string;
  elapsedMs: number;
}

async function boundedRead<T>(
  label: string,
  work: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<ReadOutcome<T>> {
  const result = await withBoundedTimeout(work, {
    fallback,
    timeoutMs,
    label: `agent-obligations:${label}`,
  });
  return {
    value: result.value,
    degraded: result.degraded,
    ...(result.degraded ? { reason: result.errorMessage ?? result.reason ?? 'unavailable' } : {}),
    elapsedMs: result.elapsedMs,
  };
}

function stablePortfolio(portfolio: GoalPortfolioBrief | null): unknown {
  if (!portfolio) return null;
  const { assembledAt: _observationClock, ...stable } = portfolio;
  return stable;
}

function stableLaunch(launch: GoalLaunchResolution | null): unknown {
  if (!launch) return null;
  return {
    goalId: launch.goalId,
    settings: launch.settings,
    effective: launch.effective,
    ceilings: launch.ceilings,
    headcount: launch.headcount,
    budget: launch.budget,
    refusal: launch.refusal,
    degraded: launch.degraded,
    degradedReasons: launch.degradedReasons,
  };
}

function readFailure(label: string, outcome: ReadOutcome<unknown>): string {
  return `${label} ${outcome.reason ?? 'was unavailable'} after ${outcome.elapsedMs}ms`;
}

export interface AgentObligationAgendaRead {
  agenda: AgentObligationAgenda;
  goalId: string | null;
  planSlugs: string[];
  /** The canonical portfolio read that fed the plan-placement provider.
   *  Exposed so another read-side consumer can present the SAME snapshot
   *  without issuing a second portfolio query or rebuilding it client-side. */
  portfolio: GoalPortfolioBrief | null;
  observedAt: string;
  elapsedMs: number;
  degradedSources: string[];
}

/**
 * Read the active definition once, then run every applicable policy source in
 * one concurrent wave. Observation clocks never enter source generations, so
 * an unchanged agenda stays deduplicable across warm turns and reappears on a
 * cold context epoch through the consumer's existing cursor boundary.
 */
export async function readAgentObligationAgenda(input: {
  workspaceId: string;
  ownerId: string;
  goalId?: string | null;
  planSlugs?: string[];
  fleetSlug?: string | null;
  launchCount?: number;
  sourceTimeoutMs?: number;
  now?: Date;
  deps?: Partial<AgentObligationReaderDeps>;
}): Promise<AgentObligationAgendaRead> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const sourceTimeoutMs = Math.max(
    1,
    Math.min(
      AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS,
      input.sourceTimeoutMs ?? AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS,
    ),
  );
  const deps = { ...defaultAgentObligationReaderDeps(), ...(input.deps ?? {}) };
  const [goalOutcome, plansOutcome] = await Promise.all([
    input.goalId !== undefined
      ? Promise.resolve<ReadOutcome<string | null>>({ value: input.goalId, degraded: false, elapsedMs: 0 })
      : boundedRead('goal-subject', deps.goalSubject(input.workspaceId, input.ownerId), null, sourceTimeoutMs),
    input.planSlugs !== undefined
      ? Promise.resolve<ReadOutcome<string[]>>({ value: input.planSlugs, degraded: false, elapsedMs: 0 })
      : boundedRead('plan-context', deps.planSlugs(input.workspaceId, input.ownerId), [], sourceTimeoutMs),
  ]);
  const goalId = goalOutcome.value;
  const planSlugs = [...new Set(plansOutcome.value.map((slug) => slug.trim()).filter(Boolean))].slice(0, 8);
  const degradedSources = [
    ...(goalOutcome.degraded ? [readFailure('goal subject', goalOutcome)] : []),
    ...(plansOutcome.degraded ? [readFailure('plan context', plansOutcome)] : []),
  ];

  const portfolioPromise = goalId
    ? boundedRead('goal-portfolio', deps.goalPortfolio(input.workspaceId, goalId), null, sourceTimeoutMs)
    : Promise.resolve<ReadOutcome<GoalPortfolioBrief | null>>({ value: null, degraded: false, elapsedMs: 0 });
  const launchPromise = goalId
    ? boundedRead(
        'goal-launch',
        deps.goalLaunch({
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          fleetSlug: input.fleetSlug ?? null,
          count: Math.max(1, Math.floor(input.launchCount ?? 1)),
        }),
        null as GoalLaunchResolution | null,
        sourceTimeoutMs,
      )
    : Promise.resolve<ReadOutcome<GoalLaunchResolution | null>>({ value: null, degraded: false, elapsedMs: 0 });
  const fleetPromise = goalId
    ? boundedRead(
        'plan-fleet',
        deps.planFleet(input.workspaceId, goalId),
        {
          status: 'unknown',
          alert: null,
          applicablePlanCount: null,
        } as GoalPlanFleetObservation,
        sourceTimeoutMs,
      )
    : Promise.resolve<ReadOutcome<GoalPlanFleetObservation>>({
        value: { status: 'known', alert: null, applicablePlanCount: 0 },
        degraded: false,
        elapsedMs: 0,
      });
  const reportPromise = goalId
    ? boundedRead(
        'owner-report',
        deps.ownerReport(input.workspaceId, input.ownerId, goalId, now.getTime()),
        null,
        sourceTimeoutMs,
      )
    : Promise.resolve<ReadOutcome<GoalOwnerReportObligation | null>>({ value: null, degraded: false, elapsedMs: 0 });
  const acceptancePromises = planSlugs.map((planSlug) =>
    boundedRead(
      'plan-acceptance:' + planSlug,
      deps.planAcceptance(planSlug),
      null as PlanAcceptanceGateVerdict | null,
      sourceTimeoutMs,
    ),
  );
  const [portfolio, launch, fleet, report, acceptances] = await Promise.all([
    portfolioPromise,
    launchPromise,
    fleetPromise,
    reportPromise,
    Promise.all(acceptancePromises),
  ]);

  for (const [label, outcome] of [
    ['goal portfolio', portfolio],
    ['goal launch', launch],
    ['plan fleet', fleet],
    ['owner report', report],
  ] as const) {
    if (goalId && outcome.degraded) degradedSources.push(readFailure(label, outcome));
  }

  let planPlacement: PlanPlacementProviderInput | undefined;
  let ownerReport: OwnerReportProviderInput | undefined;
  const scopeReadFailure = goalOutcome.degraded || plansOutcome.degraded;
  if (scopeReadFailure && !goalId) {
    const scopeGeneration = agentObligationSourceGeneration({
      ownerId: input.ownerId,
      goalSubject: goalOutcome.degraded ? 'unknown' : goalId,
      planContext: plansOutcome.degraded ? 'unknown' : planSlugs,
    });
    const detail =
      degradedSources.filter((entry) => /goal subject|plan context/.test(entry)).join('; ') ||
      'the canonical goal/plan scope was unavailable';
    planPlacement = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId: `unresolved-owner-scope:${input.ownerId}`,
      observedAt,
      sourceGeneration: scopeGeneration,
      read: {
        status: 'unknown',
        failure: {
          code: 'canonical-obligation-scope-read-failed',
          detail,
          retry: 'retry canonical goal-subject and plan-context discovery for this owner',
        },
      },
    };
  }
  if (goalId) {
    const placementGeneration = agentObligationSourceGeneration({
      portfolio: stablePortfolio(portfolio.value),
      launch: stableLaunch(launch.value),
      fleet: fleet.value,
    });
    const placementFailure =
      scopeReadFailure || portfolio.degraded || launch.degraded || fleet.degraded || fleet.value.status === 'unknown';
    planPlacement = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId,
      observedAt,
      sourceGeneration: placementGeneration,
      read: placementFailure
        ? {
            status: 'unknown',
            failure: {
              code: 'canonical-plan-placement-read-failed',
              detail:
                degradedSources.filter((entry) => /goal subject|plan context|goal portfolio|goal launch|plan fleet/.test(entry)).join('; ') ||
                'the canonical plan-fleet observation was unreadable',
              retry: 'refresh the portfolio, plan-fleet cohort, and exact launch resolution together',
            },
          }
        : {
            status: 'known',
            value: {
              portfolio: portfolio.value,
              launch: launch.value,
              alert: fleet.value.alert,
              evidenceRef: `goal-plan-fleet-cohort:${goalId}:${placementGeneration}`,
            },
          },
    };

    // A report read and a goal read may straddle a stop transition. The
    // canonical lifecycle governs whether a recurring reporting duty applies;
    // an older due receipt must not reactivate that duty after the stop.
    const scopedGoal =
      !goalOutcome.degraded && !portfolio.degraded && portfolio.value?.goal.id === goalId
        ? portfolio.value.goal
        : null;
    const inactiveGoal =
      scopedGoal?.status === 'paused' || scopedGoal?.status === 'achieved' || scopedGoal?.status === 'killed';
    const lifecycleUnknown = !scopedGoal || (!inactiveGoal && scopedGoal.status !== 'active');
    const lifecycleFailure = 'canonical goal identity or lifecycle is unavailable for owner reporting';
    if (lifecycleUnknown) degradedSources.push(lifecycleFailure);
    const reportGeneration = agentObligationSourceGeneration({
      goalStatus: scopedGoal?.status ?? 'unknown',
      report: report.value
        ? {
            lastReportAt: report.value.lastReportAt,
            floorMin: report.value.floorMin,
            standing: report.value.standing,
            obligation: report.value.obligation,
          }
        : null,
    });
    ownerReport = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId,
      observedAt,
      sourceGeneration: reportGeneration,
      read: inactiveGoal
        ? { status: 'known', value: null }
        : lifecycleUnknown
          ? {
              status: 'unknown',
              failure: {
                code: 'canonical-owner-report-lifecycle-unresolved',
                detail: lifecycleFailure,
                retry: 'refresh the exact goal portfolio before treating reporting as applicable',
              },
            }
          : report.degraded
        ? {
            status: 'unknown',
            failure: {
              code: 'canonical-owner-report-read-failed',
              detail: readFailure('owner report', report),
              retry: 'retry readGoalOwnerReportObligation on the three-source delivery union',
            },
          }
        : { status: 'known', value: report.value },
    };
  }

  const independentVerification: IndependentVerificationProviderInput[] = planSlugs.map((planSlug, index) => {
    const outcome = acceptances[index]!;
    if (outcome.degraded || !outcome.value) {
      degradedSources.push(readFailure(`plan acceptance ${planSlug}`, outcome));
      return {
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        planSlug,
        observedAt,
        sourceGeneration: agentObligationSourceGeneration({ planSlug, status: 'unknown' }),
        read: {
          status: 'unknown',
          failure: {
            code: 'canonical-plan-acceptance-read-failed',
            detail: readFailure(`plan acceptance ${planSlug}`, outcome),
            retry: `retry evaluatePlanAcceptanceGate for ${planSlug}`,
          },
        },
      };
    }
    const gate = outcome.value;
    const generation = agentObligationSourceGeneration({ planSlug, gate });
    return {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      planSlug,
      observedAt,
      sourceGeneration: generation,
      read: {
        status: 'known',
        value: {
          gate,
          evidenceRef: `plan-acceptance:${planSlug}:${generation}`,
          gradeable: gate.satisfied || gate.code !== 'plan_items_unfinished',
        },
      },
    };
  });

  return {
    agenda: buildAgentObligationAgenda({ planPlacement, ownerReport, independentVerification }, observedAt),
    goalId,
    planSlugs,
    portfolio: portfolio.value,
    observedAt,
    elapsedMs: Date.now() - startedAt,
    degradedSources,
  };
}

export interface AgentObligationBrief {
  schemaVersion: AgentObligationAgenda['schemaVersion'];
  evaluatedAt: string;
  sourceGeneration: string;
  evaluations: AgentObligationAgenda['evaluations'];
  primary: AgentObligationAgenda['primary'];
  projection: AgentObligationProjection;
  detailRef: string;
}

export function projectAgentObligationBrief(input: {
  agenda: AgentObligationAgenda;
  sink: string;
  detailRef: string;
  detail?: 'full' | 'action';
  maxEntries?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}): AgentObligationBrief {
  const projection = projectAgentObligationAgenda({
    agenda: input.agenda,
    sink: input.sink,
    mode: 'truncate',
    detail: input.detail,
    maxEntries: input.maxEntries,
    maxChars: input.maxChars,
    maxEstimatedTokens: input.maxEstimatedTokens,
  });
  return {
    schemaVersion: input.agenda.schemaVersion,
    evaluatedAt: input.agenda.evaluatedAt,
    sourceGeneration: input.agenda.sourceGeneration,
    evaluations: input.agenda.evaluations,
    primary: input.agenda.primary,
    projection,
    detailRef: input.detailRef,
  };
}

/**
 * The automatic turn-start sink's exact projection contract.
 *
 * The GUI goal cockpit calls this same function: sharing only the agenda while
 * respelling these limits would let the screen claim to show “what the agent
 * sees” while delivering a different subset after the next budget change.
 */
export function projectAgentTurnStartObligationBrief(agenda: AgentObligationAgenda): AgentObligationBrief {
  return projectAgentObligationBrief({
    agenda,
    sink: 'turn-start',
    detailRef: 'coord:orient for the complete obligation agenda',
    // Real provider explanations can exceed this sink's entire 400-char slot.
    // Deliver the complete action here; the recovery reader retains every field.
    detail: 'action',
    maxEntries: 3,
    // The whole orientation remains capped at 600 chars. Keep this slice
    // strict so obligations cannot crowd out direct messages or held work.
    maxChars: 400,
    maxEstimatedTokens: 100,
  });
}

export const AGENT_GOAL_MODE_STATE_SCHEMA_VERSION = 'agent-goal-mode-state-v1' as const;

/** One read-only server projection shared by the goal agent and its GUI. */
export interface AgentGoalModeState {
  schemaVersion: typeof AGENT_GOAL_MODE_STATE_SCHEMA_VERSION;
  status: 'known' | 'degraded' | 'unknown';
  ownerId: string | null;
  observedAt: string;
  portfolio: GoalPortfolioBrief | null;
  obligations: AgentObligationBrief | null;
  degradedReasons: string[];
  unknown?: {
    code: 'no-canonical-goal-holder' | 'goal-mode-state-read-failed';
    detail: string;
    retry: string;
  };
}

/**
 * Assemble the goal cockpit's state from the same bounded canonical read and
 * exact turn-start projection the holder receives. Missing attribution and a
 * whole-read failure are explicit unknowns; a partial source failure remains a
 * degraded success with the provider-owned unknown evaluations intact.
 */
export async function readAgentGoalModeState(input: {
  workspaceId: string;
  ownerId: string | null;
  goalId: string;
  planSlugs: string[];
  now?: Date;
  sourceTimeoutMs?: number;
  deps?: Partial<AgentObligationReaderDeps>;
}): Promise<AgentGoalModeState> {
  const observedAt = (input.now ?? new Date()).toISOString();
  if (!input.ownerId) {
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: 'unknown',
      ownerId: null,
      observedAt,
      portfolio: null,
      obligations: null,
      degradedReasons: [],
      unknown: {
        code: 'no-canonical-goal-holder',
        detail: 'No canonical goal holder is attached, so an agent obligation agenda cannot be attributed.',
        retry: 'start or resume the goal, then refresh goals.detail',
      },
    };
  }

  try {
    const read = await readAgentObligationAgenda({
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId: input.goalId,
      planSlugs: input.planSlugs,
      sourceTimeoutMs: input.sourceTimeoutMs,
      now: input.now,
      deps: input.deps,
    });
    const portfolioReasons = read.portfolio?.degradedReasons ?? [];
    const degradedReasons = [...new Set([
      ...read.degradedSources,
      ...portfolioReasons,
      ...(!read.portfolio ? ['canonical goal portfolio was unavailable'] : []),
    ])];
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: degradedReasons.length > 0 ? 'degraded' : 'known',
      ownerId: input.ownerId,
      observedAt: read.observedAt,
      portfolio: read.portfolio,
      obligations: projectAgentTurnStartObligationBrief(read.agenda),
      degradedReasons,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: 'unknown',
      ownerId: input.ownerId,
      observedAt,
      portfolio: null,
      obligations: null,
      degradedReasons: [],
      unknown: {
        code: 'goal-mode-state-read-failed',
        detail,
        retry: 'refresh goals.detail; the goal page remains read-only while this state is unknown',
      },
    };
  }
}

export function defaultAgentObligationReaderDeps(): AgentObligationReaderDeps {
  return {
    goalSubject: async (workspaceId, ownerId) => {
      const [{ getModes }, { goalIdFromModes }] = await Promise.all([
        import('./modes/store'),
        import('./modes/goal-session'),
      ]);
      return goalIdFromModes(await getModes(workspaceId, ownerId));
    },
    planSlugs: async (_workspaceId, ownerId) => {
      const { getSessionBrief } = await import('./session-brief');
      const brief = await getSessionBrief({ ownerId });
      return brief?.currentPlanSlug ? [brief.currentPlanSlug] : [];
    },
    goalPortfolio: async (workspaceId, goalId) => {
      const { readGoalPortfolioBrief } = await import('./goal-launch-settings');
      return readGoalPortfolioBrief({ workspaceId, goalId });
    },
    goalLaunch: async ({ workspaceId, ownerId, fleetSlug, count }) => {
      const { resolveGoalLaunch } = await import('./goal-launch-settings');
      return resolveGoalLaunch({
        workspaceId,
        launcherOwnerId: ownerId,
        goalRole: 'plan-fleet-leader',
        fleetSlug,
        count,
      });
    },
    planFleet: async (workspaceId, goalId) => {
      const [{ readGoalPlanFleetObservation }, { getOrgPg }] = await Promise.all([
        import('./system-health/goal-drain-fleet-watchdog'),
        import('@papercusp/db-org'),
      ]);
      return readGoalPlanFleetObservation(getOrgPg().sql, { workspaceId, goalId });
    },
    ownerReport: async (workspaceId, ownerId, goalId, nowMs) => {
      const [{ readGoalOwnerReportObligation }, { getOrgPg }] = await Promise.all([
        import('./system-health/goal-owner-report-watchdog'),
        import('@papercusp/db-org'),
      ]);
      return readGoalOwnerReportObligation(getOrgPg().sql, { workspaceId, ownerId, goalId }, nowMs);
    },
    planAcceptance: async (planSlug) => {
      const { evaluatePlanAcceptanceGate } = await import('./plan-acceptance-gate');
      return evaluatePlanAcceptanceGate(planSlug);
    },
  };
}
