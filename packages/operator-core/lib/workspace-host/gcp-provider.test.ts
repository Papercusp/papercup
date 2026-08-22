import { describe, expect, it } from 'vitest';
import {
  GCP_DATA_DISK_RESIZE_POLICY,
  GCP_DATA_MOUNT_POINT,
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  runFakeWorkspaceHostProviderContractSuite,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderContext,
  type WorkspaceHostRef,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  GCP_CLOUD_PLATFORM_SCOPE,
  GCP_IAP_TCP_FORWARDING_RANGE,
  createGcpWorkspaceHostProvider,
  gcpWorkspaceHostRequestUuid,
  type GcpComputeInstanceStatus,
  type GcpDiskInsertInput,
  type GcpDiskObservation,
  type GcpFirewallInsertInput,
  type GcpInstanceInsertInput,
  type GcpInstanceObservation,
  type GcpNetworkInsertInput,
  type GcpOperationObservation,
  type GcpOperationRef,
  type GcpResourceObservation,
  type GcpSnapshotInsertInput,
  type GcpSnapshotObservation,
  type GcpSubnetworkInsertInput,
  type GcpWorkspaceHostApiClient,
} from './gcp-provider';

const NOW = '2026-08-22T08:30:00.000Z';

function desired(network: 'managed' | 'existing' = 'managed'): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-gcp-1',
    target: 'gcp',
    scope: { kind: 'project', id: 'papercusp-dev-123' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'n2-standard-2',
    image: { id: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64' },
    data: { volumeGiB: 120, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' } },
    labels: { environment: 'test', owner: 'workspace-host-contract' },
    provider: {
      projectId: 'papercusp-dev-123',
      network:
        network === 'managed'
          ? {
              mode: 'managed',
              networkName: 'pc-host-gcp-1-net',
              subnetworkName: 'pc-host-gcp-1-subnet',
              firewallName: 'pc-host-gcp-1-iap',
              ipCidrRange: '10.132.12.0/24',
            }
          : {
              mode: 'existing',
              networkName: 'shared-vpc',
              subnetworkName: 'shared-subnet',
              firewallName: 'shared-iap-firewall',
            },
      serviceAccountEmail: 'workspace-host@papercusp-dev-123.iam.gserviceaccount.com',
      serviceAccountScopes: [GCP_CLOUD_PLATFORM_SCOPE],
      instanceName: 'pc-host-gcp-1-vm',
      dataDiskName: 'pc-host-gcp-1-data',
      dataDeviceName: 'papercusp-data',
      bootDiskGiB: 40,
      bootDiskType: 'pd-balanced',
      dataDiskType: 'pd-ssd',
      kmsKeyName: 'projects/papercusp-dev-123/locations/us-central1/keyRings/workspaces/cryptoKeys/workspace-disks',
      startupScript: '#!/bin/sh\necho papercusp-bootstrap\n',
      metadata: { 'papercusp-bootstrap-version': 'v1' },
    },
  };
}

function context(): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-gcp-1',
    requestId: 'request-gcp-1',
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' },
      scope: { kind: 'project', id: 'papercusp-dev-123' },
      provider: { projectId: 'papercusp-dev-123', credentialSource: 'adc' },
    },
  };
}

class FakeGcpWorkspaceHostApiClient implements GcpWorkspaceHostApiClient {
  readonly insertNetworkCalls: Array<{ input: GcpNetworkInsertInput; requestId: string }> = [];
  readonly insertSubnetworkCalls: Array<{ input: GcpSubnetworkInsertInput; requestId: string }> = [];
  readonly insertFirewallCalls: Array<{ input: GcpFirewallInsertInput; requestId: string }> = [];
  readonly insertDiskCalls: Array<{ input: GcpDiskInsertInput; requestId: string }> = [];
  readonly insertInstanceCalls: Array<{ input: GcpInstanceInsertInput; requestId: string }> = [];
  readonly snapshotCalls: Array<{ input: GcpSnapshotInsertInput; requestId: string }> = [];
  readonly waitedOperations: GcpOperationRef[] = [];
  startCalls = 0;
  stopCalls = 0;
  resetCalls = 0;
  deleteCalls = 0;

  private operationNumber = 0;
  private readonly operationsByRequestId = new Map<string, GcpOperationRef>();
  private readonly networks = new Map<string, GcpResourceObservation>();
  private readonly subnetworks = new Map<string, GcpResourceObservation>();
  private readonly firewalls = new Map<string, GcpResourceObservation>();
  private readonly disks = new Map<string, GcpDiskObservation>();
  private readonly instances = new Map<string, GcpInstanceObservation>();
  private readonly snapshots = new Map<string, GcpSnapshotObservation>();

  seedExistingNetwork(): void {
    this.networks.set('shared-vpc', { name: 'shared-vpc', observedAt: NOW });
    this.subnetworks.set('shared-subnet', { name: 'shared-subnet', observedAt: NOW });
    this.firewalls.set('shared-iap-firewall', { name: 'shared-iap-firewall', observedAt: NOW });
  }

  async validateConnection() {
    return {
      ok: true,
      checkedAt: NOW,
      identity: 'operator@example.com',
      warnings: [],
      errors: [],
    };
  }

  async listScopes() {
    return [{ kind: 'project', id: 'papercusp-dev-123', label: 'Papercusp development' }];
  }

  async listRegions() {
    return [{ id: 'us-central1', label: 'Iowa', available: true, zones: ['us-central1-a'] }];
  }

  async listSizes() {
    return [{ id: 'n2-standard-2', label: 'n2-standard-2', cpuCount: 2, memoryMiB: 8192, available: true }];
  }

  async listImages() {
    return [
      {
        id: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
        label: 'Ubuntu 24.04 LTS',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.11, observedAt: NOW, confidence: 'estimated' as const };
  }

  async getNetwork(_projectId: string, name: string) {
    return this.networks.get(name);
  }

  async getSubnetwork(_projectId: string, _region: string, name: string) {
    return this.subnetworks.get(name);
  }

  async getFirewall(_projectId: string, name: string) {
    return this.firewalls.get(name);
  }

  async getDisk(_projectId: string, _zone: string, name: string) {
    return this.disks.get(name);
  }

  async getInstance(_projectId: string, _zone: string, name: string) {
    return this.instances.get(name);
  }

  async getSnapshot(_projectId: string, name: string) {
    return this.snapshots.get(name);
  }

  async insertNetwork(_projectId: string, input: GcpNetworkInsertInput, requestId: string) {
    return this.mutation(requestId, 'global', undefined, () => {
      this.insertNetworkCalls.push({ input, requestId });
      this.networks.set(input.name, { name: input.name, observedAt: NOW });
    });
  }

  async insertSubnetwork(_projectId: string, region: string, input: GcpSubnetworkInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      this.insertSubnetworkCalls.push({ input, requestId });
      this.subnetworks.set(input.name, { name: input.name, observedAt: NOW });
    });
  }

  async insertFirewall(_projectId: string, input: GcpFirewallInsertInput, requestId: string) {
    return this.mutation(requestId, 'global', undefined, () => {
      this.insertFirewallCalls.push({ input, requestId });
      this.firewalls.set(input.name, { name: input.name, observedAt: NOW });
    });
  }

  async insertDisk(_projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
      this.insertDiskCalls.push({ input, requestId });
      this.disks.set(input.name, {
        name: input.name,
        status: 'READY',
        attachedInstanceNames: [],
        sizeGb: input.sizeGb,
        labels: input.labels,
        observedAt: NOW,
      });
    });
  }

  async insertInstance(_projectId: string, zone: string, input: GcpInstanceInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
      this.insertInstanceCalls.push({ input, requestId });
      const dataDiskName = input.disks[1].source.split('/').at(-1)!;
      const dataDisk = this.disks.get(dataDiskName);
      if (!dataDisk) throw new Error('fake GCP instance references an unknown data disk');
      this.disks.set(dataDiskName, {
        ...dataDisk,
        attachedInstanceNames: [input.name],
      });
      this.instances.set(input.name, {
        name: input.name,
        status: 'RUNNING',
        sourceImage: input.disks[0].initializeParams.sourceImage,
        attachedDiskNames: [dataDiskName],
        agentOnline: true,
        labels: input.labels,
        recreateInput: input,
        observedAt: NOW,
      });
    });
  }

  async createSnapshot(_projectId: string, input: GcpSnapshotInsertInput, requestId: string) {
    return this.mutation(requestId, 'global', undefined, () => {
      this.snapshotCalls.push({ input, requestId });
      this.snapshots.set(input.name, { name: input.name, status: 'READY', observedAt: NOW });
    });
  }

  async startInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.startCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'RUNNING');
  }

  async stopInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.stopCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'TERMINATED');
  }

  async resetInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.resetCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'RUNNING');
  }

  async deleteInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'zone', zone, () => {
      this.instances.delete(name);
      for (const [diskName, disk] of this.disks) {
        this.disks.set(diskName, {
          ...disk,
          attachedInstanceNames: disk.attachedInstanceNames.filter((candidate) => candidate !== name),
        });
      }
    });
  }

  async deleteDisk(_projectId: string, zone: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'zone', zone, () => this.disks.delete(name));
  }

  async deleteFirewall(_projectId: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'global', undefined, () => this.firewalls.delete(name));
  }

  async deleteSubnetwork(_projectId: string, region: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => this.subnetworks.delete(name));
  }

  async deleteNetwork(_projectId: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'global', undefined, () => this.networks.delete(name));
  }

  async waitForOperation(operation: GcpOperationRef): Promise<GcpOperationObservation> {
    this.waitedOperations.push(operation);
    return { ...operation, status: 'DONE', observedAt: NOW };
  }

  private instanceMutation(
    requestId: string,
    zone: string,
    name: string,
    status: GcpComputeInstanceStatus,
  ): GcpOperationRef {
    return this.mutation(requestId, 'zone', zone, () => {
      const current = this.instances.get(name);
      if (!current) throw new Error(`fake GCP instance '${name}' is absent`);
      this.instances.set(name, { ...current, status, observedAt: NOW });
    });
  }

  private mutation(
    requestId: string,
    scope: GcpOperationRef['scope'],
    location: string | undefined,
    effect: () => unknown,
  ): GcpOperationRef {
    const existing = this.operationsByRequestId.get(requestId);
    if (existing) return existing;
    effect();
    const operation = {
      name: `operation-${++this.operationNumber}`,
      scope,
      ...(location ? { location } : {}),
      requestId,
    };
    this.operationsByRequestId.set(requestId, operation);
    return operation;
  }
}

function providerAndClient() {
  const client = new FakeGcpWorkspaceHostApiClient();
  const provider = createGcpWorkspaceHostProvider({ client, now: () => NOW });
  return { client, provider };
}

function requireAppliedResource(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef {
  if (!('resource' in result) || !result.resource) {
    throw new Error(`expected an applied GCP resource, received '${result.state}'`);
  }
  return result.resource;
}

async function provision(
  client: FakeGcpWorkspaceHostApiClient,
  provider: ReturnType<typeof createGcpWorkspaceHostProvider>,
  spec = desired(),
): Promise<{ host: WorkspaceHostRef; resources: WorkspaceHostResourceRef[] }> {
  if ((spec.provider?.network as { mode?: string } | undefined)?.mode === 'existing') client.seedExistingNetwork();
  const plan = await provider.plan(
    { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: spec },
    context(),
  );
  const resources: WorkspaceHostResourceRef[] = [];
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
      context(),
    );
    if (
      'resource' in result &&
      result.resource &&
      !resources.some((item) => item.providerId === result.resource!.providerId)
    ) {
      resources.push(result.resource);
    }
  }
  return { host: { hostId: spec.hostId, target: 'gcp', resources }, resources };
}

describe('GCP workspace-host provider planning', () => {
  it('builds a deterministic managed resource graph with RFC-4122 request UUIDs and hardened instance inputs', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const [first, replay] = await Promise.all([provider.plan(request, context()), provider.plan(request, context())]);
    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: 'create-network', dependsOn: [] },
      { id: 'create-subnetwork', dependsOn: ['create-network'] },
      { id: 'create-firewall', dependsOn: ['create-network'] },
      { id: 'create-data-disk', dependsOn: [] },
      { id: 'create-instance', dependsOn: ['create-subnetwork', 'create-firewall', 'create-data-disk'] },
    ]);
    const requestIds = first.steps.map((step) => (step.input as { requestId: string }).requestId);
    expect(requestIds).toHaveLength(new Set(requestIds).size);
    requestIds.forEach((requestId) =>
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    );
    expect(gcpWorkspaceHostRequestUuid('operation-1')).toBe(gcpWorkspaceHostRequestUuid('operation-1'));

    const firewall = (first.steps[2].input as unknown as { request: GcpFirewallInsertInput }).request;
    expect(firewall).toMatchObject({ sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE], allowed: [{ ports: ['22'] }] });
    const disk = (first.steps[3].input as unknown as { request: GcpDiskInsertInput }).request;
    expect(disk).toMatchObject({ sizeGb: 120, type: 'pd-ssd', diskEncryptionKey: { kmsKeyName: expect.any(String) } });
    const instance = (first.steps[4].input as unknown as { request: GcpInstanceInsertInput }).request;
    expect(instance.networkInterfaces[0]).not.toHaveProperty('accessConfigs');
    expect(instance.serviceAccounts).toEqual([
      {
        email: 'workspace-host@papercusp-dev-123.iam.gserviceaccount.com',
        scopes: [GCP_CLOUD_PLATFORM_SCOPE],
      },
    ]);
    expect(instance.disks[1]).toMatchObject({ autoDelete: false, deviceName: 'papercusp-data' });
    expect(instance.metadata.items).toEqual(
      expect.arrayContaining([
        { key: 'enable-oslogin', value: 'TRUE' },
        { key: 'block-project-ssh-keys', value: 'TRUE' },
        { key: 'papercusp-data-resize-policy', value: GCP_DATA_DISK_RESIZE_POLICY },
        {
          key: 'startup-script',
          value: expect.stringContaining(`data_mount='${GCP_DATA_MOUNT_POINT}'`),
        },
      ]),
    );
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      '# User-supplied bootstrap follows the durable mount.\necho papercusp-bootstrap',
    );
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      'resize2fs "$data_device"',
    );
  });

  it('refuses dependent Compute Engine calls until prerequisite identities have been persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1], knownResources: [] },
        context(),
      ),
    ).rejects.toThrow('requires a persisted network resource identity');
    expect(client.insertSubnetworkCalls).toHaveLength(0);

    const disk = requireAppliedResource(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[3], knownResources: [] },
        context(),
      ),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[4], knownResources: [disk] },
        context(),
      ),
    ).rejects.toThrow('requires a persisted subnetwork/existing-subnetwork resource identity');
    expect(client.insertInstanceCalls).toHaveLength(0);
  });

  it('records but never owns or deletes explicitly selected existing network resources', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider, desired('existing'));
    expect(resources.map((item) => item.kind)).toEqual([
      'existing-network',
      'existing-subnetwork',
      'existing-firewall',
      'disk',
      'vm',
    ]);
    expect(client.insertNetworkCalls).toHaveLength(0);
    expect(client.insertSubnetworkCalls).toHaveLength(0);
    expect(client.insertFirewallCalls).toHaveLength(0);
    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'destroy-existing',
        idempotencyKey: 'destroy-existing',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    expect(destroy.steps.map((step) => step.resourceKind)).toEqual(['vm', 'disk']);
  });

  it('fails closed for unencrypted data, cross-project ambiguity, and implicit live clients', async () => {
    const { provider } = providerAndClient();
    const unencrypted = desired();
    unencrypted.data = { ...unencrypted.data, encrypted: false };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-1', idempotencyKey: 'unsafe-1', desired: unencrypted },
        context(),
      ),
    ).rejects.toThrow('data disks must be encrypted');

    const crossProject = desired();
    crossProject.provider = { ...crossProject.provider, projectId: 'other-project-123' };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-2', idempotencyKey: 'unsafe-2', desired: crossProject },
        context(),
      ),
    ).rejects.toThrow('projectId must match desired.scope.id');
    expect(() => createGcpWorkspaceHostProvider({ client: undefined as never })).toThrow('requires an injected');
  });
});

describe('GCP workspace-host provider contract and lifecycle', () => {
  it('passes the shared fake contract with reconciliation, observation, IAP transport, and confirmed deletion', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/gcp/provider-contract-1',
      context: context(),
      desired: desired(),
      operationId: 'contract-operation',
      idempotencyKey: 'contract-operation',
      confirmedBy: 'vitest',
      now: () => NOW,
    });
    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(report.provisionedResources.map((item) => item.kind)).toEqual([
      'network',
      'subnetwork',
      'firewall',
      'disk',
      'vm',
    ]);
    expect(report.destroyConfirmations.map((item) => item.providerResourceId)).toEqual([
      'pc-host-gcp-1-vm',
      'pc-host-gcp-1-data',
      'pc-host-gcp-1-iap',
      'pc-host-gcp-1-subnet',
      'pc-host-gcp-1-net',
    ]);
  });

  it('polls scoped operations for stop/start/restart/snapshot/repair and freshly confirms every delete', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const actions = ['stop', 'start', 'restart', 'snapshot', 'repair'] as const;
    for (const action of actions) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? {
              action,
              operationId: `operation:${action}`,
              idempotencyKey: `operation:${action}`,
              host,
              name: 'manual-snapshot',
            }
          : { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host },
        context(),
      );
      for (const step of plan.steps) {
        const result = await provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
          context(),
        );
        expect(result.state).toBe('applied');
      }
    }
    expect({
      start: client.startCalls,
      stop: client.stopCalls,
      reset: client.resetCalls,
      snapshots: client.snapshotCalls.length,
    }).toEqual({ start: 2, stop: 2, reset: 2, snapshots: 1 });
    expect(client.waitedOperations.length).toBeGreaterThanOrEqual(10);

    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') expect(result.confirmation.source).toBe('provider-read');
    }
    expect(client.deleteCalls).toBe(5);
  });

  it('reconciles an ambiguous instance insert by fresh resource read without a duplicate API mutation', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-3', idempotencyKey: 'operation-3', desired: desired() },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
    const instanceStep = plan.steps.at(-1)!;
    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: instanceStep,
        knownResources: resources,
        reason: 'ambiguous-timeout',
        previousProviderRequestId: 'operation-5',
      },
      context(),
    );
    expect(reconciled.state).toBe('unchanged');
    expect('resource' in reconciled && reconciled.resource?.providerId).toBe('pc-host-gcp-1-vm');
    expect(client.insertInstanceCalls).toHaveLength(1);
  });
});
