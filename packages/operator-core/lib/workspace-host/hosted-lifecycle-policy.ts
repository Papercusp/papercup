/**
 * Pure policy for hosted workspace lifecycle admission and reconciliation (P-040 / D-146).
 *
 * Persistence lives in hosted-lifecycle-store.ts. Keeping the decision layer pure makes quota,
 * budget, approval, idle-stop, and recovery behavior deterministic and cheap to falsify.
 */

export type HostedLifecycleRiskTier = 'low' | 'moderate' | 'high' | 'critical';
export type HostedLifecycleApprovalStatus = 'not-required' | 'pending' | 'approved' | 'rejected';
export type HostedLifecycleAction =
  | 'provision'
  | 'start'
  | 'stop'
  | 'restart'
  | 'snapshot'
  | 'restore'
  | 'upgrade'
  | 'repair'
  | 'destroy';

export interface HostedLifecyclePolicy {
  tenantConcurrencyLimit: number;
  providerConcurrencyLimit: number;
  monthlyBudgetCents: number | null;
  idleStopAfterMinutes: number | null;
  approvalRequiredAt: HostedLifecycleRiskTier;
  stuckAfterMs: number;
  orphanAfterMs: number;
  maxRecoveryAttempts: number;
}

export const DEFAULT_HOSTED_LIFECYCLE_POLICY: HostedLifecyclePolicy = {
  tenantConcurrencyLimit: 2,
  providerConcurrencyLimit: 8,
  monthlyBudgetCents: null,
  idleStopAfterMinutes: 60,
  approvalRequiredAt: 'high',
  stuckAfterMs: 5 * 60_000,
  orphanAfterMs: 20 * 60_000,
  maxRecoveryAttempts: 3,
};

export interface HostedCostEstimate {
  cents: number;
  currency: string;
  source: string;
  evidenceRef: string;
  estimatedAt: string;
}

export interface HostedBillingOwner {
  kind: 'organization' | 'customer' | 'platform';
  id: string;
}

export interface HostedLifecycleAdmissionRequest {
  action: HostedLifecycleAction;
  riskTier: HostedLifecycleRiskTier;
  approvalStatus: HostedLifecycleApprovalStatus;
  estimate: HostedCostEstimate;
  billingOwner: HostedBillingOwner;
  emergencyTeardown?: boolean;
  teardownReason?: string;
}

export interface HostedLifecycleAdmissionSnapshot {
  activeTenantJobs: number;
  activeProviderJobs: number;
  committedMonthlyCents: number;
}

export interface HostedLifecycleAdmissionDecision {
  allowed: boolean;
  reasons: string[];
  projectedMonthlyCents: number;
  emergencyBypass: boolean;
}

const RISK_WEIGHT: Record<HostedLifecycleRiskTier, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateHostedLifecyclePolicy(policy: HostedLifecyclePolicy): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(policy.tenantConcurrencyLimit) || policy.tenantConcurrencyLimit < 1) {
    problems.push('tenantConcurrencyLimit must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.providerConcurrencyLimit) || policy.providerConcurrencyLimit < 1) {
    problems.push('providerConcurrencyLimit must be a positive integer');
  }
  if (policy.monthlyBudgetCents !== null && !finiteInteger(policy.monthlyBudgetCents)) {
    problems.push('monthlyBudgetCents must be a non-negative safe integer or null');
  }
  if (policy.idleStopAfterMinutes !== null &&
      (!Number.isSafeInteger(policy.idleStopAfterMinutes) || policy.idleStopAfterMinutes < 1)) {
    problems.push('idleStopAfterMinutes must be a positive integer or null');
  }
  if (!finiteInteger(policy.stuckAfterMs) || policy.stuckAfterMs < 1_000) {
    problems.push('stuckAfterMs must be at least 1000');
  }
  if (!finiteInteger(policy.orphanAfterMs) || policy.orphanAfterMs <= policy.stuckAfterMs) {
    problems.push('orphanAfterMs must be greater than stuckAfterMs');
  }
  if (!Number.isSafeInteger(policy.maxRecoveryAttempts) || policy.maxRecoveryAttempts < 0) {
    problems.push('maxRecoveryAttempts must be a non-negative integer');
  }
  return problems;
}

export function validateHostedCostEstimate(estimate: HostedCostEstimate): string[] {
  const problems: string[] = [];
  if (!finiteInteger(estimate.cents)) problems.push('estimate.cents must be a non-negative safe integer');
  if (!/^[A-Z]{3}$/.test(estimate.currency)) problems.push('estimate.currency must be an ISO-4217 code');
  if (!nonEmpty(estimate.source)) problems.push('estimate.source is required');
  if (!nonEmpty(estimate.evidenceRef)) problems.push('estimate.evidenceRef is required');
  if (!validIso(estimate.estimatedAt)) problems.push('estimate.estimatedAt must be an ISO timestamp');
  return problems;
}

export function evaluateHostedLifecycleAdmission(
  policy: HostedLifecyclePolicy,
  snapshot: HostedLifecycleAdmissionSnapshot,
  request: HostedLifecycleAdmissionRequest,
): HostedLifecycleAdmissionDecision {
  const reasons = [
    ...validateHostedLifecyclePolicy(policy),
    ...validateHostedCostEstimate(request.estimate),
  ];
  if (!nonEmpty(request.billingOwner.id)) reasons.push('billingOwner.id is required');
  if (![snapshot.activeTenantJobs, snapshot.activeProviderJobs, snapshot.committedMonthlyCents]
    .every(finiteInteger)) {
    reasons.push('admission snapshot counters must be non-negative safe integers');
  }

  const emergencyBypass = request.emergencyTeardown === true;
  if (emergencyBypass) {
    if (request.action !== 'destroy') reasons.push('emergency teardown is valid only for destroy');
    if (!nonEmpty(request.teardownReason ?? '')) reasons.push('emergency teardown requires a reason');
  }

  const requiresApproval = RISK_WEIGHT[request.riskTier] >= RISK_WEIGHT[policy.approvalRequiredAt];
  if (request.approvalStatus === 'rejected') reasons.push('lifecycle request was rejected');
  if (requiresApproval && request.approvalStatus !== 'approved') {
    reasons.push(`risk tier ${request.riskTier} requires approval`);
  }

  const projectedMonthlyCents = snapshot.committedMonthlyCents + request.estimate.cents;
  if (!emergencyBypass) {
    if (snapshot.activeTenantJobs >= policy.tenantConcurrencyLimit) {
      reasons.push('tenant concurrency limit reached');
    }
    if (snapshot.activeProviderJobs >= policy.providerConcurrencyLimit) {
      reasons.push('provider concurrency limit reached');
    }
    if (policy.monthlyBudgetCents !== null && projectedMonthlyCents > policy.monthlyBudgetCents) {
      reasons.push('monthly lifecycle budget exceeded');
    }
  }

  return { allowed: reasons.length === 0, reasons, projectedMonthlyCents, emergencyBypass };
}

export type HostedLifecycleJobHealth = 'healthy' | 'stuck' | 'orphaned' | 'recovery-exhausted' | 'terminal';

export interface HostedLifecycleJobObservation {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  heartbeatAt?: string | null;
  updatedAt: string;
  recoveryAttempts: number;
}

export function classifyHostedLifecycleJob(
  job: HostedLifecycleJobObservation,
  policy: HostedLifecyclePolicy,
  now = Date.now(),
): HostedLifecycleJobHealth {
  if (job.status === 'succeeded' || job.status === 'failed') return 'terminal';
  if (job.recoveryAttempts >= policy.maxRecoveryAttempts) return 'recovery-exhausted';
  const heartbeat = Date.parse(job.heartbeatAt || job.updatedAt);
  if (!Number.isFinite(heartbeat)) return 'orphaned';
  const age = Math.max(0, now - heartbeat);
  if (age >= policy.orphanAfterMs) return 'orphaned';
  if (age >= policy.stuckAfterMs) return 'stuck';
  return 'healthy';
}

export interface HostedWorkspaceActivity {
  state: string;
  observedState: string;
  lastActivityAt?: string | null;
  idleStopAfterMinutes?: number | null;
  activeLifecycleJobs: number;
}

export interface HostedIdleStopDecision {
  due: boolean;
  idleForMs: number;
  reason?: string;
}

export function evaluateHostedIdleStop(
  workspace: HostedWorkspaceActivity,
  now = Date.now(),
): HostedIdleStopDecision {
  if (workspace.state !== 'active') return { due: false, idleForMs: 0 };
  if (workspace.observedState !== 'running') return { due: false, idleForMs: 0 };
  if (workspace.activeLifecycleJobs > 0) return { due: false, idleForMs: 0 };
  const minutes = workspace.idleStopAfterMinutes;
  if (minutes == null || !Number.isSafeInteger(minutes) || minutes < 1) {
    return { due: false, idleForMs: 0 };
  }
  const lastActivity = Date.parse(workspace.lastActivityAt ?? '');
  if (!Number.isFinite(lastActivity)) return { due: false, idleForMs: 0 };
  const idleForMs = Math.max(0, now - lastActivity);
  const due = idleForMs >= minutes * 60_000;
  return {
    due,
    idleForMs,
    ...(due ? { reason: `workspace idle for ${Math.floor(idleForMs / 60_000)} minutes` } : {}),
  };
}

