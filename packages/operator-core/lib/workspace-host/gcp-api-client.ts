import type {
  WorkspaceHostCatalogQuery,
  WorkspaceHostConnectionValidation,
  WorkspaceHostDesiredSpec,
  WorkspaceHostImage,
  WorkspaceHostPriceEstimate,
  WorkspaceHostProviderConnection,
  WorkspaceHostRegion,
  WorkspaceHostScope,
  WorkspaceHostSize,
} from '@papercusp/deployment-driver';
import {
  GCP_DEFAULT_WORKSPACE_HOST_IMAGE,
  acquireGcpAdcAuth,
  fetchGcpApiJson,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import type {
  GcpComputeDiskStatus,
  GcpComputeInstanceStatus,
  GcpComputeSnapshotStatus,
  GcpDiskInsertInput,
  GcpDiskObservation,
  GcpFirewallInsertInput,
  GcpFirewallObservation,
  GcpInstanceInsertInput,
  GcpInstanceObservation,
  GcpNetworkInsertInput,
  GcpOperationObservation,
  GcpOperationRef,
  GcpResourceObservation,
  GcpSnapshotInsertInput,
  GcpSnapshotObservation,
  GcpSubnetworkInsertInput,
  GcpWorkspaceHostApiClient,
} from './gcp-provider';

const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';

interface GcpHttpError extends Error {
  status?: number;
}

interface RawOperation {
  name?: string;
  status?: 'PENDING' | 'RUNNING' | 'DONE';
  zone?: string;
  region?: string;
  clientOperationId?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

interface RawResource {
  name?: string;
  selfLink?: string;
  labels?: Record<string, string>;
}

interface RawDisk extends RawResource {
  status?: GcpComputeDiskStatus;
  users?: string[];
  sizeGb?: string;
  type?: string;
  sourceImage?: string;
  diskEncryptionKey?: { kmsKeyName?: string };
}

interface RawInstance extends RawResource {
  status?: GcpComputeInstanceStatus;
  machineType?: string;
  tags?: { items?: string[] };
  networkInterfaces?: Array<{
    network?: string;
    subnetwork?: string;
    stackType?: 'IPV4_ONLY';
    networkIP?: string;
    accessConfigs?: Array<{
      name?: string;
      type?: 'ONE_TO_ONE_NAT';
      natIP?: string;
      networkTier?: 'PREMIUM';
    }>;
  }>;
  disks?: Array<{
    boot?: boolean;
    autoDelete?: boolean;
    source?: string;
    deviceName?: string;
    mode?: 'READ_WRITE';
  }>;
  serviceAccounts?: Array<{ email?: string; scopes?: string[] }>;
  metadata?: { items?: Array<{ key?: string; value?: string }> };
}

interface RawMachineType {
  name?: string;
  guestCpus?: number;
  memoryMb?: number;
  deprecated?: { state?: string };
}

interface RawImage extends RawResource {
  architecture?: string;
  creationTimestamp?: string;
  deprecated?: { state?: string };
}

export interface GcpWorkspaceHostApiClientOptions {
  acquireAuth?: () => Promise<GcpResolvedAuth>;
  fetch?: typeof fetch;
  now?: () => string;
  /** Resolve this family for discovery, but return only its exact immutable member id. */
  imageFamily?: {
    project: string;
    family: string;
    label?: string;
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`gcp_workspace_host_${label}_missing`);
  return normalized;
}

function segment(value: string, label: string): string {
  return encodeURIComponent(required(value, label));
}

function lastSegment(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\/+$/, '');
  return normalized ? normalized.slice(normalized.lastIndexOf('/') + 1) : undefined;
}

function zoneRegion(zone: string): string {
  const match = required(zone, 'zone').match(/^(.+)-[a-z]$/);
  if (!match?.[1]) throw new Error('gcp_workspace_host_zone_region_invalid');
  return match[1];
}

function resourcePath(value: string, prefix: string): string {
  const normalized = required(value, 'resource_ref');
  return normalized.includes('/') ? normalized : `${prefix}/${normalized}`;
}

function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function projectFromConnection(connection: WorkspaceHostProviderConnection): string {
  if (connection.target !== 'gcp') throw new Error(`gcp_workspace_host_target_${connection.target}_invalid`);
  if (!connection.cloudCredentialRef.ref.startsWith('adc://')) {
    throw new Error('gcp_workspace_host_cloud_credential_ref_must_use_adc');
  }
  if (connection.scope && connection.scope.kind !== 'project') {
    throw new Error('gcp_workspace_host_scope_must_be_project');
  }
  const providerProject =
    typeof connection.provider?.projectId === 'string' ? connection.provider.projectId.trim() : undefined;
  const scopeProject = connection.scope?.id.trim();
  if (providerProject && scopeProject && providerProject !== scopeProject) {
    throw new Error('gcp_workspace_host_connection_project_mismatch');
  }
  return required(scopeProject || providerProject, 'project_id');
}

function assertCatalogProject(query: WorkspaceHostCatalogQuery, projectId: string): void {
  if (query.scope.kind !== 'project' || query.scope.id !== projectId) {
    throw new Error('gcp_workspace_host_catalog_project_mismatch');
  }
}

function observedResource(raw: RawResource, observedAt: string): GcpResourceObservation {
  return {
    name: required(raw.name, 'resource_name'),
    ...(raw.selfLink ? { selfLink: raw.selfLink } : {}),
    ...(raw.labels ? { labels: raw.labels } : {}),
    observedAt,
  };
}

function attachedNames(users: readonly string[] | undefined): string[] {
  return (users ?? []).map(lastSegment).filter((name): name is string => !!name);
}

function operationError(raw: RawOperation): GcpOperationObservation['error'] | undefined {
  const entries = raw.error?.errors ?? [];
  if (entries.length === 0) return undefined;
  const codes = [...new Set(entries.map(({ code }) => code).filter((code): code is string => !!code))];
  return {
    ...(codes[0] ? { code: codes[0] } : {}),
    message: codes.length > 0 ? `GCP operation failed (${codes.join(', ')})` : 'GCP operation failed',
  };
}

function asOperation(
  raw: RawOperation,
  known: Omit<GcpOperationRef, 'name'> & { name?: string },
  observedAt?: string,
): GcpOperationRef | GcpOperationObservation {
  const scope = raw.zone ? 'zone' : raw.region ? 'region' : known.scope;
  const location = lastSegment(raw.zone ?? raw.region) ?? known.location;
  const common: GcpOperationRef = {
    name: required(raw.name ?? known.name, 'operation_name'),
    projectId: known.projectId,
    scope,
    ...(location ? { location } : {}),
    requestId: known.requestId,
  };
  if (!observedAt) return common;
  return {
    ...common,
    status: raw.status ?? 'PENDING',
    observedAt,
    ...(operationError(raw) ? { error: operationError(raw) } : {}),
  };
}

function recreateInput(
  raw: RawInstance,
  bootDisk: RawDisk | undefined,
  zone: string,
): GcpInstanceInsertInput | undefined {
  const boot = raw.disks?.find((disk) => disk.boot === true);
  const data = raw.disks?.find((disk) => disk.boot !== true);
  const network = raw.networkInterfaces?.[0];
  const account = raw.serviceAccounts?.[0];
  const sourceImage = bootDisk?.sourceImage;
  const bootSize = numberValue(bootDisk?.sizeGb);
  if (
    !raw.name ||
    !raw.machineType ||
    !boot ||
    !data?.source ||
    !data.deviceName ||
    !network?.network ||
    !network.subnetwork ||
    !account?.email ||
    !sourceImage ||
    !bootSize ||
    !bootDisk?.type
  ) {
    return undefined;
  }
  const access = network.accessConfigs?.[0];
  const metadata = (raw.metadata?.items ?? [])
    .filter(
      (item): item is { key: string; value: string } => typeof item.key === 'string' && typeof item.value === 'string',
    )
    .map(({ key, value }) => ({ key, value }));
  return {
    name: raw.name,
    zone,
    machineType: raw.machineType,
    labels: raw.labels ?? {},
    tags: { items: raw.tags?.items ?? [] },
    networkInterfaces: [
      {
        network: network.network,
        subnetwork: network.subnetwork,
        stackType: 'IPV4_ONLY',
        ...(access
          ? {
              accessConfigs: [
                {
                  name: 'External NAT',
                  type: 'ONE_TO_ONE_NAT',
                  networkTier: 'PREMIUM',
                },
              ] as const,
            }
          : {}),
      },
    ],
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage,
          diskSizeGb: bootSize,
          diskType: bootDisk.type,
          ...(bootDisk.diskEncryptionKey?.kmsKeyName
            ? { diskEncryptionKey: { kmsKeyName: bootDisk.diskEncryptionKey.kmsKeyName } }
            : {}),
        },
      },
      {
        boot: false,
        autoDelete: false,
        source: data.source,
        deviceName: data.deviceName,
        mode: 'READ_WRITE',
      },
    ],
    serviceAccounts: [{ email: account.email, scopes: account.scopes ?? [] }],
    metadata: { items: metadata },
  };
}

/** ADC-backed, raw-REST implementation of the GCP workspace-host client seam. */
export class GoogleComputeWorkspaceHostApiClient implements GcpWorkspaceHostApiClient {
  private readonly acquireAuth: () => Promise<GcpResolvedAuth>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly imageFamily: { project: string; family: string; label?: string };

  constructor(options: GcpWorkspaceHostApiClientOptions = {}) {
    this.acquireAuth = options.acquireAuth ?? acquireGcpAdcAuth;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    const imageFamily = options.imageFamily ?? GCP_DEFAULT_WORKSPACE_HOST_IMAGE;
    const label = options.imageFamily?.label?.trim();
    this.imageFamily = {
      project: required(imageFamily.project, 'image_project'),
      family: required(imageFamily.family, 'image_family'),
      ...(label ? { label } : {}),
    };
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const auth = await this.acquireAuth();
    return fetchGcpApiJson<T>(this.fetchImpl, auth.accessToken, url, init);
  }

  private async requestWithAuth<T>(auth: GcpResolvedAuth, url: string, init: RequestInit = {}): Promise<T> {
    return fetchGcpApiJson<T>(this.fetchImpl, auth.accessToken, url, init);
  }

  private async getOrUndefined<T>(url: string): Promise<T | undefined> {
    try {
      return await this.request<T>(url);
    } catch (error) {
      if ((error as GcpHttpError).status === 404) return undefined;
      throw error;
    }
  }

  private projectBase(projectId: string): string {
    return `${COMPUTE_API}/projects/${segment(projectId, 'project_id')}`;
  }

  private async mutate(
    projectId: string,
    scope: GcpOperationRef['scope'],
    location: string | undefined,
    requestId: string,
    url: string,
    method: 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<GcpOperationRef> {
    const separator = url.includes('?') ? '&' : '?';
    const raw = await this.request<RawOperation>(`${url}${separator}requestId=${segment(requestId, 'request_id')}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return asOperation(raw, { projectId, scope, ...(location ? { location } : {}), requestId }) as GcpOperationRef;
  }

  async validateConnection(connection: WorkspaceHostProviderConnection): Promise<WorkspaceHostConnectionValidation> {
    const checkedAt = this.now();
    try {
      const projectId = projectFromConnection(connection);
      const auth = await this.acquireAuth();
      const project = await this.requestWithAuth<{ name?: string }>(auth, `${this.projectBase(projectId)}?fields=name`);
      if (!project.name) throw new Error('gcp_workspace_host_project_unreadable');
      return {
        ok: true,
        checkedAt,
        ...(auth.identity ? { identity: auth.identity } : {}),
        warnings: [],
        errors: [],
      };
    } catch (error) {
      const status = (error as GcpHttpError).status;
      return {
        ok: false,
        checkedAt,
        warnings: [],
        errors: [status ? `GCP ADC/Compute validation failed (HTTP ${status})` : 'GCP ADC/Compute validation failed'],
      };
    }
  }

  async listScopes(connection: WorkspaceHostProviderConnection): Promise<readonly WorkspaceHostScope[]> {
    const projectId = projectFromConnection(connection);
    return [{ kind: 'project', id: projectId, label: projectId }];
  }

  async listRegions(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostRegion[]> {
    const projectId = projectFromConnection(connection);
    assertCatalogProject(query, projectId);
    const base = this.projectBase(projectId);
    const [regions, zones] = await Promise.all([
      this.request<{ items?: Array<{ name?: string; status?: string }> }>(
        `${base}/regions?maxResults=500&fields=items(name,status)`,
      ),
      this.request<{ items?: Array<{ name?: string; status?: string; region?: string }> }>(
        `${base}/zones?maxResults=500&fields=items(name,status,region)`,
      ),
    ]);
    return (regions.items ?? [])
      .filter((region): region is { name: string; status?: string } => !!region.name)
      .filter((region) => !query.region || region.name === query.region)
      .map((region) => ({
        id: region.name,
        label: region.name,
        available: region.status === 'UP',
        zones: (zones.items ?? [])
          .filter((zone) => lastSegment(zone.region) === region.name && zone.status === 'UP' && !!zone.name)
          .map((zone) => zone.name!),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listSizes(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostSize[]> {
    const projectId = projectFromConnection(connection);
    assertCatalogProject(query, projectId);
    const result = await this.request<{ items?: Record<string, { machineTypes?: RawMachineType[] }> }>(
      `${this.projectBase(projectId)}/aggregated/machineTypes?maxResults=500&fields=items/*/machineTypes(name,guestCpus,memoryMb,deprecated)`,
    );
    const sizes = new Map<string, WorkspaceHostSize>();
    for (const [scope, group] of Object.entries(result.items ?? {})) {
      const zone = scope.startsWith('zones/') ? scope.slice('zones/'.length) : undefined;
      if (!zone || (query.region && !zone.startsWith(`${query.region}-`))) continue;
      for (const raw of group.machineTypes ?? []) {
        if (!raw.name || !Number.isFinite(raw.guestCpus) || !Number.isFinite(raw.memoryMb)) continue;
        const available = !raw.deprecated || raw.deprecated.state === 'ACTIVE';
        const current = sizes.get(raw.name);
        sizes.set(raw.name, {
          id: raw.name,
          label: raw.name,
          cpuCount: Number(raw.guestCpus),
          memoryMiB: Number(raw.memoryMb),
          available: available || current?.available === true,
          ...(available ? {} : { constraints: [`Deprecated by GCP (${raw.deprecated?.state ?? 'unknown'})`] }),
        });
      }
    }
    return [...sizes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async listImages(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostImage[]> {
    const projectId = projectFromConnection(connection);
    assertCatalogProject(query, projectId);
    const image = await this.request<RawImage>(
      `${COMPUTE_API}/projects/${segment(this.imageFamily.project, 'image_project')}/global/images/family/${segment(this.imageFamily.family, 'image_family')}`,
    );
    const architecture =
      image.architecture === 'ARM64' ? 'arm64' : image.architecture === 'X86_64' ? 'x86_64' : undefined;
    if (query.architecture && architecture && query.architecture !== architecture) return [];
    const name = required(image.name, 'image_name');
    return [
      {
        id: `projects/${this.imageFamily.project}/global/images/${name}`,
        version: name,
        label:
          this.imageFamily.label ??
          (this.imageFamily.project === GCP_DEFAULT_WORKSPACE_HOST_IMAGE.project &&
          this.imageFamily.family === GCP_DEFAULT_WORKSPACE_HOST_IMAGE.family
            ? `Ubuntu 24.04 LTS (${name})`
            : `${this.imageFamily.family} (${name})`),
        ...(architecture ? { architecture } : {}),
        signed: true,
        ...(image.creationTimestamp ? { publishedAt: image.creationTimestamp } : {}),
        ...(image.deprecated ? { deprecated: image.deprecated.state !== 'ACTIVE' } : {}),
      },
    ];
  }

  async estimatePrice(
    _desired: WorkspaceHostDesiredSpec,
    _connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate> {
    return {
      currency: 'USD',
      hourlyAmount: 0,
      observedAt: this.now(),
      confidence: 'unknown',
      lineItems: [{ kind: 'provider-pricing', description: 'Authoritative GCP pricing unavailable', hourlyAmount: 0 }],
    };
  }

  async getNetwork(projectId: string, name: string): Promise<GcpResourceObservation | undefined> {
    const raw = await this.getOrUndefined<RawResource>(
      `${this.projectBase(projectId)}/global/networks/${segment(name, 'network_name')}`,
    );
    return raw ? observedResource(raw, this.now()) : undefined;
  }

  async getSubnetwork(projectId: string, region: string, name: string): Promise<GcpResourceObservation | undefined> {
    const raw = await this.getOrUndefined<RawResource>(
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks/${segment(name, 'subnetwork_name')}`,
    );
    return raw ? observedResource(raw, this.now()) : undefined;
  }

  async getFirewall(projectId: string, name: string): Promise<GcpFirewallObservation | undefined> {
    const raw = await this.getOrUndefined<
      RawResource & {
        direction?: 'INGRESS';
        sourceRanges?: string[];
        targetTags?: string[];
        allowed?: Array<{ IPProtocol?: string; ports?: string[] }>;
      }
    >(`${this.projectBase(projectId)}/global/firewalls/${segment(name, 'firewall_name')}`);
    if (!raw) return undefined;
    if (raw.direction !== 'INGRESS') throw new Error('gcp_workspace_host_firewall_direction_invalid');
    return {
      ...observedResource(raw, this.now()),
      direction: 'INGRESS',
      sourceRanges: raw.sourceRanges ?? [],
      targetTags: raw.targetTags ?? [],
      allowed: (raw.allowed ?? [])
        .filter((rule): rule is { IPProtocol: 'tcp'; ports?: string[] } => rule.IPProtocol === 'tcp')
        .map((rule) => ({
          IPProtocol: 'tcp',
          ports: rule.ports ?? [],
        })) as unknown as GcpFirewallObservation['allowed'],
    };
  }

  async getDisk(projectId: string, zone: string, name: string): Promise<GcpDiskObservation | undefined> {
    const raw = await this.getOrUndefined<RawDisk>(
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(name, 'disk_name')}`,
    );
    if (!raw) return undefined;
    return {
      ...observedResource(raw, this.now()),
      status: raw.status ?? 'CREATING',
      attachedInstanceNames: attachedNames(raw.users),
      ...(numberValue(raw.sizeGb) !== undefined ? { sizeGb: numberValue(raw.sizeGb) } : {}),
    };
  }

  async getInstance(projectId: string, zone: string, name: string): Promise<GcpInstanceObservation | undefined> {
    const raw = await this.getOrUndefined<RawInstance>(
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}`,
    );
    if (!raw) return undefined;
    const bootName = lastSegment(raw.disks?.find((disk) => disk.boot === true)?.source);
    const bootDisk = bootName
      ? await this.getOrUndefined<RawDisk>(
          `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(bootName, 'boot_disk_name')}`,
        )
      : undefined;
    const recreated = recreateInput(raw, bootDisk, zone);
    return {
      ...observedResource(raw, this.now()),
      status: raw.status ?? 'PROVISIONING',
      attachedDiskNames: (raw.disks ?? [])
        .map(({ source }) => lastSegment(source))
        .filter((item): item is string => !!item),
      ...(raw.networkInterfaces?.[0]?.networkIP ? { internalIp: raw.networkInterfaces[0].networkIP } : {}),
      ...(raw.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
        ? { externalIp: raw.networkInterfaces[0].accessConfigs[0].natIP }
        : {}),
      ...(bootDisk?.sourceImage ? { sourceImage: bootDisk.sourceImage } : {}),
      ...(recreated ? { recreateInput: recreated } : {}),
    };
  }

  async getSnapshot(projectId: string, name: string): Promise<GcpSnapshotObservation | undefined> {
    const raw = await this.getOrUndefined<RawResource & { status?: GcpComputeSnapshotStatus }>(
      `${this.projectBase(projectId)}/global/snapshots/${segment(name, 'snapshot_name')}`,
    );
    return raw ? { ...observedResource(raw, this.now()), status: raw.status ?? 'CREATING' } : undefined;
  }

  insertNetwork(projectId: string, input: GcpNetworkInsertInput, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/networks`,
      'POST',
      input,
    );
  }

  insertSubnetwork(
    projectId: string,
    region: string,
    input: GcpSubnetworkInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { region: _region, ...body } = input;
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks`,
      'POST',
      { ...body, network: resourcePath(body.network, 'global/networks') },
    );
  }

  insertFirewall(projectId: string, input: GcpFirewallInsertInput, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/firewalls`,
      'POST',
      { ...input, network: resourcePath(input.network, 'global/networks') },
    );
  }

  insertDisk(projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string): Promise<GcpOperationRef> {
    const { zone: _zone, type, sourceSnapshot, ...rest } = input;
    const body = {
      ...rest,
      type: resourcePath(type, `zones/${zone}/diskTypes`),
      ...(sourceSnapshot
        ? { sourceSnapshot: resourcePath(sourceSnapshot, 'global/snapshots') }
        : {}),
    };
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks`,
      'POST',
      body,
    );
  }

  insertInstance(
    projectId: string,
    zone: string,
    input: GcpInstanceInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { zone: _zone, ...rest } = input;
    const region = zoneRegion(zone);
    const body = {
      ...rest,
      machineType: resourcePath(rest.machineType, `zones/${zone}/machineTypes`),
      networkInterfaces: rest.networkInterfaces.map((network) => ({
        ...network,
        network: resourcePath(network.network, 'global/networks'),
        subnetwork: resourcePath(network.subnetwork, `regions/${region}/subnetworks`),
      })),
      disks: [
        {
          ...rest.disks[0],
          initializeParams: {
            ...rest.disks[0].initializeParams,
            diskType: resourcePath(rest.disks[0].initializeParams.diskType, `zones/${zone}/diskTypes`),
          },
        },
        { ...rest.disks[1], source: resourcePath(rest.disks[1].source, `zones/${zone}/disks`) },
      ],
    };
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances`,
      'POST',
      body,
    );
  }

  createSnapshot(
    projectId: string,
    zone: string,
    input: GcpSnapshotInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef> {
    const { sourceDisk, ...body } = input;
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/disks/${segment(sourceDisk, 'source_disk')}/createSnapshot`,
      'POST',
      body,
    );
  }

  startInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'start');
  }

  stopInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'stop');
  }

  resetInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.instanceAction(projectId, zone, name, requestId, 'reset');
  }

  private instanceAction(
    projectId: string,
    zone: string,
    name: string,
    requestId: string,
    action: 'start' | 'stop' | 'reset',
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/instances/${segment(name, 'instance_name')}/${action}`,
      'POST',
    );
  }

  deleteInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteZonal(projectId, zone, 'instances', name, requestId);
  }

  deleteDisk(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteZonal(projectId, zone, 'disks', name, requestId);
  }

  private deleteZonal(
    projectId: string,
    zone: string,
    collection: 'instances' | 'disks',
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'zone',
      zone,
      requestId,
      `${this.projectBase(projectId)}/zones/${segment(zone, 'zone')}/${collection}/${segment(name, 'resource_name')}`,
      'DELETE',
    );
  }

  deleteFirewall(projectId: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteGlobal(projectId, 'firewalls', name, requestId);
  }

  deleteNetwork(projectId: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.deleteGlobal(projectId, 'networks', name, requestId);
  }

  private deleteGlobal(
    projectId: string,
    collection: 'firewalls' | 'networks',
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'global',
      undefined,
      requestId,
      `${this.projectBase(projectId)}/global/${collection}/${segment(name, 'resource_name')}`,
      'DELETE',
    );
  }

  deleteSubnetwork(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef> {
    return this.mutate(
      projectId,
      'region',
      region,
      requestId,
      `${this.projectBase(projectId)}/regions/${segment(region, 'region')}/subnetworks/${segment(name, 'subnetwork_name')}`,
      'DELETE',
    );
  }

  async waitForOperation(operation: GcpOperationRef, signal?: AbortSignal): Promise<GcpOperationObservation> {
    const scopePath =
      operation.scope === 'global'
        ? 'global/operations'
        : operation.scope === 'region'
          ? `regions/${segment(required(operation.location, 'operation_region'), 'operation_region')}/operations`
          : `zones/${segment(required(operation.location, 'operation_zone'), 'operation_zone')}/operations`;
    const raw = await this.request<RawOperation>(
      `${this.projectBase(operation.projectId)}/${scopePath}/${segment(operation.name, 'operation_name')}/wait`,
      { method: 'POST', signal },
    );
    return asOperation(raw, operation, this.now()) as GcpOperationObservation;
  }
}

export function createGcpWorkspaceHostApiClient(
  options: GcpWorkspaceHostApiClientOptions = {},
): GoogleComputeWorkspaceHostApiClient {
  return new GoogleComputeWorkspaceHostApiClient(options);
}
