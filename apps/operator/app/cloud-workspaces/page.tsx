"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
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
} from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { toast } from "sonner";
import { useSyncMutate, useSyncQuery } from "@papercusp/sync";
import { Button } from "@/app/harness/Button";
import { Modal } from "@/app/harness/Modal";
import { Select } from "@/app/harness/Select";
import { TextInput } from "@/app/harness/TextInput";
import styles from "./cloud-workspaces.module.css";

type ProviderTarget = "gcp" | "aws" | "azure";
type ConnectionStatus = "connected" | "degraded" | "invalid";
type LifecycleState =
  | "provisioning"
  | "running"
  | "stopped"
  | "degraded"
  | "repairing"
  | "destroying"
  | "absent";
type LifecycleAction = "start" | "stop" | "repair" | "snapshot" | "destroy";
type DestroyDisposition = "snapshot" | "backup" | "discard";

interface CatalogOption {
  id: string;
  label: string;
}

interface RegionOption extends CatalogOption {
  zones?: string[];
}

interface SizeOption extends CatalogOption {
  vcpu: number;
  memoryGiB: number;
  hourlyUsd?: number;
}

interface ImageOption extends CatalogOption {
  version?: string;
}

export interface WorkspaceHostConnectionRow {
  kind: "connection";
  id: string;
  target: string;
  label: string;
  status: ConnectionStatus;
  credentialRef: string;
  lastValidatedAt?: string;
  statusDetail?: string;
  provider?: {
    projectId?: string;
    serviceAccountEmail?: string;
  };
  scopes: CatalogOption[];
  regions: RegionOption[];
  sizes: SizeOption[];
  images: ImageOption[];
  networks: CatalogOption[];
  diskPricePerGiBMonth?: number;
}

interface OperationEvent {
  id: string;
  ts: string;
  phase: string;
  status: "queued" | "running" | "succeeded" | "failed";
  level?: "info" | "warn" | "error";
  source?: string;
  message: string;
  details?: unknown;
}

interface OperationProgress {
  id: string;
  action: LifecycleAction | "provision";
  status: "queued" | "running" | "succeeded" | "failed";
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
  stream: "cloud-init" | "systemd" | "controller";
  unit?: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: unknown;
}

export interface WorkspaceHostControlRow {
  kind: "workspace";
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
    kind: "snapshot" | "backup" | "none";
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

export type CloudWorkspacesControlRow =
  | WorkspaceHostConnectionRow
  | WorkspaceHostControlRow;

type WorkspaceHostActionArgs =
  | {
      action: "connect";
      target: ProviderTarget;
      label: string;
      credentialRef: string;
      projectId: string;
      serviceAccountEmail: string;
    }
  | { action: "validate-connection"; connectionId: string }
  | {
      action: "provision";
      connectionId: string;
      name: string;
      desired: {
        hostId: string;
        target: ProviderTarget;
        scope: { kind: "project"; id: string };
        region: string;
        zone: string;
        size: string;
        image: { id: string; version?: string };
        data: { volumeGiB: number; encrypted: true };
        provider: {
          network: { mode: "managed" };
        };
      };
    }
  | { action: Exclude<LifecycleAction, "destroy">; workspaceId: string }
  | { action: "destroy"; workspaceId: string; disposition: DestroyDisposition };

interface WorkspaceHostActionResponse {
  ok: boolean;
  operationId?: string;
  message?: string;
  error?: string;
}

const PROVIDERS: readonly {
  target: ProviderTarget;
  label: string;
  scope: string;
  accent: string;
}[] = [
  { target: "gcp", label: "Google Cloud", scope: "Project", accent: "GCP" },
  {
    target: "aws",
    label: "Amazon Web Services",
    scope: "Account",
    accent: "AWS",
  },
  {
    target: "azure",
    label: "Microsoft Azure",
    scope: "Subscription",
    accent: "AZURE",
  },
];

const DESTROY_DISPOSITIONS: readonly {
  value: DestroyDisposition;
  label: string;
  detail: string;
}[] = [
  {
    value: "snapshot",
    label: "Create a snapshot first",
    detail: "Block deletion until a fresh provider snapshot is durable.",
  },
  {
    value: "backup",
    label: "Use an existing backup",
    detail: "Record the current durable backup as the recovery point.",
  },
  {
    value: "discard",
    label: "Discard recoverability",
    detail: "Permanently accept that no snapshot or backup will be created.",
  },
];

const LIFECYCLE_STATES: readonly LifecycleState[] = [
  "provisioning",
  "running",
  "stopped",
  "degraded",
  "repairing",
  "destroying",
  "absent",
];

function isLifecycleState(value: string): value is LifecycleState {
  return LIFECYCLE_STATES.includes(value as LifecycleState);
}

function formatTimestamp(value?: string): string {
  if (!value) return "not yet";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

function formatMoney(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCapacity(
  size?: Partial<Pick<SizeOption, "vcpu" | "memoryGiB">> | null,
): string {
  if (
    !size ||
    !Number.isFinite(size.vcpu) ||
    !Number.isFinite(size.memoryGiB)
  ) {
    return "Capacity details unavailable";
  }
  return `${size.vcpu} vCPU · ${size.memoryGiB} GiB RAM`;
}

function formatSignal(value: unknown): string {
  if (value == null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function signalTone(value: string): string {
  if (
    [
      "healthy",
      "connected",
      "ok",
      "applied",
      "unchanged",
      "succeeded",
    ].includes(value)
  )
    return styles.good;
  if (["degraded", "unreachable", "failed", "error", "invalid"].includes(value))
    return styles.bad;
  if (
    ["warn", "warning", "retry-wait", "reconciling", "applying"].includes(value)
  )
    return styles.warn;
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

function stateTone(
  state: LifecycleState | ConnectionStatus | OperationEvent["status"],
): string {
  if (state === "running" || state === "connected" || state === "succeeded")
    return styles.good;
  if (state === "degraded" || state === "invalid" || state === "failed")
    return styles.bad;
  if (
    state === "provisioning" ||
    state === "repairing" ||
    state === "destroying"
  ) {
    return styles.warn;
  }
  return styles.neutral;
}

export function workspaceHostIdFromName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `host-${normalized || "workspace"}`;
}

export async function workspaceHostActionRest(
  args: WorkspaceHostActionArgs,
): Promise<WorkspaceHostActionResponse> {
  const endpoint =
    args.action === "connect" || args.action === "validate-connection"
      ? "/api/workspace-hosts/connection"
      : args.action === "provision"
        ? "/api/workspace-hosts/provision"
        : "/api/workspace-hosts/action";
  const payload =
    args.action === "provision"
      ? {
          connectionId: args.connectionId,
          name: args.name,
          desired: args.desired,
        }
      : args;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response
    .json()
    .catch(() => null)) as WorkspaceHostActionResponse | null;
  if (!response.ok || !body?.ok) {
    throw new Error(
      body?.message ||
        body?.error ||
        `Workspace-host action failed (${response.status})`,
    );
  }
  return body;
}

function StatusBadge({ state, prefix }: { state: string; prefix?: string }) {
  const normalized = isLifecycleState(state)
    ? state
    : (state as ConnectionStatus);
  return (
    <span className={`${styles.badge} ${stateTone(normalized)}`}>
      {prefix ? `${prefix}: ` : ""}
      {state}
    </span>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode | ((hintId: string | undefined) => React.ReactNode);
  hint?: string;
}) {
  const generatedHintId = useId();
  const hintId = hint ? generatedHintId : undefined;

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {typeof children === "function" ? children(hintId) : children}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function SectionHeading({
  id,
  step,
  eyebrow,
  title,
  description,
}: {
  id: string;
  step: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.sectionHeading}>
      <div className={styles.sectionTitle}>
        <span className={styles.sectionNumber} aria-hidden="true">
          {step}
        </span>
        <div>
          <p className={styles.step}>{eyebrow}</p>
          <h2 id={id}>{title}</h2>
        </div>
      </div>
      <p>{description}</p>
    </div>
  );
}

export default function CloudWorkspacesPage() {
  const control = useSyncQuery<CloudWorkspacesControlRow>({
    queryName: "workspaceHosts.control",
  });
  const mutate = useSyncMutate<
    WorkspaceHostActionArgs,
    WorkspaceHostActionResponse
  >("workspaceHosts.action", workspaceHostActionRest);
  const rows = useMemo(() => control.data ?? [], [control.data]);
  const connections = useMemo(
    () =>
      rows.filter(
        (row): row is WorkspaceHostConnectionRow => row.kind === "connection",
      ),
    [rows],
  );
  const workspaces = useMemo(
    () =>
      rows.filter(
        (row): row is WorkspaceHostControlRow => row.kind === "workspace",
      ),
    [rows],
  );

  const [connectionParam, setConnectionParam] = useQueryState(
    "connection",
    parseAsString.withDefault(""),
  );
  const [scopeParam, setScopeParam] = useQueryState(
    "scope",
    parseAsString.withDefault(""),
  );
  const [regionParam, setRegionParam] = useQueryState(
    "region",
    parseAsString.withDefault(""),
  );
  const [sizeParam, setSizeParam] = useQueryState(
    "size",
    parseAsString.withDefault(""),
  );
  const [imageParam, setImageParam] = useQueryState(
    "image",
    parseAsString.withDefault(""),
  );
  const [networkParam, setNetworkParam] = useQueryState(
    "network",
    parseAsString.withDefault(""),
  );
  const [diskParam, setDiskParam] = useQueryState(
    "disk",
    parseAsString.withDefault("100"),
  );
  const [nameParam, setNameParam] = useQueryState(
    "name",
    parseAsString.withDefault(""),
  );
  const [connectTarget, setConnectTarget] = useQueryState(
    "connect",
    parseAsStringEnum<ProviderTarget>(["gcp", "aws", "azure"]),
  );
  const [destroyId, setDestroyId] = useQueryState("destroy", parseAsString);
  const [disposition, setDisposition] = useQueryState(
    "disposition",
    parseAsStringEnum<DestroyDisposition>([
      "snapshot",
      "backup",
      "discard",
    ]).withDefault("snapshot"),
  );

  const [credentialRef, setCredentialRef] = useState("");
  const [connectionLabel, setConnectionLabel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [serviceAccountEmail, setServiceAccountEmail] = useState("");
  const [destroyConfirm, setDestroyConfirm] = useState("");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const inFlightKeysRef = useRef(new Set<string>());
  const dispositionButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedConnection =
    connections.find((row) => row.id === connectionParam) ??
    connections[0] ??
    null;
  const selectedScope =
    selectedConnection?.scopes.find((option) => option.id === scopeParam) ??
    selectedConnection?.scopes[0] ??
    null;
  const selectedRegion =
    selectedConnection?.regions.find((option) => option.id === regionParam) ??
    selectedConnection?.regions[0] ??
    null;
  const selectedZone = selectedRegion?.zones?.[0] ?? null;
  const selectedSize =
    selectedConnection?.sizes.find((option) => option.id === sizeParam) ??
    selectedConnection?.sizes[0] ??
    null;
  const selectedImage =
    selectedConnection?.images.find((option) => option.id === imageParam) ??
    selectedConnection?.images[0] ??
    null;
  const selectedNetwork =
    selectedConnection?.networks.find((option) => option.id === networkParam) ??
    selectedConnection?.networks[0] ??
    null;
  const provisionBlockers = [
    selectedConnection && selectedConnection.target !== "gcp"
      ? "choose a supported Google Cloud connection"
      : null,
    selectedConnection?.status !== "connected"
      ? "validate the provider connection"
      : null,
    !nameParam.trim() ? "enter a workspace name" : null,
    !selectedScope
      ? "load a project, account, or subscription from the provider catalog"
      : null,
    !selectedRegion ? "load a region from the provider catalog" : null,
    selectedRegion && !selectedZone
      ? "load an available zone for the selected region"
      : null,
    !selectedSize ? "load a machine size from the provider catalog" : null,
    !selectedImage ? "load an image from the provider catalog" : null,
    !selectedNetwork ? "load a network from the provider catalog" : null,
  ].filter((blocker): blocker is string => Boolean(blocker));
  const diskGiB = Number.parseInt(diskParam, 10);
  const validDiskGiB = Number.isFinite(diskGiB)
    ? Math.max(20, Math.min(16_384, diskGiB))
    : 100;
  const estimatedMonthlyUsd =
    selectedSize?.hourlyUsd === undefined
      ? undefined
      : selectedSize.hourlyUsd * 730 +
        validDiskGiB * (selectedConnection?.diskPricePerGiBMonth ?? 0);
  const destroyWorkspace =
    workspaces.find((row) => row.id === destroyId) ?? null;
  const connectedProviderCount = connections.filter(
    (row) => row.status === "connected",
  ).length;
  const healthyWorkspaceCount = workspaces.filter(
    (row) => row.health?.status === "healthy",
  ).length;
  const alignedWorkspaceCount = workspaces.filter(
    (row) => row.desiredState === row.observedState,
  ).length;
  const managedMonthlyUsd = workspaces.reduce(
    (total, row) =>
      total +
      (Number.isFinite(row.estimatedMonthlyUsd)
        ? (row.estimatedMonthlyUsd ?? 0)
        : 0),
    0,
  );

  const perform = useCallback(
    async (
      key: string,
      args: WorkspaceHostActionArgs,
      successMessage: string,
    ) => {
      if (inFlightKeysRef.current.has(key)) return false;

      inFlightKeysRef.current.add(key);
      setBusyKeys((current) => {
        const next = new Set(current);
        next.add(key);
        return next;
      });
      try {
        const response = await mutate(args);
        toast.success(response.message || successMessage);
        await control.invalidate?.();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Workspace-host action failed",
        );
        return false;
      } finally {
        inFlightKeysRef.current.delete(key);
        setBusyKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [control, mutate],
  );

  const closeConnectionModal = useCallback(() => {
    void setConnectTarget(null);
    setCredentialRef("");
    setConnectionLabel("");
    setProjectId("");
    setServiceAccountEmail("");
  }, [setConnectTarget]);

  const closeDestroyModal = useCallback(() => {
    void setDestroyId(null);
    void setDisposition("snapshot");
    setDestroyConfirm("");
  }, [setDestroyId, setDisposition]);

  const handleDispositionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        nextIndex = (index + 1) % DESTROY_DISPOSITIONS.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        nextIndex =
          (index - 1 + DESTROY_DISPOSITIONS.length) %
          DESTROY_DISPOSITIONS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = DESTROY_DISPOSITIONS.length - 1;
      }
      if (nextIndex === null) return;

      event.preventDefault();
      void setDisposition(DESTROY_DISPOSITIONS[nextIndex].value);
      dispositionButtonsRef.current[nextIndex]?.focus();
    },
    [setDisposition],
  );

  const canProvision = Boolean(
    selectedConnection?.target === "gcp" &&
    selectedConnection?.status === "connected" &&
    nameParam.trim() &&
    selectedScope &&
    selectedRegion &&
    selectedZone &&
    selectedSize &&
    selectedImage &&
    selectedNetwork,
  );

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <Cloud size={14} aria-hidden="true" /> Local BYOC control plane
          </p>
          <h1>Cloud Workspaces</h1>
          <p className={styles.intro}>
            Provision and operate durable Papercusp hosts in infrastructure you
            control. Provider state, desired state, and observed state stay
            separate so drift is visible instead of guessed away.
          </p>
          <div
            className={styles.heroSignals}
            role="list"
            aria-label="Control-plane posture"
          >
            <span role="listitem">
              <i className={styles.liveDot} aria-hidden="true" />{" "}
              Provider-neutral orchestration
            </span>
            <span role="listitem">Credentials stay injected</span>
            <span role="listitem">Recovery is explicit</span>
          </div>
        </div>
        <div className={styles.heroActions}>
          <Button
            variant="accent"
            onClick={() => void control.invalidate?.()}
            disabled={control.loading || control.fetching}
            aria-label="Refresh cloud workspace state"
          >
            <RefreshCw
              className={control.fetching ? styles.spin : undefined}
              size={14}
              aria-hidden="true"
            />
            {control.fetching ? "Refreshing" : "Refresh"}
          </Button>
          <small>
            {control.error ? "Control read unavailable" : "Live control state"}
          </small>
        </div>
      </header>

      {control.loading ? (
        <section className={styles.notice} aria-live="polite">
          <RefreshCw className={styles.spin} size={18} aria-hidden="true" />{" "}
          Loading provider connections and workspace state…
        </section>
      ) : control.error ? (
        <section
          className={`${styles.notice} ${styles.noticeError}`}
          role="alert"
        >
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Local cloud control plane unavailable</strong>
            <p>
              {control.error.message}. No provider action is available while
              this read is unresolved.
            </p>
          </div>
        </section>
      ) : null}

      <section
        className={styles.overviewGrid}
        aria-label="Cloud workspace overview"
      >
        <article className={styles.summaryCard}>
          <div className={styles.summaryIcon}>
            <Cloud size={17} aria-hidden="true" />
          </div>
          <div>
            <span>Connected providers</span>
            <strong>
              {connectedProviderCount} <small>/ {PROVIDERS.length}</small>
            </strong>
            <p>
              {connectedProviderCount === PROVIDERS.length
                ? "All providers ready"
                : "Validated catalog connections"}
            </p>
          </div>
        </article>
        <article className={styles.summaryCard}>
          <div className={styles.summaryIcon}>
            <Server size={17} aria-hidden="true" />
          </div>
          <div>
            <span>Managed workspaces</span>
            <strong>{workspaces.length}</strong>
            <p>
              {alignedWorkspaceCount} of {workspaces.length} desired states
              aligned
            </p>
          </div>
        </article>
        <article className={styles.summaryCard}>
          <div className={styles.summaryIcon}>
            <Activity size={17} aria-hidden="true" />
          </div>
          <div>
            <span>Healthy hosts</span>
            <strong>{healthyWorkspaceCount}</strong>
            <p>Latest host attestations</p>
          </div>
        </article>
        <article className={styles.summaryCard}>
          <div className={styles.summaryIcon}>
            <DollarSign size={17} aria-hidden="true" />
          </div>
          <div>
            <span>Monthly footprint</span>
            <strong>{formatMoney(managedMonthlyUsd)}</strong>
            <p>Estimated managed compute</p>
          </div>
        </article>
      </section>

      <section
        className={styles.section}
        aria-labelledby="provider-connections-heading"
      >
        <SectionHeading
          id="provider-connections-heading"
          step="01"
          eyebrow="Connect"
          title="Provider readiness"
          description="Credential references stay outside the repository; this surface stores only their injected reference."
        />
        <div className={styles.providerGrid}>
          {PROVIDERS.map((provider) => {
            const supported = provider.target === "gcp";
            const connection = connections.find(
              (row) => row.target === provider.target,
            );
            return (
              <article
                className={`${styles.providerCard} ${connection?.status === "connected" ? styles.providerCardReady : ""}`}
                key={provider.target}
              >
                <div className={styles.cardTopline}>
                  <span className={styles.providerIdentity}>
                    <span className={styles.providerIcon}>
                      <Cloud size={15} aria-hidden="true" />
                    </span>
                    <span className={styles.providerMark}>
                      {provider.accent}
                    </span>
                  </span>
                  {connection ? (
                    <StatusBadge state={connection.status} />
                  ) : (
                    <span className={`${styles.badge} ${styles.neutral}`}>
                      not connected
                    </span>
                  )}
                </div>
                <h3>{provider.label}</h3>
                <p className={styles.providerDescription}>
                  {provider.scope} discovery, regions, machine sizes, images,
                  networks, lifecycle controls, and price estimates.
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
                ) : (
                  <p className={styles.providerPrompt}>
                    {supported
                      ? "Add a safe local credential reference to load this provider's live catalog."
                      : "Connection admission is not available in this local build yet."}
                  </p>
                )}
                <div className={styles.cardActions}>
                  {connection ? (
                    <Button
                      variant="ghost"
                      aria-label={`Validate ${provider.label} connection`}
                      disabled={
                        !supported || busyKeys.has(`validate:${connection.id}`)
                      }
                      title={
                        supported
                          ? undefined
                          : "Connection validation is not available for this provider yet."
                      }
                      onClick={() =>
                        void perform(
                          `validate:${connection.id}`,
                          {
                            action: "validate-connection",
                            connectionId: connection.id,
                          },
                          `${provider.label} connection validated`,
                        )
                      }
                    >
                      <ShieldCheck size={14} aria-hidden="true" /> Validate
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      aria-label={
                        supported
                          ? `Connect ${provider.label}`
                          : `${provider.label} connection is not available`
                      }
                      disabled={!supported}
                      onClick={() => void setConnectTarget(provider.target)}
                    >
                      <Plus size={14} aria-hidden="true" />{" "}
                      {supported ? "Connect" : "Not yet available"}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section
        className={styles.section}
        aria-labelledby="new-workspace-heading"
      >
        <SectionHeading
          id="new-workspace-heading"
          step="02"
          eyebrow="Configure"
          title="New workspace"
          description="Selections are URL-backed so this exact provisioning view can be reviewed, shared, and revisited."
        />
        {connections.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>
              <Server size={22} aria-hidden="true" />
            </span>
            <h3>Connect a provider to begin</h3>
            <p>
              The form stays inert until a validated provider catalog supplies
              real scope and capacity options.
            </p>
            <Button
              variant="primary"
              onClick={() => void setConnectTarget("gcp")}
            >
              <Plus size={14} aria-hidden="true" /> Connect a provider
            </Button>
          </div>
        ) : (
          <form
            className={styles.provisionForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !canProvision ||
                !selectedConnection ||
                selectedConnection.target !== "gcp" ||
                !selectedScope ||
                !selectedRegion ||
                !selectedZone ||
                !selectedSize ||
                !selectedImage ||
                !selectedNetwork
              )
                return;
              void perform(
                "provision",
                {
                  action: "provision",
                  connectionId: selectedConnection.id,
                  name: nameParam.trim(),
                  desired: {
                    hostId: workspaceHostIdFromName(nameParam),
                    target: "gcp",
                    scope: { kind: "project", id: selectedScope.id },
                    region: selectedRegion.id,
                    zone: selectedZone,
                    size: selectedSize.id,
                    image: {
                      id: selectedImage.id,
                      ...(selectedImage.version
                        ? { version: selectedImage.version }
                        : {}),
                    },
                    data: { volumeGiB: validDiskGiB, encrypted: true },
                    provider: { network: { mode: "managed" } },
                  },
                },
                `Provisioning ${nameParam.trim()}`,
              );
            }}
          >
            <div className={styles.formGrid}>
              <div className={styles.formIntro}>
                <span className={styles.formIcon}>
                  <Server size={17} aria-hidden="true" />
                </span>
                <div>
                  <strong>Workspace configuration</strong>
                  <p>
                    Choose the provider catalog, capacity, image, disk, and
                    network for this durable host.
                  </p>
                </div>
              </div>
              <Field
                label="Workspace name"
                hint={
                  !nameParam.trim()
                    ? "Required before provisioning."
                    : undefined
                }
              >
                {(hintId) => (
                  <TextInput
                    value={nameParam}
                    onChange={(event) => void setNameParam(event.target.value)}
                    placeholder="research-control"
                    aria-label="Workspace name"
                    aria-describedby={hintId}
                  />
                )}
              </Field>
              <Field label="Provider connection">
                <Select
                  value={selectedConnection?.id ?? ""}
                  onChange={(value) => void setConnectionParam(value)}
                  ariaLabel="Provider connection"
                  options={connections.map((row) => ({
                    value: row.id,
                    label: `${row.label} · ${row.target.toUpperCase()}`,
                  }))}
                />
              </Field>
              <Field
                label="Project, account, or subscription"
                hint={
                  selectedConnection?.scopes.length
                    ? undefined
                    : "No projects, accounts, or subscriptions were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={selectedScope?.id ?? ""}
                    onChange={(value) => void setScopeParam(value)}
                    ariaLabel="Project, account, or subscription"
                    placeholder="No scopes available"
                    disabled={!selectedConnection?.scopes.length}
                    options={
                      selectedConnection?.scopes.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
              <Field
                label="Region"
                hint={
                  selectedConnection?.regions.length
                    ? undefined
                    : "No regions were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={selectedRegion?.id ?? ""}
                    onChange={(value) => void setRegionParam(value)}
                    ariaLabel="Region"
                    placeholder="No regions available"
                    disabled={!selectedConnection?.regions.length}
                    options={
                      selectedConnection?.regions.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
              <Field
                label="Size"
                hint={
                  selectedSize
                    ? formatCapacity(selectedSize)
                    : "No machine sizes were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={selectedSize?.id ?? ""}
                    onChange={(value) => void setSizeParam(value)}
                    ariaLabel="Machine size"
                    placeholder="No machine sizes available"
                    disabled={!selectedConnection?.sizes.length}
                    options={
                      selectedConnection?.sizes.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
              <Field
                label="Image"
                hint={
                  selectedConnection?.images.length
                    ? undefined
                    : "No images were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={selectedImage?.id ?? ""}
                    onChange={(value) => void setImageParam(value)}
                    ariaLabel="Machine image"
                    placeholder="No images available"
                    disabled={!selectedConnection?.images.length}
                    options={
                      selectedConnection?.images.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
              <Field label="Disk (GiB)" hint="20–16,384 GiB">
                {(hintId) => (
                  <TextInput
                    type="number"
                    min={20}
                    max={16_384}
                    value={diskParam}
                    onChange={(event) => void setDiskParam(event.target.value)}
                    aria-label="Disk size in GiB"
                    aria-describedby={hintId}
                  />
                )}
              </Field>
              <Field
                label="Network"
                hint={
                  selectedConnection?.networks.length
                    ? undefined
                    : "No networks were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={selectedNetwork?.id ?? ""}
                    onChange={(value) => void setNetworkParam(value)}
                    ariaLabel="Network"
                    placeholder="No networks available"
                    disabled={!selectedConnection?.networks.length}
                    options={
                      selectedConnection?.networks.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
            </div>
            <div
              className={styles.estimate}
              role="group"
              aria-label="Estimated workspace cost"
            >
              <span className={styles.estimateIcon}>
                <DollarSign size={19} aria-hidden="true" />
              </span>
              <div className={styles.estimateTotal}>
                <span>Estimated monthly cost</span>
                <strong>
                  {formatMoney(estimatedMonthlyUsd)} <small>/ month</small>
                </strong>
                <p>
                  Estimate only · 730 compute hours + selected disk · provider
                  taxes and egress excluded.
                </p>
              </div>
              <dl className={styles.estimateFacts}>
                <div>
                  <dt>Provider</dt>
                  <dd>{selectedConnection?.target.toUpperCase() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd>{selectedRegion?.label ?? "—"}</dd>
                </div>
                <div>
                  <dt>Compute</dt>
                  <dd>{selectedSize ? formatCapacity(selectedSize) : "—"}</dd>
                </div>
              </dl>
              {provisionBlockers.length > 0 ? (
                <p
                  id="provision-blockers"
                  className={styles.provisionBlockers}
                  role="status"
                >
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>
                    <strong>Provisioning blocked</strong>
                    <span>Required: {provisionBlockers.join("; ")}.</span>
                  </span>
                </p>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!canProvision || busyKeys.has("provision")}
                aria-describedby={
                  provisionBlockers.length > 0
                    ? "provision-blockers"
                    : undefined
                }
              >
                <Cloud size={16} aria-hidden="true" /> Provision workspace
              </Button>
            </div>
          </form>
        )}
      </section>

      <section
        className={styles.section}
        aria-labelledby="managed-workspaces-heading"
      >
        <SectionHeading
          id="managed-workspaces-heading"
          step="03"
          eyebrow="Operate"
          title="Managed workspaces"
          description="Actions set desired state; reconciliation updates observed state and the durable progress stream."
        />
        {workspaces.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>
              <Server size={22} aria-hidden="true" />
            </span>
            <h3>No cloud workspaces yet</h3>
            <p>
              Provisioning runs will appear here with their operation receipt
              and recoverability posture.
            </p>
            {connections.length > 0 ? (
              <Button asChild variant="ghost">
                <a href="#new-workspace-heading">
                  Configure the first workspace
                </a>
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={styles.workspaceList}>
            {workspaces.map((workspace) => (
              <article className={styles.workspaceCard} key={workspace.id}>
                <div className={styles.workspaceHeader}>
                  <div className={styles.workspaceIdentity}>
                    <span className={styles.workspaceIcon}>
                      <Server size={18} aria-hidden="true" />
                    </span>
                    <div>
                      <p className={styles.workspaceProvider}>
                        {workspace.target.toUpperCase()} ·{" "}
                        {workspace.scopeLabel}
                      </p>
                      <h3>{workspace.name}</h3>
                      <p>
                        {workspace.region} · {workspace.size} ·{" "}
                        {workspace.diskGiB} GiB · {workspace.network}
                      </p>
                    </div>
                  </div>
                  <div
                    className={styles.statePair}
                    aria-label={`Desired ${workspace.desiredState}; observed ${workspace.observedState}`}
                  >
                    <span
                      className={`${styles.badge} ${signalTone(workspace.health?.status ?? "unknown")}`}
                    >
                      health: {workspace.health?.status ?? "unknown"}
                    </span>
                    <StatusBadge
                      state={workspace.desiredState}
                      prefix="desired"
                    />
                    <StatusBadge
                      state={workspace.observedState}
                      prefix="observed"
                    />
                  </div>
                </div>

                <div className={styles.workspaceMeta}>
                  <div>
                    <span>Resource</span>
                    <strong>
                      {workspace.providerResourceId ?? "pending allocation"}
                    </strong>
                  </div>
                  <div>
                    <span>Endpoint</span>
                    <strong>{workspace.endpoint ?? "not exposed"}</strong>
                  </div>
                  <div>
                    <span>Estimate</span>
                    <strong>
                      {formatMoney(workspace.estimatedMonthlyUsd)} / month
                    </strong>
                  </div>
                  <div>
                    <span>Observed</span>
                    <strong>{formatTimestamp(workspace.observedAt)}</strong>
                  </div>
                </div>

                <div className={styles.recoverability}>
                  {workspace.recoverability.kind === "none" ? (
                    <AlertTriangle size={16} aria-hidden="true" />
                  ) : (
                    <CheckCircle2 size={16} aria-hidden="true" />
                  )}
                  <div>
                    <strong>
                      Recoverability · {workspace.recoverability.kind}
                    </strong>
                    <span>
                      {workspace.recoverability.label}
                      {workspace.recoverability.updatedAt
                        ? ` · ${formatTimestamp(workspace.recoverability.updatedAt)}`
                        : ""}
                    </span>
                  </div>
                </div>

                {workspace.operation ? (
                  <div className={styles.operation} aria-live="polite">
                    <div className={styles.operationHeader}>
                      <span>
                        {workspace.operation.action} ·{" "}
                        {workspace.operation.message} ·{" "}
                        <code>{workspace.operation.id}</code>
                      </span>
                      <strong>{workspace.operation.percent}%</strong>
                    </div>
                    <progress max={100} value={workspace.operation.percent}>
                      {workspace.operation.percent}%
                    </progress>
                    {workspace.operation.request != null ||
                    workspace.operation.error != null ? (
                      <div className={styles.operationPayloads}>
                        {workspace.operation.request != null ? (
                          <div>
                            <strong>Redacted request</strong>
                            <code>
                              {formatSignal(workspace.operation.request)}
                            </code>
                          </div>
                        ) : null}
                        {workspace.operation.error != null ? (
                          <div>
                            <strong>Operation error</strong>
                            <code>
                              {formatSignal(workspace.operation.error)}
                            </code>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <ol
                      className={styles.eventStream}
                      aria-label={`Progress for ${workspace.name}`}
                    >
                      {workspace.operation.events.map((event) => (
                        <li key={event.id}>
                          <span
                            className={`${styles.eventDot} ${signalTone(event.level ?? event.status)}`}
                            aria-hidden="true"
                          />
                          <time dateTime={event.ts}>
                            {formatTimestamp(event.ts)}
                          </time>
                          <strong>{event.phase}</strong>
                          <span>
                            {event.message}
                            <small>
                              {event.source ?? "controller"} ·{" "}
                              {event.level ?? "info"}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}

                <details className={styles.telemetryDetails}>
                  <summary>
                    <span>Observability &amp; diagnostics</span>
                    <small>
                      {workspace.resources?.length ?? 0} resources ·{" "}
                      {workspace.logs?.length ?? 0} recent logs
                    </small>
                  </summary>
                  <div className={styles.telemetryGrid}>
                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Health and attestation for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Health &amp; attestation</h4>
                        <span
                          className={`${styles.badge} ${signalTone(workspace.health?.status ?? "unknown")}`}
                        >
                          {workspace.health?.status ?? "not attested"}
                        </span>
                      </div>
                      <dl className={styles.telemetryFacts}>
                        <div>
                          <dt>Attested</dt>
                          <dd>
                            {formatTimestamp(workspace.health?.attestedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt>Bootstrap</dt>
                          <dd>
                            {workspace.health?.bootstrapVersion ?? "unknown"}
                          </dd>
                        </div>
                      </dl>
                      <SignalList
                        items={workspace.health?.checks}
                        empty="No health checks recorded."
                      />
                    </section>

                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Provider resources for ${workspace.name}`}
                    >
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
                                <span
                                  className={`${styles.badge} ${signalTone(resource.state)}`}
                                >
                                  {resource.state}
                                </span>
                              </div>
                              <code>
                                {resource.providerId ?? "provider id pending"}
                              </code>
                              <small>
                                {resource.kind ?? "resource"} · attempts{" "}
                                {resource.attempts}
                                {resource.providerRequestId
                                  ? ` · request ${resource.providerRequestId}`
                                  : ""}
                              </small>
                              {resource.error != null ? (
                                <em>{formatSignal(resource.error)}</em>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.telemetryEmpty}>
                          No provider resource checkpoints recorded.
                        </p>
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
                      <code className={styles.signalCode}>
                        {formatSignal(workspace.tunnel ?? {})}
                      </code>
                      <h5>Version drift</h5>
                      <SignalList
                        items={workspace.versionDrift}
                        empty="No version drift recorded."
                      />
                    </section>

                    <section
                      className={styles.telemetryPanel}
                      aria-label={`Cost and quota signals for ${workspace.name}`}
                    >
                      <div className={styles.telemetryHeading}>
                        <h4>Cost &amp; quota</h4>
                      </div>
                      <h5>Cost signals</h5>
                      <SignalList
                        items={workspace.costSignals}
                        empty="No cost signals recorded."
                      />
                      <h5>Quota signals</h5>
                      <SignalList
                        items={workspace.quotaSignals}
                        empty="No quota signals recorded."
                      />
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
                              <time dateTime={log.observedAt}>
                                {formatTimestamp(log.observedAt)}
                              </time>
                              <span
                                className={`${styles.badge} ${signalTone(log.level)}`}
                              >
                                {log.level}
                              </span>
                              <strong>
                                {log.stream}
                                {log.unit ? ` · ${log.unit}` : ""}
                              </strong>
                              <code>{log.message}</code>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className={styles.telemetryEmpty}>
                          No cloud-init, systemd, or controller logs recorded.
                        </p>
                      )}
                    </section>
                  </div>
                </details>

                <div className={styles.workspaceActionBar}>
                  <Button asChild variant="ghost">
                    <a
                      href={`/api/workspace-hosts/${encodeURIComponent(workspace.id)}/audit`}
                      download
                    >
                      <Download size={14} aria-hidden="true" /> Audit export
                    </a>
                  </Button>
                  <div
                    className={styles.lifecycleActions}
                    aria-label={`Lifecycle actions for ${workspace.name}`}
                  >
                    <Button
                      variant="ghost"
                      disabled={
                        !workspace.capabilities.start ||
                        busyKeys.has(`start:${workspace.id}`)
                      }
                      onClick={() =>
                        void perform(
                          `start:${workspace.id}`,
                          { action: "start", workspaceId: workspace.id },
                          `Starting ${workspace.name}`,
                        )
                      }
                    >
                      <Play size={14} aria-hidden="true" /> Start
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        !workspace.capabilities.stop ||
                        busyKeys.has(`stop:${workspace.id}`)
                      }
                      onClick={() =>
                        void perform(
                          `stop:${workspace.id}`,
                          { action: "stop", workspaceId: workspace.id },
                          `Stopping ${workspace.name}`,
                        )
                      }
                    >
                      <Square size={13} aria-hidden="true" /> Stop
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        !workspace.capabilities.repair ||
                        busyKeys.has(`repair:${workspace.id}`)
                      }
                      onClick={() =>
                        void perform(
                          `repair:${workspace.id}`,
                          { action: "repair", workspaceId: workspace.id },
                          `Repairing ${workspace.name}`,
                        )
                      }
                    >
                      <Wrench size={14} aria-hidden="true" /> Repair
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        !workspace.capabilities.snapshot ||
                        busyKeys.has(`snapshot:${workspace.id}`)
                      }
                      onClick={() =>
                        void perform(
                          `snapshot:${workspace.id}`,
                          { action: "snapshot", workspaceId: workspace.id },
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
        title={`Connect ${PROVIDERS.find((provider) => provider.target === connectTarget)?.label ?? "provider"}`}
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
            hint="Use adc://default or gcloud://active-user. Service-account key files are rejected."
          >
            {(hintId) => (
              <TextInput
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder="adc://default"
                aria-label="Injected credential reference"
                aria-describedby={hintId}
              />
            )}
          </Field>
          <Field
            label="Google Cloud project ID"
            hint="The project must be active and visible to the selected credential."
          >
            {(hintId) => (
              <TextInput
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="papercusp-prod"
                aria-label="Google Cloud project ID"
                aria-describedby={hintId}
              />
            )}
          </Field>
          <Field
            label="Runtime service account email"
            hint="This identity is attached to the host VM; no key material is stored."
          >
            {(hintId) => (
              <TextInput
                value={serviceAccountEmail}
                onChange={(event) => setServiceAccountEmail(event.target.value)}
                placeholder="papercusp-host@papercusp-prod.iam.gserviceaccount.com"
                aria-label="Runtime service account email"
                aria-describedby={hintId}
              />
            )}
          </Field>
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeConnectionModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                !connectTarget ||
                connectTarget !== "gcp" ||
                !connectionLabel.trim() ||
                !credentialRef.trim() ||
                !projectId.trim() ||
                !serviceAccountEmail.trim() ||
                busyKeys.has("connect")
              }
              onClick={() => {
                if (!connectTarget) return;
                void perform(
                  "connect",
                  {
                    action: "connect",
                    target: connectTarget,
                    label: connectionLabel.trim(),
                    credentialRef: credentialRef.trim(),
                    projectId: projectId.trim(),
                    serviceAccountEmail: serviceAccountEmail.trim(),
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
        title={`Destroy ${destroyWorkspace?.name ?? "workspace"}`}
        description="Choose and record the recoverability disposition before any provider resource is deleted."
        contentClassName={styles.modal}
        closeOnOutsideClick={false}
      >
        <div className={styles.modalBody}>
          <div className={styles.dangerNotice}>
            <AlertTriangle size={18} aria-hidden="true" />
            Destroy is asynchronous. Completion requires a provider read
            confirming every resource is absent.
          </div>
          <div
            className={styles.dispositionGroup}
            role="radiogroup"
            aria-label="Recoverability disposition"
          >
            {DESTROY_DISPOSITIONS.map(({ value, label, detail }, index) => (
              <button
                type="button"
                role="radio"
                aria-checked={disposition === value}
                className={styles.disposition}
                data-selected={disposition === value ? "true" : "false"}
                key={value}
                ref={(node) => {
                  dispositionButtonsRef.current[index] = node;
                }}
                tabIndex={disposition === value ? 0 : -1}
                onClick={() => void setDisposition(value)}
                onKeyDown={(event) => handleDispositionKeyDown(event, index)}
              >
                <strong>{label}</strong>
                <span>{detail}</span>
              </button>
            ))}
          </div>
          {disposition === "discard" && destroyWorkspace ? (
            <Field label={`Type “${destroyWorkspace.name}” to confirm discard`}>
              <TextInput
                value={destroyConfirm}
                onChange={(event) => setDestroyConfirm(event.target.value)}
                aria-label={`Type ${destroyWorkspace.name} to confirm discard`}
              />
            </Field>
          ) : null}
          <p
            id="destroy-admission-blocker"
            className={styles.provisionBlockers}
            role="status"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              <strong>Audited canary evidence required</strong>
              <span>
                Final destroy stays disabled here until the host canary workflow
                supplies its approved contract, cost, and teardown evidence.
              </span>
            </span>
          </p>
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeDestroyModal}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled
              aria-describedby="destroy-admission-blocker"
            >
              <Trash2 size={14} aria-hidden="true" /> Confirm destroy
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
