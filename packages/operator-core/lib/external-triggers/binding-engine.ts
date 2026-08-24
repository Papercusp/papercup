/**
 * Durable external-trigger binding engine (external-triggers P-003).
 *
 * Ingestion records one `trigger-bindings` sink delivery after the event-bus sink.
 * That sink evaluates armed bindings and writes one idempotent trigger_runs outbox
 * row per match. A tier:durable system routine drains the outbox through the
 * canonical plan-run writer. Provider/request processes never need to host DBOS.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { emitAwaitedEvent } from '../events/await/engine';
import { keyMatchesPattern, payloadMatchesFilter } from '../events/await/pattern';
import {
  runScheduledPlanFire,
  type ScheduledPlanFireOptions,
  type ScheduledPlanFireResult,
} from '../harness/routines/plan-run-action';
import type { CanonicalExternalEvent, ExternalTriggerSink } from './ingestion';
import { startGoalById, type StartGoalByIdResult } from '../goals/start-goal-by-id';

type Db = postgres.Sql | postgres.TransactionSql;

const DEFAULT_STORM_WINDOW_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_AFTER_SECONDS = 60;

/**
 * The action vocabulary (work-on-everything-goal-2026-08-23 P-020, D-006).
 * `launch-plan` mints a plan run; `start-goal` ACTIVATES the binding's target
 * goal through the one goal-activation primitive (`startGoalById`) — never a
 * second spawn path.
 */
const SUPPORTED_TRIGGER_ACTIONS: ReadonlySet<string> = new Set(['launch-plan', 'start-goal']);

interface BindingRow {
  id: string;
  sourceId: string;
  /** Nullable since migration 921: a binding targets EXACTLY ONE of plan / goal. */
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  armed: boolean;
  stormPolicy: Record<string, unknown>;
}

interface ClaimedTriggerRun {
  id: string;
  workspaceId: string;
  bindingId: string;
  planHarnessSlug: string | null;
  planSlug: string | null;
  goalId: string | null;
  args: TriggerRunArgs;
  action: Record<string, unknown>;
  attempts: number;
}

interface TriggerRunArgs {
  trigger: {
    key: string;
    source: string;
    event: string;
    sourceId: string;
    externalId: string;
    occurredAt: string | null;
    datatypeId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  };
}

export interface StormPolicy {
  maxRuns: number | null;
  windowSeconds: number;
}

export interface BindingEnqueueResult {
  matched: number;
  queued: number;
  deduped: number;
  skippedForStorm: number;
  failed: number;
  triggerRunIds: string[];
}

export interface TriggerDispatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /**
   * `start-goal` runs closed TERMINALLY without an activation (goal gone /
   * not-active / no harness / already held) — refusals a re-firing trigger
   * treats as settled, never retried. Plan runs never land here.
   */
  skipped: number;
  triggerRunIds: string[];
}

type RunPlan = (
  sql: postgres.Sql,
  opts: ScheduledPlanFireOptions,
) => Promise<ScheduledPlanFireResult | null>;

export interface TriggerDispatchDeps {
  runPlan?: RunPlan;
  /** The goal-activation primitive (P-020) — injectable for tests, `startGoalById` in production. */
  startGoal?: (
    sql: postgres.Sql,
    input: { workspaceId: string; goalId: string; launcherOwnerId: string },
  ) => Promise<StartGoalByIdResult>;
  announceRunWork?: (sql: postgres.Sql, workspaceId: string, runId: number) => Promise<void>;
  batchSize?: number;
  staleAfterSeconds?: number;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`external_trigger_invalid_${field}`);
  }
  return parsed;
}

/** Parse the small, explicit v1 storm-policy vocabulary. Empty means unbounded. */
export function parseStormPolicy(raw: Record<string, unknown>): StormPolicy {
  const maxRaw = raw.maxRuns ?? raw.max_runs;
  const windowRaw = raw.windowSeconds ?? raw.window_seconds;
  return {
    maxRuns: maxRaw === undefined || maxRaw === null ? null : positiveInteger(maxRaw, 'storm_max_runs'),
    windowSeconds:
      windowRaw === undefined || windowRaw === null
        ? DEFAULT_STORM_WINDOW_SECONDS
        : positiveInteger(windowRaw, 'storm_window_seconds'),
  };
}

/** Stable decimal token accepted by the canonical `<plan>@run-<digits>` grammar. */
export function triggerRunPlanToken(triggerRunId: string): string {
  const hex = createHash('sha256').update(triggerRunId).digest('hex').slice(0, 15);
  return BigInt(`0x${hex}`).toString(10);
}

function triggerArgs(event: CanonicalExternalEvent): TriggerRunArgs {
  return {
    trigger: {
      key: event.key,
      source: event.source,
      event: event.event,
      sourceId: event.sourceId,
      externalId: event.externalId,
      occurredAt: event.occurredAt ?? null,
      datatypeId: event.datatypeId,
      dedupeKey: event.dedupeKey,
      payload: event.payload,
    },
  };
}

function actionType(action: Record<string, unknown>): string {
  const type = typeof action.type === 'string' ? action.type.trim() : '';
  return type || 'launch-plan';
}

async function loadBindingForUpdate(tx: Db, workspaceId: string, id: string): Promise<BindingRow | null> {
  const rows = await tx<BindingRow[]>`
    SELECT id,
           source_id AS "sourceId",
           plan_harness_slug AS "planHarnessSlug",
           plan_slug AS "planSlug",
           goal_id AS "goalId",
           event_pattern AS "eventPattern",
           event_filter AS "eventFilter",
           action,
           armed,
           storm_policy AS "stormPolicy"
      FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${workspaceId} AND id = ${id}
       AND detached_at IS NULL
     FOR UPDATE`;
  return rows[0] ?? null;
}

async function insertTerminalTriggerRun(
  tx: Db,
  input: {
    event: CanonicalExternalEvent;
    binding: BindingRow;
    deliveryId: string;
    status: 'failed' | 'skipped';
    error: string;
  },
): Promise<{ id: string; inserted: boolean; status: string }> {
  const args = JSON.stringify(triggerArgs(input.event));
  const rows = await tx<Array<{ id: string; status: string }>>`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args,
       error, completed_at, updated_at)
    VALUES (${input.event.workspaceId}, ${input.binding.id}, ${input.deliveryId},
            ${input.event.dedupeKey}, ${input.status}, ${args}::text::jsonb,
            ${input.error}, now(), now())
    ON CONFLICT (workspace_id, binding_id, dedupe_key) DO NOTHING
    RETURNING id, status`;
  if (rows[0]) return { ...rows[0], inserted: true };
  const existing = await tx<Array<{ id: string; status: string }>>`
    SELECT id, status FROM harness_shared.trigger_runs
     WHERE workspace_id = ${input.event.workspaceId}
       AND binding_id = ${input.binding.id}
       AND dedupe_key = ${input.event.dedupeKey}`;
  if (!existing[0]) throw new Error('external_trigger_run_insert_lost');
  return { ...existing[0], inserted: false };
}

async function queueOneBinding(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
  bindingId: string,
  deliveryId: string,
): Promise<{ id: string; inserted: boolean; status: string } | null> {
  return sql.begin(async (tx) => {
    const binding = await loadBindingForUpdate(tx, event.workspaceId, bindingId);
    if (!binding?.armed) return null;
    if (!keyMatchesPattern(binding.eventPattern, event.key)) return null;
    if (!payloadMatchesFilter(binding.eventFilter, event.payload)) return null;

    if (!SUPPORTED_TRIGGER_ACTIONS.has(actionType(binding.action))) {
      return insertTerminalTriggerRun(tx, {
        event,
        binding,
        deliveryId,
        status: 'failed',
        error: `external_trigger_unsupported_action:${actionType(binding.action)}`,
      });
    }

    let storm: StormPolicy;
    try {
      storm = parseStormPolicy(binding.stormPolicy);
    } catch (cause) {
      return insertTerminalTriggerRun(tx, {
        event,
        binding,
        deliveryId,
        status: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (storm.maxRuns !== null) {
      const recent = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM harness_shared.trigger_runs
         WHERE workspace_id = ${event.workspaceId}
           AND binding_id = ${binding.id}
           AND status <> 'cancelled'
           AND triggered_at >= now() - (${storm.windowSeconds} * interval '1 second')`;
      if ((recent[0]?.count ?? 0) >= storm.maxRuns) {
        return insertTerminalTriggerRun(tx, {
          event,
          binding,
          deliveryId,
          status: 'skipped',
          error: `external_trigger_storm_limit:${storm.maxRuns}/${storm.windowSeconds}s`,
        });
      }
    }

    const args = JSON.stringify(triggerArgs(event));
    const inserted = await tx<Array<{ id: string; status: string }>>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args, updated_at)
      VALUES (${event.workspaceId}, ${binding.id}, ${deliveryId}, ${event.dedupeKey},
              'pending', ${args}::text::jsonb, now())
      ON CONFLICT (workspace_id, binding_id, dedupe_key) DO NOTHING
      RETURNING id, status`;
    if (inserted[0]) return { ...inserted[0], inserted: true };
    const existing = await tx<Array<{ id: string; status: string }>>`
      SELECT id, status FROM harness_shared.trigger_runs
       WHERE workspace_id = ${event.workspaceId}
         AND binding_id = ${binding.id}
         AND dedupe_key = ${event.dedupeKey}`;
    if (!existing[0]) throw new Error('external_trigger_run_queue_lost');
    return { ...existing[0], inserted: false };
  });
}

/** Match armed bindings and durably queue one trigger_run per match. */
export async function queueExternalTriggerBindings(
  sql: postgres.Sql,
  event: CanonicalExternalEvent,
): Promise<BindingEnqueueResult> {
  const deliveries = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND dedupe_key = ${event.dedupeKey}
       AND sink_kind = 'event-bus' AND sink_ref = 'workspace'
       AND outcome = 'delivered'
     LIMIT 1`;
  if (!deliveries[0]) throw new Error('external_trigger_event_bus_delivery_required');

  const candidates = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${event.workspaceId}
       AND source_id = ${event.sourceId}
       AND armed = TRUE
       AND detached_at IS NULL
     ORDER BY created_at, id`;

  const result: BindingEnqueueResult = {
    matched: 0,
    queued: 0,
    deduped: 0,
    skippedForStorm: 0,
    failed: 0,
    triggerRunIds: [],
  };
  for (const candidate of candidates) {
    const queued = await queueOneBinding(sql, event, candidate.id, deliveries[0].id);
    if (!queued) continue;
    result.matched += 1;
    result.triggerRunIds.push(queued.id);
    if (!queued.inserted) result.deduped += 1;
    else if (queued.status === 'pending') result.queued += 1;
    else if (queued.status === 'skipped') result.skippedForStorm += 1;
    else result.failed += 1;
  }
  return result;
}

/** The default ingestion sink; its own trigger_deliveries row dedupes enqueue. */
export function createTriggerBindingSink(sql: postgres.Sql): ExternalTriggerSink {
  return {
    kind: 'trigger-bindings',
    ref: 'workspace',
    deliver: (event) => queueExternalTriggerBindings(sql, event),
  };
}

async function claimPendingTriggerRuns(
  sql: postgres.Sql,
  batchSize: number,
  staleAfterSeconds: number,
): Promise<ClaimedTriggerRun[]> {
  return sql.begin(async (tx) => tx<ClaimedTriggerRun[]>`
    WITH candidates AS (
      SELECT tr.workspace_id, tr.id
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings binding
          ON binding.workspace_id = tr.workspace_id
         AND binding.id = tr.binding_id
         AND binding.detached_at IS NULL
       WHERE tr.attempts < ${DEFAULT_MAX_ATTEMPTS}
         AND (
           tr.status IN ('pending', 'failed')
           OR (tr.status = 'running'
               AND tr.started_at < now() - (${staleAfterSeconds} * interval '1 second'))
         )
       ORDER BY tr.triggered_at, tr.id
       FOR UPDATE SKIP LOCKED
       LIMIT ${batchSize}
    ), claimed AS (
      UPDATE harness_shared.trigger_runs tr
         SET status = 'running', attempts = tr.attempts + 1, error = NULL,
             started_at = now(), completed_at = NULL, updated_at = now()
        FROM candidates c
       WHERE tr.workspace_id = c.workspace_id AND tr.id = c.id
      RETURNING tr.*
    )
    SELECT c.id,
           c.workspace_id AS "workspaceId",
           c.binding_id AS "bindingId",
           b.plan_harness_slug AS "planHarnessSlug",
           b.plan_slug AS "planSlug",
           b.goal_id AS "goalId",
           c.args,
           b.action,
           c.attempts
      FROM claimed c
      JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = c.workspace_id
       AND b.id = c.binding_id
       AND b.detached_at IS NULL
     ORDER BY c.triggered_at, c.id`);
}

async function resolvePlanRunId(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  instanceSlug: string,
  reportedId: number,
): Promise<number> {
  if (reportedId > 0) return reportedId;
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM harness_shared.plan_runs
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND instance_plan_slug = ${instanceSlug}
     ORDER BY id DESC LIMIT 1`;
  if (!rows[0]) throw new Error('external_trigger_plan_run_replay_missing');
  return Number(rows[0].id);
}

async function announceRunWork(sql: postgres.Sql, workspaceId: string, runId: number): Promise<void> {
  const rows = await sql<Array<{
    id: string;
    kind: string;
    title: string;
    harness: string;
    state: string;
    plan: string | null;
  }>>`
    SELECT feature_id AS id, item_kind AS kind, title, harness_slug AS harness,
           status AS state, source_plan_slug AS plan
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND payload -> 'plan_run' ->> 'runId' = ${String(runId)}
       AND status = 'todo' AND taken_by IS NULL`;
  for (const row of rows) {
    const payload = {
      id: row.id,
      kind: row.kind,
      severity: null,
      harness: row.harness,
      title: row.title,
      state: row.state,
      reason: 'created',
      plan: row.plan,
      tags: [],
    };
    await emitAwaitedEvent({
      key: 'work-item:created',
      summary: `${row.id} created (${row.kind}): ${row.title}`,
      payload,
      source: 'external-trigger',
    });
    await emitAwaitedEvent({
      key: 'work-item:claimable',
      summary: `${row.id} claimable (created): ${row.title}`,
      payload,
      source: 'external-trigger',
    });
  }
}

/** Claim and execute a bounded batch from the durable trigger_runs outbox. */
export async function dispatchPendingTriggerRuns(
  sql: postgres.Sql,
  deps: TriggerDispatchDeps = {},
): Promise<TriggerDispatchResult> {
  const batchSize = Math.min(200, positiveInteger(deps.batchSize ?? DEFAULT_BATCH_SIZE, 'batch_size'));
  const staleAfterSeconds = positiveInteger(
    deps.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    'stale_after_seconds',
  );
  const rows = await claimPendingTriggerRuns(sql, batchSize, staleAfterSeconds);
  const runPlan = deps.runPlan ?? runScheduledPlanFire;
  const startGoal = deps.startGoal ?? startGoalById;
  const announce = deps.announceRunWork ?? announceRunWork;
  const result: TriggerDispatchResult = {
    claimed: rows.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    triggerRunIds: rows.map((row) => row.id),
  };

  for (const row of rows) {
    try {
      const type = actionType(row.action);
      if (!SUPPORTED_TRIGGER_ACTIONS.has(type)) {
        throw new Error(`external_trigger_unsupported_action:${type}`);
      }

      // ── start-goal (P-020): activate the binding's target goal ──────────
      // The primitive owns every guard; this leg only maps its verdict onto
      // the outbox row. plan_run_ref stays NULL — a goal run's handle is
      // outcome.goalId + outcome.agentOwnerId, never a plan-run ref.
      if (type === 'start-goal') {
        if (!row.goalId) throw new Error('external_trigger_missing_goal_target');
        const started = await startGoal(sql, {
          workspaceId: row.workspaceId,
          goalId: row.goalId,
          launcherOwnerId: `trigger-binding:${row.bindingId}`,
        });
        if (started.ok) {
          await sql`
            UPDATE harness_shared.trigger_runs
               SET status = 'succeeded',
                   outcome = outcome || ${JSON.stringify({
                     goalId: started.goalId,
                     agentOwnerId: started.ownerId,
                     ...(started.warnings.length ? { warnings: started.warnings } : {}),
                   })}::text::jsonb,
                   error = NULL, completed_at = now(), updated_at = now()
             WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
          result.succeeded += 1;
        } else if (started.reason === 'holder-unknown' || started.reason === 'not-ready') {
          // Heal-able refusals: liveness evidence recovers, prerequisites
          // complete. Throw → 'failed' → the outbox retries under attempts.
          throw new Error(`external_trigger_goal_start_refused:${started.reason}:${started.detail}`);
        } else {
          // Terminal refusals (not-found / not-active / no-harness /
          // already-held): the trigger's intent is settled — never retried.
          await sql`
            UPDATE harness_shared.trigger_runs
               SET status = 'skipped',
                   outcome = outcome || ${JSON.stringify({ goalId: row.goalId, refusal: started.reason })}::text::jsonb,
                   error = ${started.detail}, completed_at = now(), updated_at = now()
             WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
          result.skipped += 1;
        }
        continue;
      }

      // ── launch-plan (the original path) ─────────────────────────────────
      if (!row.planHarnessSlug || !row.planSlug) {
        throw new Error('external_trigger_missing_plan_target');
      }
      const launched = await runPlan(sql, {
        installSlug: row.planHarnessSlug,
        workspaceId: row.workspaceId,
        templateSlug: row.planSlug,
        trigger: 'event',
        runToken: triggerRunPlanToken(row.id),
        inputs: row.args,
      });
      if (!launched || launched.skippedForConcurrency) {
        throw new Error('external_trigger_plan_run_not_started');
      }
      const planRunId = await resolvePlanRunId(
        sql,
        row.workspaceId,
        row.planHarnessSlug,
        launched.instanceSlug,
        launched.runId,
      );
      await announce(sql, row.workspaceId, planRunId);
      await sql`
        UPDATE harness_shared.trigger_runs
           SET status = 'succeeded', plan_run_ref = ${String(planRunId)},
               outcome = outcome || ${JSON.stringify({
                 instancePlanSlug: launched.instanceSlug,
                 planRunId,
                 minted: launched.minted,
                 replayed: launched.replayed,
               })}::text::jsonb,
               error = NULL, completed_at = now(), updated_at = now()
         WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
      result.succeeded += 1;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await sql`
        UPDATE harness_shared.trigger_runs
           SET status = 'failed', error = ${error}, completed_at = now(), updated_at = now()
         WHERE workspace_id = ${row.workspaceId} AND id = ${row.id}`;
      result.failed += 1;
    }
  }
  return result;
}
