import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";
import type {
  AgentCredentialRef,
  CloudCredentialRef,
  GitCredentialRef,
  WorkspaceHostCredentialRefs,
} from "./workspace-host-types";

/** Persisted, provider-neutral contract for work performed after host bootstrap. */
export const WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION =
  "papercusp-workspace-host-initialization-v1";

export const WORKSPACE_HOST_CREDENTIAL_CHANNELS = [
  "cloud",
  "git",
  "agent",
] as const;
export type WorkspaceHostCredentialChannel =
  (typeof WORKSPACE_HOST_CREDENTIAL_CHANNELS)[number];

export const WORKSPACE_HOST_IMPORT_UNITS = [
  "repositories",
  "files",
  "database",
  "transcripts",
  "agents",
] as const;
export type WorkspaceHostImportUnit =
  (typeof WORKSPACE_HOST_IMPORT_UNITS)[number];

export type WorkspaceHostCredentialDeliveryKind =
  | "provider-identity"
  | "forwarded-agent"
  | "short-lived-delegation"
  | "encrypted-reference";

/**
 * Public binding metadata only. The resolver named by the typed credential
 * reference delivers the actual authorization material out of band.
 */
export interface WorkspaceHostCredentialDelivery {
  kind: WorkspaceHostCredentialDeliveryKind;
  generation: number;
  audience: string;
  revocationRef: string;
  expiresAt?: string;
}

export interface WorkspaceHostCredentialDeliverySet {
  cloud: WorkspaceHostCredentialDelivery;
  git?: WorkspaceHostCredentialDelivery;
  agent?: WorkspaceHostCredentialDelivery;
}

export interface WorkspaceHostPairingReference {
  readonly kind: "pairing";
  readonly ref: string;
}

export type WorkspaceHostInitializationSource =
  | { kind: "empty" }
  | {
      kind: "git";
      repositoryUrl: string;
      visibility: "public" | "private";
      destination: string;
      revision?: string;
    }
  | {
      kind: "pair";
      sourceWorkspaceId: string;
      pairingReference: WorkspaceHostPairingReference;
      /** Explicit projection exposed through the pair; never an implicit whole-workspace share. */
      include: readonly WorkspaceHostImportUnit[];
    }
  | {
      kind: "import";
      sourceWorkspaceId: string;
      sourceSnapshotRef: string;
      /** Explicit copy allowlist; omitted state remains absent on the destination. */
      include: readonly WorkspaceHostImportUnit[];
    };

export interface WorkspaceHostInitializationRequest {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
  source: WorkspaceHostInitializationSource;
  credentialRefs: WorkspaceHostCredentialRefs;
  credentialDelivery: WorkspaceHostCredentialDeliverySet;
  /** Persistable labels only. */
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export type WorkspaceHostInitializationStepKind =
  | "create-workspace"
  | "clone-repository"
  | "pair-workspace"
  | "import-workspace"
  | "bind-credential"
  | "verify-initialization";

export interface WorkspaceHostInitializationStep {
  id: string;
  kind: WorkspaceHostInitializationStepKind;
  dependsOn: readonly string[];
  idempotencyKey: string;
  input: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostInitializationPlan {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
  steps: readonly WorkspaceHostInitializationStep[];
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostInitializationStepReceipt {
  stepId: string;
  status: "succeeded";
  observedAt: string;
  /** Structured, redacted evidence. Raw stdout/stderr and resolved authorization are forbidden. */
  publicEvidence?: Readonly<Record<string, unknown>>;
}

/** Host adapter seam: DBOS/provider controllers execute one persisted step at a time. */
export interface WorkspaceHostInitializationExecutor {
  execute(
    step: WorkspaceHostInitializationStep,
  ): Promise<WorkspaceHostInitializationStepReceipt>;
}

type AnyCredentialRef =
  | CloudCredentialRef
  | GitCredentialRef
  | AgentCredentialRef;

interface CredentialBinding {
  channel: WorkspaceHostCredentialChannel;
  credentialRef: AnyCredentialRef;
  delivery: WorkspaceHostCredentialDelivery;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function requireId(value: string, label: string): void {
  requireCondition(SAFE_ID.test(value), `${label} must be a stable identifier`);
}

function requireTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  requireCondition(
    Number.isFinite(timestamp),
    `${label} must be an ISO timestamp`,
  );
  return timestamp;
}

function requireReference(value: string, label: string): void {
  requireCondition(
    value.trim().length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value),
    `${label} must be a non-empty resolver reference`,
  );
}

function requireRelativePath(value: string, label: string): void {
  requireCondition(
    SAFE_RELATIVE_PATH.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    `${label} must be a safe relative workspace path`,
  );
}

function requireRepositoryUrl(value: string): void {
  const scpStyle = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(
    value,
  );
  if (scpStyle) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "source.repositoryUrl must be an HTTPS, SSH, or git@ repository URL",
    );
  }
  requireCondition(
    parsed.protocol === "https:" || parsed.protocol === "ssh:",
    "source.repositoryUrl must use HTTPS or SSH",
  );
  requireCondition(
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash,
    "source.repositoryUrl must not contain credentials, query parameters, or fragments",
  );
}

function validateImportSelection(
  include: readonly WorkspaceHostImportUnit[],
  label: string,
): void {
  requireCondition(
    include.length > 0,
    `${label} must explicitly select at least one unit`,
  );
  requireCondition(
    new Set(include).size === include.length,
    `${label} must not contain duplicate units`,
  );
  for (const unit of include) {
    requireCondition(
      (WORKSPACE_HOST_IMPORT_UNITS as readonly string[]).includes(unit),
      `${label} contains unsupported unit '${unit}'`,
    );
  }
}

function bindings(
  refs: WorkspaceHostCredentialRefs,
  delivery: WorkspaceHostCredentialDeliverySet,
): CredentialBinding[] {
  const result: CredentialBinding[] = [
    {
      channel: "cloud",
      credentialRef: refs.cloudCredentialRef,
      delivery: delivery.cloud,
    },
  ];
  if (refs.gitCredentialRef && delivery.git) {
    result.push({
      channel: "git",
      credentialRef: refs.gitCredentialRef,
      delivery: delivery.git,
    });
  }
  if (refs.agentCredentialRef && delivery.agent) {
    result.push({
      channel: "agent",
      credentialRef: refs.agentCredentialRef,
      delivery: delivery.agent,
    });
  }
  return result;
}

const ALLOWED_DELIVERY: Readonly<
  Record<
    WorkspaceHostCredentialChannel,
    readonly WorkspaceHostCredentialDeliveryKind[]
  >
> = {
  cloud: ["provider-identity", "short-lived-delegation", "encrypted-reference"],
  git: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"],
  agent: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"],
};

function validateCredentialSet(
  refs: WorkspaceHostCredentialRefs,
  delivery: WorkspaceHostCredentialDeliverySet,
  requestedAt: string,
): CredentialBinding[] {
  requireCondition(
    refs.cloudCredentialRef?.kind === "cloud",
    "cloudCredentialRef must be a typed cloud reference",
  );
  requireCondition(
    refs.gitCredentialRef?.kind !== "git" ? !refs.gitCredentialRef : true,
    "gitCredentialRef must be a typed Git reference",
  );
  requireCondition(
    refs.agentCredentialRef?.kind !== "agent" ? !refs.agentCredentialRef : true,
    "agentCredentialRef must be a typed agent reference",
  );
  requireCondition(
    Boolean(refs.gitCredentialRef) === Boolean(delivery.git),
    "gitCredentialRef and credentialDelivery.git must be supplied together",
  );
  requireCondition(
    Boolean(refs.agentCredentialRef) === Boolean(delivery.agent),
    "agentCredentialRef and credentialDelivery.agent must be supplied together",
  );

  const requestedAtMs = requireTimestamp(requestedAt, "requestedAt");
  const resolved = bindings(refs, delivery);
  const seenRefs = new Set<string>();
  const seenRevocationRefs = new Set<string>();
  for (const binding of resolved) {
    requireCondition(
      binding.credentialRef.kind === binding.channel,
      `${binding.channel} credential reference kind does not match its channel`,
    );
    requireReference(
      binding.credentialRef.ref,
      `${binding.channel}CredentialRef.ref`,
    );
    requireCondition(
      !seenRefs.has(binding.credentialRef.ref),
      "cloud, Git, and agent credential references must be distinct",
    );
    seenRefs.add(binding.credentialRef.ref);
    requireCondition(
      ALLOWED_DELIVERY[binding.channel].includes(binding.delivery.kind),
      `credentialDelivery.${binding.channel}.kind is not allowed for that channel`,
    );
    requireCondition(
      Number.isSafeInteger(binding.delivery.generation) &&
        binding.delivery.generation >= 1,
      `credentialDelivery.${binding.channel}.generation must be a positive safe integer`,
    );
    requireId(
      binding.delivery.audience,
      `credentialDelivery.${binding.channel}.audience`,
    );
    requireReference(
      binding.delivery.revocationRef,
      `credentialDelivery.${binding.channel}.revocationRef`,
    );
    requireCondition(
      !seenRevocationRefs.has(binding.delivery.revocationRef),
      "cloud, Git, and agent revocation references must be distinct",
    );
    seenRevocationRefs.add(binding.delivery.revocationRef);
    if (binding.delivery.kind === "short-lived-delegation") {
      requireCondition(
        typeof binding.delivery.expiresAt === "string",
        `credentialDelivery.${binding.channel}.expiresAt is required for short-lived delegation`,
      );
      requireCondition(
        requireTimestamp(
          binding.delivery.expiresAt!,
          `credentialDelivery.${binding.channel}.expiresAt`,
        ) > requestedAtMs,
        `credentialDelivery.${binding.channel}.expiresAt must be after requestedAt`,
      );
    }
  }
  assertWorkspaceHostSecretIsolation(
    { refs, delivery },
    "workspaceHost.credentialBindings",
  );
  return resolved;
}

function validateSource(
  source: WorkspaceHostInitializationSource,
  refs: WorkspaceHostCredentialRefs,
): void {
  if (source.kind === "empty") return;
  if (source.kind === "git") {
    requireRepositoryUrl(source.repositoryUrl);
    requireRelativePath(source.destination, "source.destination");
    if (source.revision) {
      requireCondition(
        SAFE_REVISION.test(source.revision),
        "source.revision must be a safe Git revision",
      );
    }
    requireCondition(
      source.visibility !== "private" || Boolean(refs.gitCredentialRef),
      "A private repository requires gitCredentialRef",
    );
    return;
  }
  requireId(source.sourceWorkspaceId, "source.sourceWorkspaceId");
  validateImportSelection(source.include, "source.include");
  if (source.kind === "pair") {
    requireCondition(
      source.pairingReference.kind === "pairing",
      "source.pairingReference must be a typed pairing reference",
    );
    requireReference(
      source.pairingReference.ref,
      "source.pairingReference.ref",
    );
  } else {
    requireReference(source.sourceSnapshotRef, "source.sourceSnapshotRef");
  }
}

function initStep(
  request: WorkspaceHostInitializationRequest,
  id: string,
  kind: WorkspaceHostInitializationStepKind,
  dependsOn: readonly string[],
  input: Readonly<Record<string, unknown>>,
): WorkspaceHostInitializationStep {
  return {
    id,
    kind,
    dependsOn,
    idempotencyKey: `workspace-init:${request.operationId}:${id}`,
    input,
  };
}

/** Build a deterministic, persistable post-bootstrap plan. */
export function planWorkspaceHostInitialization(
  request: WorkspaceHostInitializationRequest,
): WorkspaceHostInitializationPlan {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`,
  );
  requireId(request.operationId, "operationId");
  requireId(request.workspaceId, "workspaceId");
  requireId(request.hostId, "hostId");
  requireTimestamp(request.requestedAt, "requestedAt");
  validateSource(request.source, request.credentialRefs);
  const credentialBindings = validateCredentialSet(
    request.credentialRefs,
    request.credentialDelivery,
    request.requestedAt,
  );
  assertWorkspaceHostSecretIsolation(
    request.publicMetadata ?? {},
    "workspaceHost.initialization.publicMetadata",
  );

  const steps: WorkspaceHostInitializationStep[] = [
    initStep(request, "workspace", "create-workspace", [], {
      workspaceId: request.workspaceId,
      hostId: request.hostId,
    }),
  ];
  const bindingStepIds = credentialBindings.map(
    (binding) => `bind-${binding.channel}`,
  );
  const addBindingStep = (
    binding: CredentialBinding,
    dependsOn: readonly string[],
  ): void => {
    const id = `bind-${binding.channel}`;
    steps.push(
      initStep(request, id, "bind-credential", dependsOn, {
        channel: binding.channel,
        credentialRef: binding.credentialRef,
        delivery: binding.delivery,
      }),
    );
  };
  const privateGitBinding =
    request.source.kind === "git" && request.source.visibility === "private"
      ? credentialBindings.find((binding) => binding.channel === "git")
      : undefined;
  if (privateGitBinding) {
    addBindingStep(privateGitBinding, ["workspace"]);
  }

  let sourceStepId = "workspace";
  if (request.source.kind !== "empty") {
    const kind =
      request.source.kind === "git"
        ? "clone-repository"
        : request.source.kind === "pair"
          ? "pair-workspace"
          : "import-workspace";
    sourceStepId = "source";
    steps.push(
      initStep(
        request,
        sourceStepId,
        kind,
        privateGitBinding ? ["bind-git"] : ["workspace"],
        request.source.kind === "git" && request.source.visibility === "private"
          ? { ...request.source, credentialChannel: "git" }
          : { ...request.source },
      ),
    );
  }

  for (const binding of credentialBindings) {
    if (binding === privateGitBinding) continue;
    addBindingStep(binding, [sourceStepId]);
  }
  steps.push(
    initStep(request, "verify", "verify-initialization", bindingStepIds, {
      sourceKind: request.source.kind,
      requiredChannels: credentialBindings.map((binding) => binding.channel),
    }),
  );

  const plan: WorkspaceHostInitializationPlan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    requestedAt: request.requestedAt,
    steps,
    ...(request.publicMetadata
      ? { publicMetadata: request.publicMetadata }
      : {}),
  };
  assertWorkspaceHostSecretIsolation(plan, "workspaceHost.initialization.plan");
  return plan;
}

/** Execute a plan through the existing durable host controller's injected adapter seam. */
export async function executeWorkspaceHostInitialization(
  plan: WorkspaceHostInitializationPlan,
  executor: WorkspaceHostInitializationExecutor,
): Promise<readonly WorkspaceHostInitializationStepReceipt[]> {
  assertWorkspaceHostSecretIsolation(plan, "workspaceHost.initialization.plan");
  const completed = new Set<string>();
  const receipts: WorkspaceHostInitializationStepReceipt[] = [];
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      requireCondition(
        completed.has(dependency),
        `Initialization step '${step.id}' dependency '${dependency}' has not completed`,
      );
    }
    const receipt = await executor.execute(step);
    requireCondition(
      receipt.stepId === step.id && receipt.status === "succeeded",
      `Initialization step '${step.id}' returned an invalid receipt`,
    );
    requireTimestamp(receipt.observedAt, `receipt.${step.id}.observedAt`);
    assertWorkspaceHostSecretIsolation(
      receipt.publicEvidence ?? {},
      `workspaceHost.initialization.receipt.${step.id}`,
    );
    receipts.push(receipt);
    completed.add(step.id);
  }
  return receipts;
}

export interface WorkspaceHostBackupCredentialManifest {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  workspaceId: string;
  capturedAt: string;
  authorizationMaterial: "excluded";
  credentialReferences: "excluded";
  rebindRequired: readonly WorkspaceHostCredentialChannel[];
}

/**
 * Backups remember only which runtime channels must be rebound. Neither
 * resolved authorization nor credential-reference locations enter the backup.
 */
export function buildWorkspaceHostBackupCredentialManifest(
  workspaceId: string,
  capturedAt: string,
  refs: WorkspaceHostCredentialRefs,
): WorkspaceHostBackupCredentialManifest {
  requireId(workspaceId, "workspaceId");
  requireTimestamp(capturedAt, "capturedAt");
  const rebindRequired: WorkspaceHostCredentialChannel[] = ["cloud"];
  if (refs.gitCredentialRef) rebindRequired.push("git");
  if (refs.agentCredentialRef) rebindRequired.push("agent");
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId,
    capturedAt,
    authorizationMaterial: "excluded",
    credentialReferences: "excluded",
    rebindRequired,
  };
}

interface WorkspaceHostCredentialLifecycleBase {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  requestedAt: string;
}

export type WorkspaceHostCredentialLifecycleRequest =
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "rotate";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
      nextCredentialRefs: WorkspaceHostCredentialRefs;
      nextDelivery: WorkspaceHostCredentialDeliverySet;
    })
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "revoke";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
      channels: readonly WorkspaceHostCredentialChannel[];
    })
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "reconnect";
      currentCredentialRefs: WorkspaceHostCredentialRefs;
      currentDelivery: WorkspaceHostCredentialDeliverySet;
    })
  | (WorkspaceHostCredentialLifecycleBase & {
      action: "restore-rebind";
      backup: WorkspaceHostBackupCredentialManifest;
      nextCredentialRefs: WorkspaceHostCredentialRefs;
      nextDelivery: WorkspaceHostCredentialDeliverySet;
    });

export type WorkspaceHostCredentialLifecycleStepKind =
  | "bind"
  | "verify-bound"
  | "revoke"
  | "verify-revoked";

export interface WorkspaceHostCredentialLifecycleStep {
  id: string;
  kind: WorkspaceHostCredentialLifecycleStepKind;
  channel: WorkspaceHostCredentialChannel;
  dependsOn: readonly string[];
  idempotencyKey: string;
  credentialRef: AnyCredentialRef;
  /** Public resolver metadata required for binding and revocation. */
  delivery: WorkspaceHostCredentialDelivery;
}

export interface WorkspaceHostCredentialLifecyclePlan {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  operationId: string;
  workspaceId: string;
  hostId: string;
  action: WorkspaceHostCredentialLifecycleRequest["action"];
  requestedAt: string;
  steps: readonly WorkspaceHostCredentialLifecycleStep[];
}

function lifecycleStep(
  request: WorkspaceHostCredentialLifecycleRequest,
  id: string,
  kind: WorkspaceHostCredentialLifecycleStepKind,
  binding: CredentialBinding,
  dependsOn: readonly string[],
): WorkspaceHostCredentialLifecycleStep {
  return {
    id,
    kind,
    channel: binding.channel,
    dependsOn,
    idempotencyKey: `workspace-credential:${request.operationId}:${id}`,
    credentialRef: binding.credentialRef,
    delivery: binding.delivery,
  };
}

function validateLifecycleBase(
  request: WorkspaceHostCredentialLifecycleRequest,
): void {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`,
  );
  requireId(request.operationId, "operationId");
  requireId(request.workspaceId, "workspaceId");
  requireId(request.hostId, "hostId");
  requireTimestamp(request.requestedAt, "requestedAt");
}

function sameChannels(
  a: readonly WorkspaceHostCredentialChannel[],
  b: readonly WorkspaceHostCredentialChannel[],
): boolean {
  return a.length === b.length && a.every((channel) => b.includes(channel));
}

/**
 * Plan rotation/revocation/reconnect/restore rebinding without ever persisting
 * resolved authorization. Rotation verifies the replacement before revoking
 * the previous binding; restore starts from a reference-free backup manifest.
 */
export function planWorkspaceHostCredentialLifecycle(
  request: WorkspaceHostCredentialLifecycleRequest,
): WorkspaceHostCredentialLifecyclePlan {
  validateLifecycleBase(request);
  const steps: WorkspaceHostCredentialLifecycleStep[] = [];
  let tail: string[] = [];

  if (request.action === "rotate") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
    );
    const next = validateCredentialSet(
      request.nextCredentialRefs,
      request.nextDelivery,
      request.requestedAt,
    );
    requireCondition(
      sameChannels(
        current.map((entry) => entry.channel),
        next.map((entry) => entry.channel),
      ),
      "Rotation must replace every currently bound credential channel",
    );
    for (const replacement of next) {
      const previous = current.find(
        (entry) => entry.channel === replacement.channel,
      )!;
      requireCondition(
        replacement.delivery.generation > previous.delivery.generation,
        `Rotation generation for ${replacement.channel} must increase`,
      );
      requireCondition(
        replacement.delivery.revocationRef !== previous.delivery.revocationRef,
        `Rotation revocation reference for ${replacement.channel} must change`,
      );
      const bindId = `bind-next-${replacement.channel}`;
      const verifyId = `verify-next-${replacement.channel}`;
      const revokeId = `revoke-previous-${replacement.channel}`;
      const revokedId = `verify-revoked-${replacement.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", replacement, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", replacement, [bindId]),
      );
      steps.push(
        lifecycleStep(request, revokeId, "revoke", previous, [verifyId]),
      );
      steps.push(
        lifecycleStep(request, revokedId, "verify-revoked", previous, [
          revokeId,
        ]),
      );
      tail = [revokedId];
    }
  } else if (request.action === "revoke") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
    );
    requireCondition(
      request.channels.length > 0 &&
        new Set(request.channels).size === request.channels.length,
      "Revocation channels must be a non-empty unique list",
    );
    for (const channel of request.channels) {
      const binding = current.find((entry) => entry.channel === channel);
      requireCondition(binding, `Cannot revoke unbound ${channel} channel`);
      const revokeId = `revoke-${channel}`;
      const verifyId = `verify-revoked-${channel}`;
      steps.push(lifecycleStep(request, revokeId, "revoke", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-revoked", binding, [revokeId]),
      );
      tail = [verifyId];
    }
  } else {
    const refs =
      request.action === "restore-rebind"
        ? request.nextCredentialRefs
        : request.currentCredentialRefs;
    const delivery =
      request.action === "restore-rebind"
        ? request.nextDelivery
        : request.currentDelivery;
    const current = validateCredentialSet(refs, delivery, request.requestedAt);
    if (request.action === "restore-rebind") {
      requireCondition(
        request.backup.contractVersion ===
          WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION &&
          request.backup.workspaceId === request.workspaceId &&
          request.backup.authorizationMaterial === "excluded" &&
          request.backup.credentialReferences === "excluded",
        "Restore requires a matching credential-free backup manifest",
      );
      requireCondition(
        sameChannels(
          request.backup.rebindRequired,
          current.map((entry) => entry.channel),
        ),
        "Restore must rebind every channel named by the backup manifest",
      );
    }
    for (const binding of current) {
      const bindId = `bind-${binding.channel}`;
      const verifyId = `verify-${binding.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", binding, [bindId]),
      );
      tail = [verifyId];
    }
  }

  const plan: WorkspaceHostCredentialLifecyclePlan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    action: request.action,
    requestedAt: request.requestedAt,
    steps,
  };
  assertWorkspaceHostSecretIsolation(
    plan,
    "workspaceHost.credentialLifecycle.plan",
  );
  return plan;
}

export interface WorkspaceHostInitializationCanaryEvidence {
  contractVersion: typeof WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION;
  kind: "live";
  runId: string;
  workspaceId: string;
  hostId: string;
  observedAt: string;
  repository: { visibility: "private"; cloned: true };
  channels: Readonly<
    Record<
      WorkspaceHostCredentialChannel,
      {
        bound: true;
        rotated: true;
        previousBindingRevoked: true;
        reconnected: true;
      }
    >
  >;
  agents: Readonly<Record<"claude" | "codex" | "omp", { authenticated: true }>>;
  backupRestore: {
    authorizationMaterial: "excluded";
    credentialReferences: "excluded";
    reboundChannels: readonly WorkspaceHostCredentialChannel[];
  };
}

export interface WorkspaceHostInitializationCanaryValidation {
  ok: boolean;
  errors: readonly string[];
}

/** Validate only structured, non-secret evidence from a real host canary. */
export function validateWorkspaceHostInitializationCanary(
  evidence: WorkspaceHostInitializationCanaryEvidence,
): WorkspaceHostInitializationCanaryValidation {
  const errors: string[] = [];
  try {
    assertWorkspaceHostSecretIsolation(
      evidence,
      "workspaceHost.initialization.canary",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (
    evidence.contractVersion !== WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION
  ) {
    errors.push("canary contract version mismatch");
  }
  if (evidence.kind !== "live")
    errors.push("canary evidence must come from a live host");
  for (const [value, label] of [
    [evidence.runId, "runId"],
    [evidence.workspaceId, "workspaceId"],
    [evidence.hostId, "hostId"],
  ] as const) {
    if (!SAFE_ID.test(value))
      errors.push(`canary ${label} must be a stable identifier`);
  }
  if (!Number.isFinite(Date.parse(evidence.observedAt))) {
    errors.push("canary observedAt must be an ISO timestamp");
  }
  if (
    evidence.repository?.visibility !== "private" ||
    !evidence.repository.cloned
  ) {
    errors.push("private-repository clone did not pass");
  }
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const result = evidence.channels?.[channel];
    if (
      !result?.bound ||
      !result.rotated ||
      !result.previousBindingRevoked ||
      !result.reconnected
    ) {
      errors.push(`${channel} credential lifecycle did not pass`);
    }
  }
  for (const agent of ["claude", "codex", "omp"] as const) {
    if (!evidence.agents?.[agent]?.authenticated) {
      errors.push(`${agent} live authentication did not pass`);
    }
  }
  if (
    evidence.backupRestore?.authorizationMaterial !== "excluded" ||
    evidence.backupRestore?.credentialReferences !== "excluded"
  ) {
    errors.push("backup retained credential authorization or references");
  }
  if (
    !sameChannels(
      evidence.backupRestore?.reboundChannels ?? [],
      WORKSPACE_HOST_CREDENTIAL_CHANNELS,
    )
  ) {
    errors.push("restore did not rebind all credential channels");
  }
  return { ok: errors.length === 0, errors };
}
