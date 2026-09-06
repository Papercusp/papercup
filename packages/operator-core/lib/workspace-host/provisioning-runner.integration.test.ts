/**
 * The production provisioning assembly against real Postgres and real workspace RLS.
 * Provider calls stay fake: this test proves controller/store ordering and replay semantics,
 * not Google Compute Engine itself (the GCP provider contract owns that boundary).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type {
  WorkspaceHostApplyResult,
  WorkspaceHostControllerAuthority,
  WorkspaceHostDesiredSpec,
  WorkspaceHostObservation,
  WorkspaceHostPlanStep,
  WorkspaceHostProvider,
  WorkspaceHostProviderConnection,
  WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  makeFakeWorkspaceHostProvider,
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

const { runWorkspaceHostDestroy, runWorkspaceHostProvisioning } = await import('./provisioning-runner');
const {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  recordWorkspaceHostObservation,
  updateWorkspaceHostOperation,
  upsertWorkspaceHostResourceCheckpoint,
  WorkspaceHostControllerFenceError,
} = await import('./observability-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let sequence = 0;
const NOW = '2026-08-25T00:10:00.000Z';
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
  // Capabilities default to all-false, which is what this suite exercises: the runner reads
  // `capabilities.lifecycle.hostBootstrap` and must take the no-bootstrap path.
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-25T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => ({
      planId: `plan:${operationId}`,
      operationId,
      target: 'gcp' as const,
      hostId,
      generatedAt: '2026-08-25T00:00:00Z',
      steps,
      warnings: [],
    })),
    apply,
    reconcile,
    observe: vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
      host,
      state: 'running' as const,
      resources: host.resources,
      observedAt: '2026-08-25T00:00:10Z',
      drift: [],
    })),
  });
  return { provider, apply, reconcile };
}

function destroyProviderHarness(operationId: string, hostId: string, resources: readonly WorkspaceHostResourceRef[]) {
  const ordered = ['vm', 'disk', 'firewall', 'nat', 'router', 'subnetwork', 'network'];
  const destroySteps = ordered.map((kind, index): WorkspaceHostPlanStep => {
    const resource = resources.find((entry) => entry.kind === kind)!;
    const priorKind = ordered[index - 1];
    const prior = priorKind ? resources.find((entry) => entry.kind === priorKind)! : undefined;
    return {
      id: `delete-${kind}-${resource.providerId}`,
      action: 'destroy',
      resourceKind: resource.kind,
      dependsOn: prior ? [`delete-${prior.kind}-${prior.providerId}`] : [],
      idempotencyKey: `destroy:${kind}`,
      destructive: true,
      input: { op: `delete-${kind}`, resourceName: resource.providerId },
    };
  });
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
    plan: vi.fn(async () => ({
      planId: `plan:${operationId}`,
      operationId,
      target: 'gcp' as const,
      hostId,
      generatedAt: NOW,
      steps: destroySteps,
      warnings: [],
    })),
    apply: vi.fn<WorkspaceHostProvider['apply']>(async (request) => ({
      operationId,
      stepId: request.step.id,
      state: 'destroyed' as const,
      observedAt: NOW,
      confirmation: {
        hostId,
        providerResourceId: String(request.step.input.resourceName),
        confirmedAbsentAt: NOW,
        source: 'provider-read' as const,
      },
    })),
    reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
    observe: vi.fn<WorkspaceHostProvider['observe']>(),
    inventoryManagedResources: vi.fn(async () => ({
      complete: true as const,
      observed: [],
      inventoryEvidence: [
        { kind: 'vm' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/vm' },
        { kind: 'disk' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/disk' },
        {
          kind: 'firewall' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/firewall',
          deterministicNames: ['pc-host-iap'],
        },
        {
          kind: 'subnetwork' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/subnetwork',
          deterministicNames: ['pc-host-subnet'],
        },
        {
          kind: 'network' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/network',
          deterministicNames: ['pc-host-net'],
        },
        {
          kind: 'snapshot' as const,
          strategy: 'managed-labels' as const,
          providerEvidenceRef: 'gcp://inventory/snapshot',
        },
        {
          kind: 'router' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/router',
          deterministicNames: ['pc-host-router'],
        },
        {
          kind: 'nat' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/nat',
          deterministicNames: ['pc-host-nat'],
        },
      ],
    })),
  });
  return provider;
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

  it('replays an exact request but rejects changed or reordered content for the same operation', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    const operationId = `op_${randomBytes(3).toString('hex')}`;
    const authority: WorkspaceHostControllerAuthority = { controllerId: 'controller:replay', fence: 1 };
    const steps = [step('create-network'), step('create-instance', ['create-network'])];
    const first = providerHarness(steps, operationId, hostId);
    first.apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => ({
      operationId,
      stepId: request.step.id,
      state: 'applied',
      observedAt: '2026-08-25T00:00:05Z',
      resource: {
        target: 'gcp',
        kind: request.step.resourceKind,
        providerId: `provider-${request.step.id}`,
      },
    }));
    const input = {
      workspaceId,
      connectionId,
      name: 'Replay host',
      desired: desired(hostId),
      connection,
      provider: first.provider,
      operationId,
      controllerAuthority: authority,
      desiredRevision: 1,
    };

    await expect(runWorkspaceHostProvisioning(input)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(runWorkspaceHostProvisioning(input)).resolves.toMatchObject({ status: 'succeeded' });
    expect(first.apply).toHaveBeenCalledTimes(2);
    expect(first.reconcile).not.toHaveBeenCalled();

    await expect(
      runWorkspaceHostProvisioning({ ...input, name: 'Changed replay host' }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    const reordered = providerHarness([...steps].reverse(), operationId, hostId);
    await expect(
      runWorkspaceHostProvisioning({ ...input, provider: reordered.provider }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    expect(reordered.apply).not.toHaveBeenCalled();
  });

  it('rejects stale same-controller writes after a newer desired revision takes ownership', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    const staleOperationId = `op_stale_${randomBytes(3).toString('hex')}`;
    const currentOperationId = `op_current_${randomBytes(3).toString('hex')}`;
    const authority: WorkspaceHostControllerAuthority = { controllerId: 'controller:stable', fence: 8 };
    const first = providerHarness([step('create-network')], staleOperationId, hostId);
    first.apply.mockResolvedValue({
      operationId: staleOperationId,
      stepId: 'create-network',
      state: 'applied',
      observedAt: '2026-08-25T00:00:05Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-create-network' },
    });
    await runWorkspaceHostProvisioning({
      workspaceId,
      connectionId,
      name: 'Revision host',
      desired: desired(hostId),
      connection,
      provider: first.provider,
      operationId: staleOperationId,
      controllerAuthority: authority,
      desiredRevision: 1,
    });

    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: currentOperationId,
      hostId,
      action: 'restart',
      status: 'running',
      message: 'Revision 2 owns the host',
      request: { sourceHostId: hostId, revision: 2 },
      controllerAuthority: authority,
      desiredRevision: 2,
    });

    const stale = { operationId: staleOperationId, controllerAuthority: authority };
    await expect(
      updateWorkspaceHostOperation({
        workspaceId,
        operationId: staleOperationId,
        status: 'failed',
        percent: 99,
        message: 'stale controller update',
        controllerAuthority: authority,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    await expect(
      upsertWorkspaceHostResourceCheckpoint({
        workspaceId,
        hostId,
        operationId: staleOperationId,
        checkpoint: { logicalKey: 'create-network', state: 'failed', attempts: 9, error: 'stale' },
        controllerAuthority: authority,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    await expect(
      appendWorkspaceHostEvent({
        workspaceId,
        hostId,
        operationId: staleOperationId,
        phase: 'stale',
        status: 'failed',
        message: 'stale event',
        controllerAuthority: authority,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    const observation: WorkspaceHostObservation = {
      host: {
        hostId,
        target: 'gcp',
        resources: [{ target: 'gcp', kind: 'network', providerId: 'stale-provider-network' }],
      },
      state: 'degraded',
      resources: [{ target: 'gcp', kind: 'network', providerId: 'stale-provider-network' }],
      observedAt: '2026-08-25T00:00:11Z',
      drift: ['network identity is stale'],
    };
    await expect(
      recordWorkspaceHostObservation(workspaceId, observation, stale),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);

    const [host] = await db.adminSql`
      SELECT desired_revision, observed_revision, observed_state
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(host).toMatchObject({ desired_revision: 2, observed_revision: 1, observed_state: 'running' });
    const [operation] = await db.adminSql`
      SELECT status, percent FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = ${staleOperationId}
    `;
    expect(operation).toMatchObject({ status: 'succeeded', percent: 100 });
    const [resource] = await db.adminSql`
      SELECT state, attempts, provider_id FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId} AND host_id = ${hostId} AND logical_key = 'create-network'
    `;
    expect(resource).toMatchObject({ state: 'applied', attempts: 1, provider_id: 'provider-create-network' });
    const [{ count: staleEventCount }] = await db.adminSql`
      SELECT count(*)::int AS count FROM harness_shared.workspace_host_events
      WHERE workspace_id = ${workspaceId} AND operation_id = ${staleOperationId} AND phase = 'stale'
    `;
    expect(staleEventCount).toBe(0);
  });

  it('persists a complete discard graph and terminal evidence before marking the host absent', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = await seedConnection(workspaceId);
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    const provisionOperationId = `provision_${randomBytes(3).toString('hex')}`;
    const destroyOperationId = `destroy_${randomBytes(3).toString('hex')}`;
    const runId = `canary_${randomBytes(3).toString('hex')}`;
    const canaryDesired = {
      ...desired(hostId),
      labels: {
        papercusp_canary: 'true',
        papercusp_run_id: runId,
        papercusp_workspace_id: workspaceId,
      },
    };
    const graph: readonly WorkspaceHostResourceRef[] = [
      { target: 'gcp', kind: 'vm', providerId: 'pc-host-vm', parentProviderId: 'project-1', zone: canaryDesired.zone },
      {
        target: 'gcp',
        kind: 'disk',
        providerId: 'pc-host-data',
        parentProviderId: 'project-1',
        zone: canaryDesired.zone,
      },
      { target: 'gcp', kind: 'firewall', providerId: 'pc-host-iap', parentProviderId: 'project-1' },
      {
        target: 'gcp',
        kind: 'nat',
        providerId: 'pc-host-nat',
        parentProviderId: 'project-1',
        region: canaryDesired.region,
      },
      {
        target: 'gcp',
        kind: 'router',
        providerId: 'pc-host-router',
        parentProviderId: 'project-1',
        region: canaryDesired.region,
      },
      {
        target: 'gcp',
        kind: 'subnetwork',
        providerId: 'pc-host-subnet',
        parentProviderId: 'project-1',
        region: canaryDesired.region,
      },
      { target: 'gcp', kind: 'network', providerId: 'pc-host-net', parentProviderId: 'project-1' },
    ];

    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size,
        image, disk_gib, network, desired_state, observed_state, desired_spec
      ) VALUES (
        ${workspaceId}, ${hostId}, 'Canary host', ${connectionId}, 'gcp', 'project-1',
        ${canaryDesired.region}, ${canaryDesired.size}, ${canaryDesired.image.id},
        ${canaryDesired.data.volumeGiB}, 'pc-host-net', 'running', 'running',
        ${JSON.stringify(canaryDesired)}::jsonb
      )
    `;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_operations (
        workspace_id, id, host_id, action, status, percent, message
      ) VALUES (${workspaceId}, ${provisionOperationId}, ${hostId}, 'provision', 'succeeded', 100, 'seeded')
    `;
    for (const [index, resource] of graph.entries()) {
      await db.adminSql`
        INSERT INTO harness_shared.workspace_host_resources (
          workspace_id, host_id, logical_key, operation_id, state, attempts,
          target, kind, provider_id, parent_provider_id, region, zone
        ) VALUES (
          ${workspaceId}, ${hostId}, ${`create-${index}-${resource.kind}`}, ${provisionOperationId},
          'applied', 1, ${resource.target}, ${resource.kind}, ${resource.providerId},
          ${resource.parentProviderId ?? null}, ${resource.region ?? null}, ${resource.zone ?? null}
        )
      `;
    }

    const result = await runWorkspaceHostDestroy({
      workspaceId,
      hostId,
      connection,
      provider: destroyProviderHarness(destroyOperationId, hostId, graph),
      disposition: 'discard',
      confirmation: { expectedHostId: hostId, confirmedBy: 'operator:test', confirmedAt: NOW },
      canary: {
        runId,
        workspaceId,
        contractApproval: {
          status: 'approved',
          suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
          reportRef: 'report://gcp/fake-contract',
          approvedBy: 'operator:test',
          approvedAt: NOW,
        },
        teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
        budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
        preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
        costEvidence: [{ cents: 71, observedAt: NOW, providerEvidenceRef: 'gcp://billing/settled' }],
        lateObservedSpend: [{ cents: 4, observedAt: NOW, providerEvidenceRef: 'gcp://billing/late' }],
      },
      operationId: destroyOperationId,
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      evidence: {
        completionReceipt: { resourceCount: 7, spentCents: 75 },
        providerCensus: { clean: true, inventoryComplete: true },
      },
    });
    const destroyRows = await db.adminSql`
      SELECT state, provider_id, deletion_confirmation
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId} AND host_id = ${hostId} AND operation_id = ${destroyOperationId}
      ORDER BY logical_key
    `;
    expect(destroyRows).toHaveLength(7);
    expect(destroyRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'absent',
          deletion_confirmation: expect.objectContaining({ source: 'provider-read' }),
        }),
      ]),
    );
    const [persisted] = await db.adminSql`
      SELECT desired_state, observed_state, cost_signals
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    expect(persisted).toMatchObject({
      desired_state: 'absent',
      observed_state: 'absent',
      cost_signals: [
        expect.objectContaining({
          kind: 'workspace-host-canary-cost-evidence-v1',
          budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
          completion: expect.objectContaining({ spentCents: 75 }),
        }),
      ],
    });
  });
});
