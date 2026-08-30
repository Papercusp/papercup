import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  HostedLifecycleAdmissionError,
  admitHostedLifecycleJob,
  readHostedLifecycleSupportDiagnostics,
  reconcileHostedLifecycleJobs,
  setHostedLifecycleStoreHooks,
} from './hosted-lifecycle-store';

type QueryHandler = (text: string, values: unknown[]) => unknown[] | Promise<unknown[]>;

function fakeTransaction(handler: QueryHandler) {
  return async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>): Promise<T> => {
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      return Promise.resolve(handler(text, values));
    }) as unknown as Sql;
    return fn(tag);
  };
}

const baseInput = {
  workspaceId: 'control-a',
  customerWorkspaceId: 'customer-a',
  hostId: 'host-a',
  providerTarget: 'gcp',
  action: 'start' as const,
  actorId: 'owner-a',
  riskTier: 'moderate' as const,
  approvalStatus: 'not-required' as const,
  estimate: {
    cents: 1200,
    currency: 'USD',
    source: 'gcp-catalog-v1',
    evidenceRef: 'gcp://catalog/e2-small',
    estimatedAt: '2026-08-28T00:00:00Z',
  },
  operationId: 'op-1',
};

const directory = {
  organization_id: 'org-a',
  customer_workspace_id: 'customer-a',
  workspace_host_id: 'host-a',
  provider_target: 'gcp',
  state: 'active',
  tenant_concurrency_limit: 2,
  provider_concurrency_limit: 8,
  monthly_lifecycle_budget_cents: 5000,
  lifecycle_budget_period_started_at: '2026-08-01T00:00:00Z',
  billing_owner_kind: 'organization',
  billing_owner_id: 'org-a',
  idle_stop_after_minutes: 60,
};

afterEach(() => setHostedLifecycleStoreHooks(null));

describe('hosted lifecycle store', () => {
  it('serializes admission, reads the writer counters, and inserts the canonical operation row', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        if (text.includes('FROM harness_shared.customer_workspaces customer')) return [directory];
        if (text.includes('AS active_tenant_jobs')) {
          return [{ active_tenant_jobs: 1, active_provider_jobs: 3, committed_monthly_cents: '2000' }];
        }
        if (text.includes('INSERT INTO harness_shared.workspace_host_operations')) return [{ id: 'op-1' }];
        return [];
      }),
    });

    await expect(admitHostedLifecycleJob(baseInput)).resolves.toMatchObject({
      operationId: 'op-1', created: true, organizationId: 'org-a',
      decision: { allowed: true, projectedMonthlyCents: 3200 },
    });
    expect(queries.filter((query) => query.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(queries.some((query) => query.includes('INSERT INTO harness_shared.workspace_host_operations'))).toBe(true);
  });

  it('rejects before inserting when the persisted tenant limit is reached', async () => {
    let inserted = false;
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        if (text.includes('FROM harness_shared.customer_workspaces customer')) return [directory];
        if (text.includes('AS active_tenant_jobs')) {
          return [{ active_tenant_jobs: 2, active_provider_jobs: 3, committed_monthly_cents: '2000' }];
        }
        if (text.includes('INSERT INTO harness_shared.workspace_host_operations')) inserted = true;
        return [];
      }),
    });
    await expect(admitHostedLifecycleJob(baseInput)).rejects.toBeInstanceOf(HostedLifecycleAdmissionError);
    expect(inserted).toBe(false);
  });

  it('marks orphaned work and uses replay-safe notifications', async () => {
    const notify = vi.fn(async (_input: { dedupeKey: string }) => ({
      recordId: 1, deduped: false, mobileDelivered: true, desktopDelivered: true,
    }));
    setHostedLifecycleStoreHooks({
      notify,
      transaction: fakeTransaction((text) => {
        if (text.includes('FOR UPDATE OF operation')) {
          return [{
            ...directory,
            operation_id: 'orphan-1', host_id: 'host-a', action: 'repair', status: 'running',
            heartbeat_at: '2026-08-28T00:00:00Z', operation_updated_at: '2026-08-28T00:00:00Z',
            recovery_attempts: 0,
          }];
        }
        return [];
      }),
    });
    const result = await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(result.orphaned).toEqual(['orphan-1']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      'hosted-lifecycle:control-a:orphan-1:orphaned',
    ]);
  });

  it('no longer issues an idle-stop query against customer_workspaces (the sweep was retired)', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        return [];
      }),
    });
    await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(queries.some((query) => query.includes('idle_stop_after_minutes IS NOT NULL'))).toBe(false);
    expect(queries.some((query) => query.includes('active_lifecycle_jobs'))).toBe(false);
  });

  it('projects bounded support diagnostics from the canonical writer fields', async () => {
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        if (text.includes("count(*) FILTER (WHERE status = 'queued')")) {
          return [{ queued: 2, running: 1, stuck: 1, orphaned: 1, exhausted: 0 }];
        }
        if (text.includes('SELECT id, host_id, action')) return [{ id: 'op-1', cost_estimate_ref: 'gcp://catalog/e2-small' }];
        return [];
      }),
    });
    await expect(readHostedLifecycleSupportDiagnostics('control-a', 5)).resolves.toMatchObject({
      workspaceId: 'control-a',
      counts: { queued: 2, running: 1, stuck: 1, orphaned: 1, exhausted: 0 },
      jobs: [{ id: 'op-1', cost_estimate_ref: 'gcp://catalog/e2-small' }],
    });
  });
});
