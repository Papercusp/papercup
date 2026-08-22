'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Cloud,
  DollarSign,
  Download,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { Button } from '@/app/harness/Button';
import { Modal } from '@/app/harness/Modal';
import { Select } from '@/app/harness/Select';
import { TextInput } from '@/app/harness/TextInput';
import styles from './cloud-workspaces.module.css';

type ProviderTarget = 'gcp' | 'aws' | 'azure';
type ConnectionStatus = 'connected' | 'degraded' | 'invalid';
type LifecycleState =
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'degraded'
  | 'repairing'
  | 'destroying'
  | 'absent';
type LifecycleAction = 'start' | 'stop' | 'repair' | 'snapshot' | 'destroy';
type DestroyDisposition = 'snapshot' | 'backup' | 'discard';

interface CatalogOption {
  id: string;
  label: string;
}

interface SizeOption extends CatalogOption {
  vcpu: number;
  memoryGiB: number;
  hourlyUsd?: number;
}

export interface WorkspaceHostConnectionRow {
  kind: 'connection';
  id: string;
  target: string;
  label: string;
  status: ConnectionStatus;
  credentialRef: string;
  lastValidatedAt?: string;
  statusDetail?: string;
  scopes: CatalogOption[];
  regions: CatalogOption[];
  sizes: SizeOption[];
  images: CatalogOption[];
  networks: CatalogOption[];
  diskPricePerGiBMonth?: number;
}

interface OperationEvent {
  id: string;
  ts: string;
  phase: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  level?: 'info' | 'warn' | 'error';
  source?: string;
  message: string;
  details?: unknown;
}

interface OperationProgress {
  id: string;
  action: LifecycleAction | 'provision';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  percent: number;
  message: string;
  request?: unknown;
  error?: unknown;
  events: OperationEvent[];
}

interface WorkspaceHostResourceRow {
  logicalKey: string;
  kind?: string | null;
  state: string;
  providerId?: string | null;
  providerRequestId?: string | null;
  attempts: number;
  retryClass?: string | null;
  updatedAt?: string;
  error?: unknown;
}

interface WorkspaceHostLogRow {
  id: string;
  operationId?: string;
  observedAt?: string;
  stream: 'cloud-init' | 'systemd' | 'controller';
  unit?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata?: unknown;
}

export interface WorkspaceHostControlRow {
  kind: 'workspace';
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
  desiredState: LifecycleState;
  observedState: LifecycleState;
  observedAt?: string;
  providerResourceId?: string;
  endpoint?: string;
  recoverability: {
    kind: 'snapshot' | 'backup' | 'none';
    label: string;
    updatedAt?: string;
  };
  capabilities: Partial<Record<LifecycleAction, boolean>>;
  resources?: WorkspaceHostResourceRow[];
  health?: {
    status: string;
    attestedAt?: string;
    checks: unknown[];
    bootstrapVersion?: string;
  };
  versionDrift?: unknown[];
  tunnel?: Record<string, unknown>;
  costSignals?: unknown[];
  quotaSignals?: unknown[];
  logs?: WorkspaceHostLogRow[];
  operation?: OperationProgress;
}

export type CloudWorkspacesControlRow = WorkspaceHostConnectionRow | WorkspaceHostControlRow;

type WorkspaceHostActionArgs =
  | { action: 'connect'; target: ProviderTarget; label: string; credentialRef: string }
  | { action: 'validate-connection'; connectionId: string }
  | {
      action: 'provision';
      connectionId: string;
      name: string;
      scopeId: string;
      regionId: string;
      sizeId: string;
      imageId: string;
      diskGiB: number;
      networkId: string;
    }
  | { action: Exclude<LifecycleAction, 'destroy'>; workspaceId: string }
  | { action: 'destroy'; workspaceId: string; disposition: DestroyDisposition };

interface WorkspaceHostActionResponse {
  ok: boolean;
  operationId?: string;
  message?: string;
}

const PROVIDERS: readonly { target: ProviderTarget; label: string; scope: string; accent: string }[] = [
  { target: 'gcp', label: 'Google Cloud', scope: 'Project', accent: 'GCP' },
  { target: 'aws', label: 'Amazon Web Services', scope: 'Account', accent: 'AWS' },
  { target: 'azure', label: 'Microsoft Azure', scope: 'Subscription', accent: 'AZURE' },
];

const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'provisioning',
  'running',
  'stopped',
  'degraded',
  'repairing',
  'destroying',
  'absent',
];

function isLifecycleState(value: string): value is LifecycleState {
  return LIFECYCLE_STATES.includes(value as LifecycleState);
}

function formatTimestamp(value?: string): string {
  if (!value) return 'not yet';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

function formatMoney(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignal(value: unknown): string {
  if (value == null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function signalTone(value: string): string {
  if (['healthy', 'connected', 'ok', 'applied', 'unchanged', 'succeeded'].includes(value)) return styles.good;
  if (['degraded', 'unreachable', 'failed', 'error', 'invalid'].includes(value)) return styles.bad;
  if (['warn', 'warning', 'retry-wait', 'reconciling', 'applying'].includes(value)) return styles.warn;
  return styles.neutral;
}

function SignalList({ items, empty }: { items?: unknown[]; empty: string }) {
  if (!items?.length) return <p className={styles.telemetryEmpty}>{empty}</p>;
  return (
    <ul className={styles.signalList}>
      {items.map((item, index) => (
        <li key={`${index}:${formatSignal(item)}`}>{formatSignal(item)}</li>
      ))}
    </ul>
  );
}

function stateTone(state: LifecycleState | ConnectionStatus | OperationEvent['status']): string {
  if (state === 'running' || state === 'connected' || state === 'succeeded') return styles.good;
  if (state === 'degraded' || state === 'invalid' || state === 'failed') return styles.bad;
  if (state === 'provisioning' || state === 'repairing' || state === 'destroying') {
    return styles.warn;
  }
  return styles.neutral;
}

async function workspaceHostActionRest(args: WorkspaceHostActionArgs): Promise<WorkspaceHostActionResponse> {
  const response = await fetch('/api/workspace-hosts/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = (await response.json().catch(() => null)) as WorkspaceHostActionResponse | null;
  if (!response.ok || !body?.ok) {
    throw new Error(body?.message || `Workspace-host action failed (${response.status})`);
  }
  return body;
}

function StatusBadge({ state, prefix }: { state: string; prefix?: string }) {
  const normalized = isLifecycleState(state) ? state : state as ConnectionStatus;
  return (
    <span className={`${styles.badge} ${stateTone(normalized)}`}>
      {prefix ? `${prefix}: ` : ''}{state}
    </span>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

export default function CloudWorkspacesPage() {
  const control = useSyncQuery<CloudWorkspacesControlRow>({ queryName: 'workspaceHosts.control' });
  const mutate = useSyncMutate<WorkspaceHostActionArgs, WorkspaceHostActionResponse>(
    'workspaceHosts.action',
    workspaceHostActionRest,
  );
  const rows = useMemo(() => control.data ?? [], [control.data]);
  const connections = useMemo(
    () => rows.filter((row): row is WorkspaceHostConnectionRow => row.kind === 'connection'),
    [rows],
  );
  const workspaces = useMemo(
    () => rows.filter((row): row is WorkspaceHostControlRow => row.kind === 'workspace'),
    [rows],
  );

  const [connectionParam, setConnectionParam] = useQueryState('connection', parseAsString.withDefault(''));
  const [scopeParam, setScopeParam] = useQueryState('scope', parseAsString.withDefault(''));
  const [regionParam, setRegionParam] = useQueryState('region', parseAsString.withDefault(''));
  const [sizeParam, setSizeParam] = useQueryState('size', parseAsString.withDefault(''));
  const [imageParam, setImageParam] = useQueryState('image', parseAsString.withDefault(''));
  const [networkParam, setNetworkParam] = useQueryState('network', parseAsString.withDefault(''));
  const [diskParam, setDiskParam] = useQueryState('disk', parseAsString.withDefault('100'));
  const [nameParam, setNameParam] = useQueryState('name', parseAsString.withDefault(''));
  const [connectTarget, setConnectTarget] = useQueryState(
    'connect',
    parseAsStringEnum<ProviderTarget>(['gcp', 'aws', 'azure']),
  );
  const [destroyId, setDestroyId] = useQueryState('destroy', parseAsString);
  const [disposition, setDisposition] = useQueryState(
    'disposition',
    parseAsStringEnum<DestroyDisposition>(['snapshot', 'backup', 'discard']).withDefault('snapshot'),
  );

  const [credentialRef, setCredentialRef] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [destroyConfirm, setDestroyConfirm] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const selectedConnection = connections.find((row) => row.id === connectionParam) ?? connections[0] ?? null;
  const selectedScope = selectedConnection?.scopes.find((option) => option.id === scopeParam)
    ?? selectedConnection?.scopes[0]
    ?? null;
  const selectedRegion = selectedConnection?.regions.find((option) => option.id === regionParam)
    ?? selectedConnection?.regions[0]
    ?? null;
  const selectedSize = selectedConnection?.sizes.find((option) => option.id === sizeParam)
    ?? selectedConnection?.sizes[0]
    ?? null;
  const selectedImage = selectedConnection?.images.find((option) => option.id === imageParam)
    ?? selectedConnection?.images[0]
    ?? null;
  const selectedNetwork = selectedConnection?.networks.find((option) => option.id === networkParam)
    ?? selectedConnection?.networks[0]
    ?? null;
  const diskGiB = Number.parseInt(diskParam, 10);
  const validDiskGiB = Number.isFinite(diskGiB) ? Math.max(20, Math.min(16_384, diskGiB)) : 100;
  const estimatedMonthlyUsd = selectedSize?.hourlyUsd === undefined
    ? undefined
    : selectedSize.hourlyUsd * 730 + validDiskGiB * (selectedConnection?.diskPricePerGiBMonth ?? 0);
  const destroyWorkspace = workspaces.find((row) => row.id === destroyId) ?? null;

  const perform = useCallback(
    async (key: string, args: WorkspaceHostActionArgs, successMessage: string) => {
      setBusyKey(key);
      try {
        const response = await mutate(args);
        toast.success(response.message || successMessage);
        await control.invalidate?.();
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Workspace-host action failed');
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [control, mutate],
  );

  const closeConnectionModal = useCallback(() => {
    void setConnectTarget(null);
    setCredentialRef('');
    setConnectionLabel('');
  }, [setConnectTarget]);

  const closeDestroyModal = useCallback(() => {
    void setDestroyId(null);
    void setDisposition('snapshot');
    setDestroyConfirm('');
  }, [setDestroyId, setDisposition]);

  const canProvision = Boolean(
    selectedConnection?.status === 'connected'
      && nameParam.trim()
      && selectedScope
      && selectedRegion
      && selectedSize
      && selectedImage
      && selectedNetwork,
  );

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>
            <Cloud size={14} aria-hidden="true" /> Local BYOC control plane
          </p>
          <h1>Cloud Workspaces</h1>
          <p className={styles.intro}>
            Provision and operate durable Papercusp hosts in infrastructure you control. Provider state, desired state,
            and observed state stay separate so drift is visible instead of guessed away.
          </p>
        </div>
        <Button
          variant="accent"
          onClick={() => void control.invalidate?.()}
          disabled={control.loading || control.fetching}
          aria-label="Refresh cloud workspace state"
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      </header>

      {control.loading ? (
        <section className={styles.notice} aria-live="polite">
          <RefreshCw className={styles.spin} size={18} aria-hidden="true" /> Loading provider connections and workspace
          state…
        </section>
      ) : control.error ? (
        <section className={`${styles.notice} ${styles.noticeError}`} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Local cloud control plane unavailable</strong>
            <p>{control.error.message}. No provider action is available while this read is unresolved.</p>
          </div>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="provider-connections-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.step}>01 · CONNECT</p>
            <h2 id="provider-connections-heading">Provider connections</h2>
          </div>
          <p>Credential references stay outside the repository; this surface stores only their injected reference.</p>
        </div>
        <div className={styles.providerGrid}>
          {PROVIDERS.map((provider) => {
            const connection = connections.find((row) => row.target === provider.target);
            return (
              <article className={styles.providerCard} key={provider.target}>
                <div className={styles.cardTopline}>
                  <span className={styles.providerMark}>{provider.accent}</span>
                  {connection ? (
                    <StatusBadge state={connection.status} />
                  ) : (
                    <span className={`${styles.badge} ${styles.neutral}`}>not connected</span>
                  )}
                </div>
                <h3>{provider.label}</h3>
                <p>
                  {provider.scope} discovery, regions, machine sizes, images, networks, lifecycle controls, and price
                  estimates.
                </p>
                {connection ? (
                  <dl className={styles.compactList}>
                    <div>
                      <dt>Connection</dt>
                      <dd>{connection.label}</dd>
                    </div>
                    <div>
                      <dt>Credential</dt>
                      <dd>
                        <code>{connection.credentialRef}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Validated</dt>
                      <dd>{formatTimestamp(connection.lastValidatedAt)}</dd>
                    </div>
                  </dl>
                ) : null}
                <div className={styles.cardActions}>
                  {connection ? (
                    <Button
                      variant="ghost"
                      disabled={busyKey === `validate:${connection.id}`}
                      onClick={() =>
                        void perform(
                          `validate:${connection.id}`,
                          { action: 'validate-connection', connectionId: connection.id },
                          `${provider.label} connection validated`,
                        )
                      }
                    >
                      <ShieldCheck size={14} aria-hidden="true" /> Validate
                    </Button>
                  ) : (
                    <Button variant="accent" onClick={() => void setConnectTarget(provider.target)}>
                      <Plus size={14} aria-hidden="true" /> Connect
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="new-workspace-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.step}>02 · CONFIGURE</p>
            <h2 id="new-workspace-heading">New workspace</h2>
          </div>
          <p>Selections are URL-backed so this exact provisioning view can be reviewed and revisited.</p>
        </div>
        {connections.length === 0 ? (
          <div className={styles.emptyState}>
            <Server size={24} aria-hidden="true" />
            <h3>Connect a provider to begin</h3>
            <p>The form stays inert until a validated provider catalog supplies real scope and capacity options.</p>
          </div>
        ) : (
          <form
            className={styles.provisionForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !canProvision ||
                !selectedConnection ||
                !selectedScope ||
                !selectedRegion ||
                !selectedSize ||
                !selectedImage ||
                !selectedNetwork
              )
                return;
              void perform(
                'provision',
                {
                  action: 'provision',
                  connectionId: selectedConnection.id,
                  name: nameParam.trim(),
                  scopeId: selectedScope.id,
                  regionId: selectedRegion.id,
                  sizeId: selectedSize.id,
                  imageId: selectedImage.id,
                  diskGiB: validDiskGiB,
                  networkId: selectedNetwork.id,
                },
                `Provisioning ${nameParam.trim()}`,
              );
            }}
          >
            <div className={styles.formGrid}>
              <Field label="Workspace name">
                <TextInput
                  value={nameParam}
                  onChange={(event) => void setNameParam(event.target.value)}
                  placeholder="research-control"
                  aria-label="Workspace name"
                />
              </Field>
              <Field label="Provider connection">
                <Select
                  value={selectedConnection?.id ?? ''}
                  onChange={(value) => void setConnectionParam(value)}
                  ariaLabel="Provider connection"
                  options={connections.map((row) => ({
                    value: row.id,
                    label: `${row.label} · ${row.target.toUpperCase()}`,
                  }))}
                />
              </Field>
              <Field label="Project, account, or subscription">
                <Select
                  value={selectedScope?.id ?? ''}
                  onChange={(value) => void setScopeParam(value)}
                  ariaLabel="Project, account, or subscription"
                  options={
                    selectedConnection?.scopes.map((option) => ({ value: option.id, label: option.label })) ?? []
                  }
                />
              </Field>
              <Field label="Region">
                <Select
                  value={selectedRegion?.id ?? ''}
                  onChange={(value) => void setRegionParam(value)}
                  ariaLabel="Region"
                  options={
                    selectedConnection?.regions.map((option) => ({ value: option.id, label: option.label })) ?? []
                  }
                />
              </Field>
              <Field
                label="Size"
                hint={selectedSize ? `${selectedSize.vcpu} vCPU · ${selectedSize.memoryGiB} GiB RAM` : undefined}
              >
                <Select
                  value={selectedSize?.id ?? ''}
                  onChange={(value) => void setSizeParam(value)}
                  ariaLabel="Machine size"
                  options={selectedConnection?.sizes.map((option) => ({ value: option.id, label: option.label })) ?? []}
                />
              </Field>
              <Field label="Image">
                <Select
                  value={selectedImage?.id ?? ''}
                  onChange={(value) => void setImageParam(value)}
                  ariaLabel="Machine image"
                  options={
                    selectedConnection?.images.map((option) => ({ value: option.id, label: option.label })) ?? []
                  }
                />
              </Field>
              <Field label="Disk (GiB)" hint="20–16,384 GiB">
                <TextInput
                  type="number"
                  min={20}
                  max={16_384}
                  value={diskParam}
                  onChange={(event) => void setDiskParam(event.target.value)}
                  aria-label="Disk size in GiB"
                />
              </Field>
              <Field label="Network">
                <Select
                  value={selectedNetwork?.id ?? ''}
                  onChange={(value) => void setNetworkParam(value)}
                  ariaLabel="Network"
                  options={
                    selectedConnection?.networks.map((option) => ({ value: option.id, label: option.label })) ?? []
                  }
                />
              </Field>
            </div>
            <aside className={styles.estimate} aria-label="Estimated workspace cost">
              <DollarSign size={22} aria-hidden="true" />
              <div>
                <span>Estimated cost</span>
                <strong>
                  {formatMoney(estimatedMonthlyUsd)} <small>/ month</small>
                </strong>
                <p>Estimate only · 730 compute hours + selected disk · provider taxes and egress excluded.</p>
              </div>
              <Button type="submit" variant="primary" size="lg" disabled={!canProvision || busyKey === 'provision'}>
                <Cloud size={16} aria-hidden="true" /> Provision workspace
              </Button>
            </aside>
          </form>
        )}
      </section>

      <section className={styles.section} aria-labelledby="managed-workspaces-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.step}>03 · OPERATE</p>
            <h2 id="managed-workspaces-heading">Managed workspaces</h2>
          </div>
          <p>Actions set desired state; reconciliation updates observed state and the durable progress stream.</p>
        </div>
        {workspaces.length === 0 ? (
          <div className={styles.emptyState}>
            <Server size={24} aria-hidden="true" />
            <h3>No cloud workspaces yet</h3>
            <p>Provisioning runs will appear here with their operation receipt and recoverability posture.</p>
          </div>
        ) : (
          <div className={styles.workspaceList}>
            {workspaces.map((workspace) => (
              <article className={styles.workspaceCard} key={workspace.id}>
                <div className={styles.workspaceHeader}>
                  <div>
                    <p className={styles.workspaceProvider}>
                      {workspace.target.toUpperCase()} · {workspace.scopeLabel}
                    </p>
                    <h3>{workspace.name}</h3>
                    <p>
                      {workspace.region} · {workspace.size} · {workspace.diskGiB} GiB · {workspace.network}
                    </p>
                  </div>
                  <div
                    className={styles.statePair}
                    aria-label={`Desired ${workspace.desiredState}; observed ${workspace.observedState}`}
                  >
                    <StatusBadge state={workspace.desiredState} prefix="desired" />
                    <StatusBadge state={workspace.observedState} prefix="observed" />
                  </div>
                </div>

                <div className={styles.workspaceMeta}>
                  <div>
                    <span>Resource</span>
                    <strong>{workspace.providerResourceId ?? 'pending allocation'}</strong>
                  </div>
                  <div>
                    <span>Endpoint</span>
                    <strong>{workspace.endpoint ?? 'not exposed'}</strong>
                  </div>
                  <div>
                    <span>Estimate</span>
                    <strong>{formatMoney(workspace.estimatedMonthlyUsd)} / month</strong>
                  </div>
                  <div>
                    <span>Observed</span>
                    <strong>{formatTimestamp(workspace.observedAt)}</strong>
                  </div>
                </div>

                <div className={styles.recoverability}>
                  {workspace.recoverability.kind === 'none' ? (
                    <AlertTriangle size={16} aria-hidden="true" />
                  ) : (
                    <CheckCircle2 size={16} aria-hidden="true" />
                  )}
                  <div>
                    <strong>Recoverability · {workspace.recoverability.kind}</strong>
                    <span>
                      {workspace.recoverability.label}
                      {workspace.recoverability.updatedAt
                        ? ` · ${formatTimestamp(workspace.recoverability.updatedAt)}`
                        : ''}
                    </span>
                  </div>
                </div>

                {workspace.operation ? (
                  <div className={styles.operation} aria-live="polite">
                    <div className={styles.operationHeader}>
                      <span>
                        {workspace.operation.action} · {workspace.operation.message} ·{' '}
                        <code>{workspace.operation.id}</code>
                      </span>
                      <strong>{workspace.operation.percent}%</strong>
                    </div>
                    <progress max={100} value={workspace.operation.percent}>
                      {workspace.operation.percent}%
                    </progress>
                    {workspace.operation.request != null || workspace.operation.error != null ? (
                      <div className={styles.operationPayloads}>
                        {workspace.operation.request != null ? (
                          <div>
                            <strong>Redacted request</strong>
                            <code>{formatSignal(workspace.operation.request)}</code>
                          </div>
                        ) : null}
                        {workspace.operation.error != null ? (
                          <div>
                            <strong>Operation error</strong>
                            <code>{formatSignal(workspace.operation.error)}</code>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <ol className={styles.eventStream} aria-label={`Progress for ${workspace.name}`}>
                      {workspace.operation.events.map((event) => (
                        <li key={event.id}>
                          <span
                            className={`${styles.eventDot} ${signalTone(event.level ?? event.status)}`}
                            aria-hidden="true"
                          />
                          <time dateTime={event.ts}>{formatTimestamp(event.ts)}</time>
                          <strong>{event.phase}</strong>
                          <span>
                            {event.message}
                            <small>
                              {event.source ?? 'controller'} · {event.level ?? 'info'}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}

                <details className={styles.telemetryDetails}>
                  <summary>Observability &amp; diagnostics</summary>
                  <div className={styles.telemetryGrid}>
                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Health and attestation for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Health &amp; attestation</h4>
                        <span className={`${styles.badge} ${signalTone(workspace.health?.status ?? 'unknown')}`}>
                          {workspace.health?.status ?? 'not attested'}
                        </span>
                      </div>
                      <dl className={styles.telemetryFacts}>
                        <div>
                          <dt>Attested</dt>
                          <dd>{formatTimestamp(workspace.health?.attestedAt)}</dd>
                        </div>
                        <div>
                          <dt>Bootstrap</dt>
                          <dd>{workspace.health?.bootstrapVersion ?? 'unknown'}</dd>
                        </div>
                      </dl>
                      <SignalList items={workspace.health?.checks} empty="No health checks recorded." />
                    </section>

                    <section className={styles.telemetryPanel} aria-label={`Provider resources for ${workspace.name}`}>
                      <div className={styles.telemetryHeading}>
                        <h4>Provider resources</h4>
                        <span>{workspace.resources?.length ?? 0}</span>
                      </div>
                      {workspace.resources?.length ? (
                        <ul className={styles.resourceList}>
                          {workspace.resources.map((resource) => (
                            <li key={resource.logicalKey}>
                              <div>
                                <strong>{resource.logicalKey}</strong>
                                <span className={`${styles.badge} ${signalTone(resource.state)}`}>
                                  {resource.state}
                                </span>
                              </div>
                              <code>{resource.providerId ?? 'provider id pending'}</code>
                              <small>
                                {resource.kind ?? 'resource'} · attempts {resource.attempts}
                                {resource.providerRequestId ? ` · request ${resource.providerRequestId}` : ''}
                              </small>
                              {resource.error != null ? <em>{formatSignal(resource.error)}</em> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.telemetryEmpty}>No provider resource checkpoints recorded.</p>
                      )}
                    </section>

                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Drift and connectivity for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Drift &amp; connectivity</h4>
                      </div>
                      <h5>Tunnel status</h5>
                      <code className={styles.signalCode}>{formatSignal(workspace.tunnel ?? {})}</code>
                      <h5>Version drift</h5>
                      <SignalList items={workspace.versionDrift} empty="No version drift recorded." />
                    </section>

                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Cost and quota signals for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Cost &amp; quota</h4>
                      </div>
                      <h5>Cost signals</h5>
                      <SignalList items={workspace.costSignals} empty="No cost signals recorded." />
                      <h5>Quota signals</h5>
                      <SignalList items={workspace.quotaSignals} empty="No quota signals recorded." />
                    </section>

                    <section
                      className={`${styles.telemetryPanel} ${styles.logPanel}`}
                      aria-label={`Recent host logs for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Recent host logs</h4>
                        <span>latest {workspace.logs?.length ?? 0}</span>
                      </div>
                      {workspace.logs?.length ? (
                        <ol className={styles.logList}>
                          {workspace.logs.map((log) => (
                            <li key={log.id}>
                              <time dateTime={log.observedAt}>{formatTimestamp(log.observedAt)}</time>
                              <span className={`${styles.badge} ${signalTone(log.level)}`}>{log.level}</span>
                              <strong>
                                {log.stream}
                                {log.unit ? ` · ${log.unit}` : ''}
                              </strong>
                              <code>{log.message}</code>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className={styles.telemetryEmpty}>No cloud-init, systemd, or controller logs recorded.</p>
                      )}
                    </section>
                  </div>
                </details>

                <div className={styles.workspaceActions}>
                  <Button asChild variant="ghost">
                    <a href={`/api/workspace-hosts/${encodeURIComponent(workspace.id)}/audit`} download>
                      <Download size={14} aria-hidden="true" /> Audit export
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!workspace.capabilities.start || busyKey === `start:${workspace.id}`}
                    onClick={() =>
                      void perform(
                        `start:${workspace.id}`,
                        { action: 'start', workspaceId: workspace.id },
                        `Starting ${workspace.name}`,
                      )
                    }
                  >
                    <Play size={14} aria-hidden="true" /> Start
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!workspace.capabilities.stop || busyKey === `stop:${workspace.id}`}
                    onClick={() =>
                      void perform(
                        `stop:${workspace.id}`,
                        { action: 'stop', workspaceId: workspace.id },
                        `Stopping ${workspace.name}`,
                      )
                    }
                  >
                    <Square size={13} aria-hidden="true" /> Stop
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!workspace.capabilities.repair || busyKey === `repair:${workspace.id}`}
                    onClick={() =>
                      void perform(
                        `repair:${workspace.id}`,
                        { action: 'repair', workspaceId: workspace.id },
                        `Repairing ${workspace.name}`,
                      )
                    }
                  >
                    <Wrench size={14} aria-hidden="true" /> Repair
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!workspace.capabilities.snapshot || busyKey === `snapshot:${workspace.id}`}
                    onClick={() =>
                      void perform(
                        `snapshot:${workspace.id}`,
                        { action: 'snapshot', workspaceId: workspace.id },
                        `Snapshotting ${workspace.name}`,
                      )
                    }
                  >
                    <Camera size={14} aria-hidden="true" /> Snapshot
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={!workspace.capabilities.destroy}
                    onClick={() => void setDestroyId(workspace.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Destroy
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={Boolean(connectTarget)}
        onOpenChange={(open) => {
          if (!open) closeConnectionModal();
        }}
        title={`Connect ${PROVIDERS.find((provider) => provider.target === connectTarget)?.label ?? 'provider'}`}
        description="Store a reference to an injected credential, then validate provider discovery. Raw secrets never enter this form."
        contentClassName={styles.modal}
      >
        <div className={styles.modalBody}>
          <Field label="Connection label">
            <TextInput
              value={connectionLabel}
              onChange={(event) => setConnectionLabel(event.target.value)}
              placeholder="production-gcp"
              aria-label="Connection label"
            />
          </Field>
          <Field
            label="Injected credential reference"
            hint="Examples: env:GCP_APPLICATION_CREDENTIALS or vault:cloud/gcp-prod"
          >
            <TextInput
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              placeholder="env:GCP_APPLICATION_CREDENTIALS"
              aria-label="Injected credential reference"
            />
          </Field>
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeConnectionModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!connectTarget || !connectionLabel.trim() || !credentialRef.trim() || busyKey === 'connect'}
              onClick={() => {
                if (!connectTarget) return;
                void perform(
                  'connect',
                  {
                    action: 'connect',
                    target: connectTarget,
                    label: connectionLabel.trim(),
                    credentialRef: credentialRef.trim(),
                  },
                  `${connectionLabel.trim()} connected`,
                ).then((ok) => {
                  if (ok) closeConnectionModal();
                });
              }}
            >
              <ShieldCheck size={14} aria-hidden="true" /> Connect and validate
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(destroyWorkspace)}
        onOpenChange={(open) => {
          if (!open) closeDestroyModal();
        }}
        title={`Destroy ${destroyWorkspace?.name ?? 'workspace'}`}
        description="Choose and record the recoverability disposition before any provider resource is deleted."
        contentClassName={styles.modal}
        closeOnOutsideClick={false}
      >
        <div className={styles.modalBody}>
          <div className={styles.dangerNotice}>
            <AlertTriangle size={18} aria-hidden="true" />
            Destroy is asynchronous. Completion requires a provider read confirming every resource is absent.
          </div>
          <div className={styles.dispositionGroup} role="radiogroup" aria-label="Recoverability disposition">
            {(
              [
                ['snapshot', 'Create a snapshot first', 'Block deletion until a fresh provider snapshot is durable.'],
                ['backup', 'Use an existing backup', 'Record the current durable backup as the recovery point.'],
                ['discard', 'Discard recoverability', 'Permanently accept that no snapshot or backup will be created.'],
              ] as const
            ).map(([value, label, detail]) => (
              <button
                type="button"
                role="radio"
                aria-checked={disposition === value}
                className={styles.disposition}
                data-selected={disposition === value ? 'true' : 'false'}
                key={value}
                onClick={() => void setDisposition(value)}
              >
                <strong>{label}</strong>
                <span>{detail}</span>
              </button>
            ))}
          </div>
          {disposition === 'discard' && destroyWorkspace ? (
            <Field label={`Type “${destroyWorkspace.name}” to confirm discard`}>
              <TextInput
                value={destroyConfirm}
                onChange={(event) => setDestroyConfirm(event.target.value)}
                aria-label={`Type ${destroyWorkspace.name} to confirm discard`}
              />
            </Field>
          ) : null}
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeDestroyModal}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !destroyWorkspace ||
                busyKey === `destroy:${destroyWorkspace?.id}` ||
                (disposition === 'discard' && destroyConfirm !== destroyWorkspace?.name)
              }
              onClick={() => {
                if (!destroyWorkspace) return;
                void perform(
                  `destroy:${destroyWorkspace.id}`,
                  { action: 'destroy', workspaceId: destroyWorkspace.id, disposition },
                  `Destroy scheduled for ${destroyWorkspace.name}`,
                ).then((ok) => {
                  if (ok) closeDestroyModal();
                });
              }}
            >
              <Trash2 size={14} aria-hidden="true" /> Confirm destroy
            </Button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
