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
  if (goalId) {
    const placementGeneration = agentObligationSourceGeneration({
      portfolio: stablePortfolio(portfolio.value),
      launch: stableLaunch(launch.value),
      fleet: fleet.value,
    });
    const placementFailure =
      portfolio.degraded || launch.degraded || fleet.degraded || fleet.value.status === 'unknown';
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
                degradedSources.filter((entry) => /goal portfolio|goal launch|plan fleet/.test(entry)).join('; ') ||
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

    const reportGeneration = agentObligationSourceGeneration(
      report.value
        ? {
            lastReportAt: report.value.lastReportAt,
            floorMin: report.value.floorMin,
            standing: report.value.standing,
            obligation: report.value.obligation,
          }
        : null,
    );
    ownerReport = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId,
      observedAt,
      sourceGeneration: reportGeneration,
      read: report.degraded
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
  maxEntries?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}): AgentObligationBrief {
  const projection = projectAgentObligationAgenda({
    agenda: input.agenda,
    sink: input.sink,
    mode: 'truncate',
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
