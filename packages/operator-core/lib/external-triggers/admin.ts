/**
 * Shared data/mutation seam for the external-trigger admin surface (P-004).
 *
 * The HTTP pane and the upcoming triggers:* agent verbs both consume these
 * functions. Keeping SQL here prevents a dashboard-only interpretation of armed
 * state, storm policy, or recent-run outcomes from drifting away from the tool
 * surface.
 */
import type postgres from 'postgres';
import { parseStormPolicy } from './binding-engine';
import { defaultSocialStormPolicyForSourceKind, socialStormPolicyFor } from './social/storm-policy';
import { getSocialPlatform, isSocialPlatformVerified } from './social/platform-registry';
import { socialCursorFreshness, type SocialCursorFreshness } from './social/cursor-freshness';
import type { PlanSchedule } from '../agent-tools/plans/source';
import { planScheduleRoutineName } from '../harness/routines/materialize-plan-schedule';
import { redactSensitiveValue } from '../sensitive-text';

type Db = postgres.Sql | postgres.TransactionSql;

const SOURCE_KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_STATUSES = new Set(['unconfigured', 'ready', 'connecting', 'connected', 'degraded', 'error', 'disabled']);

export interface CreateExternalTriggerSourceInput {
  kind: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
  status?: string;
  createdBy?: string | null;
}

export interface CreatedExternalTriggerSource {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExternalTriggerBindingInput {
  sourceId: string;
  /** Plan target — required unless `goalId` is given (exactly one target, migration 921). */
  planHarnessSlug?: string | null;
  planSlug?: string | null;
  /**
   * Goal target (work-on-everything-goal-2026-08-23 P-020): the binding's
   * matches ACTIVATE this goal (action type `start-goal`, dispatched through
   * `startGoalById`) instead of launching a plan.
   */
  goalId?: string | null;
  eventPattern: string;
  eventFilter?: Record<string, unknown>;
  stormPolicy?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface CreatedExternalTriggerBinding {
  id: string;
  sourceId: string;
  sourceKind: string;
  /** Null on a goal-targeted binding (exactly one of plan / goal, migration 921). */
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  armed: boolean;
  stormPolicy: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Platform facts a social trigger source carries beyond the generic row (P-027).
 *
 * Present only when the source's `kind` resolves to a registry platform — a
 * social source's kind IS its platform id, so `getSocialPlatform(kind)` is the
 * whole mapping. Non-social sources (gmail, gcal, slack, …) keep `social: null`
 * and render exactly as they did before.
 *
 * These are all DERIVED at read time from the registry and the persisted cursor.
 * Nothing here is a second copy of state: recording, say, a platform's rate
 * budget on the source row would be a value describing code that drifts the
 * moment the registry is corrected.
 */
export interface ExternalTriggerSocialAdminFacts {
  platformId: string;
  label: string;
  wave: 'A' | 'B' | 'C';
  /** Registry row verified against its cited sources. */
  verified: boolean;
  /**
   * The owner-side wall, when the platform declares one (Meta app review, a
   * TikTok audit, a paid tier). Surfaced because "not connected" and "cannot be
   * connected until the owner clears a review" are different problems, and only
   * one of them is worth an owner's attention today.
   */
  blockedOn: string | null;
  authMode: string;
  readTransport: string;
  /** Cursor freshness — four states; see cursor-freshness.ts for why not a nullable date. */
  cursor: SocialCursorFreshness;
  /**
   * The storm cap this platform's rate budget funds, and whether a provider
   * throttle currently HOLDS all launches. `hold` is not `maxRuns: 0`: a cap of
   * zero says rationed-to-nothing, a hold says the provider told us to stop.
   */
  rateBudget: {
    maxRuns: number;
    windowSeconds: number;
    basis: string;
    hold: { reason: string; retryForbidden: boolean; untilMs: number | null } | null;
  };
  /** Write path verified separately from the row (a row can read before it can write). */
  writeVerified: boolean;
  writeVerbs: string[];
}

export interface ExternalTriggerSourceAdminRow {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  lastConnectedAt: string | null;
  lastError: string | null;
  bindingCount: number;
  armedBindingCount: number;
  failedDeliveries24h: number;
  /** Null for every non-social source kind. */
  social: ExternalTriggerSocialAdminFacts | null;
}

export interface ExternalTriggerBindingAdminRow {
  id: string;
  sourceId: string;
  sourceKind: string;
  sourceStatus: string;
  planHarnessSlug: string;
  planSlug: string;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  armed: boolean;
  stormPolicy: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: {
    id: string;
    status: string;
    triggeredAt: string;
    completedAt: string | null;
    error: string | null;
  } | null;
}

export type ExternalTriggerRunDisposition =
  | 'ran'
  | 'running'
  | 'queued'
  | 'dropped'
  | 'deduped'
  | 'coalesced'
  | 'failed';

export interface ExternalTriggerOutcomeLink {
  kind: 'gmail-draft' | 'slack-thread';
  label: string;
  href: string | null;
}

export interface ExternalTriggerTimelineStep {
  stage: 'received' | 'matched' | 'policy' | 'launched' | 'completed';
  at: string | null;
  status: 'done' | 'active' | 'pending' | 'failed' | 'dropped';
  detail: string;
}

/**
 * One trigger-run visibility record shared by the global Activity view, the
 * per-plan Runs tab, and the existing RunDetailPanel. It is a projection of the
 * canonical trigger/plan-run ledgers — never a parallel activity store.
 */
export interface ExternalTriggerRunVisibility {
  id: string;
  bindingId: string;
  sourceKind: string;
  eventPattern: string;
  planHarnessSlug: string;
  planSlug: string;
  status: string;
  attempts: number;
  dedupeKey: string;
  triggeredAt: string;
  startedAt: string | null;
  completedAt: string | null;
  planRunRef: string | null;
  error: string | null;
  causeSummary: string;
  policyDisposition: ExternalTriggerRunDisposition;
  policyDetail: string;
  eventFilter: Record<string, unknown>;
  stormPolicy: Record<string, unknown>;
  redactedPayload: Record<string, unknown>;
  outcomeLinks: ExternalTriggerOutcomeLink[];
  timeline: ExternalTriggerTimelineStep[];
  planRun: {
    id: number;
    instancePlanSlug: string | null;
    status: string;
    launchedBy: string | null;
    workItems: { total: number; passed: number; failed: number; open: number };
    agents: string[];
    durationMs: number | null;
    costUsd: number;
  } | null;
}

type ExternalTriggerRunAdminBase = Pick<
  ExternalTriggerRunVisibility,
  | 'id'
  | 'bindingId'
  | 'sourceKind'
  | 'eventPattern'
  | 'planHarnessSlug'
  | 'planSlug'
  | 'status'
  | 'attempts'
  | 'triggeredAt'
  | 'completedAt'
  | 'planRunRef'
  | 'error'
>;

/** Backward-compatible global snapshot row; new readers receive every field. */
export type ExternalTriggerRunAdminRow = ExternalTriggerRunAdminBase &
  Partial<Omit<ExternalTriggerRunVisibility, keyof ExternalTriggerRunAdminBase>>;

export interface ExternalTriggerAdminSnapshot {
  enabled: boolean;
  counts: {
    sources: number;
    bindings: number;
    armed: number;
    recentFailures: number;
  };
  sources: ExternalTriggerSourceAdminRow[];
  bindings: ExternalTriggerBindingAdminRow[];
  recentRuns: ExternalTriggerRunAdminRow[];
}

/** Per-plan schedule/manual state folded into the existing trigger admin read. */
export interface ExternalTriggerPlanAdminSnapshot {
  harnessSlug: string;
  planSlug: string;
  schedule: PlanSchedule | null;
  scheduleActive: boolean;
  scheduledAt: string | null;
  expiresAt: string | null;
  tzid: string | null;
  lastFire: string | null;
  nextFire: string | null;
  manualSource: 'input-schema' | 'template' | null;
}

interface SourceDbRow {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  lastConnectedAt: Date | string | null;
  lastError: string | null;
  bindingCount: number;
  armedBindingCount: number;
  failedDeliveries24h: number;
}

interface BindingDbRow {
  id: string;
  sourceId: string;
  sourceKind: string;
  sourceStatus: string;
  planHarnessSlug: string;
  planSlug: string;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  armed: boolean;
  stormPolicy: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunTriggeredAt: Date | string | null;
  lastRunCompletedAt: Date | string | null;
  lastRunError: string | null;
}

interface RunVisibilityDbRow {
  id: string;
  bindingId: string;
  sourceKind: string;
  sourceConfig: Record<string, unknown>;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  stormPolicy: Record<string, unknown>;
  planHarnessSlug: string;
  planSlug: string;
  status: string;
  attempts: number;
  dedupeKey: string;
  args: Record<string, unknown>;
  outcome: Record<string, unknown>;
  triggeredAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  planRunRef: string | null;
  error: string | null;
  deliveryPayload: Record<string, unknown> | null;
  receivedAt: Date | string | null;
  planRunId: number | string | null;
  instancePlanSlug: string | null;
  planRunStatus: string | null;
  planRunLaunchedBy: string | null;
  planRunLaunchedAt: number | string | null;
  planRunFinishedAt: number | string | null;
  workItemTotal: number | string;
  workItemPassed: number | string;
  workItemFailed: number | string;
  agents: unknown;
  costUsd: number | string;
}

interface PlanTriggerDbRow {
  harnessSlug: string;
  planSlug: string;
  schedule: PlanSchedule | null;
  scheduleActive: boolean;
  scheduledAt: Date | string | null;
  expiresAt: Date | string | null;
  tzid: string | null;
  template: string | null;
  hasInputSchema: boolean;
}

interface RoutineFireDbRow {
  lastFire: Date | string | null;
  nextFire: Date | string | null;
}

function iso(value: Date | string | number | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function short(value: unknown, max = 120): string {
  const normalized = text(value).replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const direct = short(payload[key]);
  if (direct) return direct;
  for (const container of ['message', 'event', 'email', 'data']) {
    const nested = short(object(payload[container])[key]);
    if (nested) return nested;
  }
  return '';
}

export function summarizeExternalTriggerCause(
  sourceKind: string,
  eventPattern: string,
  payload: Record<string, unknown>,
): string {
  const subject = payloadString(payload, 'subject') || payloadString(payload, 'title');
  const sender = payloadString(payload, 'from') || payloadString(payload, 'sender');
  if (subject && sender) return short(`${subject} · ${sender}`);
  if (subject) return subject;
  const summary = payloadString(payload, 'summary') || payloadString(payload, 'text');
  if (summary) return summary;
  const channel = payloadString(payload, 'channelName') || payloadString(payload, 'channelId');
  if (channel) return short(`${sourceKind} · ${channel}`);
  return short(`${sourceKind} · ${eventPattern}`);
}

export function externalTriggerDisposition(
  status: string,
  outcome: Record<string, unknown>,
  error: string | null,
): { disposition: ExternalTriggerRunDisposition; detail: string } {
  const coalesced = finiteNumber(outcome.coalescedCount);
  if (coalesced && coalesced > 0) {
    return { disposition: 'coalesced', detail: `coalesced×${Math.floor(coalesced)}` };
  }
  const deduped = finiteNumber(outcome.dedupedCount ?? outcome.dedupeCount);
  if (deduped && deduped > 0) {
    return { disposition: 'deduped', detail: `deduped×${Math.floor(deduped)}` };
  }
  if (status === 'pending') return { disposition: 'queued', detail: 'queued' };
  if (status === 'running') return { disposition: 'running', detail: 'running' };
  if (status === 'succeeded') return { disposition: 'ran', detail: 'ran' };
  if (status === 'failed') {
    return { disposition: 'failed', detail: error ? `failed · ${short(error, 100)}` : 'failed' };
  }
  if (status === 'skipped') {
    const storm = error?.startsWith('external_trigger_storm_limit:')
      ? error.slice('external_trigger_storm_limit:'.length)
      : null;
    return { disposition: 'dropped', detail: storm ? `dropped · storm limit ${storm}` : 'dropped' };
  }
  return { disposition: 'dropped', detail: status === 'cancelled' ? 'dropped · cancelled' : `dropped · ${status}` };
}

function outcomeLinks(
  outcome: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): ExternalTriggerOutcomeLink[] {
  const result: ExternalTriggerOutcomeLink[] = [];
  const gmail = object(outcome.gmailDraft);
  const draftId = text(gmail.draftId);
  if (draftId) {
    result.push({
      kind: 'gmail-draft',
      label: text(gmail.subject) || `Gmail draft ${draftId}`,
      href: `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(draftId)}`,
    });
  }
  const slack = object(outcome.slackThreadReply);
  const channelId = text(slack.channelId);
  const threadId = text(slack.threadId);
  const teamId = text(sourceConfig.teamId);
  if (channelId && threadId) {
    const href = teamId
      ? `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}/thread-${encodeURIComponent(channelId)}-${encodeURIComponent(threadId.replace('.', ''))}`
      : null;
    result.push({
      kind: 'slack-thread',
      label: `Slack thread ${channelId}`,
      href,
    });
  }
  return result;
}

function mapRunVisibility(row: RunVisibilityDbRow): ExternalTriggerRunVisibility {
  const args = object(row.args);
  const trigger = object(args.trigger);
  const rawPayload = row.deliveryPayload ?? object(trigger.payload);
  const redactedPayload = object(redactSensitiveValue(rawPayload));
  const outcome = object(row.outcome);
  const policy = externalTriggerDisposition(row.status, outcome, row.error);
  const total = Number(row.workItemTotal ?? 0);
  const passed = Number(row.workItemPassed ?? 0);
  const failed = Number(row.workItemFailed ?? 0);
  const planRunId = row.planRunId == null ? null : Number(row.planRunId);
  const planRunFinishedAt = row.planRunFinishedAt == null ? null : Number(row.planRunFinishedAt);
  const planRunLaunchedAt = row.planRunLaunchedAt == null ? null : Number(row.planRunLaunchedAt);
  const planRun = planRunId == null || !Number.isFinite(planRunId)
    ? null
    : {
        id: planRunId,
        instancePlanSlug: row.instancePlanSlug,
        status: row.planRunStatus ?? 'unknown',
        launchedBy: row.planRunLaunchedBy,
        workItems: { total, passed, failed, open: Math.max(0, total - passed - failed) },
        agents: Array.isArray(row.agents)
          ? row.agents.filter((agent): agent is string => typeof agent === 'string' && agent.length > 0)
          : [],
        durationMs:
          planRunLaunchedAt == null || planRunFinishedAt == null
            ? null
            : Math.max(0, planRunFinishedAt - planRunLaunchedAt),
        costUsd: Number(row.costUsd ?? 0),
      };
  const receivedAt = iso(row.receivedAt);
  const triggeredAt = iso(row.triggeredAt) as string;
  const startedAt = iso(row.startedAt);
  const completedAt = iso(row.completedAt);
  const planCompletedAt = planRunFinishedAt == null ? null : iso(planRunFinishedAt);
  const timeline: ExternalTriggerTimelineStep[] = [
    { stage: 'received', at: receivedAt, status: receivedAt ? 'done' : 'pending', detail: receivedAt ? 'Provider event normalized and deduplicated' : 'Provider delivery unavailable' },
    { stage: 'matched', at: triggeredAt, status: 'done', detail: `${row.eventPattern} matched binding ${row.bindingId}` },
    { stage: 'policy', at: triggeredAt, status: policy.disposition === 'failed' ? 'failed' : policy.disposition === 'dropped' ? 'dropped' : 'done', detail: policy.detail },
    { stage: 'launched', at: planRunLaunchedAt == null ? startedAt : iso(planRunLaunchedAt), status: planRun ? 'done' : row.status === 'running' ? 'active' : 'pending', detail: planRun ? `Plan run #${planRun.id} launched` : 'Plan run not launched' },
    { stage: 'completed', at: planCompletedAt, status: planCompletedAt ? (planRun?.status === 'failed' ? 'failed' : 'done') : planRun?.status === 'running' ? 'active' : 'pending', detail: planCompletedAt ? `Plan run ${planRun?.status ?? 'completed'}` : 'Plan run has not completed' },
  ];
  return {
    id: row.id,
    bindingId: row.bindingId,
    sourceKind: row.sourceKind,
    eventPattern: row.eventPattern,
    planHarnessSlug: row.planHarnessSlug,
    planSlug: row.planSlug,
    status: row.status,
    attempts: Number(row.attempts),
    dedupeKey: row.dedupeKey,
    triggeredAt,
    startedAt,
    completedAt,
    planRunRef: row.planRunRef,
    error: row.error,
    causeSummary: summarizeExternalTriggerCause(row.sourceKind, row.eventPattern, redactedPayload),
    policyDisposition: policy.disposition,
    policyDetail: policy.detail,
    eventFilter: object(redactSensitiveValue(row.eventFilter)),
    stormPolicy: object(row.stormPolicy),
    redactedPayload,
    outcomeLinks: outcomeLinks(outcome, row.sourceConfig),
    timeline,
    planRun,
  };
}

export async function loadExternalTriggerRunVisibilities(
  sql: Db,
  workspaceId: string,
  opts: {
    planHarnessSlug?: string;
    planSlug?: string;
    planRunRef?: string;
    limit?: number;
  } = {},
): Promise<ExternalTriggerRunVisibility[]> {
  const harnessFilter = opts.planHarnessSlug
    ? sql`AND b.plan_harness_slug = ${opts.planHarnessSlug}`
    : sql``;
  const planFilter = opts.planSlug ? sql`AND b.plan_slug = ${opts.planSlug}` : sql``;
  const planRunFilter = opts.planRunRef ? sql`AND tr.plan_run_ref = ${opts.planRunRef}` : sql``;
  const limit = Math.min(5_000, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rows = await sql<RunVisibilityDbRow[]>`
    SELECT tr.id::text,
           tr.binding_id::text AS "bindingId",
           s.kind AS "sourceKind",
           s.config AS "sourceConfig",
           b.event_pattern AS "eventPattern",
           b.event_filter AS "eventFilter",
           b.storm_policy AS "stormPolicy",
           b.plan_harness_slug AS "planHarnessSlug",
           b.plan_slug AS "planSlug",
           tr.status,
           tr.attempts,
           tr.dedupe_key AS "dedupeKey",
           tr.args,
           tr.outcome,
           tr.triggered_at AS "triggeredAt",
           tr.started_at AS "startedAt",
           tr.completed_at AS "completedAt",
           tr.plan_run_ref AS "planRunRef",
           tr.error,
           d.payload AS "deliveryPayload",
           d.received_at AS "receivedAt",
           pr.id AS "planRunId",
           pr.instance_plan_slug AS "instancePlanSlug",
           pr.status AS "planRunStatus",
           pr.launched_by AS "planRunLaunchedBy",
           pr.launched_at AS "planRunLaunchedAt",
           pr.finished_at AS "planRunFinishedAt",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text) AS "workItemTotal",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
               AND w.status IN ('passed', 'done', 'resolved', 'closed')) AS "workItemPassed",
           (SELECT count(*)::int
              FROM harness_shared.harness_features_consolidated w
             WHERE w.workspace_id = tr.workspace_id
               AND w.harness_slug = b.plan_harness_slug
               AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
               AND w.status IN ('failed', 'dropped', 'deprecated')) AS "workItemFailed",
           COALESCE((
             SELECT jsonb_agg(agent ORDER BY agent)
               FROM (
                 SELECT DISTINCT w.taken_by AS agent
                   FROM harness_shared.harness_features_consolidated w
                  WHERE w.workspace_id = tr.workspace_id
                    AND w.harness_slug = b.plan_harness_slug
                    AND w.payload -> 'plan_run' ->> 'runId' = pr.id::text
                    AND w.taken_by IS NOT NULL
               ) assigned_agents
           ), '[]'::jsonb) AS agents,
           (SELECT COALESCE(sum(t.cost_usd), 0)
              FROM harness_shared.plan_run_turns t
             WHERE t.workspace_id = tr.workspace_id AND t.plan_run_id = pr.id) AS "costUsd"
      FROM harness_shared.trigger_runs tr
      JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
      JOIN harness_shared.trigger_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
      LEFT JOIN harness_shared.trigger_deliveries d
        ON d.workspace_id = tr.workspace_id AND d.id = tr.delivery_id
      LEFT JOIN harness_shared.plan_runs pr
        ON pr.workspace_id = tr.workspace_id AND pr.id::text = tr.plan_run_ref
     WHERE tr.workspace_id = ${workspaceId}
       ${harnessFilter}
       ${planFilter}
       ${planRunFilter}
     ORDER BY tr.triggered_at DESC, tr.id DESC
     LIMIT ${limit}`;
  return rows.map(mapRunVisibility);
}

function required(value: string | null | undefined, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`external_trigger_${field}_required`);
  return normalized;
}

function normalizedStormPolicy(raw: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = parseStormPolicy(raw);
  return {
    windowSeconds: parsed.windowSeconds,
    ...(parsed.maxRuns === null ? {} : { maxRuns: parsed.maxRuns }),
  };
}

/** Create a non-secret source definition. Provider credentials remain opaque references. */
export async function createExternalTriggerSource(
  sql: postgres.Sql,
  workspaceId: string,
  input: CreateExternalTriggerSourceInput,
): Promise<CreatedExternalTriggerSource> {
  const kind = required(input.kind, 'source_kind');
  if (!SOURCE_KIND_RE.test(kind)) throw new Error(`external_trigger_invalid_source_kind:${kind}`);
  const status = input.status?.trim() || 'unconfigured';
  if (!SOURCE_STATUSES.has(status)) throw new Error(`external_trigger_invalid_source_status:${status}`);
  const config = JSON.stringify(input.config ?? {});
  const rows = await sql<
    Array<
      Omit<CreatedExternalTriggerSource, 'createdAt' | 'updatedAt'> & {
        createdAt: Date | string;
        updatedAt: Date | string;
      }
    >
  >`
    INSERT INTO harness_shared.trigger_sources
      (workspace_id, kind, config, credential_ref, status, created_by)
    VALUES (
      ${required(workspaceId, 'workspace_id')}, ${kind}, ${config}::text::jsonb,
      ${input.credentialRef?.trim() || null}, ${status}, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              kind,
              status,
              config,
              credential_ref AS "credentialRef",
              cursor,
              created_at AS "createdAt",
              updated_at AS "updatedAt"`;
  if (!rows[0]) throw new Error('external_trigger_source_create_failed');
  return {
    ...rows[0],
    createdAt: iso(rows[0].createdAt) as string,
    updatedAt: iso(rows[0].updatedAt) as string,
  };
}

/** Install an external-event binding. Installed bindings always begin disarmed. */
export async function createExternalTriggerBinding(
  sql: Db,
  workspaceId: string,
  input: CreateExternalTriggerBindingInput,
): Promise<CreatedExternalTriggerBinding> {
  const ws = required(workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  const goalId = input.goalId?.trim() || null;
  // Exactly one target (mirrors migration 921's CHECK, refused here so the
  // caller gets a named error instead of a constraint violation).
  const planGiven = Boolean(input.planSlug?.trim() || input.planHarnessSlug?.trim());
  if (goalId && planGiven) throw new Error('external_trigger_binding_both_targets');
  if (!goalId && !planGiven) throw new Error('external_trigger_binding_no_target');
  const planHarnessSlug = goalId ? null : required(input.planHarnessSlug, 'plan_harness_slug');
  const planSlug = goalId ? null : required(input.planSlug, 'plan_slug');
  const eventPattern = required(input.eventPattern, 'event_pattern');
  const sources = await sql<Array<{ kind: string }>>`
    SELECT kind FROM harness_shared.trigger_sources
     WHERE workspace_id = ${ws} AND id = ${sourceId}::uuid
     LIMIT 1`;
  if (!sources[0]) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  const expectedPrefix = `ext:${sources[0].kind}:`;
  if (!eventPattern.startsWith(expectedPrefix)) {
    throw new Error(`external_trigger_pattern_source_mismatch:${expectedPrefix}`);
  }
  if (goalId) {
    const goals = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM harness_shared.goals
         WHERE workspace_id = ${ws} AND id = ${goalId}
      ) AS exists`;
    if (!goals[0]?.exists) throw new Error(`external_trigger_unknown_goal:${goalId}`);
  } else {
    const plans = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws}
           AND harness_slug = ${planHarnessSlug}
           AND plan_slug = ${planSlug}
      ) AS exists`;
    if (!plans[0]?.exists) throw new Error(`external_trigger_unknown_plan:${planHarnessSlug}/${planSlug}`);
  }

  const eventFilter = JSON.stringify(input.eventFilter ?? {});
  const action = JSON.stringify({ type: goalId ? 'start-goal' : 'launch-plan' });
  // A binding with no explicit storm policy is UNBOUNDED under the landed
  // default (parseStormPolicy yields maxRuns:null). That is tolerable for mail,
  // where volume is bounded by how fast humans write, and unsafe for social,
  // where one viral post can produce thousands of genuinely-distinct inbound
  // comments. So a social source falls back to its per-platform coalesce-with-cap
  // default (P-023) instead of to unbounded. An explicit caller-supplied policy
  // still wins, and non-social sources are untouched.
  const socialDefault = input.stormPolicy
    ? null
    : defaultSocialStormPolicyForSourceKind(sources[0].kind);
  const stormPolicy = socialDefault ?? normalizedStormPolicy(input.stormPolicy);
  const stormPolicyJson = JSON.stringify(stormPolicy);
  const rows = await sql<
    Array<
      Omit<CreatedExternalTriggerBinding, 'sourceKind' | 'createdAt' | 'updatedAt'> & {
        createdAt: Date | string;
        updatedAt: Date | string;
      }
    >
  >`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id, event_pattern,
       event_filter, action, armed, storm_policy, created_by)
    VALUES (
      ${ws}, ${sourceId}::uuid, ${planHarnessSlug}, ${planSlug}, ${goalId}, ${eventPattern},
      ${eventFilter}::text::jsonb, ${action}::text::jsonb, FALSE,
      ${stormPolicyJson}::text::jsonb, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              source_id::text AS "sourceId",
              plan_harness_slug AS "planHarnessSlug",
              plan_slug AS "planSlug",
              goal_id AS "goalId",
              event_pattern AS "eventPattern",
              event_filter AS "eventFilter",
              action,
              armed,
              storm_policy AS "stormPolicy",
              created_by AS "createdBy",
              created_at AS "createdAt",
              updated_at AS "updatedAt"`;
  if (!rows[0]) throw new Error('external_trigger_binding_create_failed');
  return {
    ...rows[0],
    sourceKind: sources[0].kind,
    createdAt: iso(rows[0].createdAt) as string,
    updatedAt: iso(rows[0].updatedAt) as string,
  };
}

/**
 * Idempotently install one semantic source→plan binding.
 *
 * `trigger_bindings` intentionally permits multiple bindings between the same
 * source and plan because users may author distinct filters. Connection-time
 * provisioning needs a narrower guarantee: reconnecting (or two concurrent
 * OAuth callbacks) must not multiply the one built-in Calendar binding. A
 * transaction-scoped advisory lock serializes that exact semantic key, then an
 * equality read reuses the installed row. The binding remains disarmed; arming
 * is still an explicit, separately-governed operation.
 */
export async function ensureExternalTriggerBinding(
  sql: postgres.Sql,
  workspaceId: string,
  input: CreateExternalTriggerBindingInput,
): Promise<CreatedExternalTriggerBinding> {
  const ws = required(workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  // Plan-only by design: this door serves connection-time provisioning of the
  // built-in plan bindings. A goal binding has no such provisioning caller —
  // use createExternalTriggerBinding directly (P-020).
  if (input.goalId?.trim()) throw new Error('external_trigger_goal_binding_ensure_unsupported');
  const planHarnessSlug = required(input.planHarnessSlug, 'plan_harness_slug');
  const planSlug = required(input.planSlug, 'plan_slug');
  const eventPattern = required(input.eventPattern, 'event_pattern');
  const eventFilter = JSON.stringify(input.eventFilter ?? {});
  const action = JSON.stringify({ type: 'launch-plan' });
  const lockKey = [
    'external-trigger-binding',
    ws,
    sourceId,
    planHarnessSlug,
    planSlug,
    eventPattern,
  ].join(':');

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const rows = await tx<
      Array<
        Omit<CreatedExternalTriggerBinding, 'createdAt' | 'updatedAt'> & {
          createdAt: Date | string;
          updatedAt: Date | string;
        }
      >
    >`
      SELECT b.id::text,
             b.source_id::text AS "sourceId",
             s.kind AS "sourceKind",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             b.goal_id AS "goalId",
             b.event_pattern AS "eventPattern",
             b.event_filter AS "eventFilter",
             b.action,
             b.armed,
             b.storm_policy AS "stormPolicy",
             b.created_by AS "createdBy",
             b.created_at AS "createdAt",
             b.updated_at AS "updatedAt"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE b.workspace_id = ${ws}
         AND b.source_id = ${sourceId}::uuid
         AND b.plan_harness_slug = ${planHarnessSlug}
         AND b.plan_slug = ${planSlug}
         AND b.event_pattern = ${eventPattern}
         AND b.event_filter = ${eventFilter}::text::jsonb
         AND b.action = ${action}::text::jsonb
         AND b.detached_at IS NULL
       ORDER BY b.created_at, b.id
       LIMIT 1`;
    if (rows[0]) {
      return {
        ...rows[0],
        createdAt: iso(rows[0].createdAt) as string,
        updatedAt: iso(rows[0].updatedAt) as string,
      };
    }
    return createExternalTriggerBinding(tx, ws, input);
  });
}

export function disabledExternalTriggerAdminSnapshot(): ExternalTriggerAdminSnapshot {
  return {
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  };
}

/**
 * Derive a social source's platform facts, or null for a non-social kind.
 *
 * Exported for direct testing: the pane's correctness rests on this returning
 * null for every kind the registry does not know, so that a gmail or slack
 * source can never pick up a social platform's rate budget by accident.
 */
export function socialAdminFacts(
  kind: string,
  cursor: unknown,
  nowMs: number,
): ExternalTriggerSocialAdminFacts | null {
  const row = getSocialPlatform(kind);
  if (!row) return null;
  // `read` for the cap: the poll loop is what spends budget continuously, and
  // it is the spend an owner watching this pane is deciding about.
  const policy = socialStormPolicyFor(row, 'read');
  return {
    platformId: row.id,
    label: row.label,
    wave: row.wave,
    verified: isSocialPlatformVerified(row),
    blockedOn: row.blockedOn ?? null,
    authMode: row.auth.mode,
    readTransport: row.read.transport,
    cursor: socialCursorFreshness(cursor, nowMs),
    rateBudget: {
      maxRuns: policy.maxRuns,
      windowSeconds: policy.windowSeconds,
      basis: policy.basis.kind,
      hold: policy.hold
        ? {
            reason: policy.hold.reason,
            retryForbidden: policy.hold.retryForbidden,
            untilMs: policy.hold.untilMs,
          }
        : null,
    },
    writeVerified: typeof row.write.verifiedAt === 'string' && row.write.verifiedAt.length > 0,
    writeVerbs: [...row.write.verbs],
  };
}

/** Read the one workspace-scoped snapshot rendered by /admin/triggers. */
export async function loadExternalTriggerAdminSnapshot(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<ExternalTriggerAdminSnapshot> {
  const [sourceRows, bindingRows, recentRuns, failureRows] = await Promise.all([
    sql<SourceDbRow[]>`
      SELECT s.id::text,
             s.kind,
             s.status,
             s.config,
             s.credential_ref AS "credentialRef",
             s.cursor,
             s.last_connected_at AS "lastConnectedAt",
             s.last_error AS "lastError",
             count(DISTINCT b.id)::int AS "bindingCount",
             count(DISTINCT b.id) FILTER (WHERE b.armed)::int AS "armedBindingCount",
             count(DISTINCT d.id) FILTER (
               WHERE d.outcome = 'failed'
                 AND d.received_at >= now() - interval '24 hours'
             )::int AS "failedDeliveries24h"
        FROM harness_shared.trigger_sources s
        LEFT JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = s.workspace_id
         AND b.source_id = s.id
         AND b.detached_at IS NULL
        LEFT JOIN harness_shared.trigger_deliveries d
          ON d.workspace_id = s.workspace_id AND d.source_id = s.id
       WHERE s.workspace_id = ${workspaceId}
       GROUP BY s.workspace_id, s.id
       ORDER BY s.kind, s.created_at, s.id`,
    sql<BindingDbRow[]>`
      SELECT b.id::text,
             b.source_id::text AS "sourceId",
             s.kind AS "sourceKind",
             s.status AS "sourceStatus",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             b.event_pattern AS "eventPattern",
             b.event_filter AS "eventFilter",
             b.action,
             b.armed,
             b.storm_policy AS "stormPolicy",
             b.created_by AS "createdBy",
             b.created_at AS "createdAt",
             b.updated_at AS "updatedAt",
             lr.id::text AS "lastRunId",
             lr.status AS "lastRunStatus",
             lr.triggered_at AS "lastRunTriggeredAt",
             lr.completed_at AS "lastRunCompletedAt",
             lr.error AS "lastRunError"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
        LEFT JOIN LATERAL (
          SELECT tr.id, tr.status, tr.triggered_at, tr.completed_at, tr.error
            FROM harness_shared.trigger_runs tr
           WHERE tr.workspace_id = b.workspace_id AND tr.binding_id = b.id
           ORDER BY tr.triggered_at DESC, tr.id DESC
           LIMIT 1
        ) lr ON TRUE
       WHERE b.workspace_id = ${workspaceId}
         AND b.detached_at IS NULL
       ORDER BY b.created_at, b.id`,
    loadExternalTriggerRunVisibilities(sql, workspaceId, { limit: 50 }),
    sql<Array<{ count: number }>>`
      SELECT (
        (SELECT count(*)::int
           FROM harness_shared.trigger_deliveries
          WHERE workspace_id = ${workspaceId}
            AND outcome = 'failed'
            AND received_at >= now() - interval '24 hours')
        +
        (SELECT count(*)::int
           FROM harness_shared.trigger_runs
          WHERE workspace_id = ${workspaceId}
            AND status = 'failed'
            AND triggered_at >= now() - interval '24 hours')
      )::int AS count`,
  ]);

  const nowMs = Date.now();
  const sources = sourceRows.map((row) => ({
    ...row,
    lastConnectedAt: iso(row.lastConnectedAt),
    social: socialAdminFacts(row.kind, row.cursor, nowMs),
  }));
  const bindings = bindingRows.map(
    (row): ExternalTriggerBindingAdminRow => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceKind: row.sourceKind,
      sourceStatus: row.sourceStatus,
      planHarnessSlug: row.planHarnessSlug,
      planSlug: row.planSlug,
      eventPattern: row.eventPattern,
      eventFilter: row.eventFilter,
      action: row.action,
      armed: row.armed,
      stormPolicy: row.stormPolicy,
      createdBy: row.createdBy,
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string,
      lastRun:
        row.lastRunId && row.lastRunStatus && row.lastRunTriggeredAt
          ? {
              id: row.lastRunId,
              status: row.lastRunStatus,
              triggeredAt: iso(row.lastRunTriggeredAt) as string,
              completedAt: iso(row.lastRunCompletedAt),
              error: row.lastRunError,
            }
          : null,
    }),
  );
  return {
    enabled: true,
    counts: {
      sources: sources.length,
      bindings: bindings.length,
      armed: bindings.filter((binding) => binding.armed).length,
      recentFailures: failureRows[0]?.count ?? 0,
    },
    sources,
    bindings,
    recentRuns,
  };
}

/** Read the schedule/manual half of one plan's unified trigger model. */
export async function loadExternalTriggerPlanAdminSnapshot(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<ExternalTriggerPlanAdminSnapshot | null> {
  const ws = required(workspaceId, 'workspace_id');
  const harness = required(harnessSlug, 'plan_harness_slug');
  const plan = required(planSlug, 'plan_slug');
  const [planRows, routineRows] = await Promise.all([
    sql<PlanTriggerDbRow[]>`
      SELECT harness_slug AS "harnessSlug",
             plan_slug AS "planSlug",
             schedule,
             schedule_active AS "scheduleActive",
             scheduled_at AS "scheduledAt",
             expires_at AS "expiresAt",
             tzid,
             template,
             (input_schema IS NOT NULL) AS "hasInputSchema"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${ws}
         AND harness_slug = ${harness}
         AND plan_slug = ${plan}
       LIMIT 1`,
    sql<RoutineFireDbRow[]>`
      SELECT last_fired_at AS "lastFire", next_fire_at AS "nextFire"
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND install_slug = ${harness}
         AND name = ${planScheduleRoutineName(plan)}
       LIMIT 1`,
  ]);
  const row = planRows[0];
  if (!row) return null;
  const routine = routineRows[0];
  return {
    harnessSlug: row.harnessSlug,
    planSlug: row.planSlug,
    schedule: row.schedule,
    scheduleActive: row.scheduleActive,
    scheduledAt: iso(row.scheduledAt),
    expiresAt: iso(row.expiresAt),
    tzid: row.tzid,
    lastFire: iso(routine?.lastFire ?? null),
    nextFire: iso(routine?.nextFire ?? null),
    manualSource: row.hasInputSchema ? 'input-schema' : row.template ? 'template' : null,
  };
}

export async function setExternalTriggerBindingArmed(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  armed: boolean,
): Promise<{ id: string; armed: boolean; updatedAt: string } | null> {
  const rows = await sql<Array<{ id: string; armed: boolean; updatedAt: Date | string }>>`
    UPDATE harness_shared.trigger_bindings
       SET armed = ${armed}, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id}::uuid
       AND detached_at IS NULL
     RETURNING id::text, armed, updated_at AS "updatedAt"`;
  if (!rows[0]) return null;
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
}

/**
 * Soft-detach a binding: stop execution immediately while preserving every run
 * that references the binding. Repeating the detach is an idempotent miss.
 */
export async function detachExternalTriggerBinding(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<{ id: string; detachedAt: string; updatedAt: string } | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      Array<{ id: string; detachedAt: Date | string; updatedAt: Date | string }>
    >`
      UPDATE harness_shared.trigger_bindings
         SET armed = FALSE,
             detached_at = now(),
             updated_at = now()
       WHERE workspace_id = ${workspaceId}
         AND id = ${id}::uuid
         AND detached_at IS NULL
       RETURNING id::text,
                 detached_at AS "detachedAt",
                 updated_at AS "updatedAt"`;
    if (!rows[0]) return null;
    // A detached binding must not leave queued work that can still launch later.
    // Running attempts are allowed to settle; only not-yet-started rows cancel.
    await tx`
      UPDATE harness_shared.trigger_runs
         SET status = 'cancelled',
             completed_at = now(),
             updated_at = now(),
             error = COALESCE(error, 'binding detached before dispatch')
       WHERE workspace_id = ${workspaceId}
         AND binding_id = ${id}::uuid
         AND status = 'pending'`;
    return {
      id: rows[0].id,
      detachedAt: iso(rows[0].detachedAt) as string,
      updatedAt: iso(rows[0].updatedAt) as string,
    };
  });
}

export async function updateExternalTriggerBindingStormPolicy(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  input: { maxRuns: number | null; windowSeconds: number },
): Promise<{ id: string; stormPolicy: Record<string, unknown>; updatedAt: string } | null> {
  const parsed = parseStormPolicy({
    maxRuns: input.maxRuns,
    windowSeconds: input.windowSeconds,
  });
  const stormPolicy: Record<string, unknown> = {
    windowSeconds: parsed.windowSeconds,
    ...(parsed.maxRuns === null ? {} : { maxRuns: parsed.maxRuns }),
  };
  const rows = await sql<
    Array<{
      id: string;
      stormPolicy: Record<string, unknown>;
      updatedAt: Date | string;
    }>
  >`
    UPDATE harness_shared.trigger_bindings
       SET storm_policy = ${JSON.stringify(stormPolicy)}::text::jsonb,
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id}::uuid
       AND detached_at IS NULL
     RETURNING id::text, storm_policy AS "stormPolicy", updated_at AS "updatedAt"`;
  if (!rows[0]) return null;
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
}
