/**
 * The production provisioning assembly against real Postgres and real workspace RLS.
 * Provider calls stay fake: this test proves controller/store ordering and replay semantics,
 * not Google Compute Engine itself (the GCP provider contract owns that boundary).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type {
  WorkspaceHostApplyResult,
  WorkspaceHostDesiredSpec,
  WorkspaceHostPlanStep,
  WorkspaceHostProvider,
  WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

const { runWorkspaceHostProvisioning } = await import('./provisioning-runner');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let sequence = 0;
const freshWorkspace = () => `wh_provision_ws_${++sequence}_${randomBytes(2).toString('hex')}`;

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' },
  scope: { kind: 'project', id: 'project-1' },
};

function desired(hostId: string): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'project-1' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-small',
    image: { id: 'projects/images/global/images/papercusp-v1' },
    data: { volumeGiB: 20, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' } },
    provider: { network: { mode: 'managed', networkName: `${hostId}-network` } },
  };
}

function step(id: string, dependsOn: readonly string[] = []): WorkspaceHostPlanStep {
  return {
    id,
    action: 'provision',
    resourceKind: id === 'create-instance' ? 'vm' : 'network',
    dependsOn,
    idempotencyKey: `key:${id}`,
    destructive: false,
    input: { op: id === 'create-instance' ? 'insert-instance' : 'insert-network' },
  };
}

function providerHarness(steps: readonly WorkspaceHostPlanStep[], operationId: string, hostId: string) {
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const provider = {
    target: 'gcp',
    capabilities: {},
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-25T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => ({
      planId: `plan:${operationId}`,
      operationId,
      target: 'gcp',
      hostId,
      generatedAt: '2026-08-25T00:00:00Z',
      steps,
      warnings: [],
    })),
    apply,
    reconcile,
    observe: vi.fn(async (host) => ({
      host,
      state: 'running' as const,
      resources: host.resources,
      observedAt: '2026-08-25T00:00:10Z',
      drift: [],
    })),
  } as unknown as WorkspaceHostProvider;
  return { provider, apply, reconcile };
}

describe('workspace-host provisioning runner (real PG + real RLS)', () => {
  let db: OrgTestDb;

  async function seedConnection(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref, status
      ) VALUES (
        ${workspaceId}, ${connectionId}, 'gcp', 'integration connection',
        'adc://integration-test', 'connected'
      )
    `;
    return connectionId;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists desired intent and the whole resource graph before the first provider mutation', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    const operationId = `op_${randomBytes(3).toString('hex')}`;
    const steps = [step('create-network'), step('create-instance', ['create-network'])];
    const { provider, apply } = providerHarness(steps, operationId, hostId);

    apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => {
      if (request.step.id === 'create-network') {
        const [host] = await db.adminSql`
          SELECT desired_spec FROM harness_shared.workspace_hosts
          WHERE workspace_id = ${workspaceId} AND id = ${hostId}
        `;
        expect(host.desired_spec).toMatchObject({ hostId, zone: 'us-central1-a' });

        const rows = await db.adminSql`
          SELECT logical_key, state FROM harness_shared.workspace_host_resources
          WHERE workspace_id = ${workspaceId} AND host_id = ${hostId}
          ORDER BY logical_key
        `;
        expect(rows).toEqual([
          expect.objectContaining({ logical_key: 'create-instance', state: 'planned' }),
          expect.objectContaining({ logical_key: 'create-network', state: 'applying' }),
        ]);
      }
      return {
        operationId,
        stepId: request.step.id,
        state: 'applied',
        observedAt: '2026-08-25T00:00:05Z',
        resource: {
          target: 'gcp',
          kind: request.step.resourceKind,
          providerId: `provider-${request.step.id}`,
        },
      };
    });

    const result = await runWorkspaceHostProvisioning({
      workspaceId,
      connectionId,
      name: 'Integration host',
      desired: desired(hostId),
      connection,
      provider,
      operationId,
    });

    expect(result.status).toBe('succeeded');
    const [operation] = await db.adminSql`
      SELECT status, percent FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = ${operationId}
    `;
    expect(operation).toMatchObject({ status: 'succeeded', percent: 100 });
    const resources = await db.adminSql`
      SELECT logical_key, state, provider_id FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId} AND host_id = ${hostId}
      ORDER BY logical_key
    `;
    expect(resources).toEqual([
      expect.objectContaining({ logical_key: 'create-instance', state: 'applied' }),
      expect.objectContaining({ logical_key: 'create-network', state: 'applied' }),
    ]);
  });

  it('hydrates an ambiguous checkpoint and calls reconcile—not apply—after re-entry', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    const operationId = `op_${randomBytes(3).toString('hex')}`;
    const steps = [step('create-network')];
    const first = providerHarness(steps, operationId, hostId);
    first.apply.mockResolvedValue({
      operationId,
      stepId: 'create-network',
      state: 'in-progress',
      observedAt: '2026-08-25T00:00:01Z',
      providerRequestId: 'provider-operation-1',
      retryAfterMs: 2_000,
    });

    await expect(
      runWorkspaceHostProvisioning({
        workspaceId,
        connectionId,
        name: 'Integration host',
        desired: desired(hostId),
        connection,
        provider: first.provider,
        operationId,
      }),
    ).resolves.toMatchObject({ status: 'in-progress' });

    const [persisted] = await db.adminSql`
      SELECT state, retry_class, provider_request_id
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId} AND host_id = ${hostId} AND logical_key = 'create-network'
    `;
    expect(persisted).toMatchObject({
      state: 'retry-wait',
      retry_class: 'ambiguous',
      provider_request_id: 'provider-operation-1',
    });

    const resumed = providerHarness(steps, operationId, hostId);
    resumed.apply.mockRejectedValue(new Error('blind apply must never run during ambiguous replay'));
    resumed.reconcile.mockResolvedValue({
      operationId,
      stepId: 'create-network',
      state: 'unchanged',
      observedAt: '2026-08-25T00:00:08Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-network' },
    });

    await expect(
      runWorkspaceHostProvisioning({
        workspaceId,
        connectionId,
        name: 'Integration host',
        desired: desired(hostId),
        connection,
        provider: resumed.provider,
        operationId,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(resumed.apply).not.toHaveBeenCalled();
    expect(resumed.reconcile).toHaveBeenCalledOnce();
    expect(resumed.reconcile.mock.calls[0]?.[0]).toMatchObject({
      reason: 'resume',
      previousProviderRequestId: 'provider-operation-1',
    });
  });
});
