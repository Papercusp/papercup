/**
 * Effective status for scheduled watchdogs.
 *
 * A watchdog's truth spans configuration, its scheduler, eligible source rows,
 * and its fire ledger. This module joins those layers once and classifies them
 * into an action-oriented state so callers do not have to reverse-engineer the
 * implementation from source + environment + DBOS + product tables.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { suIdeateUngradedConfig, type SuIdeateUngradedConfig } from '../scout/ungraded-filings-watchdog';

export const SCHEDULED_WATCHDOG_IDS = ['su-ideate-ungraded'] as const;
export type ScheduledWatchdogId = (typeof SCHEDULED_WATCHDOG_IDS)[number];

export interface WatchdogSchedulerStatus {
  kind: 'dbos-operation';
  parentWorkflow: 'routinesTick';
  operation: 'su-ideate-ungraded-sweep';
  lastExecutionAt: string | null;
  lastWorkflowStatus: string | null;
  lastError: string | null;
  internalErrorCount: number;
}

export interface WatchdogEligibilityStatus {
  pendingCount: number;
  eligibleCount: number;
  oldestRoutedAt: string | null;
  firstEligibleAt: string | null;
}

export interface WatchdogFireStatus {
  source: 'su-ideate-ungraded';
  count: number;
  lastFireAt: string | null;
  lastReason: string | null;
}

export type WatchdogEffectiveState =
  | 'disabled'
  | 'scheduler-unobserved'
  | 'scheduler-error'
  | 'eligible-awaiting-sweep'
  | 'eligible-no-fire'
  | 'healthy-fired'
  | 'healthy-idle';

export interface ScheduledWatchdogStatus {
  ok: boolean;
  id: ScheduledWatchdogId;
  scope: { workspaceId: string; harnessSlug: string };
  config: SuIdeateUngradedConfig;
  scheduler: WatchdogSchedulerStatus;
  eligibility: WatchdogEligibilityStatus;
  fire: WatchdogFireStatus;
  effectiveState: WatchdogEffectiveState;
  summary: string;
  nextVerb: { name: string; args?: Record<string, unknown>; reason: string } | null;
}

function timeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Pure classifier: precedence is disable → scheduler integrity → eligibility → healthy. */
export function classifyScheduledWatchdogStatus(
  status: Omit<ScheduledWatchdogStatus, 'ok' | 'effectiveState' | 'summary' | 'nextVerb'>,
): Pick<ScheduledWatchdogStatus, 'ok' | 'effectiveState' | 'summary' | 'nextVerb'> {
  const { config, scheduler, eligibility, fire, scope } = status;
  if (!config.enabled) {
    return {
      ok: true,
      effectiveState: 'disabled',
      summary: `${status.id} is deliberately disabled by its effective threshold (${config.effectiveThresholdSec}s).`,
      nextVerb: null,
    };
  }
  if (scheduler.lastError || scheduler.internalErrorCount > 0 || scheduler.lastWorkflowStatus === 'ERROR') {
    return {
      ok: false,
      effectiveState: 'scheduler-error',
      summary: `${status.id} last execution failed (${scheduler.lastError ?? `${scheduler.internalErrorCount} internal error(s)`}).`,
      nextVerb: {
        name: 'notifications:recent',
        reason: 'Inspect the concrete scheduler/sweep error before retrying or changing the threshold.',
      },
    };
  }
  if (!scheduler.lastExecutionAt) {
    return {
      ok: false,
      effectiveState: 'scheduler-unobserved',
      summary: `${status.id} has no recorded ${scheduler.operation} execution.`,
      nextVerb: {
        name: 'dev:service_health',
        reason: 'Verify the DBOS routines host is live and PAPERCUSP_DBOS_ROUTINES is enabled.',
      },
    };
  }
  if (eligibility.eligibleCount > 0) {
    const executionMs = timeMs(scheduler.lastExecutionAt);
    const firstEligibleMs = timeMs(eligibility.firstEligibleAt);
    const fireMs = timeMs(fire.lastFireAt);
    const sweptAfterEligibility = executionMs != null && firstEligibleMs != null && executionMs >= firstEligibleMs;
    const firedAfterEligibility = fireMs != null && firstEligibleMs != null && fireMs >= firstEligibleMs;
    if (sweptAfterEligibility && !firedAfterEligibility) {
      return {
        ok: false,
        effectiveState: 'eligible-no-fire',
        summary: `${eligibility.eligibleCount} eligible filing(s) were present before a successful sweep, but no matching fire was recorded.`,
        nextVerb: {
          name: 'coord:presence',
          args: { harness: scope.harnessSlug },
          reason: 'Verify that a live Mug recipient exists; the sweep cannot fire a grading nudge without one.',
        },
      };
    }
    return {
      ok: true,
      effectiveState: 'eligible-awaiting-sweep',
      summary: `${eligibility.eligibleCount} filing(s) are eligible; the latest sweep predates their eligibility.`,
      nextVerb: null,
    };
  }
  if (fire.lastFireAt) {
    return {
      ok: true,
      effectiveState: 'healthy-fired',
      summary: `No filing is currently eligible; ${fire.count} matching fire(s) are recorded.`,
      nextVerb: null,
    };
  }
  return {
    ok: true,
    effectiveState: 'healthy-idle',
    summary: `No filing is currently eligible; zero fires is correct until ${eligibility.firstEligibleAt ?? 'a scoped filing reaches the threshold'}.`,
    nextVerb: null,
  };
}

interface SchedulerRow {
  output: string | null;
  operation_error: string | null;
  completed_at_epoch_ms: number | string | null;
  workflow_status: string | null;
  workflow_error: string | null;
}

interface EligibilityRow {
  pending_count: number | string;
  eligible_count: number | string;
  oldest_routed_at: number | string | null;
}

interface FireRow {
  fire_count: number | string;
  last_fire_at: Date | string | null;
  last_reason: string | null;
}

function parsePersistedConfig(value: unknown): SuIdeateUngradedConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SuIdeateUngradedConfig>;
  const threshold = Number(candidate.effectiveThresholdSec);
  const epochMs = Number(candidate.epochMs);
  const batchCap = Number(candidate.batchCap);
  const validOverrideSources: SuIdeateUngradedConfig['overrideSource'][] = [
    'default',
    'environment',
    'invalid-environment-fallback',
  ];
  if (
    typeof candidate.enabled !== 'boolean' ||
    !Number.isFinite(threshold) ||
    candidate.enabled !== threshold > 0 ||
    !validOverrideSources.includes(candidate.overrideSource as SuIdeateUngradedConfig['overrideSource']) ||
    candidate.overrideEnv !== 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC' ||
    (candidate.rawOverride !== null && typeof candidate.rawOverride !== 'string') ||
    !Number.isFinite(epochMs) ||
    !Number.isFinite(batchCap)
  ) {
    return undefined;
  }
  return {
    enabled: candidate.enabled,
    effectiveThresholdSec: threshold,
    overrideSource: candidate.overrideSource as SuIdeateUngradedConfig['overrideSource'],
    overrideEnv: candidate.overrideEnv,
    rawOverride: candidate.rawOverride,
    epochMs,
    batchCap,
  };
}

function parseRunSummary(output: string | null): {
  ranAtMs?: number;
  errorCount?: number;
  config?: SuIdeateUngradedConfig;
} {
  if (!output) return {};
  try {
    const decoded = JSON.parse(output) as unknown;
    const envelope =
      decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? (decoded as { json?: unknown; __dbos_serializer?: unknown })
        : null;
    const payload =
      envelope?.__dbos_serializer === 'superjson' &&
      envelope.json &&
      typeof envelope.json === 'object' &&
      !Array.isArray(envelope.json)
        ? envelope.json
        : decoded;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const parsed = payload as { ranAtMs?: unknown; errorCount?: unknown; config?: unknown };
    return {
      ranAtMs: Number.isFinite(Number(parsed.ranAtMs)) ? Number(parsed.ranAtMs) : undefined,
      errorCount: Number.isFinite(Number(parsed.errorCount)) ? Number(parsed.errorCount) : undefined,
      config: parsePersistedConfig(parsed.config),
    };
  } catch {
    return {};
  }
}

export async function readScheduledWatchdogStatus(args: {
  id: ScheduledWatchdogId;
  workspaceId: string;
  harnessSlug: string;
  nowMs?: number;
  sql?: Sql;
}): Promise<ScheduledWatchdogStatus> {
  const sql = args.sql ?? getOrgPg().sql;
  const nowMs = args.nowMs ?? Date.now();
  const schedulerRows = await sql<SchedulerRow[]>`
    SELECT op.output,
           op.error AS operation_error,
           op.completed_at_epoch_ms,
           ws.status AS workflow_status,
           ws.error AS workflow_error
      FROM dbos.operation_outputs op
      LEFT JOIN dbos.workflow_status ws ON ws.workflow_uuid = op.workflow_uuid
     WHERE op.function_name = 'su-ideate-ungraded-sweep'
     ORDER BY op.completed_at_epoch_ms DESC NULLS LAST
     LIMIT 1`;
  const schedulerRow = schedulerRows[0];
  const runSummary = parseRunSummary(schedulerRow?.output ?? null);
  // The DBOS step runs in the dedicated bg-host, while this reader usually runs
  // in the API process. Their environment overrides may differ, so the step's
  // persisted readback is authoritative whenever present.
  const config = runSummary.config ?? suIdeateUngradedConfig();
  const eligibleBeforeMs = nowMs - Math.max(0, config.effectiveThresholdSec) * 1_000;

  const [eligibilityRows, fireRows] = await Promise.all([
    sql<EligibilityRow[]>`
      SELECT count(*)::int AS pending_count,
             count(*) FILTER (WHERE routed_at <= ${eligibleBeforeMs})::int AS eligible_count,
             min(routed_at) AS oldest_routed_at
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${args.workspaceId}
         AND harness_slug = ${args.harnessSlug}
         AND origin = 'su-ideate'
         AND human_grade IS NULL
         AND (outcome IS NULL OR outcome = 'pending')
         AND routed_at >= ${config.epochMs}`,
    sql<FireRow[]>`
      SELECT count(*)::int AS fire_count,
             max(fired_at) AS last_fire_at,
             (array_agg(reason ORDER BY fired_at DESC))[1] AS last_reason
        FROM harness_shared.pot_watchdog_fires
       WHERE workspace_id = ${args.workspaceId}
         AND install_slug = ${args.harnessSlug}
         AND source = 'su-ideate-ungraded'`,
  ]);

  const completedMs = Number(schedulerRow?.completed_at_epoch_ms ?? Number.NaN);
  const executionMs = Number.isFinite(runSummary.ranAtMs)
    ? runSummary.ranAtMs!
    : Number.isFinite(completedMs)
      ? completedMs
      : null;
  const oldestMs = Number(eligibilityRows[0]?.oldest_routed_at ?? Number.NaN);
  const firstEligibleMs = Number.isFinite(oldestMs)
    ? oldestMs + Math.max(0, config.effectiveThresholdSec) * 1_000
    : null;
  const lastFire = fireRows[0]?.last_fire_at ?? null;
  const base = {
    id: args.id,
    scope: { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug },
    config,
    scheduler: {
      kind: 'dbos-operation' as const,
      parentWorkflow: 'routinesTick' as const,
      operation: 'su-ideate-ungraded-sweep' as const,
      lastExecutionAt: executionMs == null ? null : new Date(executionMs).toISOString(),
      lastWorkflowStatus: schedulerRow?.workflow_status ?? null,
      lastError: schedulerRow?.operation_error ?? schedulerRow?.workflow_error ?? null,
      internalErrorCount: Math.max(0, Number(runSummary.errorCount ?? 0)),
    },
    eligibility: {
      pendingCount: Number(eligibilityRows[0]?.pending_count ?? 0),
      eligibleCount: config.enabled ? Number(eligibilityRows[0]?.eligible_count ?? 0) : 0,
      oldestRoutedAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
      firstEligibleAt: firstEligibleMs == null ? null : new Date(firstEligibleMs).toISOString(),
    },
    fire: {
      source: 'su-ideate-ungraded' as const,
      count: Number(fireRows[0]?.fire_count ?? 0),
      lastFireAt: lastFire == null ? null : new Date(lastFire).toISOString(),
      lastReason: fireRows[0]?.last_reason ?? null,
    },
  };
  return { ...base, ...classifyScheduledWatchdogStatus(base) };
}
