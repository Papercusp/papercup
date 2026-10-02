import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  runFakeWorkspaceHostProviderContractSuite,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderContext,
  type WorkspaceHostRef,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH,
  awsWorkspaceHostClientToken,
  createAwsWorkspaceHostProvider,
  type AwsCreateSnapshotInput,
  type AwsCreateVolumeInput,
  type AwsCreatedInstance,
  type AwsCreatedSnapshot,
  type AwsCreatedVolume,
  type AwsEc2InstanceState,
  type AwsInstanceObservation,
  type AwsProviderMutationResult,
  type AwsRunInstancesInput,
  type AwsSnapshotObservation,
  type AwsVolumeObservation,
  type AwsWorkspaceHostSdkClient,
} from './aws-provider';
import { cloudResourceKindForDeleteOp, describeCloudResourceDeleteAddress } from './cloud-resource-obligations';
import type { WorkspaceHostResourceCreatedEvent } from './gcp-provider';
import type { AwsWorkspaceHostInventoryRequest, AwsWorkspaceHostInventorySnapshot } from './aws-safety';
import { AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS } from './aws-safety';

const NOW = '2026-08-22T08:00:00.000Z';

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-aws-1',
    target: 'aws',
    scope: { kind: 'account', id: '123456789012' },
    region: 'us-east-1',
    zone: 'us-east-1a',
    size: 'm7i.large',
    image: { id: 'ami-ubuntu-2404', version: '2026.08.22' },
    data: { volumeGiB: 100, encrypted: true },
    credentials: {
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/development' },
    },
    labels: { environment: 'test', owner: 'workspace-host-contract' },
    provider: {
      vpcId: 'vpc-123',
      subnetId: 'subnet-123',
      securityGroupIds: ['sg-workspace', 'sg-egress'],
      availabilityZone: 'us-east-1a',
      instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace',
      launchTemplateId: 'lt-123',
      launchTemplateVersion: '7',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
      rootVolumeGiB: 40,
      rootDeviceName: '/dev/sda1',
      dataDeviceName: '/dev/sdf',
      volumeType: 'gp3',
      userData: '#!/bin/sh\necho papercusp-bootstrap\n',
    },
  };
}

function context(provider: Readonly<Record<string, unknown>> = {}): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-aws-1',
    requestId: 'request-aws-1',
    connection: {
      target: 'aws',
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/development' },
      scope: { kind: 'account', id: '123456789012' },
      provider: { region: 'us-east-1', credentialSource: 'shared-profile', ...provider },
    },
  };
}

class FakeAwsWorkspaceHostSdkClient implements AwsWorkspaceHostSdkClient {
  readonly createVolumeCalls: AwsCreateVolumeInput[] = [];
  readonly runInstancesCalls: AwsRunInstancesInput[] = [];
  readonly attachVolumeCalls: Array<{ InstanceId: string; VolumeId: string; Device: string }> = [];
  readonly createSnapshotCalls: AwsCreateSnapshotInput[] = [];
  readonly waitedInstanceStates: Array<{ id: string; state: 'running' | 'stopped' | 'terminated' }> = [];
  readonly waitedVolumeStates: Array<{ id: string; state: 'available' | 'in-use' | 'deleted' }> = [];
  readonly describedInstances: string[] = [];
  readonly describedVolumes: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  rebootCalls = 0;
  repairCalls = 0;
  terminateCalls = 0;
  deleteVolumeCalls = 0;
  /** Inbound rule count per security group; an unlisted group reads as closed (0). */
  readonly securityGroupIngress = new Map<string, number>();
  /** Groups EC2 "does not return" — simulates an unverifiable group. */
  readonly hiddenSecurityGroups = new Set<string>();
  readonly describedSecurityGroups: string[][] = [];

  private readonly instances = new Map<string, AwsInstanceObservation>();
  private readonly volumes = new Map<string, AwsVolumeObservation>();
  private readonly snapshots = new Map<string, AwsSnapshotObservation>();
  private readonly instanceTokens = new Map<string, string>();
  private readonly volumeTokens = new Map<string, string>();
  private readonly snapshotTokens = new Map<string, string>();

  async validateConnection() {
    return {
      ok: true,
      checkedAt: NOW,
      identity: 'arn:aws:sts::123456789012:assumed-role/Papercusp/operator',
      warnings: [],
      errors: [],
    };
  }

  async listScopes() {
    return [{ kind: 'account', id: '123456789012', label: 'Development account' }];
  }

  async listRegions() {
    return [{ id: 'us-east-1', label: 'US East (N. Virginia)', available: true, zones: ['us-east-1a'] }];
  }

  async listSizes() {
    return [{ id: 'm7i.large', label: 'm7i.large', cpuCount: 2, memoryMiB: 8192, available: true }];
  }

  async listImages() {
    return [
      {
        id: 'ami-ubuntu-2404',
        version: '2026.08.22',
        label: 'Ubuntu 24.04 LTS',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.12, observedAt: NOW, confidence: 'estimated' as const };
  }

  async describeSecurityGroupIngress(groupIds: readonly string[]) {
    this.describedSecurityGroups.push([...groupIds]);
    return groupIds
      .filter((groupId) => !this.hiddenSecurityGroups.has(groupId))
      .map((groupId) => ({ groupId, ingressRuleCount: this.securityGroupIngress.get(groupId) ?? 0 }));
  }

  /** The provider never reads the console; initialization does (initialization-operations-resolver). */
  async getConsoleOutput(_instanceId: string): Promise<string | undefined> {
    return undefined;
  }

  async createVolume(input: AwsCreateVolumeInput): Promise<AwsCreatedVolume> {
    this.createVolumeCalls.push(input);
    const existing = this.volumeTokens.get(input.ClientToken);
    const volumeId = existing ?? `vol-${this.volumeTokens.size + 1}`;
    this.volumeTokens.set(input.ClientToken, volumeId);
    this.volumes.set(volumeId, {
      volumeId,
      state: 'creating',
      observedAt: NOW,
    });
    return { volumeId, requestId: `request:create:${volumeId}` };
  }

  async findVolumeByClientToken(clientToken: string): Promise<AwsVolumeObservation | undefined> {
    const id = this.volumeTokens.get(clientToken);
    return id ? this.volumes.get(id) : undefined;
  }

  async describeVolume(volumeId: string): Promise<AwsVolumeObservation | undefined> {
    this.describedVolumes.push(volumeId);
    return this.volumes.get(volumeId);
  }

  async waitForVolumeState(
    volumeId: string,
    state: 'available' | 'in-use' | 'deleted',
  ): Promise<AwsVolumeObservation | undefined> {
    this.waitedVolumeStates.push({ id: volumeId, state });
    const current = this.volumes.get(volumeId);
    if (state === 'deleted') {
      const deleted = { volumeId, state: 'deleted' as const, observedAt: NOW };
      this.volumes.set(volumeId, deleted);
      return deleted;
    }
    if (!current) return undefined;
    const observed = { ...current, state };
    this.volumes.set(volumeId, observed);
    return observed;
  }

  async deleteVolume(volumeId: string): Promise<AwsProviderMutationResult> {
    this.deleteVolumeCalls += 1;
    const current = this.volumes.get(volumeId);
    if (current) this.volumes.set(volumeId, { ...current, state: 'deleting' });
    return { requestId: `request:delete:${volumeId}` };
  }

  async runInstances(input: AwsRunInstancesInput): Promise<AwsCreatedInstance> {
    this.runInstancesCalls.push(input);
    const existing = this.instanceTokens.get(input.ClientToken);
    const instanceId = existing ?? `i-${String(this.instanceTokens.size + 1).padStart(17, '0')}`;
    this.instanceTokens.set(input.ClientToken, instanceId);
    this.instances.set(instanceId, {
      instanceId,
      state: 'pending',
      imageId: 'ami-ubuntu-2404',
      attachedVolumeIds: [],
      instanceStatus: 'initializing',
      systemStatus: 'initializing',
      ssmOnline: false,
      observedAt: NOW,
    });
    return { instanceId, requestId: `request:run:${instanceId}` };
  }

  async findInstanceByClientToken(clientToken: string): Promise<AwsInstanceObservation | undefined> {
    const id = this.instanceTokens.get(clientToken);
    return id ? this.instances.get(id) : undefined;
  }

  async describeInstance(instanceId: string): Promise<AwsInstanceObservation | undefined> {
    this.describedInstances.push(instanceId);
    return this.instances.get(instanceId);
  }

  async waitForInstanceState(
    instanceId: string,
    state: 'running' | 'stopped' | 'terminated',
  ): Promise<AwsInstanceObservation | undefined> {
    this.waitedInstanceStates.push({ id: instanceId, state });
    const current = this.instances.get(instanceId);
    if (!current) return undefined;
    const observed: AwsInstanceObservation = {
      ...current,
      state,
      instanceStatus: state === 'running' ? 'ok' : current.instanceStatus,
      systemStatus: state === 'running' ? 'ok' : current.systemStatus,
      ssmOnline: state === 'running',
      observedAt: NOW,
    };
    this.instances.set(instanceId, observed);
    return observed;
  }

  async attachVolume(input: {
    InstanceId: string;
    VolumeId: string;
    Device: string;
  }): Promise<AwsProviderMutationResult> {
    this.attachVolumeCalls.push(input);
    const volume = this.volumes.get(input.VolumeId);
    const instance = this.instances.get(input.InstanceId);
    if (!volume || !instance) throw new Error('fake AWS attachment references an unknown resource');
    this.volumes.set(input.VolumeId, {
      ...volume,
      state: 'in-use',
      attachedInstanceId: input.InstanceId,
    });
    this.instances.set(input.InstanceId, {
      ...instance,
      attachedVolumeIds: [...new Set([...instance.attachedVolumeIds, input.VolumeId])],
    });
    return { requestId: `request:attach:${input.VolumeId}` };
  }

  async startInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.startCalls += 1;
    this.setInstanceStates(instanceIds, 'pending');
    return { requestId: 'request:start' };
  }

  async stopInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.stopCalls += 1;
    this.setInstanceStates(instanceIds, 'stopping');
    return { requestId: 'request:stop' };
  }

  async rebootInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.rebootCalls += 1;
    this.setInstanceStates(instanceIds, 'pending');
    return { requestId: 'request:reboot' };
  }

  async repairInstance(instanceId: string): Promise<AwsProviderMutationResult> {
    this.repairCalls += 1;
    this.setInstanceStates([instanceId], 'pending');
    return { requestId: 'request:repair' };
  }

  async terminateInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.terminateCalls += 1;
    this.setInstanceStates(instanceIds, 'shutting-down');
    return { requestId: 'request:terminate' };
  }

  async createSnapshot(input: AwsCreateSnapshotInput): Promise<AwsCreatedSnapshot> {
    this.createSnapshotCalls.push(input);
    const existing = this.snapshotTokens.get(input.ClientToken);
    const snapshotId = existing ?? `snap-${this.snapshotTokens.size + 1}`;
    this.snapshotTokens.set(input.ClientToken, snapshotId);
    this.snapshots.set(snapshotId, { snapshotId, state: 'pending', observedAt: NOW });
    return { snapshotId, requestId: `request:snapshot:${snapshotId}` };
  }

  async findSnapshotByClientToken(clientToken: string): Promise<AwsSnapshotObservation | undefined> {
    const id = this.snapshotTokens.get(clientToken);
    return id ? this.snapshots.get(id) : undefined;
  }

  async waitForSnapshotCompleted(snapshotId: string): Promise<AwsSnapshotObservation> {
    const observed = { snapshotId, state: 'completed' as const, observedAt: NOW };
    this.snapshots.set(snapshotId, observed);
    return observed;
  }

  async listManagedResources(request: AwsWorkspaceHostInventoryRequest): Promise<AwsWorkspaceHostInventorySnapshot> {
    const resource = (kind: 'vm' | 'disk', providerId: string) => ({
      resource: { target: 'aws', kind, providerId, parentProviderId: request.projectId, region: request.region },
      labels: {},
      observedAt: NOW,
    });
    return {
      complete: true,
      observed: [
        ...[...this.instances.keys()].map((id) => resource('vm', id)),
        ...[...this.volumes.keys()].map((id) => resource('disk', id)),
      ],
      inventoryEvidence: (['vm', 'disk', 'snapshot'] as const).map((kind) => ({
        kind,
        strategy: 'managed-labels' as const,
        providerEvidenceRef: `fake://${kind}`,
      })),
    };
  }

  private setInstanceStates(instanceIds: readonly string[], state: AwsEc2InstanceState): void {
    for (const instanceId of instanceIds) {
      const current = this.instances.get(instanceId);
      if (current) this.instances.set(instanceId, { ...current, state, observedAt: NOW });
    }
  }
}

function providerAndClient() {
  const client = new FakeAwsWorkspaceHostSdkClient();
  const provider = createAwsWorkspaceHostProvider({ client, now: () => NOW });
  return { client, provider };
}

function requireAppliedResource(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef {
  if (!('resource' in result) || !result.resource) {
    throw new Error(`expected an applied AWS resource, received '${result.state}'`);
  }
  return result.resource;
}

async function provision(
  client: FakeAwsWorkspaceHostSdkClient,
  provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
): Promise<{ host: WorkspaceHostRef; resources: WorkspaceHostResourceRef[] }> {
  const plan = await provider.plan(
    { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: desired() },
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
  expect(client.attachVolumeCalls).toHaveLength(1);
  return { host: { hostId: desired().hostId, target: 'aws', resources }, resources };
}

/** Every `TagSpecifications[].ResourceType` anywhere in a value (step inputs nest the EC2 request). */
function taggedResourceTypes(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => taggedResourceTypes(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'TagSpecifications' && Array.isArray(entry)) {
        for (const spec of entry) if (typeof spec?.ResourceType === 'string') out.add(spec.ResourceType);
      } else taggedResourceTypes(entry, out);
    }
  }
  return out;
}

describe('AWS zero-orphan coverage (aws-byoc-gcp-parity P-007)', () => {
  // The teardown census (censusAwsWorkspaceHostResources) can only prove "no resource carrying this
  // host's ownership tag survives" for the kinds it enumerates. So every EC2 resource type the
  // provider TAGS for a host must map to an AWS census kind; a new tagged type (a per-host security
  // group, an instance profile, an ENI) would otherwise survive teardown invisibly.
  const EC2_TAG_TYPE_TO_CENSUS_KIND: Record<string, string> = { instance: 'vm', volume: 'disk', snapshot: 'snapshot' };

  it('tags only resource types the teardown census enumerates, and creates no per-host SG or instance profile', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'orphan-1', idempotencyKey: 'orphan-1', desired: desired() },
      context(),
    );
    const tagged = taggedResourceTypes(plan.steps.map((step) => step.input));
    expect([...tagged].sort()).toEqual(['instance', 'volume']);
    for (const type of tagged) {
      expect(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS as readonly string[]).toContain(EC2_TAG_TYPE_TO_CENSUS_KIND[type]);
    }
    // Snapshots are tagged by the snapshot action; their census kind must exist too.
    expect(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS as readonly string[]).toContain(EC2_TAG_TYPE_TO_CENSUS_KIND.snapshot);
    // Security groups and the instance profile are CONNECTION-level (settings.securityGroupIds /
    // instanceProfileArn): referenced, never created or host-tagged, so they cannot be host orphans.
    for (const step of plan.steps) {
      expect(JSON.stringify(step.input)).not.toMatch(/CreateSecurityGroup|security-group'|CreateInstanceProfile|instance-profile'/i);
      expect((step.input as { op?: string }).op ?? '').not.toMatch(/security-group|instance-profile|iam/i);
    }
  });
});

describe('AWS workspace-host provider planning', () => {
  it('builds deterministic RunInstances and encrypted EBS inputs with a stable 64-character ClientToken', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const [first, replay] = await Promise.all([provider.plan(request, context()), provider.plan(request, context())]);

    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn }))).toEqual([
      { id: 'create-data-volume', dependsOn: [] },
      { id: 'run-instance', dependsOn: ['create-data-volume'] },
      { id: 'attach-data-volume', dependsOn: ['create-data-volume', 'run-instance'] },
    ]);

    const volume = first.steps[0].input as unknown as { request: AwsCreateVolumeInput };
    expect(volume.request).toMatchObject({
      AvailabilityZone: 'us-east-1a',
      ClientToken: awsWorkspaceHostClientToken('operation-1:data-volume'),
      Encrypted: true,
      KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
      Size: 100,
      VolumeType: 'gp3',
    });
    expect(volume.request.ClientToken).toHaveLength(AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH);

    const instance = first.steps[1].input as unknown as { request: AwsRunInstancesInput; vpcId: string };
    expect(instance.vpcId).toBe('vpc-123');
    expect(instance.request.ClientToken).toBe(awsWorkspaceHostClientToken('operation-1:instance'));
    expect(instance.request.ClientToken).toHaveLength(AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH);
    expect(instance.request).toMatchObject({
      LaunchTemplate: { LaunchTemplateId: 'lt-123', Version: '7' },
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: 'subnet-123',
          Groups: ['sg-egress', 'sg-workspace'],
          DeleteOnTermination: true,
          AssociatePublicIpAddress: false,
        },
      ],
      IamInstanceProfile: { Arn: 'arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace' },
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sda1',
          Ebs: {
            DeleteOnTermination: true,
            Encrypted: true,
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
            VolumeSize: 40,
            VolumeType: 'gp3',
          },
        },
      ],
      UserData: Buffer.from('#!/bin/sh\necho papercusp-bootstrap\n').toString('base64'),
    });
    expect(instance.request.TagSpecifications[0].Tags).toContainEqual({
      Key: 'papercusp:host-id',
      Value: 'host-aws-1',
    });
  });

  it('refuses dependent provider calls until prerequisite resource identities are persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    const runStep = plan.steps[1];
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [] },
        context(),
      ),
    ).rejects.toThrow('requires the persisted disk resource identity');
    expect(client.runInstancesCalls).toHaveLength(0);

    const volumeResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    expect('resource' in volumeResult && volumeResult.resource?.kind).toBe('disk');
    const volume = requireAppliedResource(volumeResult);
    expect(volume).toMatchObject({ region: 'us-east-1', zone: 'us-east-1a' });
    const instanceResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    expect('resource' in instanceResult && instanceResult.resource?.kind).toBe('vm');
    expect(client.runInstancesCalls).toHaveLength(1);
  });

  it('launches with no public IP and an SSM instance profile, reachable only over SSM (P-005)', async () => {
    const { client, provider } = providerAndClient();
    await provision(client, provider);

    // The request EC2 actually received, not just the plan: an omitted AssociatePublicIpAddress
    // would inherit the subnet's MapPublicIpOnLaunch, so false must be explicit on the wire input.
    expect(client.runInstancesCalls).toHaveLength(1);
    const [launch] = client.runInstancesCalls;
    expect(launch!.NetworkInterfaces).toHaveLength(1);
    expect(launch!.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
    expect(launch!.IamInstanceProfile.Arn).toBe('arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace');
    // The ingress check ran against exactly the groups the instance is launched into.
    expect(client.describedSecurityGroups).toEqual([['sg-egress', 'sg-workspace']]);

    const transports = provider.capabilities.transportKinds;
    expect(transports).toContain('aws-ssm-ssh');
  });

  it('refuses to launch into a security group that has any inbound rule (P-005)', async () => {
    const { client, provider } = providerAndClient();
    client.securityGroupIngress.set('sg-workspace', 1);
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-ingress', idempotencyKey: 'operation-ingress', desired: desired() },
      context(),
    );
    const volume = requireAppliedResource(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
        context(),
      ),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1], knownResources: [volume] },
        context(),
      ),
    ).rejects.toThrow('aws_workspace_host_security_group_has_ingress: sg-workspace');
    expect(client.runInstancesCalls).toHaveLength(0);
  });

  it('refuses to launch when EC2 cannot confirm a security group is closed (P-005)', async () => {
    const { client, provider } = providerAndClient();
    client.hiddenSecurityGroups.add('sg-egress');
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-hidden', idempotencyKey: 'operation-hidden', desired: desired() },
      context(),
    );
    const volume = requireAppliedResource(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
        context(),
      ),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1], knownResources: [volume] },
        context(),
      ),
    ).rejects.toThrow('aws_workspace_host_security_group_unverifiable: sg-egress');
    expect(client.runInstancesCalls).toHaveLength(0);
  });

  it('fails closed when a desired persistent data volume is not encrypted', async () => {
    const { provider } = providerAndClient();
    const unencrypted = desired();
    unencrypted.data = { ...unencrypted.data, encrypted: false };

    await expect(
      provider.plan(
        {
          action: 'provision',
          operationId: 'operation-unencrypted',
          idempotencyKey: 'operation-unencrypted',
          desired: unencrypted,
        },
        context(),
      ),
    ).rejects.toThrow('data volumes must be encrypted');
  });
});

describe('AWS workspace-host provider contract and lifecycle', () => {
  it('declares versioned SSM SSH prerequisites and separates interactive SCP from bulk transfer', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const profile = await provider.getTransportProfile(host, context());

    expect(profile.compatibility.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'aws-session-manager-plugin', minimumVersion: '1.1.23.0' }),
        expect.objectContaining({ id: 'aws-ssm-agent', minimumVersion: '2.3.672.0' }),
      ]),
    );
    expect(profile.kind).toBe('aws-ssm-ssh');
    expect(profile.features.fileTransfer).toBe(true);
    expect(profile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.compatibility.audit).toMatchObject({ controlPlaneEvents: true, sessionContent: false });
    expect(profile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({
        feature: 'fileTransfer',
        trafficClass: 'bulk-transfer',
        strategy: 'provider-object-storage',
      }),
    );
  });

  it('exposes restricted direct SSH only when the caller supplies an explicit non-/0 allowlist', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    await expect(
      provider.getTransportProfile(
        host,
        context({ transportPreference: 'aws-direct-ssh', directAddress: '203.0.113.17' }),
      ),
    ).rejects.toThrow('explicit restricted source CIDR allowlist');

    const profile = await provider.getTransportProfile(
      host,
      context({
        transportPreference: 'aws-direct-ssh',
        directAddress: '203.0.113.17',
        directSshSourceRanges: ['198.51.100.42/32'],
      }),
    );
    expect(profile).toMatchObject({
      kind: 'aws-direct-ssh',
      audited: false,
      compatibility: { traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' } },
    });
  });

  it('passes the shared fake provider contract including reconcile, observation, transport, and confirmed destroy', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/aws/provider-contract-1',
      context: context(),
      desired: desired(),
      operationId: 'contract-operation',
      idempotencyKey: 'contract-operation',
      confirmedBy: 'vitest',
      now: () => NOW,
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(report.provisionedResources.map((item) => item.kind)).toEqual(['disk', 'vm']);
    expect(report.destroyConfirmations.map((item) => item.providerResourceId)).toEqual([
      'i-00000000000000001',
      'vol-1',
    ]);
  });

  it('uses observed-state waiters for lifecycle actions, snapshots and repairs, then confirms instance and volume absence', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const actions = ['stop', 'start', 'restart', 'snapshot', 'repair'] as const;
    const results: WorkspaceHostApplyResult[] = [];
    for (const action of actions) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host, name: 'manual' }
          : { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host },
        context(),
      );
      results.push(
        await provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: resources },
          context(),
        ),
      );
    }

    expect(results.every((result) => result.state === 'applied')).toBe(true);
    expect({
      start: client.startCalls,
      stop: client.stopCalls,
      reboot: client.rebootCalls,
      repair: client.repairCalls,
      snapshots: client.createSnapshotCalls.length,
    }).toEqual({ start: 1, stop: 1, reboot: 1, repair: 1, snapshots: 1 });
    expect(client.waitedInstanceStates.map(({ state }) => state)).toEqual(
      expect.arrayContaining(['running', 'stopped']),
    );

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
    const confirmations: string[] = [];
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') confirmations.push(result.confirmation.providerResourceId);
    }
    expect(confirmations).toEqual(['i-00000000000000001', 'vol-1']);
    expect(client.terminateCalls).toBe(1);
    expect(client.deleteVolumeCalls).toBe(1);
    expect(client.describedInstances).toContain('i-00000000000000001');
    expect(client.describedVolumes).toContain('vol-1');
    expect(client.waitedInstanceStates.map(({ state }) => state)).toContain('terminated');
    expect(client.waitedVolumeStates.map(({ state }) => state)).toContain('deleted');
  });

  it('reconciles an ambiguous RunInstances success by ClientToken without issuing another launch', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-3', idempotencyKey: 'operation-3', desired: desired() },
      context(),
    );
    const volumeResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    const volume = requireAppliedResource(volumeResult);
    const runStep = plan.steps[1];
    const applied = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    expect(client.runInstancesCalls).toHaveLength(1);

    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: runStep,
        knownResources: [volume],
        reason: 'ambiguous-timeout',
        previousProviderRequestId: applied.providerRequestId,
      },
      context(),
    );
    expect(reconciled.state).toBe('unchanged');
    expect('resource' in reconciled && reconciled.resource?.providerId).toBe('i-00000000000000001');
    expect(client.runInstancesCalls).toHaveLength(1);
  });
});

// aws-byoc-gcp-parity-2026-10-01 P-003: the AWS provider feeds the same teardown-obligation
// ledger as GCP. A created EC2 instance / EBS volume must open an obligation addressed for an
// out-of-band delete, and a confirmed delete must close exactly that row.
describe('AWS workspace-host provider teardown-obligation observers', () => {
  function observedProvider(overrides: { onResourceCreated?: (event: WorkspaceHostResourceCreatedEvent) => void } = {}) {
    const created: WorkspaceHostResourceCreatedEvent[] = [];
    const destroyed: Array<{ deleteOp: string; providerId: string; workspaceId: string }> = [];
    const client = new FakeAwsWorkspaceHostSdkClient();
    const provider = createAwsWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: overrides.onResourceCreated ?? ((event) => void created.push(event)),
      onResourceDestroyed: (event) =>
        void destroyed.push({ ...event.resource, workspaceId: event.workspaceId }),
    });
    return { client, provider, created, destroyed };
  }

  async function destroyAll(
    provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
    host: WorkspaceHostRef,
    resources: WorkspaceHostResourceRef[],
  ): Promise<void> {
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
    }
  }

  it('opens one obligation per owned resource, addressed to the connection account and region', async () => {
    const { client, provider, created } = observedProvider();
    await provision(client, provider);

    expect(created.map((event) => [event.resource.kind, event.resource.providerId])).toEqual([
      ['disk', 'vol-1'],
      ['vm', 'i-00000000000000001'],
    ]);
    for (const event of created) {
      expect(event).toMatchObject({
        workspaceId: 'workspace-aws-1',
        hostId: 'host-aws-1',
        parentResourceId: '123456789012',
        resource: { parentProviderId: '123456789012', region: 'us-east-1' },
      });
      // Every recorded row must be addressable for an out-of-band AWS delete.
      const addressability = describeCloudResourceDeleteAddress({
        provider: 'aws',
        resourceKind: event.resource.kind,
        resourceId: event.resource.providerId,
        projectId: event.resource.parentProviderId ?? '',
        zone: event.resource.zone ?? '',
        region: event.resource.region ?? '',
        parentResourceId: event.parentResourceId ?? '',
        hostId: event.hostId ?? '',
      });
      expect(addressability.addressable, JSON.stringify(addressability)).toBe(true);
    }
  });

  it('closes each obligation on a confirmed delete with an op that maps back to the recorded kind', async () => {
    const { client, provider, created, destroyed } = observedProvider();
    const { host, resources } = await provision(client, provider);
    await destroyAll(provider, host, resources);

    expect(destroyed).toEqual([
      { deleteOp: 'terminate-instance', providerId: 'i-00000000000000001', workspaceId: 'workspace-aws-1' },
      { deleteOp: 'delete-volume', providerId: 'vol-1', workspaceId: 'workspace-aws-1' },
    ]);
    const createdKindById = new Map(created.map((event) => [event.resource.providerId, event.resource.kind]));
    for (const event of destroyed) {
      expect(cloudResourceKindForDeleteOp(event.deleteOp, 'aws')).toBe(createdKindById.get(event.providerId));
    }
  });

  it('fails the step when the obligation producer fails, so a billable resource is never untracked', async () => {
    const { provider } = observedProvider({
      onResourceCreated: () => {
        throw new Error('obligation ledger unavailable');
      },
    });
    const plan = await provider.plan(
      { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: desired() },
      context(),
    );
    await expect(
      provider.apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] }, context()),
    ).rejects.toThrow('obligation ledger unavailable');
  });
});
