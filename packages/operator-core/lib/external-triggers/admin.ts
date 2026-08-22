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
  planHarnessSlug: string;
  planSlug: string;
  eventPattern: string;
  eventFilter?: Record<string, unknown>;
  stormPolicy?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface CreatedExternalTriggerBinding {
  id: string;
  sourceId: string;
  sourceKind: string;
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

export interface ExternalTriggerRunAdminRow {
  id: string;
  bindingId: string;
  sourceKind: string;
  eventPattern: string;
  planHarnessSlug: string;
  planSlug: string;
  status: string;
  attempts: number;
  triggeredAt: string;
  completedAt: string | null;
  planRunRef: string | null;
  error: string | null;
}

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

interface RunDbRow {
  id: string;
  bindingId: string;
  sourceKind: string;
  eventPattern: string;
  planHarnessSlug: string;
  planSlug: string;
  status: string;
  attempts: number;
  triggeredAt: Date | string;
  completedAt: Date | string | null;
  planRunRef: string | null;
  error: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function required(value: string, field: string): string {
  const normalized = value.trim();
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
  sql: postgres.Sql,
  workspaceId: string,
  input: CreateExternalTriggerBindingInput,
): Promise<CreatedExternalTriggerBinding> {
  const ws = required(workspaceId, 'workspace_id');
  const sourceId = required(input.sourceId, 'source_id');
  const planHarnessSlug = required(input.planHarnessSlug, 'plan_harness_slug');
  const planSlug = required(input.planSlug, 'plan_slug');
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
  const plans = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.harness_plans
       WHERE workspace_id = ${ws}
         AND harness_slug = ${planHarnessSlug}
         AND plan_slug = ${planSlug}
    ) AS exists`;
  if (!plans[0]?.exists) throw new Error(`external_trigger_unknown_plan:${planHarnessSlug}/${planSlug}`);

  const eventFilter = JSON.stringify(input.eventFilter ?? {});
  const action = JSON.stringify({ type: 'launch-plan' });
  const stormPolicy = normalizedStormPolicy(input.stormPolicy);
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
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       event_filter, action, armed, storm_policy, created_by)
    VALUES (
      ${ws}, ${sourceId}::uuid, ${planHarnessSlug}, ${planSlug}, ${eventPattern},
      ${eventFilter}::text::jsonb, ${action}::text::jsonb, FALSE,
      ${stormPolicyJson}::text::jsonb, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              source_id::text AS "sourceId",
              plan_harness_slug AS "planHarnessSlug",
              plan_slug AS "planSlug",
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

export function disabledExternalTriggerAdminSnapshot(): ExternalTriggerAdminSnapshot {
  return {
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  };
}

/** Read the one workspace-scoped snapshot rendered by /admin/triggers. */
export async function loadExternalTriggerAdminSnapshot(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<ExternalTriggerAdminSnapshot> {
  const [sourceRows, bindingRows, runRows, failureRows] = await Promise.all([
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
          ON b.workspace_id = s.workspace_id AND b.source_id = s.id
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
       ORDER BY b.created_at, b.id`,
    sql<RunDbRow[]>`
      SELECT tr.id::text,
             tr.binding_id::text AS "bindingId",
             s.kind AS "sourceKind",
             b.event_pattern AS "eventPattern",
             b.plan_harness_slug AS "planHarnessSlug",
             b.plan_slug AS "planSlug",
             tr.status,
             tr.attempts,
             tr.triggered_at AS "triggeredAt",
             tr.completed_at AS "completedAt",
             tr.plan_run_ref AS "planRunRef",
             tr.error
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE tr.workspace_id = ${workspaceId}
       ORDER BY tr.triggered_at DESC, tr.id DESC
       LIMIT 50`,
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

  const sources = sourceRows.map((row) => ({
    ...row,
    lastConnectedAt: iso(row.lastConnectedAt),
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
  const recentRuns = runRows.map((row) => ({
    ...row,
    triggeredAt: iso(row.triggeredAt) as string,
    completedAt: iso(row.completedAt),
  }));

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
     RETURNING id::text, armed, updated_at AS "updatedAt"`;
  if (!rows[0]) return null;
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
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
     RETURNING id::text, storm_policy AS "stormPolicy", updated_at AS "updatedAt"`;
  if (!rows[0]) return null;
  return { ...rows[0], updatedAt: iso(rows[0].updatedAt) as string };
}
