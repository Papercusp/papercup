import { randomUUID } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { notifyAttentionOnce } from '../attention-notify';
import {
  classifyHostedLifecycleJob,
  evaluateHostedLifecycleAdmission,
  type HostedBillingOwner,
  type HostedCostEstimate,
  type HostedLifecycleAction,
  type HostedLifecycleAdmissionDecision,
  type HostedLifecycleApprovalStatus,
  type HostedLifecyclePolicy,
  type HostedLifecycleRiskTier,
} from './hosted-lifecycle-policy';

type TxRunner = <T>(workspaceId: string, fn: (tx: Sql) => Promise<T>) => Promise<T>;
type Notify = typeof notifyAttentionOnce;

interface HostedLifecycleStoreHooks {
  transaction?: TxRunner;
  notify?: Notify;
  uuid?: () => string;
}

function hooks(): HostedLifecycleStoreHooks {
  const root = globalThis as typeof globalThis & {
    __papercuspHostedLifecycleStoreHooks__?: HostedLifecycleStoreHooks;
  };
  return (root.__papercuspHostedLifecycleStoreHooks__ ??= {});
}

/** Test seam; production always resolves the canonical workspace transaction + attention rail. */
export function setHostedLifecycleStoreHooks(next: HostedLifecycleStoreHooks | null): void {
  const target = hooks();
  for (const key of Object.keys(target) as Array<keyof HostedLifecycleStoreHooks>) delete target[key];
  if (next) Object.assign(target, next);
}

function transaction<T>(workspaceId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (hooks().transaction ?? withWorkspace)(workspaceId, fn);
}

function notify(input: Parameters<Notify>[0]): ReturnType<Notify> {
  return (hooks().notify ?? notifyAttentionOnce)(input);
}

function uuid(): string {
  return (hooks().uuid ?? randomUUID)();
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`hosted_lifecycle_${name}_required`);
  return trimmed;
}

function safeInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`hosted_lifecycle_${name}_invalid`);
  return value;
}

interface DirectoryRow {
  organization_id: string;
  customer_workspace_id: string;
  workspace_host_id: string;
  provider_target: string;
  state: string;
  tenant_concurrency_limit: number;
  provider_concurrency_limit: number;
  monthly_lifecycle_budget_cents: string | number | null;
  lifecycle_budget_period_started_at: Date | string;
  billing_owner_kind: HostedBillingOwner['kind'] | null;
  billing_owner_id: string | null;
  idle_stop_after_minutes: number | null;
}

interface AdmissionCountRow {
  active_tenant_jobs: number;
  active_provider_jobs: number;
  committed_monthly_cents: string | number;
}

export interface AdmitHostedLifecycleJobInput {
  workspaceId: string;
  customerWorkspaceId: string;
  hostId: string;
  providerTarget: string;
  action: HostedLifecycleAction;
  actorId: string;
  riskTier: HostedLifecycleRiskTier;
  approvalStatus: HostedLifecycleApprovalStatus;
  approvedByPrincipalId?: string;
  approvedAt?: string;
  estimate: HostedCostEstimate;
  billingOwner?: HostedBillingOwner;
  emergencyTeardown?: boolean;
  teardownReason?: string;
  operationId?: string;
  request?: unknown;
  policy?: Partial<HostedLifecyclePolicy>;
}

export interface HostedLifecycleAdmissionReceipt {
  operationId: string;
  created: boolean;
  decision: HostedLifecycleAdmissionDecision;
  organizationId: string;
  customerWorkspaceId: string;
  providerTarget: string;
}

export class HostedLifecycleAdmissionError extends Error {
  constructor(readonly decision: HostedLifecycleAdmissionDecision) {
    super(`hosted lifecycle admission rejected: ${decision.reasons.join('; ')}`);
    this.name = 'HostedLifecycleAdmissionError';
  }
}

function policyFrom(row: DirectoryRow, override?: Partial<HostedLifecyclePolicy>): HostedLifecyclePolicy {
  return {
    tenantConcurrencyLimit: row.tenant_concurrency_limit,
    providerConcurrencyLimit: row.provider_concurrency_limit,
    monthlyBudgetCents: row.monthly_lifecycle_budget_cents == null
      ? null
      : Number(row.monthly_lifecycle_budget_cents),
    idleStopAfterMinutes: row.idle_stop_after_minutes,
    approvalRequiredAt: 'high',
    stuckAfterMs: 5 * 60_000,
    orphanAfterMs: 20 * 60_000,
    maxRecoveryAttempts: 3,
    ...override,
  };
}

/**
 * Atomically admit one hosted lifecycle job.
 *
 * The provider lock serializes the global provider cap and the tenant lock serializes the tenant
 * cap/budget. Both live in the same transaction as the canonical operation-row insert.
 */
export async function admitHostedLifecycleJob(
  raw: AdmitHostedLifecycleJobInput,
): Promise<HostedLifecycleAdmissionReceipt> {
  const input = {
    ...raw,
    workspaceId: required(raw.workspaceId, 'workspace_id'),
    customerWorkspaceId: required(raw.customerWorkspaceId, 'customer_workspace_id'),
    hostId: required(raw.hostId, 'host_id'),
    providerTarget: required(raw.providerTarget, 'provider_target'),
    actorId: required(raw.actorId, 'actor_id'),
    operationId: required(raw.operationId ?? uuid(), 'operation_id'),
  };
  safeInt(input.estimate.cents, 'estimate_cents');

  return transaction(input.workspaceId, async (tx) => {
    const providerLock = `hosted-lifecycle:provider:${input.workspaceId}:${input.providerTarget}`;
    const tenantLock = `hosted-lifecycle:tenant:${input.workspaceId}:${input.customerWorkspaceId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${providerLock}, 0))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${tenantLock}, 0))`;

    const directory = await tx<DirectoryRow[]>`
      SELECT
        customer.organization_id,
        customer.id AS customer_workspace_id,
        customer.workspace_host_id,
        host.target AS provider_target,
        customer.state,
        customer.tenant_concurrency_limit,
        customer.provider_concurrency_limit,
        customer.monthly_lifecycle_budget_cents,
        customer.lifecycle_budget_period_started_at,
        customer.billing_owner_kind,
        customer.billing_owner_id,
        customer.idle_stop_after_minutes
      FROM harness_shared.customer_workspaces customer
      JOIN harness_shared.workspace_hosts host
        ON host.workspace_id = customer.workspace_id
       AND host.id = customer.workspace_host_id
      WHERE customer.workspace_id = ${input.workspaceId}
        AND customer.id = ${input.customerWorkspaceId}
        AND customer.workspace_host_id = ${input.hostId}
      LIMIT 1`;
    const row = directory[0];
    if (!row) throw new Error('hosted_lifecycle_customer_workspace_not_found');
    if (row.state === 'deleted' || row.state === 'offboarding') {
      throw new Error(`hosted_lifecycle_customer_workspace_${row.state}`);
    }
    if (row.provider_target !== input.providerTarget) {
      throw new Error('hosted_lifecycle_provider_target_mismatch');
    }

    const counts = await tx<AdmissionCountRow[]>`
      SELECT
        count(*) FILTER (
          WHERE customer_workspace_id = ${input.customerWorkspaceId}
            AND status IN ('queued', 'running')
        )::int AS active_tenant_jobs,
        count(*) FILTER (
          WHERE provider_target = ${input.providerTarget}
            AND status IN ('queued', 'running')
        )::int AS active_provider_jobs,
        coalesce(sum(estimated_cost_cents) FILTER (
          WHERE customer_workspace_id = ${input.customerWorkspaceId}
            AND created_at >= ${row.lifecycle_budget_period_started_at}
            AND action <> 'destroy'
            AND status <> 'failed'
        ), 0)::text AS committed_monthly_cents
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${input.workspaceId}`;
    const snapshot = counts[0] ?? {
      active_tenant_jobs: 0,
      active_provider_jobs: 0,
      committed_monthly_cents: 0,
    };
    const billingOwner = input.billingOwner ?? (
      row.billing_owner_kind && row.billing_owner_id
        ? { kind: row.billing_owner_kind, id: row.billing_owner_id }
        : null
    );
    if (!billingOwner) throw new Error('hosted_lifecycle_billing_owner_required');

    const decision = evaluateHostedLifecycleAdmission(
      policyFrom(row, input.policy),
      {
        activeTenantJobs: Number(snapshot.active_tenant_jobs),
        activeProviderJobs: Number(snapshot.active_provider_jobs),
        committedMonthlyCents: Number(snapshot.committed_monthly_cents),
      },
      {
        action: input.action,
        riskTier: input.riskTier,
        approvalStatus: input.approvalStatus,
        estimate: input.estimate,
        billingOwner,
        emergencyTeardown: input.emergencyTeardown,
        teardownReason: input.teardownReason,
      },
    );
    if (!decision.allowed) throw new HostedLifecycleAdmissionError(decision);

    const approvedBy = input.approvalStatus === 'approved'
      ? required(input.approvedByPrincipalId ?? '', 'approved_by')
      : null;
    const approvedAt = input.approvalStatus === 'approved'
      ? required(input.approvedAt ?? '', 'approved_at')
      : null;
    const inserted = await tx<Array<{ id: string }>>`
      INSERT INTO harness_shared.workspace_host_operations (
        workspace_id, id, host_id, action, status, percent, message, request,
        organization_id, customer_workspace_id, provider_target,
        estimated_cost_cents, cost_currency, cost_estimate_source,
        cost_estimate_ref, cost_estimated_at,
        billing_owner_kind, billing_owner_id,
        risk_tier, approval_status, approved_by_principal_id, approved_at,
        heartbeat_at, emergency_teardown, teardown_reason, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.operationId}, ${input.hostId}, ${input.action},
        'queued', 0, 'Hosted lifecycle job admitted',
        ${input.request === undefined ? null : JSON.stringify(input.request)},
        ${row.organization_id}, ${input.customerWorkspaceId}, ${input.providerTarget},
        ${input.estimate.cents}, ${input.estimate.currency}, ${input.estimate.source},
        ${input.estimate.evidenceRef}, ${input.estimate.estimatedAt},
        ${billingOwner.kind}, ${billingOwner.id},
        ${input.riskTier}, ${input.approvalStatus}, ${approvedBy}, ${approvedAt},
        now(), ${input.emergencyTeardown ?? false}, ${input.teardownReason ?? null}, now()
      )
      ON CONFLICT (workspace_id, id) DO NOTHING
      RETURNING id`;
    return {
      operationId: input.operationId,
      created: inserted.length === 1,
      decision,
      organizationId: row.organization_id,
      customerWorkspaceId: input.customerWorkspaceId,
      providerTarget: input.providerTarget,
    };
  });
}

export async function heartbeatHostedLifecycleJob(
  workspaceId: string,
  operationId: string,
  message = 'Hosted lifecycle worker heartbeat',
): Promise<boolean> {
  return transaction(required(workspaceId, 'workspace_id'), async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      UPDATE harness_shared.workspace_host_operations
      SET heartbeat_at = now(), message = ${message}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${required(operationId, 'operation_id')}
        AND status IN ('queued', 'running')
      RETURNING id`;
    return rows.length === 1;
  });
}

/**
 * One row of the reconciliation sweep.
 *
 * Deliberately NOT `extends DirectoryRow`. Reconciliation covers BYOC-connection operations as
 * well as hosted ones, and a BYOC operation has no `customer_workspaces` row at all — so every
 * customer-derived column is genuinely nullable here. Inheriting DirectoryRow typed them as
 * non-null strings, which is a claim the data cannot honour — `customer_workspace_id` is read
 * straight off the operation row, and for a BYOC operation it is NULL.
 */
interface ReconciliationRow {
  operation_id: string;
  host_id: string;
  action: HostedLifecycleAction;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  heartbeat_at: Date | string | null;
  operation_updated_at: Date | string;
  recovery_attempts: number;
  /** NULL for a BYOC-connection operation, which has no `customer_workspaces` row. Read straight
   *  off the operation — this sweep must never join `customer_workspaces` (see the note on
   *  `reconcileHostedLifecycleJobs`: `harness_app` has no privilege on that relation). */
  customer_workspace_id: string | null;
}

/**
 * The policy reconciliation actually consults.
 *
 * `classifyHostedLifecycleJob` reads ONLY `maxRecoveryAttempts`, `stuckAfterMs` and
 * `orphanAfterMs`; every tenant/concurrency/budget/idle field on `HostedLifecyclePolicy` belongs
 * to ADMISSION, which is a different function on a different code path. `policyFrom` already
 * hard-codes these same three values and reconciliation never passed it an override, so hosted
 * rows classify EXACTLY as before — but sourcing them from constants is what lets the sweep
 * classify an operation that has no customer row, and it removes the only reason reconciliation
 * ever had to join `customer_workspaces` at all.
 *
 * The admission-only fields are present solely to satisfy the shared shape. Do not start reading
 * one here without first deciding what it should mean for a BYOC operation, which has no tenant
 * or budget row to answer with.
 */
const RECONCILIATION_POLICY: HostedLifecyclePolicy = {
  tenantConcurrencyLimit: 0,
  providerConcurrencyLimit: 0,
  monthlyBudgetCents: null,
  idleStopAfterMinutes: null,
  approvalRequiredAt: 'high',
  stuckAfterMs: 5 * 60_000,
  orphanAfterMs: 20 * 60_000,
  maxRecoveryAttempts: 3,
};

/** What a notice names as the subject: the customer workspace when there is one, else the host. */
function reconciliationSubject(job: ReconciliationRow): string {
  return job.customer_workspace_id ?? `host ${job.host_id}`;
}

export interface HostedLifecycleReconciliationResult {
  recoveryPending: string[];
  orphaned: string[];
  exhausted: string[];
  notifications: string[];
}

/**
 * Classify stale work and emit replay-safe owner notices, for EVERY workspace-host lifecycle
 * operation — BYOC-connection operations included, not only hosted/customer ones.
 *
 * ⛔ THIS SWEEP READS `workspace_host_operations` AND NOTHING ELSE. IT USED TO INNER-JOIN
 * `customer_workspaces`, AND THAT MADE IT BLIND TO THE EXACT FAILURE IT EXISTS FOR (WI-2143803).
 * An operation created through the BYOC `/api/workspace-hosts/action` route carries
 * `customer_workspace_id = NULL`, so an inner join to `customer_workspaces` eliminated every one
 * of them. Measured on a live rig DB 2026-09-04: an operation orphaned by controller termination
 * sat at `running|99` with `recovery_state='none'` and `heartbeat_at` NULL; 38 of 38 operations
 * had a NULL `customer_workspace_id`; and `customer_workspaces` held 0 rows. DBOS
 * recovery-on-relaunch does not cover for it either — the host process was fully restarted and
 * the row's `updated_at` never moved.
 *
 * That made the defect two-layered, and only the outer layer was obvious: the function had no
 * production caller, AND it could not have recovered the row even when called. Scheduling it
 * without fixing the read would have produced a sweep that runs, passes, and matches nothing.
 *
 * ⛔ AND THE JOIN COULD NOT RUN AT ALL IN PRODUCTION — DO NOT REINTRODUCE ONE. `customer_workspaces`
 * is granted to `hosted_app`, and migration 997 grants that role to the pool role `harness_app`
 * `WITH INHERIT FALSE`, so privileges are NOT inherited without an explicit `SET LOCAL ROLE`.
 * `transaction()` here resolves to `withWorkspace`, which runs as plain `harness_app` and never
 * assumes `hosted_app`. Measured on the rig 2026-09-04, the moment this sweep first had a real
 * caller: `PostgresError: permission denied for table customer_workspaces`. It had been latent
 * for exactly as long as the function had no caller — a sweep that would have thrown on EVERY
 * tick. Widening the join to LEFT (the first fix attempted) does not help: the permission check
 * is on the RELATION, not the rows.
 *
 * The fix is that neither join was load-bearing. `customer.id` is by definition equal to
 * `operation.customer_workspace_id`, which is already a column on the operations table (the join
 * could only ever differ by yielding NULL for a dangling reference — and naming the id the
 * operation actually carries is the better notice subject anyway). `host.target` was selected and
 * never read by this function at all. So both were dropped: the sweep now touches only the ledger
 * it reconciles, a table `harness_app` fully owns, and it no longer depends on a role grant to
 * classify a stale operation.
 *
 * Every column this sweep does not read was dropped from the SELECT. `organization_id`,
 * `billing_owner_*`, `state` and the tenant/budget limits are ADMISSION inputs
 * (`admitHostedLifecycleJob`); reconciliation never consulted them, and continuing to select them
 * would only re-create the impression that a customer row is required here.
 *
 * NOTE: this reconciler used to also queue idle-stop jobs by reading
 * `customer_workspaces.idle_stop_after_minutes` / `.last_activity_at`. Those two columns have no
 * production writer anywhere in this tree (only migration integration tests set them), so that
 * WHERE clause could never match a row and the sweep was structurally inert — retired per
 * EI-21900891864984654 rather than left as dead code that looks live and passes in tests. The
 * pure policy decision (`evaluateHostedIdleStop`, including its P-014 desktop-viewer-signal
 * input) is unchanged in `hosted-lifecycle-policy.ts` for whoever lands the real
 * `customer_workspaces` provisioning writer to call from here.
 */
export async function reconcileHostedLifecycleJobs(
  workspaceId: string,
  now = new Date(),
): Promise<HostedLifecycleReconciliationResult> {
  const notices: Array<{ key: string; title: string; body: string; operationId: string }> = [];
  const result = await transaction(required(workspaceId, 'workspace_id'), async (tx) => {
    const out: HostedLifecycleReconciliationResult = {
      recoveryPending: [], orphaned: [], exhausted: [], notifications: [],
    };
    const jobs = await tx<ReconciliationRow[]>`
      SELECT
        operation.id AS operation_id, operation.host_id, operation.action, operation.status,
        operation.heartbeat_at, operation.updated_at AS operation_updated_at,
        operation.recovery_attempts,
        operation.customer_workspace_id
      FROM harness_shared.workspace_host_operations operation
      WHERE operation.workspace_id = ${workspaceId}
        AND operation.status IN ('queued', 'running')
      ORDER BY operation.updated_at, operation.id
      FOR UPDATE OF operation`;

    for (const job of jobs) {
      const health = classifyHostedLifecycleJob({
        status: job.status,
        heartbeatAt: job.heartbeat_at == null ? null : String(job.heartbeat_at),
        updatedAt: String(job.operation_updated_at),
        recoveryAttempts: job.recovery_attempts,
      }, RECONCILIATION_POLICY, now.getTime());
      if (health === 'healthy' || health === 'terminal') continue;
      if (health === 'stuck') {
        await tx`
          UPDATE harness_shared.workspace_host_operations
          SET recovery_state = 'recovery-pending', recovery_attempts = recovery_attempts + 1,
              message = 'Lifecycle operation is stuck; DBOS recovery requested', updated_at = now()
          WHERE workspace_id = ${workspaceId} AND id = ${job.operation_id}`;
        out.recoveryPending.push(job.operation_id);
        continue;
      }
      if (health === 'orphaned') {
        await tx`
          UPDATE harness_shared.workspace_host_operations
          SET recovery_state = 'orphaned', orphaned_at = ${now.toISOString()},
              message = 'Lifecycle operation is orphaned and requires provider reconciliation',
              updated_at = now()
          WHERE workspace_id = ${workspaceId} AND id = ${job.operation_id}`;
        out.orphaned.push(job.operation_id);
        notices.push({
          key: `hosted-lifecycle:${workspaceId}:${job.operation_id}:orphaned`,
          operationId: job.operation_id,
          title: 'Workspace-host lifecycle operation orphaned',
          body: `${job.action} on ${reconciliationSubject(job)} stopped heartbeating; provider reconciliation is required.`,
        });
        continue;
      }
      await tx`
        UPDATE harness_shared.workspace_host_operations
        SET recovery_state = 'exhausted', status = 'failed', finished_at = now(),
            message = 'Lifecycle recovery attempts exhausted',
            error = jsonb_build_object('code', 'hosted_lifecycle_recovery_exhausted'),
            updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${job.operation_id}`;
      out.exhausted.push(job.operation_id);
      notices.push({
        key: `hosted-lifecycle:${workspaceId}:${job.operation_id}:exhausted`,
        operationId: job.operation_id,
        title: 'Workspace-host lifecycle recovery exhausted',
        body: `${job.action} on ${reconciliationSubject(job)} exhausted its bounded recovery attempts.`,
      });
    }

    return out;
  });

  for (const notice of notices) {
    await notify({
      kind: 'intervention',
      title: notice.title,
      body: notice.body,
      importance: notice.title.includes('exhausted') ? 'high' : 'normal',
      workspaceId,
      dedupeKey: notice.key,
      data: { operationId: notice.operationId, source: 'hosted-lifecycle' },
    });
    result.notifications.push(notice.key);
  }
  return result;
}

export interface HostedLifecycleSupportDiagnostics {
  workspaceId: string;
  generatedAt: string;
  counts: {
    queued: number;
    running: number;
    stuck: number;
    orphaned: number;
    exhausted: number;
  };
  jobs: Array<Record<string, unknown>>;
}

/** Operator-visible, secret-free support projection from the same canonical ledger. */
export async function readHostedLifecycleSupportDiagnostics(
  workspaceId: string,
  limit = 100,
): Promise<HostedLifecycleSupportDiagnostics> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return transaction(required(workspaceId, 'workspace_id'), async (tx) => {
    const [counts] = await tx<Array<Record<string, number>>>`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE recovery_state IN ('stuck', 'recovery-pending', 'recovering'))::int AS stuck,
        count(*) FILTER (WHERE recovery_state = 'orphaned')::int AS orphaned,
        count(*) FILTER (WHERE recovery_state = 'exhausted')::int AS exhausted
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND customer_workspace_id IS NOT NULL`;
    const jobs = await tx<Array<Record<string, unknown>>>`
      SELECT id, host_id, action, status, percent, message,
             organization_id, customer_workspace_id, provider_target,
             estimated_cost_cents, cost_currency, cost_estimate_source,
             cost_estimate_ref, cost_estimated_at,
             billing_owner_kind, billing_owner_id,
             risk_tier, approval_status, heartbeat_at,
             recovery_state, recovery_attempts, orphaned_at,
             emergency_teardown, teardown_reason,
             created_at, started_at, finished_at, updated_at
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND customer_workspace_id IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT ${boundedLimit}`;
    return {
      workspaceId,
      generatedAt: new Date().toISOString(),
      counts: {
        queued: Number(counts?.queued ?? 0),
        running: Number(counts?.running ?? 0),
        stuck: Number(counts?.stuck ?? 0),
        orphaned: Number(counts?.orphaned ?? 0),
        exhausted: Number(counts?.exhausted ?? 0),
      },
      jobs,
    };
  });
}

