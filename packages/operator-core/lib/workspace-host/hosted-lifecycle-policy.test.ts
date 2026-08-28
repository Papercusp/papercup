import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOSTED_LIFECYCLE_POLICY,
  classifyHostedLifecycleJob,
  evaluateHostedIdleStop,
  evaluateHostedLifecycleAdmission,
  type HostedLifecycleAdmissionRequest,
} from './hosted-lifecycle-policy';

const request: HostedLifecycleAdmissionRequest = {
  action: 'start',
  riskTier: 'moderate',
  approvalStatus: 'not-required',
  estimate: {
    cents: 1_500,
    currency: 'USD',
    source: 'gcp-catalog-v1',
    evidenceRef: 'gcp://catalog/e2-small/2026-08-28',
    estimatedAt: '2026-08-28T00:00:00Z',
  },
  billingOwner: { kind: 'organization', id: 'org-1' },
};

describe('hosted lifecycle policy', () => {
  it('admits a provenance-backed job within tenant, provider, budget, and risk limits', () => {
    expect(evaluateHostedLifecycleAdmission(
      { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, monthlyBudgetCents: 10_000 },
      { activeTenantJobs: 1, activeProviderJobs: 2, committedMonthlyCents: 4_000 },
      request,
    )).toEqual({
      allowed: true,
      reasons: [],
      projectedMonthlyCents: 5_500,
      emergencyBypass: false,
    });
  });

  it('fails closed on every admission boundary and missing estimate provenance', () => {
    const decision = evaluateHostedLifecycleAdmission(
      {
        ...DEFAULT_HOSTED_LIFECYCLE_POLICY,
        tenantConcurrencyLimit: 1,
        providerConcurrencyLimit: 2,
        monthlyBudgetCents: 5_000,
      },
      { activeTenantJobs: 1, activeProviderJobs: 2, committedMonthlyCents: 4_000 },
      {
        ...request,
        riskTier: 'critical',
        approvalStatus: 'pending',
        estimate: { ...request.estimate, evidenceRef: '', cents: 1_500 },
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'estimate.evidenceRef is required',
      'risk tier critical requires approval',
      'tenant concurrency limit reached',
      'provider concurrency limit reached',
      'monthly lifecycle budget exceeded',
    ]));
  });

  it('lets only an attributed, reasoned destroy bypass capacity and budget', () => {
    const decision = evaluateHostedLifecycleAdmission(
      { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, monthlyBudgetCents: 0 },
      { activeTenantJobs: 99, activeProviderJobs: 99, committedMonthlyCents: 99_000 },
      {
        ...request,
        action: 'destroy',
        riskTier: 'high',
        approvalStatus: 'approved',
        emergencyTeardown: true,
        teardownReason: 'provider credential revoked; remove orphaned resources',
      },
    );
    expect(decision).toMatchObject({ allowed: true, reasons: [], emergencyBypass: true });

    expect(evaluateHostedLifecycleAdmission(
      DEFAULT_HOSTED_LIFECYCLE_POLICY,
      { activeTenantJobs: 0, activeProviderJobs: 0, committedMonthlyCents: 0 },
      { ...request, emergencyTeardown: true },
    ).reasons).toEqual(expect.arrayContaining([
      'emergency teardown is valid only for destroy',
      'emergency teardown requires a reason',
    ]));
  });

  it('classifies healthy, stuck, orphaned, exhausted, and terminal jobs from the heartbeat writer', () => {
    const policy = { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, stuckAfterMs: 1_000, orphanAfterMs: 5_000 };
    const now = Date.parse('2026-08-28T00:00:10Z');
    const job = {
      status: 'running' as const,
      heartbeatAt: '2026-08-28T00:00:09.500Z',
      updatedAt: '2026-08-28T00:00:00Z',
      recoveryAttempts: 0,
    };
    expect(classifyHostedLifecycleJob(job, policy, now)).toBe('healthy');
    expect(classifyHostedLifecycleJob({ ...job, heartbeatAt: '2026-08-28T00:00:07Z' }, policy, now)).toBe('stuck');
    expect(classifyHostedLifecycleJob({ ...job, heartbeatAt: '2026-08-28T00:00:04Z' }, policy, now)).toBe('orphaned');
    expect(classifyHostedLifecycleJob({ ...job, recoveryAttempts: policy.maxRecoveryAttempts }, policy, now))
      .toBe('recovery-exhausted');
    expect(classifyHostedLifecycleJob({ ...job, status: 'succeeded' }, policy, now)).toBe('terminal');
  });

  it('queues idle stop only for an active running workspace without another lifecycle job', () => {
    const now = Date.parse('2026-08-28T02:00:00Z');
    const active = {
      state: 'active',
      observedState: 'running',
      lastActivityAt: '2026-08-28T00:00:00Z',
      idleStopAfterMinutes: 60,
      activeLifecycleJobs: 0,
    };
    expect(evaluateHostedIdleStop(active, now)).toMatchObject({ due: true, idleForMs: 7_200_000 });
    expect(evaluateHostedIdleStop({ ...active, activeLifecycleJobs: 1 }, now)).toEqual({ due: false, idleForMs: 0 });
    expect(evaluateHostedIdleStop({ ...active, observedState: 'stopped' }, now)).toEqual({ due: false, idleForMs: 0 });
  });
});
