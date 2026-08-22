import { createHash } from 'node:crypto';
import type {
  WorkspaceHostApplyRequest,
  WorkspaceHostApplyResult,
  WorkspaceHostCatalogQuery,
  WorkspaceHostConnectionValidation,
  WorkspaceHostDesiredSpec,
  WorkspaceHostHealthAttestation,
  WorkspaceHostImage,
  WorkspaceHostObservation,
  WorkspaceHostPlan,
  WorkspaceHostPlanRequest,
  WorkspaceHostPlanStep,
  WorkspaceHostPriceEstimate,
  WorkspaceHostProvider,
  WorkspaceHostProviderCapabilities,
  WorkspaceHostProviderConnection,
  WorkspaceHostProviderContext,
  WorkspaceHostReconcileRequest,
  WorkspaceHostRef,
  WorkspaceHostRegion,
  WorkspaceHostResourceRef,
  WorkspaceHostScope,
  WorkspaceHostSize,
  WorkspaceHostSnapshotRef,
  WorkspaceHostTransportProfile,
} from '@papercusp/deployment-driver';
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import { GCP_CLOUD_PLATFORM_SCOPE } from '../cloud-workspaces/gcp-preflight';

export { GCP_CLOUD_PLATFORM_SCOPE };

export const GCP_WORKSPACE_HOST_TARGET = 'gcp';
export const GCP_WORKSPACE_HOST_PROVIDER_VERSION = 'gcp-workspace-host-provider-v1';
export const GCP_IAP_TCP_FORWARDING_RANGE = '35.235.240.0/20';
export const GCP_DATA_DISK_RESIZE_POLICY = 'grow-only';
export const GCP_DATA_MOUNT_POINT = '/var/lib/papercusp';

export type GcpComputeInstanceStatus =
  | 'PROVISIONING'
  | 'STAGING'
  | 'RUNNING'
  | 'STOPPING'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'REPAIRING'
  | 'TERMINATED';
export type GcpComputeDiskStatus = 'CREATING' | 'RESTORING' | 'READY' | 'FAILED' | 'DELETING';
export type GcpComputeSnapshotStatus = 'CREATING' | 'READY' | 'FAILED' | 'DELETING';
export type GcpOperationScope = 'global' | 'region' | 'zone';

export interface GcpOperationRef {
  name: string;
  scope: GcpOperationScope;
  location?: string;
  requestId: string;
}

export interface GcpOperationObservation extends GcpOperationRef {
  status: 'PENDING' | 'RUNNING' | 'DONE';
  observedAt: string;
  error?: { code?: string; message: string };
}

export interface GcpResourceObservation {
  name: string;
  selfLink?: string;
  observedAt: string;
  labels?: Readonly<Record<string, string>>;
}

export interface GcpInstanceObservation extends GcpResourceObservation {
  status: GcpComputeInstanceStatus;
  sourceImage?: string;
  attachedDiskNames: readonly string[];
  agentOnline?: boolean;
  recreateInput?: GcpInstanceInsertInput;
}

export interface GcpDiskObservation extends GcpResourceObservation {
  status: GcpComputeDiskStatus;
  attachedInstanceNames: readonly string[];
  sizeGb?: number;
}

export interface GcpSnapshotObservation extends GcpResourceObservation {
  status: GcpComputeSnapshotStatus;
}

export interface GcpNetworkInsertInput {
  name: string;
  autoCreateSubnetworks: false;
  routingConfig: { routingMode: 'REGIONAL' };
}

export interface GcpSubnetworkInsertInput {
  name: string;
  network: string;
  ipCidrRange: string;
  region: string;
  privateIpGoogleAccess: true;
  stackType: 'IPV4_ONLY';
}

export interface GcpFirewallInsertInput {
  name: string;
  network: string;
  direction: 'INGRESS';
  sourceRanges: readonly string[];
  targetTags: readonly string[];
  allowed: readonly [{ IPProtocol: 'tcp'; ports: readonly string[] }];
}

export interface GcpDiskInsertInput {
  name: string;
  zone: string;
  sizeGb: number;
  type: string;
  labels: Readonly<Record<string, string>>;
  diskEncryptionKey?: { kmsKeyName: string };
}

export interface GcpInstanceInsertInput {
  name: string;
  zone: string;
  machineType: string;
  labels: Readonly<Record<string, string>>;
  tags: { items: readonly string[] };
  networkInterfaces: readonly [
    {
      network: string;
      subnetwork: string;
      stackType: 'IPV4_ONLY';
    },
  ];
  disks: readonly [
    {
      boot: true;
      autoDelete: true;
      initializeParams: {
        sourceImage: string;
        diskSizeGb: number;
        diskType: string;
        diskEncryptionKey?: { kmsKeyName: string };
      };
    },
    {
      boot: false;
      autoDelete: false;
      source: string;
      deviceName: string;
      mode: 'READ_WRITE';
    },
  ];
  serviceAccounts: readonly [{ email: string; scopes: readonly string[] }];
  metadata: { items: readonly { key: string; value: string }[] };
}

export interface GcpSnapshotInsertInput {
  name: string;
  sourceDisk: string;
  labels: Readonly<Record<string, string>>;
  snapshotEncryptionKey?: { kmsKeyName: string };
}

/**
 * Compute Engine REST-shaped seam. The production composition owns ADC/token
 * resolution; this provider accepts only non-secret connection references and
 * never manufactures a live client implicitly.
 */
export interface GcpWorkspaceHostApiClient {
  validateConnection(connection: WorkspaceHostProviderConnection): Promise<WorkspaceHostConnectionValidation>;
  listScopes(connection: WorkspaceHostProviderConnection): Promise<readonly WorkspaceHostScope[]>;
  listRegions(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostRegion[]>;
  listSizes(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostSize[]>;
  listImages(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostImage[]>;
  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate>;

  getNetwork(projectId: string, name: string): Promise<GcpResourceObservation | undefined>;
  getSubnetwork(projectId: string, region: string, name: string): Promise<GcpResourceObservation | undefined>;
  getFirewall(projectId: string, name: string): Promise<GcpResourceObservation | undefined>;
  getDisk(projectId: string, zone: string, name: string): Promise<GcpDiskObservation | undefined>;
  getInstance(projectId: string, zone: string, name: string): Promise<GcpInstanceObservation | undefined>;
  getSnapshot(projectId: string, name: string): Promise<GcpSnapshotObservation | undefined>;

  insertNetwork(projectId: string, input: GcpNetworkInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertSubnetwork(
    projectId: string,
    region: string,
    input: GcpSubnetworkInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  insertFirewall(projectId: string, input: GcpFirewallInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertDisk(projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertInstance(
    projectId: string,
    zone: string,
    input: GcpInstanceInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  createSnapshot(projectId: string, input: GcpSnapshotInsertInput, requestId: string): Promise<GcpOperationRef>;

  startInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  stopInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  resetInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteDisk(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteFirewall(projectId: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteSubnetwork(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteNetwork(projectId: string, name: string, requestId: string): Promise<GcpOperationRef>;
  waitForOperation(operation: GcpOperationRef, signal?: AbortSignal): Promise<GcpOperationObservation>;
}

export interface GcpWorkspaceHostProviderOptions {
  client: GcpWorkspaceHostApiClient;
  now?: () => string;
}

interface ManagedNetworkSettings {
  mode: 'managed';
  networkName: string;
  subnetworkName: string;
  firewallName: string;
  ipCidrRange: string;
  sourceRanges: readonly string[];
  allowedTcpPorts: readonly string[];
}

interface ExistingNetworkSettings {
  mode: 'existing';
  networkName: string;
  subnetworkName: string;
  firewallName: string;
}

export interface GcpWorkspaceHostDesiredProviderSettings {
  projectId: string;
  zone: string;
  network: ManagedNetworkSettings | ExistingNetworkSettings;
  serviceAccountEmail: string;
  serviceAccountScopes: readonly string[];
  instanceName: string;
  dataDiskName: string;
  dataDeviceName: string;
  bootDiskGiB: number;
  bootDiskType: string;
  dataDiskType: string;
  dataDiskResizePolicy: typeof GCP_DATA_DISK_RESIZE_POLICY;
  kmsKeyName?: string;
  startupScript?: string;
  metadata: Readonly<Record<string, string>>;
}

type GcpStepInput =
  | { op: 'insert-network'; projectId: string; requestId: string; request: GcpNetworkInsertInput; hostId: string }
  | {
      op: 'use-existing-network';
      projectId: string;
      networkName: string;
      hostId: string;
    }
  | {
      op: 'insert-subnetwork';
      projectId: string;
      region: string;
      requestId: string;
      request: GcpSubnetworkInsertInput;
      hostId: string;
      managed: true;
    }
  | {
      op: 'use-existing-subnetwork';
      projectId: string;
      region: string;
      subnetworkName: string;
      networkName: string;
      hostId: string;
    }
  | {
      op: 'insert-firewall';
      projectId: string;
      requestId: string;
      request: GcpFirewallInsertInput;
      hostId: string;
      managed: true;
    }
  | {
      op: 'use-existing-firewall';
      projectId: string;
      firewallName: string;
      networkName: string;
      hostId: string;
    }
  | {
      op: 'insert-disk';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpDiskInsertInput;
      hostId: string;
    }
  | {
      op: 'insert-instance';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpInstanceInsertInput;
      hostId: string;
    }
  | {
      op: 'start-instance' | 'stop-instance' | 'reset-instance' | 'repair-instance';
      projectId: string;
      zone: string;
      instanceName: string;
      requestId: string;
      hostId: string;
    }
  | {
      op: 'create-snapshot';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpSnapshotInsertInput;
      hostId: string;
    }
  | {
      op: 'delete-instance' | 'delete-disk' | 'delete-firewall' | 'delete-subnetwork' | 'delete-network';
      projectId: string;
      requestId: string;
      resourceName: string;
      region?: string;
      zone?: string;
      hostId: string;
    };

type GcpDeleteStepInput = Extract<GcpStepInput, { resourceName: string }>;

const VM_KIND = 'vm';
const DISK_KIND = 'disk';
const NETWORK_KIND = 'network';
const SUBNETWORK_KIND = 'subnetwork';
const FIREWALL_KIND = 'firewall';
const EXISTING_NETWORK_KIND = 'existing-network';
const EXISTING_SUBNETWORK_KIND = 'existing-subnetwork';
const EXISTING_FIREWALL_KIND = 'existing-firewall';

const CAPABILITIES: WorkspaceHostProviderCapabilities = {
  discovery: { scopes: true, regions: true, sizes: true, images: true, priceEstimates: true },
  lifecycle: {
    start: true,
    stop: true,
    restart: true,
    snapshot: true,
    restore: false,
    upgrade: true,
    repair: true,
    confirmedDestroy: true,
  },
  transportKinds: ['gcp-iap-ssh'],
  constraints: [
    'Instances have no external IP; interactive access uses IAP TCP forwarding with OS Login',
    'Cloud authorization is a resolver reference; service-account key material is forbidden',
    'Data disks use a grow-only resize policy; shrinking requires snapshot-and-restore into a new disk',
    'Upgrade replaces the VM boot/runtime layer and reattaches the retained data disk',
    'Snapshot plans quiesce a running VM before capture and restore its prior running state afterward',
    'Restore from snapshots is not yet supported',
  ],
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function optionalPayload(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function dataDeviceName(value: unknown): string {
  const name = optionalString(value, 'gcp.desired.provider.dataDeviceName') ?? 'papercusp-data';
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error('gcp.desired.provider.dataDeviceName must be a lowercase Compute Engine device name');
  }
  return name;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function stringArray(value: unknown, label: string, fallback?: readonly string[]): readonly string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one string`);
  return [...new Set(value.map((item, index) => requireString(item, `${label}[${index}]`)))].sort();
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      requireString(key, `${label} key`),
      requireString(item, `${label}.${key}`),
    ]),
  );
}

function stableName(prefix: string, hostId: string): string {
  const suffix = createHash('sha256').update(hostId).digest('hex').slice(0, 8);
  const slug =
    hostId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host';
  const available = 63 - prefix.length - suffix.length - 2;
  const body = slug.slice(0, Math.max(1, available)).replace(/-+$/g, '') || 'host';
  return `${prefix}-${body}-${suffix}`;
}

function gcpLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (normalized.length > 0 && normalized.length <= 63) return normalized;
  return `id-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** Compute Engine requestId: deterministic, non-zero RFC-4122 UUID. */
export function gcpWorkspaceHostRequestUuid(idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(requireString(idempotencyKey, 'idempotencyKey'))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function readSettings(desired: WorkspaceHostDesiredSpec): GcpWorkspaceHostDesiredProviderSettings {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET)
    throw new Error(`GCP provider cannot plan target '${desired.target}'`);
  if (desired.scope.kind !== 'project') throw new Error("GCP workspace hosts require scope.kind 'project'");
  if (!desired.data.encrypted) throw new Error('GCP workspace-host data disks must be encrypted');
  const provider = desired.provider ?? {};
  assertWorkspaceHostSecretIsolation(provider, 'gcp.desired.provider');
  const projectId =
    optionalString(provider.projectId, 'gcp.desired.provider.projectId') ??
    requireString(desired.scope.id, 'desired.scope.id');
  if (projectId !== desired.scope.id) throw new Error('GCP provider projectId must match desired.scope.id');
  const zone = requireString(desired.zone, 'desired.zone');
  if (!zone.startsWith(`${desired.region}-`)) throw new Error('GCP desired.zone must belong to desired.region');
  const rawNetwork = provider.network;
  if (!rawNetwork || typeof rawNetwork !== 'object' || Array.isArray(rawNetwork)) {
    throw new Error('gcp.desired.provider.network must select managed or existing mode');
  }
  const networkRecord = rawNetwork as Record<string, unknown>;
  const mode = requireString(networkRecord.mode, 'gcp.desired.provider.network.mode');
  const base = stableName('pc', desired.hostId);
  let network: ManagedNetworkSettings | ExistingNetworkSettings;
  if (mode === 'managed') {
    network = {
      mode,
      networkName:
        optionalString(networkRecord.networkName, 'gcp.desired.provider.network.networkName') ?? `${base}-net`,
      subnetworkName:
        optionalString(networkRecord.subnetworkName, 'gcp.desired.provider.network.subnetworkName') ?? `${base}-subnet`,
      firewallName:
        optionalString(networkRecord.firewallName, 'gcp.desired.provider.network.firewallName') ?? `${base}-iap`,
      ipCidrRange:
        optionalString(networkRecord.ipCidrRange, 'gcp.desired.provider.network.ipCidrRange') ?? '10.132.0.0/24',
      sourceRanges: stringArray(networkRecord.sourceRanges, 'gcp.desired.provider.network.sourceRanges', [
        GCP_IAP_TCP_FORWARDING_RANGE,
      ]),
      allowedTcpPorts: stringArray(networkRecord.allowedTcpPorts, 'gcp.desired.provider.network.allowedTcpPorts', [
        '22',
      ]),
    };
  } else if (mode === 'existing') {
    network = {
      mode,
      networkName: requireString(networkRecord.networkName, 'gcp.desired.provider.network.networkName'),
      subnetworkName: requireString(networkRecord.subnetworkName, 'gcp.desired.provider.network.subnetworkName'),
      firewallName: requireString(networkRecord.firewallName, 'gcp.desired.provider.network.firewallName'),
    };
  } else {
    throw new Error("gcp.desired.provider.network.mode must be 'managed' or 'existing'");
  }
  return {
    projectId,
    zone,
    network,
    serviceAccountEmail: requireString(provider.serviceAccountEmail, 'gcp.desired.provider.serviceAccountEmail'),
    serviceAccountScopes: stringArray(provider.serviceAccountScopes, 'gcp.desired.provider.serviceAccountScopes', [
      GCP_CLOUD_PLATFORM_SCOPE,
    ]),
    instanceName: optionalString(provider.instanceName, 'gcp.desired.provider.instanceName') ?? `${base}-vm`,
    dataDiskName: optionalString(provider.dataDiskName, 'gcp.desired.provider.dataDiskName') ?? `${base}-data`,
    dataDeviceName: dataDeviceName(provider.dataDeviceName),
    bootDiskGiB:
      provider.bootDiskGiB === undefined
        ? 30
        : positiveInteger(provider.bootDiskGiB, 'gcp.desired.provider.bootDiskGiB'),
    bootDiskType: optionalString(provider.bootDiskType, 'gcp.desired.provider.bootDiskType') ?? 'pd-balanced',
    dataDiskType: optionalString(provider.dataDiskType, 'gcp.desired.provider.dataDiskType') ?? 'pd-balanced',
    dataDiskResizePolicy: GCP_DATA_DISK_RESIZE_POLICY,
    kmsKeyName: optionalString(provider.kmsKeyName, 'gcp.desired.provider.kmsKeyName'),
    startupScript: optionalPayload(provider.startupScript, 'gcp.desired.provider.startupScript'),
    metadata: stringRecord(provider.metadata, 'gcp.desired.provider.metadata'),
  };
}

function labels(desired: WorkspaceHostDesiredSpec, workspaceId: string): Readonly<Record<string, string>> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(desired.labels ?? {})) entries.set(gcpLabel(key), gcpLabel(value));
  entries.set('papercusp-host-id', gcpLabel(desired.hostId));
  entries.set('papercusp-managed', 'true');
  entries.set('papercusp-workspace-id', gcpLabel(workspaceId));
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertManagedHostResource(observed: GcpResourceObservation, hostId: string, resourceLabel: string): void {
  const expectedHostLabel = gcpLabel(hostId);
  if (observed.labels?.['papercusp-managed'] !== 'true' || observed.labels['papercusp-host-id'] !== expectedHostLabel) {
    throw new Error(`GCP ${resourceLabel} '${observed.name}' is not labeled as managed by workspace host '${hostId}'`);
  }
}

function metadata(
  settings: GcpWorkspaceHostDesiredProviderSettings,
  hostId: string,
): readonly { key: string; value: string }[] {
  const entries = new Map<string, string>(Object.entries(settings.metadata));
  entries.set('block-project-ssh-keys', 'TRUE');
  entries.set('enable-oslogin', 'TRUE');
  entries.set('papercusp-host-id', hostId);
  entries.set('papercusp-data-resize-policy', settings.dataDiskResizePolicy);
  entries.set('startup-script', durableFilesystemStartupScript(settings));
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function durableFilesystemStartupScript(settings: GcpWorkspaceHostDesiredProviderSettings): string {
  const device = `/dev/disk/by-id/google-${settings.dataDeviceName}`;
  const userScript = settings.startupScript?.trim().replace(/^#![^\n]*(?:\n|$)/, '');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `data_device='${device}'`,
    `data_mount='${GCP_DATA_MOUNT_POINT}'`,
    'for attempt in $(seq 1 60); do test -b "$data_device" && break; sleep 1; done',
    'test -b "$data_device"',
    'if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi',
    'data_uuid=$(blkid -s UUID -o value "$data_device")',
    'install -d -m 0750 "$data_mount"',
    'grep -q "^UUID=${data_uuid} " /etc/fstab || printf "UUID=%s %s ext4 defaults,nofail,discard 0 2\\n" "$data_uuid" "$data_mount" >> /etc/fstab',
    'mountpoint -q "$data_mount" || mount "$data_mount"',
    'resize2fs "$data_device"',
    'install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}',
    ...(userScript ? ['', '# User-supplied bootstrap follows the durable mount.', userScript] : []),
    '',
  ].join('\n');
}

function resource(
  kind: string,
  providerId: string,
  options: Pick<WorkspaceHostResourceRef, 'parentProviderId' | 'region' | 'zone'> = {},
): WorkspaceHostResourceRef {
  return { target: GCP_WORKSPACE_HOST_TARGET, kind, providerId, ...options };
}

function knownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
): WorkspaceHostResourceRef | undefined {
  return resources.find(
    (candidate) => candidate.target === GCP_WORKSPACE_HOST_TARGET && kinds.includes(candidate.kind),
  );
}

function requireKnownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
  stepId: string,
): WorkspaceHostResourceRef {
  const found = knownResource(resources, kinds);
  if (!found)
    throw new Error(
      `GCP step '${stepId}' requires a persisted ${kinds.join('/')} resource identity before its provider call`,
    );
  return found;
}

function stepInput(step: WorkspaceHostPlanStep): GcpStepInput {
  const input = step.input as unknown as GcpStepInput;
  if (!input || typeof input !== 'object' || !('op' in input))
    throw new Error(`GCP plan step '${step.id}' lacks a GCP operation`);
  return input;
}

function hostIdFor(request: WorkspaceHostPlanRequest): string {
  return request.action === 'provision' ? request.desired.hostId : request.host.hostId;
}

function refName(value: string): string {
  return value.split('/').filter(Boolean).at(-1) ?? value;
}

function isDeleteStepInput(input: GcpStepInput): input is GcpDeleteStepInput {
  return input.op.startsWith('delete-');
}

export class GcpWorkspaceHostProvider implements WorkspaceHostProvider {
  readonly target = GCP_WORKSPACE_HOST_TARGET;
  readonly capabilities = CAPABILITIES;
  private readonly now: () => string;

  constructor(
    private readonly client: GcpWorkspaceHostApiClient,
    options: Pick<GcpWorkspaceHostProviderOptions, 'now'> = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  validateConnection(ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostConnectionValidation> {
    if (ctx.connection.target !== GCP_WORKSPACE_HOST_TARGET) {
      return Promise.resolve({
        ok: false,
        checkedAt: this.now(),
        warnings: [],
        errors: [`GCP provider cannot validate target '${ctx.connection.target}'`],
      });
    }
    assertWorkspaceHostSecretIsolation(ctx.connection.provider, 'gcp.connection.provider');
    return this.client.validateConnection(ctx.connection);
  }

  listScopes(ctx: WorkspaceHostProviderContext): Promise<readonly WorkspaceHostScope[]> {
    return this.client.listScopes(ctx.connection);
  }

  listRegions(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostRegion[]> {
    return this.client.listRegions(query, ctx.connection);
  }

  listSizes(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostSize[]> {
    return this.client.listSizes(query, ctx.connection);
  }

  listImages(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostImage[]> {
    return this.client.listImages(query, ctx.connection);
  }

  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostPriceEstimate> {
    return this.client.estimatePrice(desired, ctx.connection);
  }

  async plan(request: WorkspaceHostPlanRequest, ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostPlan> {
    if (request.action !== 'provision' && request.host.target !== GCP_WORKSPACE_HOST_TARGET) {
      throw new Error(`GCP provider cannot plan host target '${request.host.target}'`);
    }
    return {
      planId: `gcp:${gcpWorkspaceHostRequestUuid(`${request.operationId}:plan`)}`,
      operationId: request.operationId,
      target: GCP_WORKSPACE_HOST_TARGET,
      hostId: hostIdFor(request),
      generatedAt: this.now(),
      steps: await this.planSteps(request, ctx),
      warnings: [],
    };
  }

  private async planSteps(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    if (request.action === 'provision') return this.planProvision(request, ctx);
    if (request.action === 'destroy') return this.planDestroy(request, ctx);
    if (request.action === 'restore') throw new Error("GCP workspace-host action 'restore' is not supported");
    const instance = requireKnownResource(request.host.resources, [VM_KIND], request.action);
    const zone = requireString(instance.zone, `GCP ${request.action} instance zone`);
    const projectId = requireString(
      request.host.resources.find((item) => item.target === GCP_WORKSPACE_HOST_TARGET)?.parentProviderId ??
        ctx.connection.scope?.id,
      'GCP projectId',
    );
    const requestId = gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:${request.action}:${instance.providerId}`);
    if (request.action === 'upgrade') {
      const observed = await this.client.getInstance(projectId, zone, instance.providerId);
      if (!observed?.recreateInput) {
        throw new Error('GCP upgrade requires a fresh instance read with recreateInput');
      }
      const disk = requireKnownResource(request.host.resources, [DISK_KIND], request.action);
      const [bootDisk, dataDisk] = observed.recreateInput.disks;
      if (refName(dataDisk.source) !== refName(disk.providerId) || dataDisk.autoDelete) {
        throw new Error('GCP upgrade refused because the retained data disk identity is ambiguous');
      }
      const deleteKey = `${request.idempotencyKey}:delete-boot-runtime:${instance.providerId}`;
      const createKey = `${request.idempotencyKey}:create-boot-runtime:${instance.providerId}`;
      return [
        {
          id: 'delete-boot-runtime',
          action: 'upgrade',
          resourceKind: VM_KIND,
          dependsOn: [],
          idempotencyKey: deleteKey,
          destructive: true,
          input: {
            op: 'delete-instance',
            projectId,
            zone,
            resourceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(deleteKey),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        },
        {
          id: 'create-boot-runtime',
          action: 'upgrade',
          resourceKind: VM_KIND,
          dependsOn: ['delete-boot-runtime'],
          idempotencyKey: createKey,
          destructive: false,
          input: {
            op: 'insert-instance',
            projectId,
            zone,
            requestId: gcpWorkspaceHostRequestUuid(createKey),
            hostId: request.host.hostId,
            request: {
              ...observed.recreateInput,
              disks: [
                {
                  ...bootDisk,
                  initializeParams: { ...bootDisk.initializeParams, sourceImage: request.image.id },
                },
                { ...dataDisk, autoDelete: false, source: dataDisk.source },
              ],
            },
          } satisfies GcpStepInput,
        },
      ];
    }
    if (request.action === 'snapshot') {
      const disk = requireKnownResource(request.host.resources, [DISK_KIND], request.action);
      const name = request.name ?? stableName('pc-snapshot', request.host.hostId);
      const observed = await this.client.getInstance(projectId, zone, instance.providerId);
      const quiesce = observed?.status === 'RUNNING';
      const stopId = 'quiesce-instance';
      const snapshotId = 'snapshot-data-disk';
      const steps: WorkspaceHostPlanStep[] = [];
      if (quiesce) {
        steps.push({
          id: stopId,
          action: 'snapshot',
          resourceKind: VM_KIND,
          dependsOn: [],
          idempotencyKey: `${request.idempotencyKey}:quiesce:${instance.providerId}`,
          destructive: false,
          input: {
            op: 'stop-instance',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:quiesce:${instance.providerId}`),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        });
      }
      steps.push({
        id: snapshotId,
        action: 'snapshot',
        resourceKind: 'snapshot',
        dependsOn: quiesce ? [stopId] : [],
        idempotencyKey: `${request.idempotencyKey}:snapshot:${disk.providerId}`,
        destructive: false,
        input: {
          op: 'create-snapshot',
          projectId,
          zone: requireString(disk.zone, 'GCP snapshot disk zone'),
          requestId,
          hostId: request.host.hostId,
          request: {
            name,
            sourceDisk: disk.providerId,
            labels: { 'papercusp-host-id': gcpLabel(request.host.hostId) },
          },
        } satisfies GcpStepInput,
      });
      if (quiesce) {
        steps.push({
          id: 'resume-instance',
          action: 'snapshot',
          resourceKind: VM_KIND,
          dependsOn: [snapshotId],
          idempotencyKey: `${request.idempotencyKey}:resume:${instance.providerId}`,
          destructive: false,
          input: {
            op: 'start-instance',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:resume:${instance.providerId}`),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        });
      }
      return steps;
    }
    const op =
      request.action === 'start'
        ? 'start-instance'
        : request.action === 'stop'
          ? 'stop-instance'
          : request.action === 'restart'
            ? 'reset-instance'
            : 'repair-instance';
    return [
      {
        id: `${request.action}-instance`,
        action: request.action,
        resourceKind: VM_KIND,
        dependsOn: [],
        idempotencyKey: `${request.idempotencyKey}:${request.action}:${instance.providerId}`,
        destructive: false,
        input: {
          op,
          projectId,
          zone,
          instanceName: instance.providerId,
          requestId,
          hostId: request.host.hostId,
        } satisfies GcpStepInput,
      },
    ];
  }

  private planProvision(
    request: Extract<WorkspaceHostPlanRequest, { action: 'provision' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    const desired = request.desired;
    const settings = readSettings(desired);
    const commonLabels = labels(desired, ctx.workspaceId);
    const hostTag = stableName('pc-host', desired.hostId);
    const steps: WorkspaceHostPlanStep[] = [];
    if (settings.network.mode === 'managed') {
      steps.push(
        {
          id: 'create-network',
          action: 'provision',
          resourceKind: NETWORK_KIND,
          dependsOn: [],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:network`,
          input: {
            op: 'insert-network',
            projectId: settings.projectId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:network`),
            hostId: desired.hostId,
            request: {
              name: settings.network.networkName,
              autoCreateSubnetworks: false,
              routingConfig: { routingMode: 'REGIONAL' },
            },
          } satisfies GcpStepInput,
        },
        {
          id: 'create-subnetwork',
          action: 'provision',
          resourceKind: SUBNETWORK_KIND,
          dependsOn: ['create-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:subnetwork`,
          input: {
            op: 'insert-subnetwork',
            projectId: settings.projectId,
            region: desired.region,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:subnetwork`),
            hostId: desired.hostId,
            managed: true,
            request: {
              name: settings.network.subnetworkName,
              network: settings.network.networkName,
              ipCidrRange: settings.network.ipCidrRange,
              region: desired.region,
              privateIpGoogleAccess: true,
              stackType: 'IPV4_ONLY',
            },
          } satisfies GcpStepInput,
        },
        {
          id: 'create-firewall',
          action: 'provision',
          resourceKind: FIREWALL_KIND,
          dependsOn: ['create-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:firewall`,
          input: {
            op: 'insert-firewall',
            projectId: settings.projectId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:firewall`),
            hostId: desired.hostId,
            managed: true,
            request: {
              name: settings.network.firewallName,
              network: settings.network.networkName,
              direction: 'INGRESS',
              sourceRanges: settings.network.sourceRanges,
              targetTags: [hostTag],
              allowed: [{ IPProtocol: 'tcp', ports: settings.network.allowedTcpPorts }],
            },
          } satisfies GcpStepInput,
        },
      );
    } else {
      steps.push(
        {
          id: 'record-existing-network',
          action: 'provision',
          resourceKind: EXISTING_NETWORK_KIND,
          dependsOn: [],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-network`,
          input: {
            op: 'use-existing-network',
            projectId: settings.projectId,
            networkName: settings.network.networkName,
            hostId: desired.hostId,
          } satisfies GcpStepInput,
        },
        {
          id: 'record-existing-subnetwork',
          action: 'provision',
          resourceKind: EXISTING_SUBNETWORK_KIND,
          dependsOn: ['record-existing-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-subnetwork`,
          input: {
            op: 'use-existing-subnetwork',
            projectId: settings.projectId,
            region: desired.region,
            subnetworkName: settings.network.subnetworkName,
            networkName: settings.network.networkName,
            hostId: desired.hostId,
          } satisfies GcpStepInput,
        },
        {
          id: 'record-existing-firewall',
          action: 'provision',
          resourceKind: EXISTING_FIREWALL_KIND,
          dependsOn: ['record-existing-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-firewall`,
          input: {
            op: 'use-existing-firewall',
            projectId: settings.projectId,
            firewallName: settings.network.firewallName,
            networkName: settings.network.networkName,
            hostId: desired.hostId,
          } satisfies GcpStepInput,
        },
      );
    }
    const diskKey = `${request.idempotencyKey}:data-disk`;
    steps.push({
      id: 'create-data-disk',
      action: 'provision',
      resourceKind: DISK_KIND,
      dependsOn: [],
      destructive: false,
      idempotencyKey: diskKey,
      input: {
        op: 'insert-disk',
        projectId: settings.projectId,
        zone: settings.zone,
        requestId: gcpWorkspaceHostRequestUuid(diskKey),
        hostId: desired.hostId,
        request: {
          name: settings.dataDiskName,
          zone: settings.zone,
          sizeGb: positiveInteger(desired.data.volumeGiB, 'desired.data.volumeGiB'),
          type: settings.dataDiskType,
          labels: commonLabels,
          ...(settings.kmsKeyName ? { diskEncryptionKey: { kmsKeyName: settings.kmsKeyName } } : {}),
        },
      } satisfies GcpStepInput,
    });
    const instanceKey = `${request.idempotencyKey}:instance`;
    steps.push({
      id: 'create-instance',
      action: 'provision',
      resourceKind: VM_KIND,
      dependsOn: [steps[1].id, steps[2].id, 'create-data-disk'],
      destructive: false,
      idempotencyKey: instanceKey,
      input: {
        op: 'insert-instance',
        projectId: settings.projectId,
        zone: settings.zone,
        requestId: gcpWorkspaceHostRequestUuid(instanceKey),
        hostId: desired.hostId,
        request: {
          name: settings.instanceName,
          zone: settings.zone,
          machineType: desired.size.includes('/')
            ? desired.size
            : `zones/${settings.zone}/machineTypes/${desired.size}`,
          labels: commonLabels,
          tags: { items: [hostTag] },
          networkInterfaces: [
            {
              network: settings.network.networkName,
              subnetwork: settings.network.subnetworkName,
              stackType: 'IPV4_ONLY',
            },
          ],
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: desired.image.id,
                diskSizeGb: settings.bootDiskGiB,
                diskType: settings.bootDiskType,
                ...(settings.kmsKeyName ? { diskEncryptionKey: { kmsKeyName: settings.kmsKeyName } } : {}),
              },
            },
            {
              boot: false,
              autoDelete: false,
              source: `projects/${settings.projectId}/zones/${settings.zone}/disks/${settings.dataDiskName}`,
              deviceName: settings.dataDeviceName,
              mode: 'READ_WRITE',
            },
          ],
          serviceAccounts: [{ email: settings.serviceAccountEmail, scopes: settings.serviceAccountScopes }],
          metadata: { items: metadata(settings, desired.hostId) },
        },
      } satisfies GcpStepInput,
    });
    return steps;
  }

  private planDestroy(
    request: Extract<WorkspaceHostPlanRequest, { action: 'destroy' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.confirmation.expectedHostId !== request.host.hostId)
      throw new Error('GCP destroy confirmation expectedHostId does not match the host');
    const managed = request.host.resources.filter(
      (item) =>
        item.target === GCP_WORKSPACE_HOST_TARGET &&
        [VM_KIND, DISK_KIND, FIREWALL_KIND, SUBNETWORK_KIND, NETWORK_KIND].includes(item.kind),
    );
    if (managed.length === 0) throw new Error('GCP destroy requires known managed resources');
    const projectId = requireString(managed[0]?.parentProviderId ?? ctx.connection.scope?.id, 'GCP projectId');
    const steps: WorkspaceHostPlanStep[] = [];
    const preserveIds: string[] = [];
    if (request.disposition !== 'discard') {
      for (const disk of managed.filter((item) => item.kind === DISK_KIND)) {
        const id = `preserve-disk-${disk.providerId}`;
        preserveIds.push(id);
        const key = `${request.idempotencyKey}:${id}`;
        steps.push({
          id,
          action: 'destroy',
          resourceKind: 'snapshot',
          dependsOn: [],
          destructive: false,
          idempotencyKey: key,
          input: {
            op: 'create-snapshot',
            projectId,
            zone: requireString(disk.zone, 'GCP destroy snapshot disk zone'),
            requestId: gcpWorkspaceHostRequestUuid(key),
            hostId: request.host.hostId,
            request: {
              name: stableName('pc-destroy', `${request.host.hostId}-${disk.providerId}`),
              sourceDisk: disk.providerId,
              labels: { 'papercusp-host-id': gcpLabel(request.host.hostId) },
            },
          } satisfies GcpStepInput,
        });
      }
    }
    const idsByKind = new Map<string, string[]>();
    const order: readonly [string, GcpStepInput['op']][] = [
      [VM_KIND, 'delete-instance'],
      [DISK_KIND, 'delete-disk'],
      [FIREWALL_KIND, 'delete-firewall'],
      [SUBNETWORK_KIND, 'delete-subnetwork'],
      [NETWORK_KIND, 'delete-network'],
    ];
    for (const [kind, op] of order) {
      const prior = order
        .slice(
          0,
          order.findIndex(([candidate]) => candidate === kind),
        )
        .flatMap(([candidate]) => idsByKind.get(candidate) ?? []);
      const ids: string[] = [];
      for (const item of managed
        .filter((candidate) => candidate.kind === kind)
        .sort((a, b) => a.providerId.localeCompare(b.providerId))) {
        const id = `${op}-${item.providerId}`;
        ids.push(id);
        const key = `${request.idempotencyKey}:${id}`;
        steps.push({
          id,
          action: 'destroy',
          resourceKind: kind,
          dependsOn: [...preserveIds, ...prior],
          destructive: true,
          idempotencyKey: key,
          input: {
            op,
            projectId,
            requestId: gcpWorkspaceHostRequestUuid(key),
            resourceName: item.providerId,
            region: item.region,
            zone: item.zone,
            hostId: request.host.hostId,
          } as GcpStepInput,
        });
      }
      idsByKind.set(kind, ids);
    }
    return steps;
  }

  async apply(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    switch (input.op) {
      case 'use-existing-network': {
        const found = await this.client.getNetwork(input.projectId, input.networkName);
        if (!found) throw new Error(`GCP existing network '${input.networkName}' was not found`);
        return this.unchanged(
          request,
          resource(EXISTING_NETWORK_KIND, found.name, { parentProviderId: input.projectId }),
        );
      }
      case 'use-existing-subnetwork': {
        requireKnownResource(request.knownResources, [NETWORK_KIND, EXISTING_NETWORK_KIND], request.step.id);
        const found = await this.client.getSubnetwork(input.projectId, input.region, input.subnetworkName);
        if (!found) throw new Error(`GCP existing subnetwork '${input.subnetworkName}' was not found`);
        return this.unchanged(
          request,
          resource(EXISTING_SUBNETWORK_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
        );
      }
      case 'use-existing-firewall': {
        requireKnownResource(request.knownResources, [NETWORK_KIND, EXISTING_NETWORK_KIND], request.step.id);
        const found = await this.client.getFirewall(input.projectId, input.firewallName);
        if (!found) throw new Error(`GCP existing firewall '${input.firewallName}' was not found`);
        return this.unchanged(
          request,
          resource(EXISTING_FIREWALL_KIND, found.name, { parentProviderId: input.projectId }),
        );
      }
      case 'insert-network': {
        const operation = await this.client.insertNetwork(input.projectId, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getNetwork(input.projectId, input.request.name);
        return found
          ? this.applied(
              request,
              resource(NETWORK_KIND, found.name, { parentProviderId: input.projectId }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-subnetwork': {
        requireKnownResource(request.knownResources, [NETWORK_KIND], request.step.id);
        const operation = await this.client.insertSubnetwork(
          input.projectId,
          input.region,
          input.request,
          input.requestId,
        );
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getSubnetwork(input.projectId, input.region, input.request.name);
        return found
          ? this.applied(
              request,
              resource(SUBNETWORK_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-firewall': {
        requireKnownResource(request.knownResources, [NETWORK_KIND], request.step.id);
        const operation = await this.client.insertFirewall(input.projectId, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getFirewall(input.projectId, input.request.name);
        return found
          ? this.applied(
              request,
              resource(FIREWALL_KIND, found.name, { parentProviderId: input.projectId }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-disk': {
        const operation = await this.client.insertDisk(input.projectId, input.zone, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getDisk(input.projectId, input.zone, input.request.name);
        return found?.status === 'READY'
          ? this.applied(
              request,
              resource(DISK_KIND, found.name, {
                parentProviderId: input.projectId,
                region: input.zone.slice(0, input.zone.lastIndexOf('-')),
                zone: input.zone,
              }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-instance': {
        requireKnownResource(request.knownResources, [SUBNETWORK_KIND, EXISTING_SUBNETWORK_KIND], request.step.id);
        requireKnownResource(request.knownResources, [FIREWALL_KIND, EXISTING_FIREWALL_KIND], request.step.id);
        requireKnownResource(request.knownResources, [DISK_KIND], request.step.id);
        const operation = await this.client.insertInstance(input.projectId, input.zone, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getInstance(input.projectId, input.zone, input.request.name);
        return found?.status === 'RUNNING'
          ? this.applied(
              request,
              resource(VM_KIND, found.name, {
                parentProviderId: input.projectId,
                region: input.zone.slice(0, input.zone.lastIndexOf('-')),
                zone: input.zone,
              }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'start-instance':
        return this.mutateInstance(
          request,
          input,
          'RUNNING',
          () => this.client.startInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'stop-instance':
        return this.mutateInstance(
          request,
          input,
          'TERMINATED',
          () => this.client.stopInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'reset-instance':
      case 'repair-instance':
        return this.mutateInstance(
          request,
          input,
          'RUNNING',
          () => this.client.resetInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'create-snapshot': {
        requireKnownResource(request.knownResources, [DISK_KIND], request.step.id);
        const sourceDisk = await this.client.getDisk(input.projectId, input.zone, input.request.sourceDisk);
        if (!sourceDisk) throw new Error(`GCP snapshot source disk '${input.request.sourceDisk}' is absent`);
        assertManagedHostResource(sourceDisk, input.hostId, 'snapshot source disk');
        const operation = await this.client.createSnapshot(input.projectId, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getSnapshot(input.projectId, input.request.name);
        if (found?.status !== 'READY') return this.inProgress(request, operation.name);
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'applied',
          observedAt: found.observedAt,
          providerRequestId: operation.name,
          snapshot: {
            target: GCP_WORKSPACE_HOST_TARGET,
            providerId: found.name,
            hostId: input.hostId,
            createdAt: found.observedAt,
          },
        };
      }
      case 'delete-instance':
      case 'delete-disk':
      case 'delete-firewall':
      case 'delete-subnetwork':
      case 'delete-network':
        return this.deleteResource(request, input, ctx.signal);
    }
  }

  private async mutateInstance(
    request: WorkspaceHostApplyRequest,
    input: Extract<GcpStepInput, { op: 'start-instance' | 'stop-instance' | 'reset-instance' | 'repair-instance' }>,
    expected: GcpComputeInstanceStatus,
    mutation: () => Promise<GcpOperationRef>,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    const operation = await mutation();
    if (!(await this.settled(operation, signal))) return this.inProgress(request, operation.name);
    const found = await this.client.getInstance(input.projectId, input.zone, input.instanceName);
    return found?.status === expected
      ? this.applied(
          request,
          resource(VM_KIND, found.name, { parentProviderId: input.projectId, zone: input.zone }),
          operation.name,
        )
      : this.inProgress(request, operation.name);
  }

  private async settled(operation: GcpOperationRef, signal?: AbortSignal): Promise<boolean> {
    const observed = await this.client.waitForOperation(operation, signal);
    if (observed.error) throw new Error(`GCP operation '${operation.name}' failed: ${observed.error.message}`);
    return observed.status === 'DONE';
  }

  private async deleteResource(
    request: WorkspaceHostApplyRequest,
    input: Extract<
      GcpStepInput,
      { op: 'delete-instance' | 'delete-disk' | 'delete-firewall' | 'delete-subnetwork' | 'delete-network' }
    >,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    const before = await this.describeDeleteTarget(input);
    if (!before) return this.destroyed(request, input.hostId, input.resourceName);
    if (input.op === 'delete-instance') assertManagedHostResource(before, input.hostId, 'instance');
    if (input.op === 'delete-disk') {
      const disk = before as GcpDiskObservation;
      assertManagedHostResource(disk, input.hostId, 'data disk');
      if (disk.attachedInstanceNames.length > 0) {
        throw new Error(
          `GCP data disk '${disk.name}' is still attached to ${disk.attachedInstanceNames.join(', ')}; refusing deletion`,
        );
      }
    }
    let operation: GcpOperationRef;
    if (input.op === 'delete-instance')
      operation = await this.client.deleteInstance(
        input.projectId,
        requireString(input.zone, 'delete instance zone'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-disk')
      operation = await this.client.deleteDisk(
        input.projectId,
        requireString(input.zone, 'delete disk zone'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-firewall')
      operation = await this.client.deleteFirewall(input.projectId, input.resourceName, input.requestId);
    else if (input.op === 'delete-subnetwork')
      operation = await this.client.deleteSubnetwork(
        input.projectId,
        requireString(input.region, 'delete subnetwork region'),
        input.resourceName,
        input.requestId,
      );
    else operation = await this.client.deleteNetwork(input.projectId, input.resourceName, input.requestId);
    if (!(await this.settled(operation, signal))) return this.inProgress(request, operation.name);
    return (await this.describeDeleteTarget(input))
      ? this.inProgress(request, operation.name)
      : this.destroyed(request, input.hostId, input.resourceName, operation.name);
  }

  private describeDeleteTarget(
    input: Extract<
      GcpStepInput,
      { op: 'delete-instance' | 'delete-disk' | 'delete-firewall' | 'delete-subnetwork' | 'delete-network' }
    >,
  ): Promise<GcpResourceObservation | undefined> {
    if (input.op === 'delete-instance')
      return this.client.getInstance(
        input.projectId,
        requireString(input.zone, 'delete instance zone'),
        input.resourceName,
      );
    if (input.op === 'delete-disk')
      return this.client.getDisk(input.projectId, requireString(input.zone, 'delete disk zone'), input.resourceName);
    if (input.op === 'delete-firewall') return this.client.getFirewall(input.projectId, input.resourceName);
    if (input.op === 'delete-subnetwork')
      return this.client.getSubnetwork(
        input.projectId,
        requireString(input.region, 'delete subnetwork region'),
        input.resourceName,
      );
    return this.client.getNetwork(input.projectId, input.resourceName);
  }

  async reconcile(
    request: WorkspaceHostReconcileRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    const existing = await this.describeCreatedTarget(input);
    if (existing) {
      if (input.op === 'create-snapshot' && 'status' in existing && existing.status === 'READY') {
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'unchanged',
          observedAt: existing.observedAt,
          snapshot: {
            target: GCP_WORKSPACE_HOST_TARGET,
            providerId: existing.name,
            hostId: input.hostId,
            createdAt: existing.observedAt,
          },
        };
      }
      const kind =
        input.op === 'insert-instance'
          ? VM_KIND
          : input.op === 'insert-disk'
            ? DISK_KIND
            : input.op === 'insert-network'
              ? NETWORK_KIND
              : input.op === 'insert-subnetwork'
                ? SUBNETWORK_KIND
                : input.op === 'insert-firewall'
                  ? FIREWALL_KIND
                  : input.op === 'use-existing-network'
                    ? EXISTING_NETWORK_KIND
                    : input.op === 'use-existing-subnetwork'
                      ? EXISTING_SUBNETWORK_KIND
                      : input.op === 'use-existing-firewall'
                        ? EXISTING_FIREWALL_KIND
                        : undefined;
      if (kind)
        return this.unchanged(
          request,
          resource(kind, existing.name, {
            parentProviderId: 'projectId' in input ? input.projectId : undefined,
            region: 'region' in input ? input.region : undefined,
            zone: 'zone' in input ? input.zone : undefined,
          }),
        );
      if ('instanceName' in input) {
        const wanted = input.op === 'stop-instance' ? 'TERMINATED' : 'RUNNING';
        if ('status' in existing && existing.status === wanted)
          return this.unchanged(
            request,
            resource(VM_KIND, existing.name, { parentProviderId: input.projectId, zone: input.zone }),
          );
      }
    }
    if (isDeleteStepInput(input) && !(await this.describeDeleteTarget(input))) {
      return this.destroyed(request, input.hostId, input.resourceName);
    }
    return this.apply(request, ctx);
  }

  private describeCreatedTarget(
    input: GcpStepInput,
  ): Promise<
    GcpResourceObservation | GcpInstanceObservation | GcpDiskObservation | GcpSnapshotObservation | undefined
  > {
    if (input.op === 'insert-network') return this.client.getNetwork(input.projectId, input.request.name);
    if (input.op === 'use-existing-network') return this.client.getNetwork(input.projectId, input.networkName);
    if (input.op === 'insert-subnetwork')
      return this.client.getSubnetwork(input.projectId, input.region, input.request.name);
    if (input.op === 'use-existing-subnetwork')
      return this.client.getSubnetwork(input.projectId, input.region, input.subnetworkName);
    if (input.op === 'insert-firewall') return this.client.getFirewall(input.projectId, input.request.name);
    if (input.op === 'use-existing-firewall') return this.client.getFirewall(input.projectId, input.firewallName);
    if (input.op === 'insert-disk') return this.client.getDisk(input.projectId, input.zone, input.request.name);
    if (input.op === 'insert-instance') return this.client.getInstance(input.projectId, input.zone, input.request.name);
    if (input.op === 'create-snapshot') return this.client.getSnapshot(input.projectId, input.request.name);
    if ('instanceName' in input) return this.client.getInstance(input.projectId, input.zone, input.instanceName);
    return Promise.resolve(undefined);
  }

  private applied(
    request: WorkspaceHostApplyRequest,
    appliedResource?: WorkspaceHostResourceRef,
    providerRequestId?: string,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'applied',
      observedAt: this.now(),
      providerRequestId,
      ...(appliedResource ? { resource: appliedResource } : {}),
    };
  }

  private unchanged(
    request: WorkspaceHostApplyRequest,
    unchangedResource?: WorkspaceHostResourceRef,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'unchanged',
      observedAt: this.now(),
      ...(unchangedResource ? { resource: unchangedResource } : {}),
    };
  }

  private inProgress(request: WorkspaceHostApplyRequest, providerRequestId?: string): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'in-progress',
      observedAt: this.now(),
      providerRequestId,
      retryAfterMs: 2_000,
    };
  }

  private destroyed(
    request: WorkspaceHostApplyRequest,
    hostId: string,
    providerResourceId: string,
    providerRequestId?: string,
  ): WorkspaceHostApplyResult {
    const observedAt = this.now();
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt,
      providerRequestId,
      confirmation: {
        hostId,
        providerResourceId,
        confirmedAbsentAt: observedAt,
        source: 'provider-read',
        providerRequestId,
      },
    };
  }

  async observe(host: WorkspaceHostRef, _ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostObservation> {
    const vm = knownResource(host.resources, [VM_KIND]);
    const disks = host.resources.filter((item) => item.target === GCP_WORKSPACE_HOST_TARGET && item.kind === DISK_KIND);
    const projectId = requireString(vm?.parentProviderId ?? disks[0]?.parentProviderId, 'GCP observation projectId');
    const instance = vm
      ? await this.client.getInstance(projectId, requireString(vm.zone, 'GCP VM zone'), vm.providerId)
      : undefined;
    const observedDisks = await Promise.all(
      disks.map((item) => this.client.getDisk(projectId, requireString(item.zone, 'GCP disk zone'), item.providerId)),
    );
    const drift: string[] = [];
    if (!vm || !instance) drift.push('instance-absent');
    disks.forEach((disk, index) => {
      const observed = observedDisks[index];
      if (!observed) drift.push(`disk-absent:${disk.providerId}`);
      else if (vm && !observed.attachedInstanceNames.map(refName).includes(refName(vm.providerId)))
        drift.push(`disk-detached:${disk.providerId}`);
    });
    const resources = host.resources
      .filter((item) => item.kind !== VM_KIND || !!instance)
      .filter(
        (item) =>
          item.kind !== DISK_KIND || !!observedDisks[disks.findIndex((disk) => disk.providerId === item.providerId)],
      );
    return {
      host,
      state: this.lifecycleState(instance),
      resources,
      ...(instance?.sourceImage ? { image: { id: instance.sourceImage } } : {}),
      observedAt: this.now(),
      drift,
    };
  }

  private lifecycleState(instance: GcpInstanceObservation | undefined): WorkspaceHostObservation['state'] {
    if (!instance) return 'absent';
    if (instance.status === 'RUNNING') return instance.agentOnline === false ? 'degraded' : 'running';
    if (instance.status === 'SUSPENDED' || instance.status === 'TERMINATED') return 'stopped';
    if (instance.status === 'STOPPING') return 'destroying';
    if (instance.status === 'REPAIRING') return 'repairing';
    return 'provisioning';
  }

  async getTransportProfile(
    host: WorkspaceHostRef,
    _ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostTransportProfile> {
    const vm = requireKnownResource(host.resources, [VM_KIND], 'get-transport-profile');
    return {
      kind: 'gcp-iap-ssh',
      endpoint: `gcp-iap-ssh://${vm.providerId}?zone=${encodeURIComponent(requireString(vm.zone, 'GCP VM zone'))}`,
      supportedClientPlatforms: ['linux', 'macos', 'windows'],
      features: { command: true, pty: true, tcpForward: true, fileTransfer: true, clipboard: false },
      prerequisites: ['IAP TCP forwarding permission', 'OS Login permission', 'gcloud or an IAP-capable client'],
      constraints: ['No public IP is provisioned', 'Clipboard integration is not provided by Compute Engine'],
      reconnect: 'recreate',
      audited: true,
    };
  }

  async attestHealth(
    host: WorkspaceHostRef,
    _ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostHealthAttestation> {
    const vm = knownResource(host.resources, [VM_KIND]);
    const projectId = requireString(vm?.parentProviderId, 'GCP health projectId');
    const instance = vm
      ? await this.client.getInstance(projectId, requireString(vm.zone, 'GCP VM zone'), vm.providerId)
      : undefined;
    const running = instance?.status === 'RUNNING';
    const agentOnline = instance?.agentOnline === true;
    return {
      hostId: host.hostId,
      observedAt: this.now(),
      status: !running ? 'unreachable' : agentOnline ? 'healthy' : 'degraded',
      ...(instance?.sourceImage ? { image: { id: instance.sourceImage } } : {}),
      checks: [
        { name: 'compute-running', ok: running, detail: instance?.status ?? 'absent' },
        { name: 'workspace-agent-online', ok: agentOnline },
      ],
    };
  }
}

export function createGcpWorkspaceHostProvider(options: GcpWorkspaceHostProviderOptions): GcpWorkspaceHostProvider {
  if (!options?.client) throw new Error('GCP workspace-host provider requires an injected Compute Engine client');
  return new GcpWorkspaceHostProvider(options.client, { now: options.now });
}
