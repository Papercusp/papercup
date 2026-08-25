import { randomUUID } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import type {
  WorkspaceHostProviderConnection,
  WorkspaceHostDesiredSpec,
  WorkspaceHostHealthAttestation,
  WorkspaceHostLifecycleAction,
  WorkspaceHostObservation,
  WorkspaceHostResourceCheckpoint,
  WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import { notifySyncInvalidate } from '../sync-sse';

export const WORKSPACE_HOST_CONTROL_QUERY = 'workspaceHosts.control';

type JsonRecord = Record<string, unknown>;
type ConnectionStatus = 'connected' | 'degraded' | 'invalid';
type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';
type TimelineLevel = 'info' | 'warn' | 'error';
type LogStream = 'cloud-init' | 'systemd' | 'controller';

const SECRET_KEY = /(?:authorization|cookie|password|passphrase|secret|token|private.?key|access.?key)/i;
const SAFE_REFERENCE_KEY = /(?:credential|secret|token|key)ref$/i;
const PRIVATE_KEY = /-----BEGIN [^-\n]*(?:PRIVATE KEY|SECRET)[^-\n]*-----[\s\S]*?-----END [^-\n]*-----/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/gi;
const SENSITIVE_QUERY = /([?&](?:access_token|api_key|client_secret|password|signature|token)=)[^&#\s]+/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactWorkspaceHostText(value: string): string {
  return value
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(URL_PASSWORD, '$1[REDACTED]@')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(AWS_ACCESS_KEY, '[REDACTED AWS ACCESS KEY]')
    .replace(JWT, '[REDACTED JWT]');
}

/** Redact before persistence. Audit export applies this again as defense in depth. */
export function redactWorkspaceHostValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactWorkspaceHostText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redactWorkspaceHostValue(entry, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    out[key] =
      SECRET_KEY.test(key) && !SAFE_REFERENCE_KEY.test(key) ? '[REDACTED]' : redactWorkspaceHostValue(entry, seen);
  }
  seen.delete(value);
  return out;
}

function json(value: unknown): unknown {
  return value == null ? null : redactWorkspaceHostValue(value);
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

async function pushControl(): Promise<void> {
  await notifySyncInvalidate(WORKSPACE_HOST_CONTROL_QUERY);
}

export interface WorkspaceHostConnectionInput {
  workspaceId: string;
  id: string;
  target: string;
  label: string;
  credentialRef: string;
  status: ConnectionStatus;
  statusDetail?: string;
  lastValidatedAt?: string;
  scopes?: readonly unknown[];
  regions?: readonly unknown[];
  sizes?: readonly unknown[];
  images?: readonly unknown[];
  networks?: readonly unknown[];
  diskPricePerGiBMonth?: number;
}

export async function upsertWorkspaceHostConnection(input: WorkspaceHostConnectionInput): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref, status, status_detail,
        last_validated_at, scopes, regions, sizes, images, networks,
        disk_price_per_gib_month, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.id}, ${input.target}, ${input.label},
        ${input.credentialRef}, ${input.status}, ${input.statusDetail ?? null},
        ${input.lastValidatedAt ?? null}, ${tx.json(json(input.scopes ?? []) as never)},
        ${tx.json(json(input.regions ?? []) as never)}, ${tx.json(json(input.sizes ?? []) as never)},
        ${tx.json(json(input.images ?? []) as never)}, ${tx.json(json(input.networks ?? []) as never)},
        ${input.diskPricePerGiBMonth ?? null}, now()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        target = EXCLUDED.target,
        label = EXCLUDED.label,
        credential_ref = EXCLUDED.credential_ref,
        status = EXCLUDED.status,
        status_detail = EXCLUDED.status_detail,
        last_validated_at = EXCLUDED.last_validated_at,
        scopes = EXCLUDED.scopes,
        regions = EXCLUDED.regions,
        sizes = EXCLUDED.sizes,
        images = EXCLUDED.images,
        networks = EXCLUDED.networks,
        disk_price_per_gib_month = EXCLUDED.disk_price_per_gib_month,
        updated_at = now()
    `;
  });
}

export interface StoredWorkspaceHostConnection {
  id: string;
  target: string;
  status: ConnectionStatus;
  statusDetail?: string;
  connection: WorkspaceHostProviderConnection;
}

/** Read the exact credential reference selected by a provisioning request. */
export async function readWorkspaceHostConnection(
  workspaceId: string,
  connectionId: string,
): Promise<StoredWorkspaceHostConnection | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        target: string;
        credential_ref: string;
        status: ConnectionStatus;
        status_detail: string | null;
      }>
    >`
      SELECT id, target, credential_ref, status, status_detail
      FROM harness_shared.workspace_host_connections
      WHERE workspace_id = ${workspaceId} AND id = ${connectionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      target: row.target,
      status: row.status,
      ...(row.status_detail ? { statusDetail: row.status_detail } : {}),
      connection: {
        target: row.target,
        cloudCredentialRef: { kind: 'cloud', ref: row.credential_ref },
      },
    };
  });
}

export interface WorkspaceHostInput {
  workspaceId: string;
  id: string;
  name: string;
  connectionId: string;
  target: string;
  scopeLabel: string;
  region: string;
  size: string;
  image: string;
  diskGiB: number;
  network: string;
  estimatedMonthlyUsd?: number;
  desiredState: string;
  observedState: string;
  observedAt?: string;
  endpoint?: string;
  recoverability?: { kind: 'snapshot' | 'backup' | 'none'; label: string; updatedAt?: string };
  /**
   * The provisioning intent this host was created from (migration 956).
   *
   * Recorded by the provisioner so later lifecycle actions — initialization above all — can
   * recover WHICH cloud instance this host is instead of re-deriving it from the observed
   * columns. Omitting it on a later upsert PRESERVES the stored spec rather than clearing it:
   * an observation refresh must never erase provisioning intent.
   */
  desiredSpec?: WorkspaceHostDesiredSpec;
}

export async function upsertWorkspaceHost(input: WorkspaceHostInput): Promise<void> {
  const recoverability = input.recoverability ?? { kind: 'none' as const, label: 'No recovery point recorded' };
  // Credential REFERENCES are expected here; credential MATERIAL never is. Asserting before the
  // write means a spec carrying secret material fails loudly at the boundary instead of being
  // persisted and later exported by the audit route.
  if (input.desiredSpec) assertWorkspaceHostSecretIsolation(input.desiredSpec, 'workspaceHost.desiredSpec');
  const desiredSpec = input.desiredSpec ? JSON.stringify(input.desiredSpec) : null;
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size,
        image, disk_gib, network, estimated_monthly_usd, desired_state,
        observed_state, observed_at, endpoint, recoverability_kind,
        recoverability_label, recoverability_updated_at, desired_spec, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.id}, ${input.name}, ${input.connectionId},
        ${input.target}, ${input.scopeLabel}, ${input.region}, ${input.size},
        ${input.image}, ${input.diskGiB}, ${input.network}, ${input.estimatedMonthlyUsd ?? null},
        ${input.desiredState}, ${input.observedState}, ${input.observedAt ?? null},
        ${input.endpoint ?? null}, ${recoverability.kind}, ${recoverability.label},
        ${recoverability.updatedAt ?? null}, ${desiredSpec}::jsonb, now()
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        name = EXCLUDED.name,
        connection_id = EXCLUDED.connection_id,
        target = EXCLUDED.target,
        scope_label = EXCLUDED.scope_label,
        region = EXCLUDED.region,
        size = EXCLUDED.size,
        image = EXCLUDED.image,
        disk_gib = EXCLUDED.disk_gib,
        network = EXCLUDED.network,
        estimated_monthly_usd = EXCLUDED.estimated_monthly_usd,
        desired_state = EXCLUDED.desired_state,
        observed_state = EXCLUDED.observed_state,
        observed_at = EXCLUDED.observed_at,
        endpoint = EXCLUDED.endpoint,
        recoverability_kind = EXCLUDED.recoverability_kind,
        recoverability_label = EXCLUDED.recoverability_label,
        recoverability_updated_at = EXCLUDED.recoverability_updated_at,
        -- PRESERVE, don't clobber: an observation refresh omits the spec, and provisioning
        -- intent must survive it. Only a caller that actually supplies a spec replaces one.
        desired_spec = COALESCE(EXCLUDED.desired_spec, harness_shared.workspace_hosts.desired_spec),
        updated_at = now()
    `;
  });
}

/** Why a host's recorded provisioning intent could not be returned. */
export type WorkspaceHostDesiredSpecMiss = 'host-not-found' | 'no-recorded-spec';

export interface WorkspaceHostDesiredSpecLookup {
  desired: WorkspaceHostDesiredSpec | null;
  /** Set only when `desired` is null — which of the two distinct causes applied. */
  miss?: WorkspaceHostDesiredSpecMiss;
}

/**
 * Read back the provisioning intent recorded for one host.
 *
 * The two null cases are deliberately DISTINGUISHED rather than collapsed. "No such host" and
 * "a host that predates migration 956, or was written by a provisioner that recorded no intent"
 * demand different responses — the first is a bad request, the second is a host that cannot be
 * initialized until its provisioner records what it built. Returning a bare null for both would
 * force every caller to re-query to tell them apart, and the likely failure is that none would.
 */
export async function readWorkspaceHostDesiredSpec(
  workspaceId: string,
  hostId: string,
): Promise<WorkspaceHostDesiredSpecLookup> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = (await tx`
      SELECT desired_spec
        FROM harness_shared.workspace_hosts
       WHERE workspace_id = ${workspaceId} AND id = ${hostId}
       LIMIT 1
    `) as Array<{ desired_spec: unknown }>;

    if (rows.length === 0) return { desired: null, miss: 'host-not-found' as const };
    const spec = rows[0]?.desired_spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { desired: null, miss: 'no-recorded-spec' as const };
    }
    return { desired: spec as WorkspaceHostDesiredSpec };
  });
}

export interface StoredWorkspaceHostDestroyTarget {
  id: string;
  name: string;
  connectionId: string;
  target: string;
  desired: WorkspaceHostDesiredSpec;
  resources: readonly {
    resource: WorkspaceHostResourceRef;
    registeredAt: string;
  }[];
}

/**
 * Recover the exact provider graph a later destroy must plan from.
 *
 * Provision and destroy use different operation ids, so operation-scoped replay rows alone are
 * insufficient here. This read deliberately selects the last applied/unchanged identity for every
 * provider resource and deduplicates lifecycle observations of the same resource. A destroy caller
 * must never reconstruct provider ids from the desired spec or from naming conventions.
 */
export async function readWorkspaceHostDestroyTarget(
  workspaceId: string,
  hostId: string,
): Promise<StoredWorkspaceHostDestroyTarget | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const hosts = (await tx`
      SELECT id, name, connection_id, target, desired_spec
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
      LIMIT 1
    `) as Array<{
      id: string;
      name: string;
      connection_id: string;
      target: string;
      desired_spec: unknown;
    }>;
    const host = hosts[0];
    if (!host) return null;
    if (!host.desired_spec || typeof host.desired_spec !== 'object' || Array.isArray(host.desired_spec)) {
      throw new Error(`Workspace host '${hostId}' has no recorded desired spec`);
    }

    const rows = (await tx`
      SELECT target, kind, provider_id, parent_provider_id, region, zone, updated_at
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId}
        AND host_id = ${hostId}
        AND state IN ('applied', 'unchanged')
        AND target IS NOT NULL
        AND kind IS NOT NULL
        AND provider_id IS NOT NULL
      ORDER BY updated_at DESC, logical_key
    `) as Array<{
      target: string;
      kind: string;
      provider_id: string;
      parent_provider_id: string | null;
      region: string | null;
      zone: string | null;
      updated_at: Date | string;
    }>;
    const seen = new Set<string>();
    const resources: Array<{ resource: WorkspaceHostResourceRef; registeredAt: string }> = [];
    for (const row of rows) {
      const key = `${row.target}:${row.kind}:${row.provider_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push({
        resource: {
          target: row.target,
          kind: row.kind,
          providerId: row.provider_id,
          ...(row.parent_provider_id ? { parentProviderId: row.parent_provider_id } : {}),
          ...(row.region ? { region: row.region } : {}),
          ...(row.zone ? { zone: row.zone } : {}),
        },
        registeredAt: iso(row.updated_at) ?? new Date(0).toISOString(),
      });
    }
    return {
      id: host.id,
      name: host.name,
      connectionId: host.connection_id,
      target: host.target,
      desired: host.desired_spec as WorkspaceHostDesiredSpec,
      resources,
    };
  });
}

/** Persist the user-visible lifecycle boundary without erasing the stored provisioning intent. */
export async function updateWorkspaceHostLifecycleState(input: {
  workspaceId: string;
  hostId: string;
  state: 'destroying' | 'absent';
  observedAt?: string;
  discard?: boolean;
}): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET desired_state = ${input.state},
          observed_state = ${input.state},
          observed_at = ${input.observedAt ?? new Date().toISOString()},
          endpoint = CASE WHEN ${input.state} = 'absent' THEN NULL ELSE endpoint END,
          recoverability_kind = CASE WHEN ${input.discard === true} THEN 'none' ELSE recoverability_kind END,
          recoverability_label = CASE
            WHEN ${input.discard === true} THEN 'Discarded without a recovery point'
            ELSE recoverability_label
          END,
          recoverability_updated_at = CASE
            WHEN ${input.discard === true} THEN ${input.observedAt ?? new Date().toISOString()}
            ELSE recoverability_updated_at
          END,
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
}

export interface WorkspaceHostOperationInput {
  workspaceId: string;
  operationId: string;
  hostId: string;
  action: WorkspaceHostLifecycleAction;
  status?: OperationStatus;
  percent?: number;
  message?: string;
  request?: unknown;
}

export async function beginWorkspaceHostOperation(input: WorkspaceHostOperationInput): Promise<void> {
  const percent = Math.max(0, Math.min(100, Math.round(input.percent ?? 0)));
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_host_operations (
        workspace_id, id, host_id, action, status, percent, message, request, started_at, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.operationId}, ${input.hostId}, ${input.action},
        ${input.status ?? 'queued'}, ${percent}, ${redactWorkspaceHostText(input.message ?? '')},
        ${input.request === undefined ? null : tx.json(json(input.request) as never)},
        ${input.status === 'running' ? new Date().toISOString() : null}, now()
      )
      ON CONFLICT (workspace_id, id) DO NOTHING
    `;
  });
}

export async function updateWorkspaceHostOperation(input: {
  workspaceId: string;
  operationId: string;
  status: OperationStatus;
  percent: number;
  message: string;
  error?: unknown;
}): Promise<void> {
  const percent = Math.max(0, Math.min(100, Math.round(input.percent)));
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_host_operations
      SET status = ${input.status},
          percent = ${percent},
          message = ${redactWorkspaceHostText(input.message)},
          error = ${input.error === undefined ? null : tx.json(json(input.error) as never)},
          started_at = CASE WHEN ${input.status} = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
          finished_at = CASE WHEN ${input.status} IN ('succeeded', 'failed') THEN now() ELSE NULL END,
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.operationId}
    `;
  });
}

export async function upsertWorkspaceHostResourceCheckpoint(input: {
  workspaceId: string;
  hostId: string;
  operationId: string;
  checkpoint: WorkspaceHostResourceCheckpoint;
}): Promise<void> {
  const { checkpoint } = input;
  const resource = checkpoint.providerResource;
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_host_resources (
        workspace_id, host_id, logical_key, operation_id, state, attempts,
        retry_class, retry_after_ms, target, kind, provider_id,
        parent_provider_id, region, zone, provider_request_id,
        deletion_confirmation, error, updated_at
      ) VALUES (
        ${input.workspaceId}, ${input.hostId}, ${checkpoint.logicalKey}, ${input.operationId},
        ${checkpoint.state}, ${checkpoint.attempts}, ${checkpoint.retryClass ?? null},
        ${checkpoint.retryAfterMs ?? null}, ${resource?.target ?? null}, ${resource?.kind ?? null},
        ${resource?.providerId ?? null}, ${resource?.parentProviderId ?? null},
        ${resource?.region ?? null}, ${resource?.zone ?? null},
        ${checkpoint.providerRequestId ?? null},
        ${checkpoint.deletionConfirmation === undefined ? null : tx.json(json(checkpoint.deletionConfirmation) as never)},
        ${checkpoint.error === undefined ? null : tx.json(json({ message: checkpoint.error }) as never)}, now()
      )
      ON CONFLICT (workspace_id, host_id, logical_key) DO UPDATE SET
        operation_id = EXCLUDED.operation_id,
        state = EXCLUDED.state,
        attempts = EXCLUDED.attempts,
        retry_class = EXCLUDED.retry_class,
        retry_after_ms = EXCLUDED.retry_after_ms,
        target = EXCLUDED.target,
        kind = EXCLUDED.kind,
        provider_id = EXCLUDED.provider_id,
        parent_provider_id = EXCLUDED.parent_provider_id,
        region = EXCLUDED.region,
        zone = EXCLUDED.zone,
        provider_request_id = EXCLUDED.provider_request_id,
        deletion_confirmation = EXCLUDED.deletion_confirmation,
        error = EXCLUDED.error,
        updated_at = now()
    `;
  });
}

interface ResourceCheckpointDbRow {
  logical_key: string;
  state: WorkspaceHostResourceCheckpoint['state'];
  attempts: number;
  retry_class: WorkspaceHostResourceCheckpoint['retryClass'] | null;
  retry_after_ms: number | null;
  target: string | null;
  kind: string | null;
  provider_id: string | null;
  parent_provider_id: string | null;
  region: string | null;
  zone: string | null;
  provider_request_id: string | null;
  deletion_confirmation: unknown;
  error: unknown;
}

function checkpointError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return undefined;
}

/**
 * Hydrate only checkpoints belonging to this stable operation. Filtering by operation id prevents
 * a new operation on the same host from treating an older resource graph as its own replay state.
 */
export async function readWorkspaceHostResourceCheckpoints(
  workspaceId: string,
  hostId: string,
  operationId: string,
): Promise<WorkspaceHostResourceCheckpoint[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<ResourceCheckpointDbRow[]>`
      SELECT logical_key, state, attempts, retry_class, retry_after_ms,
             target, kind, provider_id, parent_provider_id, region, zone,
             provider_request_id, deletion_confirmation, error
      FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${workspaceId}
        AND host_id = ${hostId}
        AND operation_id = ${operationId}
      ORDER BY logical_key
    `;
    return rows.map((row) => {
      const providerResource =
        row.target && row.kind && row.provider_id
          ? {
              target: row.target,
              kind: row.kind,
              providerId: row.provider_id,
              ...(row.parent_provider_id ? { parentProviderId: row.parent_provider_id } : {}),
              ...(row.region ? { region: row.region } : {}),
              ...(row.zone ? { zone: row.zone } : {}),
            }
          : undefined;
      const deletionConfirmation =
        row.deletion_confirmation && typeof row.deletion_confirmation === 'object'
          ? (row.deletion_confirmation as WorkspaceHostResourceCheckpoint['deletionConfirmation'])
          : undefined;
      return {
        logicalKey: row.logical_key,
        state: row.state,
        attempts: row.attempts,
        ...(row.retry_class ? { retryClass: row.retry_class } : {}),
        ...(row.retry_after_ms != null ? { retryAfterMs: row.retry_after_ms } : {}),
        ...(providerResource ? { providerResource } : {}),
        ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
        ...(deletionConfirmation ? { deletionConfirmation } : {}),
        ...(checkpointError(row.error) ? { error: checkpointError(row.error) } : {}),
      };
    });
  });
}

export interface WorkspaceHostTimelineEventInput {
  workspaceId: string;
  hostId: string;
  operationId: string;
  id?: string;
  occurredAt?: string;
  phase: string;
  status: OperationStatus;
  level?: TimelineLevel;
  source?: string;
  message: string;
  details?: unknown;
}

export async function appendWorkspaceHostEvent(input: WorkspaceHostTimelineEventInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.workspace_host_events (
        workspace_id, id, host_id, operation_id, occurred_at, phase,
        status, level, source, message, details
      ) VALUES (
        ${input.workspaceId}, ${id}, ${input.hostId}, ${input.operationId},
        ${input.occurredAt ?? new Date().toISOString()}, ${input.phase}, ${input.status},
        ${input.level ?? 'info'}, ${input.source ?? 'controller'},
        ${redactWorkspaceHostText(input.message)},
        ${input.details === undefined ? null : tx.json(json(input.details) as never)}
      )
      ON CONFLICT (workspace_id, id) DO NOTHING
    `;
  });
  return id;
}

export interface WorkspaceHostLogInput {
  id?: string;
  operationId?: string;
  observedAt?: string;
  stream: LogStream;
  unit?: string;
  level?: TimelineLevel;
  message: string;
  metadata?: unknown;
}

export async function appendWorkspaceHostLogs(
  workspaceId: string,
  hostId: string,
  entries: readonly WorkspaceHostLogInput[],
): Promise<string[]> {
  if (entries.length === 0) return [];
  const rows = entries.map((entry) => ({ ...entry, id: entry.id ?? randomUUID() }));
  await withWorkspace(workspaceId, async (tx) => {
    for (const entry of rows) {
      await tx`
        INSERT INTO harness_shared.workspace_host_logs (
          workspace_id, id, host_id, operation_id, observed_at, stream,
          unit, level, message, metadata
        ) VALUES (
          ${workspaceId}, ${entry.id}, ${hostId}, ${entry.operationId ?? null},
          ${entry.observedAt ?? new Date().toISOString()}, ${entry.stream}, ${entry.unit ?? null},
          ${entry.level ?? 'info'}, ${redactWorkspaceHostText(entry.message)},
          ${entry.metadata === undefined ? null : tx.json(json(entry.metadata) as never)}
        )
        ON CONFLICT (workspace_id, id) DO NOTHING
      `;
    }
  });
  await pushControl();
  return rows.map((entry) => entry.id);
}

export async function recordWorkspaceHostObservation(
  workspaceId: string,
  observation: WorkspaceHostObservation,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET observed_state = ${observation.state},
          observed_at = ${observation.observedAt},
          version_drift = ${tx.json(json(observation.drift) as never)},
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${observation.host.hostId}
    `;
  });
}

export async function recordWorkspaceHostHealth(
  workspaceId: string,
  attestation: WorkspaceHostHealthAttestation,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET health_status = ${attestation.status},
          health_attested_at = ${attestation.observedAt},
          health_checks = ${tx.json(json(attestation.checks) as never)},
          bootstrap_version = ${attestation.bootstrapVersion ?? null},
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${attestation.hostId}
    `;
  });
}

export async function recordWorkspaceHostSignals(input: {
  workspaceId: string;
  hostId: string;
  endpoint?: string;
  tunnelStatus?: unknown;
  costSignals?: readonly unknown[];
  quotaSignals?: readonly unknown[];
}): Promise<void> {
  await withWorkspace(input.workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.workspace_hosts
      SET endpoint = coalesce(${input.endpoint ?? null}, endpoint),
          tunnel_status = coalesce(${input.tunnelStatus === undefined ? null : tx.json(json(input.tunnelStatus) as never)}, tunnel_status),
          cost_signals = coalesce(${input.costSignals === undefined ? null : tx.json(json(input.costSignals) as never)}, cost_signals),
          quota_signals = coalesce(${input.quotaSignals === undefined ? null : tx.json(json(input.quotaSignals) as never)}, quota_signals),
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.hostId}
    `;
  });
}

interface ConnectionDbRow {
  id: string;
  target: string;
  label: string;
  credential_ref: string;
  status: ConnectionStatus;
  status_detail: string | null;
  last_validated_at: Date | string | null;
  scopes: unknown[];
  regions: unknown[];
  sizes: unknown[];
  images: unknown[];
  networks: unknown[];
  disk_price_per_gib_month: string | number | null;
}
interface HostDbRow {
  id: string;
  name: string;
  connection_id: string;
  target: string;
  scope_label: string;
  region: string;
  size: string;
  image: string;
  disk_gib: number;
  network: string;
  estimated_monthly_usd: string | number | null;
  desired_state: string;
  observed_state: string;
  observed_at: Date | string | null;
  endpoint: string | null;
  recoverability_kind: 'snapshot' | 'backup' | 'none';
  recoverability_label: string;
  recoverability_updated_at: Date | string | null;
  health_status: string | null;
  health_attested_at: Date | string | null;
  health_checks: unknown[];
  bootstrap_version: string | null;
  version_drift: unknown[];
  tunnel_status: JsonRecord;
  cost_signals: unknown[];
  quota_signals: unknown[];
}
interface OperationDbRow {
  id: string;
  host_id: string;
  action: string;
  status: OperationStatus;
  percent: number;
  message: string;
  request: unknown;
  error: unknown;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
}
interface ResourceDbRow {
  host_id: string;
  logical_key: string;
  operation_id: string;
  state: string;
  attempts: number;
  retry_class: string | null;
  target: string | null;
  kind: string | null;
  provider_id: string | null;
  parent_provider_id: string | null;
  region: string | null;
  zone: string | null;
  provider_request_id: string | null;
  deletion_confirmation: unknown;
  error: unknown;
  updated_at: Date | string;
}
interface EventDbRow {
  id: string;
  host_id: string;
  operation_id: string;
  occurred_at: Date | string;
  phase: string;
  status: OperationStatus;
  level: TimelineLevel;
  source: string;
  message: string;
  details: unknown;
}
interface LogDbRow {
  id: string;
  host_id: string;
  operation_id: string | null;
  observed_at: Date | string;
  stream: LogStream;
  unit: string | null;
  level: TimelineLevel;
  message: string;
  metadata: unknown;
}

function capabilities(state: string): Record<string, boolean> {
  return {
    start: state === 'stopped',
    stop: state === 'running' || state === 'degraded',
    repair: state !== 'absent' && state !== 'destroying',
    snapshot: state === 'running' || state === 'stopped' || state === 'degraded',
    destroy: state !== 'absent' && state !== 'destroying',
  };
}

export async function readWorkspaceHostControl(workspaceId: string): Promise<unknown[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const connections = await tx<ConnectionDbRow[]>`
      SELECT id, target, label, credential_ref, status, status_detail, last_validated_at,
             scopes, regions, sizes, images, networks, disk_price_per_gib_month
      FROM harness_shared.workspace_host_connections
      ORDER BY target, label, id
    `;
    const hosts = await tx<HostDbRow[]>`
      SELECT id, name, connection_id, target, scope_label, region, size, image,
             disk_gib, network, estimated_monthly_usd, desired_state, observed_state,
             observed_at, endpoint, recoverability_kind, recoverability_label,
             recoverability_updated_at, health_status, health_attested_at, health_checks,
             bootstrap_version, version_drift, tunnel_status, cost_signals, quota_signals
      FROM harness_shared.workspace_hosts
      ORDER BY updated_at DESC, id
    `;
    const operations = await tx<OperationDbRow[]>`
      SELECT DISTINCT ON (host_id)
             id, host_id, action, status, percent, message, request, error,
             created_at, started_at, finished_at, updated_at
      FROM harness_shared.workspace_host_operations
      ORDER BY host_id, updated_at DESC, id DESC
    `;
    const resources = await tx<ResourceDbRow[]>`
      SELECT host_id, logical_key, operation_id, state, attempts, retry_class,
             target, kind, provider_id, parent_provider_id, region, zone,
             provider_request_id, deletion_confirmation, error, updated_at
      FROM harness_shared.workspace_host_resources
      ORDER BY host_id, logical_key
    `;
    const events = await tx<EventDbRow[]>`
      SELECT e.id, e.host_id, e.operation_id, e.occurred_at, e.phase,
             e.status, e.level, e.source, e.message, e.details
      FROM harness_shared.workspace_host_events e
      JOIN (
        SELECT DISTINCT ON (host_id) workspace_id, host_id, id
        FROM harness_shared.workspace_host_operations
        ORDER BY host_id, updated_at DESC, id DESC
      ) latest ON latest.workspace_id = e.workspace_id
              AND latest.host_id = e.host_id
              AND latest.id = e.operation_id
      ORDER BY e.occurred_at, e.id
    `;
    const logs = await tx<LogDbRow[]>`
      SELECT id, host_id, operation_id, observed_at, stream, unit, level, message, metadata
      FROM (
        SELECT l.*, row_number() OVER (PARTITION BY host_id ORDER BY observed_at DESC, id DESC) AS rn
        FROM harness_shared.workspace_host_logs l
      ) recent
      WHERE rn <= 20
      ORDER BY host_id, observed_at DESC, id DESC
    `;

    const latestOperation = new Map(operations.map((row) => [row.host_id, row]));
    const eventsByOperation = new Map<string, EventDbRow[]>();
    for (const event of events) {
      const list = eventsByOperation.get(event.operation_id) ?? [];
      list.push(event);
      eventsByOperation.set(event.operation_id, list);
    }
    const resourcesByHost = new Map<string, ResourceDbRow[]>();
    for (const resource of resources) {
      const list = resourcesByHost.get(resource.host_id) ?? [];
      list.push(resource);
      resourcesByHost.set(resource.host_id, list);
    }
    const logsByHost = new Map<string, LogDbRow[]>();
    for (const log of logs) {
      const list = logsByHost.get(log.host_id) ?? [];
      list.push(log);
      logsByHost.set(log.host_id, list);
    }

    const connectionRows = connections.map((row) => ({
      kind: 'connection' as const,
      id: row.id,
      target: row.target,
      label: row.label,
      status: row.status,
      credentialRef: row.credential_ref,
      lastValidatedAt: iso(row.last_validated_at),
      statusDetail: row.status_detail ?? undefined,
      scopes: row.scopes,
      regions: row.regions,
      sizes: row.sizes,
      images: row.images,
      networks: row.networks,
      diskPricePerGiBMonth: row.disk_price_per_gib_month == null ? undefined : Number(row.disk_price_per_gib_month),
    }));

    const hostRows = hosts.map((row) => {
      const operation = latestOperation.get(row.id);
      const hostResources = resourcesByHost.get(row.id) ?? [];
      return {
        kind: 'workspace' as const,
        id: row.id,
        name: row.name,
        connectionId: row.connection_id,
        target: row.target,
        scopeLabel: row.scope_label,
        region: row.region,
        size: row.size,
        image: row.image,
        diskGiB: row.disk_gib,
        network: row.network,
        estimatedMonthlyUsd: row.estimated_monthly_usd == null ? undefined : Number(row.estimated_monthly_usd),
        desiredState: row.desired_state,
        observedState: row.observed_state,
        observedAt: iso(row.observed_at),
        providerResourceId:
          hostResources.find((resource) => resource.kind === 'vm')?.provider_id ??
          hostResources.find((resource) => resource.provider_id)?.provider_id ??
          undefined,
        endpoint: row.endpoint ?? undefined,
        recoverability: {
          kind: row.recoverability_kind,
          label: row.recoverability_label,
          updatedAt: iso(row.recoverability_updated_at),
        },
        capabilities: capabilities(row.observed_state),
        resources: hostResources.map((resource) => ({
          logicalKey: resource.logical_key,
          kind: resource.kind,
          state: resource.state,
          providerId: resource.provider_id,
          providerRequestId: resource.provider_request_id,
          deletionConfirmation: resource.deletion_confirmation,
          attempts: resource.attempts,
          retryClass: resource.retry_class,
          updatedAt: iso(resource.updated_at),
          error: resource.error,
        })),
        health: row.health_status
          ? {
              status: row.health_status,
              attestedAt: iso(row.health_attested_at),
              checks: row.health_checks,
              bootstrapVersion: row.bootstrap_version ?? undefined,
            }
          : undefined,
        versionDrift: row.version_drift,
        tunnel: row.tunnel_status,
        costSignals: row.cost_signals,
        quotaSignals: row.quota_signals,
        logs: (logsByHost.get(row.id) ?? []).map((log) => ({
          id: log.id,
          operationId: log.operation_id ?? undefined,
          observedAt: iso(log.observed_at),
          stream: log.stream,
          unit: log.unit ?? undefined,
          level: log.level,
          message: log.message,
          metadata: log.metadata,
        })),
        operation: operation
          ? {
              id: operation.id,
              action: operation.action,
              status: operation.status,
              percent: operation.percent,
              message: operation.message,
              request: operation.request,
              error: operation.error,
              startedAt: iso(operation.started_at ?? operation.created_at),
              finishedAt: iso(operation.finished_at),
              events: (eventsByOperation.get(operation.id) ?? []).map((event) => ({
                id: event.id,
                ts: iso(event.occurred_at),
                phase: event.phase,
                status: event.status,
                level: event.level,
                source: event.source,
                message: event.message,
                details: event.details,
              })),
            }
          : undefined,
      };
    });
    return [...connectionRows, ...hostRows];
  });
}

export async function exportWorkspaceHostAudit(workspaceId: string, hostId: string): Promise<JsonRecord | null> {
  const result = await withWorkspace(workspaceId, async (tx) => {
    const hosts = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_hosts WHERE id = ${hostId} LIMIT 1
    `;
    if (!hosts[0]) return null;
    const operations = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_operations WHERE host_id = ${hostId}
      ORDER BY created_at, id
    `;
    const resources = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_resources WHERE host_id = ${hostId}
      ORDER BY logical_key
    `;
    const events = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_events WHERE host_id = ${hostId}
      ORDER BY occurred_at, id
    `;
    const logs = await tx<JsonRecord[]>`
      SELECT * FROM harness_shared.workspace_host_logs WHERE host_id = ${hostId}
      ORDER BY observed_at, id
    `;
    return {
      schemaVersion: 'papercusp-workspace-host-audit-v1',
      exportedAt: new Date().toISOString(),
      host: hosts[0],
      operations,
      resources,
      events,
      logs,
    };
  });
  return result ? (redactWorkspaceHostValue(result) as JsonRecord) : null;
}
