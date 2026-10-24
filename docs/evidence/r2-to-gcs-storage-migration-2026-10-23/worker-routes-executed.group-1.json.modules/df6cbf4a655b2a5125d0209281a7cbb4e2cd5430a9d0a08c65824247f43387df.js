'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_CHANNELS", () => { try { return WORKSPACE_HOST_CREDENTIAL_CHANNELS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_IMPORT_UNITS", () => { try { return WORKSPACE_HOST_IMPORT_UNITS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY", () => { try { return WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialDeliveryCapabilityError", () => { try { return WorkspaceHostCredentialDeliveryCapabilityError } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_INITIALIZATION_STEP_KINDS", () => { try { return WORKSPACE_HOST_INITIALIZATION_STEP_KINDS } catch {} });
__vite_ssr_exportName__("workspaceHostInitializationStepFingerprint", () => { try { return workspaceHostInitializationStepFingerprint } catch {} });
__vite_ssr_exportName__("ReplaySafeWorkspaceHostInitializationExecutor", () => { try { return ReplaySafeWorkspaceHostInitializationExecutor } catch {} });
__vite_ssr_exportName__("planWorkspaceHostInitialization", () => { try { return planWorkspaceHostInitialization } catch {} });
__vite_ssr_exportName__("executeWorkspaceHostInitialization", () => { try { return executeWorkspaceHostInitialization } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostBackupCredentialManifest", () => { try { return buildWorkspaceHostBackupCredentialManifest } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS", () => { try { return WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostBackupRestoreCredentialRebindRequest", () => { try { return buildWorkspaceHostBackupRestoreCredentialRebindRequest } catch {} });
__vite_ssr_exportName__("planWorkspaceHostCredentialLifecycle", () => { try { return planWorkspaceHostCredentialLifecycle } catch {} });
__vite_ssr_exportName__("validateWorkspaceHostInitializationCanary", () => { try { return validateWorkspaceHostInitializationCanary } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-agent-authentication.ts", {"importedNames":["resolveWorkspaceHostRequestedAgents","workspaceHostAgentVerificationKindIsAllowed"]});



const WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION = "papercusp-workspace-host-initialization-v1";
const WORKSPACE_HOST_CREDENTIAL_CHANNELS = [
  "cloud",
  "git",
  "agent"
];
const WORKSPACE_HOST_IMPORT_UNITS = [
  "repositories",
  "files",
  "database",
  "transcripts",
  "agents"
];
const WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY = Object.freeze(["agent", "git"]);
class WorkspaceHostCredentialDeliveryCapabilityError extends Error {
  channel;
  capability = "fileTransfer";
  constructor(channel) {
    super(
      `The ${channel} credential channel requires delivered material on the host, but this provider's transport declares fileTransfer: false. Refused at plan time: a running host would fail at bind with no way to distinguish a missing capability from a lost delivery.`
    );
    this.name = "WorkspaceHostCredentialDeliveryCapabilityError";
    this.channel = channel;
  }
};
const WORKSPACE_HOST_INITIALIZATION_STEP_KINDS = [
  "create-workspace",
  "verify-retained-workspace",
  "clone-repository",
  "pair-workspace",
  "import-workspace",
  "bind-credential",
  "verify-initialization"
];
function canonicalInitializationJson(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  };
  if (typeof value === "number") {
    requireCondition(
      Number.isFinite(value),
      `${path} must contain finite numbers`
    );
    return JSON.stringify(value);
  };
  if (Array.isArray(value)) {
    return `[${value.map(
      (entry, index) => canonicalInitializationJson(entry, `${path}[${index}]`)
    ).join(",")}]`;
  };
  requireCondition(
    typeof value === "object" && value !== void 0,
    `${path} must contain JSON-compatible values`
  );
  const prototype = Object.getPrototypeOf(value);
  requireCondition(
    prototype === Object.prototype || prototype === null,
    `${path} must contain plain JSON objects`
  );
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => {
    requireCondition(
      entry !== void 0,
      `${path}.${key} must not be undefined`
    );
    return `${JSON.stringify(key)}:${canonicalInitializationJson(entry, `${path}.${key}`)}`;
  }).join(",")}}`;
}
function workspaceHostInitializationStepFingerprint(step) {
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(step, "workspaceHost.initialization.step");
  return (0,__vite_ssr_import_0__.createHash)("sha256").update(
    canonicalInitializationJson(step, "workspaceHost.initialization.step"),
    "utf8"
  ).digest("hex");
};
class ReplaySafeWorkspaceHostInitializationExecutor {
  operations;
  replayStore;
  supportedStepKinds;
  constructor(deps) {
    requireCondition(
      deps.operations.supportedStepKinds.length > 0,
      "Workspace-host initialization operations must declare at least one supported step kind"
    );
    const supported = new Set(
      deps.operations.supportedStepKinds
    );
    requireCondition(
      supported.size === deps.operations.supportedStepKinds.length,
      "Workspace-host initialization operations must not declare duplicate step kinds"
    );
    for (const kind of supported) {
      requireCondition(
        WORKSPACE_HOST_INITIALIZATION_STEP_KINDS.includes(kind) || WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS.includes(kind),
        `Unsupported workspace-host initialization step kind '${kind}'`
      );
    };
    this.operations = deps.operations;
    this.replayStore = deps.replayStore;
    this.supportedStepKinds = supported;
  }
  async execute(step) {
    requireId(step.id, "step.id");
    requireReference(step.idempotencyKey, "step.idempotencyKey");
    requireCondition(
      this.supportedStepKinds.has(step.kind),
      `Workspace-host initialization operation '${step.kind}' is not supported by this adapter`
    );
    (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
      step,
      `workspaceHost.initialization.step.${step.id}`
    );
    const receipt = await this.replayStore.runOnce(
      {
        idempotencyKey: step.idempotencyKey,
        stepFingerprint: workspaceHostInitializationStepFingerprint(step)
      },
      async () => {
        const result = await this.operations.execute(step);
        requireTimestamp(result.observedAt, `receipt.${step.id}.observedAt`);
        (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
          result.publicEvidence ?? {},
          `workspaceHost.initialization.receipt.${step.id}`
        );
        return {
          stepId: step.id,
          status: "succeeded",
          observedAt: result.observedAt,
          ...result.publicEvidence ? { publicEvidence: result.publicEvidence } : {}
        };
      }
    );
    requireCondition(
      receipt.stepId === step.id && receipt.status === "succeeded",
      `Initialization replay for '${step.id}' returned an invalid receipt`
    );
    requireTimestamp(receipt.observedAt, `receipt.${step.id}.observedAt`);
    (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
      receipt.publicEvidence ?? {},
      `workspaceHost.initialization.receipt.${step.id}`
    );
    return receipt;
  }
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function requireId(value, label) {
  requireCondition(SAFE_ID.test(value), `${label} must be a stable identifier`);
}
function requireTimestamp(value, label) {
  const timestamp = Date.parse(value);
  requireCondition(
    Number.isFinite(timestamp),
    `${label} must be an ISO timestamp`
  );
  return timestamp;
}
function requireReference(value, label) {
  requireCondition(
    value.trim().length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value),
    `${label} must be a non-empty resolver reference`
  );
}
function requireRelativePath(value, label) {
  requireCondition(
    SAFE_RELATIVE_PATH.test(value) && !value.startsWith("/") && !value.split("/").some((part) => part === "." || part === ".."),
    `${label} must be a safe relative workspace path`
  );
}
function requireRepositoryUrl(value) {
  const scpStyle = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(
    value
  );
  if (scpStyle) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "source.repositoryUrl must be an HTTPS, SSH, or git@ repository URL"
    );
  };
  requireCondition(
    parsed.protocol === "https:" || parsed.protocol === "ssh:",
    "source.repositoryUrl must use HTTPS or SSH"
  );
  requireCondition(
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash,
    "source.repositoryUrl must not contain credentials, query parameters, or fragments"
  );
}
function validateImportSelection(include, label) {
  requireCondition(
    include.length > 0,
    `${label} must explicitly select at least one unit`
  );
  requireCondition(
    new Set(include).size === include.length,
    `${label} must not contain duplicate units`
  );
  for (const unit of include) {
    requireCondition(
      WORKSPACE_HOST_IMPORT_UNITS.includes(unit),
      `${label} contains unsupported unit '${unit}'`
    );
  }
}
function bindings(refs, delivery) {
  const result = [
    {
      channel: "cloud",
      credentialRef: refs.cloudCredentialRef,
      delivery: delivery.cloud
    }
  ];
  if (refs.gitCredentialRef && delivery.git) {
    result.push({
      channel: "git",
      credentialRef: refs.gitCredentialRef,
      delivery: delivery.git
    });
  };
  if (refs.agentCredentialRef && delivery.agent) {
    result.push({
      channel: "agent",
      credentialRef: refs.agentCredentialRef,
      delivery: delivery.agent
    });
  };
  return result;
}
const ALLOWED_DELIVERY = {
  cloud: ["provider-identity", "short-lived-delegation", "encrypted-reference"],
  git: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"],
  agent: ["forwarded-agent", "short-lived-delegation", "encrypted-reference"]
};
function requireDeliveryCapability(bindings2, capabilities) {
  requireCondition(
    typeof capabilities?.fileTransfer === "boolean",
    "deliveryCapabilities.fileTransfer must be declared"
  );
  if (capabilities.fileTransfer) return;
  for (const binding of bindings2) {
    if (WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY.includes(binding.channel)) {
      throw new WorkspaceHostCredentialDeliveryCapabilityError(binding.channel);
    }
  }
}
function validateCredentialSet(refs, delivery, requestedAt, capabilities) {
  requireCondition(
    refs.cloudCredentialRef?.kind === "cloud",
    "cloudCredentialRef must be a typed cloud reference"
  );
  requireCondition(
    refs.gitCredentialRef?.kind !== "git" ? !refs.gitCredentialRef : true,
    "gitCredentialRef must be a typed Git reference"
  );
  requireCondition(
    refs.agentCredentialRef?.kind !== "agent" ? !refs.agentCredentialRef : true,
    "agentCredentialRef must be a typed agent reference"
  );
  requireCondition(
    Boolean(refs.gitCredentialRef) === Boolean(delivery.git),
    "gitCredentialRef and credentialDelivery.git must be supplied together"
  );
  requireCondition(
    Boolean(refs.agentCredentialRef) === Boolean(delivery.agent),
    "agentCredentialRef and credentialDelivery.agent must be supplied together"
  );
  const requestedAtMs = requireTimestamp(requestedAt, "requestedAt");
  const resolved = bindings(refs, delivery);
  const seenRefs = /* @__PURE__ */ new Set();
  const seenRevocationRefs = /* @__PURE__ */ new Set();
  for (const binding of resolved) {
    requireCondition(
      binding.credentialRef.kind === binding.channel,
      `${binding.channel} credential reference kind does not match its channel`
    );
    requireReference(
      binding.credentialRef.ref,
      `${binding.channel}CredentialRef.ref`
    );
    requireCondition(
      !seenRefs.has(binding.credentialRef.ref),
      "cloud, Git, and agent credential references must be distinct"
    );
    seenRefs.add(binding.credentialRef.ref);
    requireCondition(
      ALLOWED_DELIVERY[binding.channel].includes(binding.delivery.kind),
      `credentialDelivery.${binding.channel}.kind is not allowed for that channel`
    );
    requireCondition(
      Number.isSafeInteger(binding.delivery.generation) && binding.delivery.generation >= 1,
      `credentialDelivery.${binding.channel}.generation must be a positive safe integer`
    );
    requireId(
      binding.delivery.audience,
      `credentialDelivery.${binding.channel}.audience`
    );
    requireReference(
      binding.delivery.revocationRef,
      `credentialDelivery.${binding.channel}.revocationRef`
    );
    requireCondition(
      !seenRevocationRefs.has(binding.delivery.revocationRef),
      "cloud, Git, and agent revocation references must be distinct"
    );
    seenRevocationRefs.add(binding.delivery.revocationRef);
    if (binding.delivery.kind === "short-lived-delegation") {
      requireCondition(
        typeof binding.delivery.expiresAt === "string",
        `credentialDelivery.${binding.channel}.expiresAt is required for short-lived delegation`
      );
      requireCondition(
        requireTimestamp(
          binding.delivery.expiresAt,
          `credentialDelivery.${binding.channel}.expiresAt`
        ) > requestedAtMs,
        `credentialDelivery.${binding.channel}.expiresAt must be after requestedAt`
      );
    }
  };
  if (capabilities) requireDeliveryCapability(resolved, capabilities);
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
    { refs, delivery },
    "workspaceHost.credentialBindings"
  );
  return resolved;
}
function validateSource(source, refs) {
  if (source.kind === "empty") return;
  if (source.kind === "retained") {
    requireCondition(/^[a-f0-9]{64}$/.test(source.tenantIdentity), "source.tenantIdentity must be a SHA256 tenant identity");
    return;
  };
  if (source.kind === "git") {
    requireRepositoryUrl(source.repositoryUrl);
    requireRelativePath(source.destination, "source.destination");
    if (source.revision) {
      requireCondition(
        SAFE_REVISION.test(source.revision),
        "source.revision must be a safe Git revision"
      );
    };
    requireCondition(
      source.visibility !== "private" || Boolean(refs.gitCredentialRef),
      "A private repository requires gitCredentialRef"
    );
    return;
  };
  requireId(source.sourceWorkspaceId, "source.sourceWorkspaceId");
  validateImportSelection(source.include, "source.include");
  if (source.kind === "pair") {
    requireCondition(
      source.pairingReference.kind === "pairing",
      "source.pairingReference must be a typed pairing reference"
    );
    requireReference(
      source.pairingReference.ref,
      "source.pairingReference.ref"
    );
  } else {
    requireReference(source.sourceSnapshotRef, "source.sourceSnapshotRef");
  }
}
function initStep(request, id, kind, dependsOn, input) {
  return {
    id,
    kind,
    dependsOn,
    idempotencyKey: `workspace-init:${request.operationId}:${id}`,
    input
  };
}
function planWorkspaceHostInitialization(request) {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`
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
    request.deliveryCapabilities
  );
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
    request.publicMetadata ?? {},
    "workspaceHost.initialization.publicMetadata"
  );
  const steps = [
    initStep(request, "workspace", request.source.kind === "retained" ? "verify-retained-workspace" : "create-workspace", [], {
      workspaceId: request.workspaceId,
      hostId: request.hostId,
      ...request.source.kind === "retained" ? { tenantIdentity: request.source.tenantIdentity } : {}
    })
  ];
  const bindingStepIds = credentialBindings.map(
    (binding) => `bind-${binding.channel}`
  );
  const addBindingStep = (binding, dependsOn) => {
    const id = `bind-${binding.channel}`;
    steps.push(
      initStep(request, id, "bind-credential", dependsOn, {
        channel: binding.channel,
        credentialRef: binding.credentialRef,
        delivery: binding.delivery
      })
    );
  };
  const privateGitBinding = request.source.kind === "git" && request.source.visibility === "private" ? credentialBindings.find((binding) => binding.channel === "git") : void 0;
  if (privateGitBinding) {
    addBindingStep(privateGitBinding, ["workspace"]);
  };
  let sourceStepId = "workspace";
  if (request.source.kind !== "empty" && request.source.kind !== "retained") {
    const kind = request.source.kind === "git" ? "clone-repository" : request.source.kind === "pair" ? "pair-workspace" : "import-workspace";
    sourceStepId = "source";
    steps.push(
      initStep(
        request,
        sourceStepId,
        kind,
        privateGitBinding ? ["bind-git"] : ["workspace"],
        request.source.kind === "git" && request.source.visibility === "private" ? { ...request.source, credentialChannel: "git" } : { ...request.source }
      )
    );
  };
  for (const binding of credentialBindings) {
    if (binding === privateGitBinding) continue;
    addBindingStep(binding, [sourceStepId]);
  };
  steps.push(
    initStep(request, "verify", "verify-initialization", bindingStepIds, {
      sourceKind: request.source.kind,
      ...request.requestedAgents !== void 0 ? { requestedAgents: (0,__vite_ssr_import_2__.resolveWorkspaceHostRequestedAgents)(request.requestedAgents) } : {},
      requiredChannels: credentialBindings.map((binding) => binding.channel),
      ...request.source.kind === "git" ? {
        repository: {
          destination: request.source.destination,
          visibility: request.source.visibility
        }
      } : {}
    })
  );
  const plan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    requestedAt: request.requestedAt,
    steps,
    ...request.publicMetadata ? { publicMetadata: request.publicMetadata } : {}
  };
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(plan, "workspaceHost.initialization.plan");
  return plan;
};
async function executeWorkspaceHostInitialization(plan, executor) {
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(plan, "workspaceHost.initialization.plan");
  const completed = /* @__PURE__ */ new Set();
  const receipts = [];
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      requireCondition(
        completed.has(dependency),
        `Initialization step '${step.id}' dependency '${dependency}' has not completed`
      );
    };
    const receipt = await executor.execute(step);
    requireCondition(
      receipt.stepId === step.id && receipt.status === "succeeded",
      `Initialization step '${step.id}' returned an invalid receipt`
    );
    requireTimestamp(receipt.observedAt, `receipt.${step.id}.observedAt`);
    (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
      receipt.publicEvidence ?? {},
      `workspaceHost.initialization.receipt.${step.id}`
    );
    receipts.push(receipt);
    completed.add(step.id);
  };
  return receipts;
};
function buildWorkspaceHostBackupCredentialManifest(workspaceId, capturedAt, refs, delivery) {
  requireId(workspaceId, "workspaceId");
  const current = validateCredentialSet(refs, delivery, capturedAt, null);
  const manifest = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId,
    capturedAt,
    authorizationMaterial: "excluded",
    credentialReferences: "excluded",
    rebindRequired: current.map((binding) => binding.channel),
    bindingState: current.map((binding) => ({
      channel: binding.channel,
      generation: binding.delivery.generation,
      revocationRefSha256: (0,__vite_ssr_import_0__.createHash)("sha256").update(binding.delivery.revocationRef, "utf8").digest("hex")
    }))
  };
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
    manifest,
    "workspaceHost.backupCredentialManifest"
  );
  return manifest;
};
const WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS = [
  "bind",
  "verify-bound",
  "revoke",
  "verify-revoked"
];
function lifecycleStep(request, id, kind, binding, dependsOn) {
  return {
    id,
    kind,
    channel: binding.channel,
    dependsOn,
    idempotencyKey: `workspace-credential:${request.operationId}:${id}`,
    credentialRef: binding.credentialRef,
    delivery: binding.delivery
  };
}
function validateLifecycleBase(request) {
  requireCondition(
    request.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    `Unsupported workspace-host initialization contract '${request.contractVersion}'`
  );
  requireId(request.operationId, "operationId");
  requireId(request.workspaceId, "workspaceId");
  requireId(request.hostId, "hostId");
  requireTimestamp(request.requestedAt, "requestedAt");
}
function sameChannels(a, b) {
  return a.length === b.length && a.every((channel) => b.includes(channel));
}
function validateBackupCredentialManifest(backup, workspaceId) {
  requireCondition(
    backup.contractVersion === WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION && backup.workspaceId === workspaceId && backup.authorizationMaterial === "excluded" && backup.credentialReferences === "excluded",
    "Restore requires a matching credential-free backup manifest"
  );
  requireTimestamp(backup.capturedAt, "backup.capturedAt");
  requireCondition(
    Array.isArray(backup.bindingState) && backup.bindingState.length > 0,
    "Restore backup must include credential replacement metadata"
  );
  const channels = backup.bindingState.map((binding) => binding.channel);
  requireCondition(
    new Set(channels).size === channels.length && channels.every(
      (channel) => WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
        channel
      )
    ) && sameChannels(backup.rebindRequired, channels),
    "Restore backup replacement metadata must cover every channel named by the manifest"
  );
  for (const binding of backup.bindingState) {
    requireCondition(
      Number.isSafeInteger(binding.generation) && binding.generation >= 1,
      `Restore backup generation for ${binding.channel} must be a positive safe integer`
    );
    requireCondition(
      /^[a-f0-9]{64}$/.test(binding.revocationRefSha256),
      `Restore backup revocation fingerprint for ${binding.channel} must be SHA-256`
    );
  }
}
function requireCredentialReplacements(label, previous, next) {
  requireCondition(
    sameChannels(
      previous.map((entry) => entry.channel),
      next.map((entry) => entry.channel)
    ),
    `${label} must ${label === "Restore" ? "rebind" : "replace"} every currently bound credential channel`
  );
  for (const replacement of next) {
    const prior = previous.find(
      (entry) => entry.channel === replacement.channel
    );
    requireCondition(
      replacement.delivery.generation > prior.generation,
      `${label} generation for ${replacement.channel} must increase`
    );
    requireCondition(
      (0,__vite_ssr_import_0__.createHash)("sha256").update(replacement.delivery.revocationRef, "utf8").digest("hex") !== prior.revocationRefSha256,
      `${label} revocation reference for ${replacement.channel} must change`
    );
  }
}
function buildWorkspaceHostBackupRestoreCredentialRebindRequest(backup, nextCredentialRefs, nextDelivery, requestedAt) {
  validateBackupCredentialManifest(backup, backup.workspaceId);
  const next = validateCredentialSet(
    nextCredentialRefs,
    nextDelivery,
    requestedAt,
    null
  );
  requireCredentialReplacements("Restore", backup.bindingState, next);
  return {
    action: "restore-rebind",
    backup,
    nextCredentialRefs,
    nextDelivery
  };
};
function planWorkspaceHostCredentialLifecycle(request) {
  validateLifecycleBase(request);
  const steps = [];
  let tail = [];
  if (request.action === "rotate") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
      request.deliveryCapabilities
    );
    const next = validateCredentialSet(
      request.nextCredentialRefs,
      request.nextDelivery,
      request.requestedAt,
      request.deliveryCapabilities
    );
    requireCredentialReplacements(
      "Rotation",
      current.map((binding) => ({
        channel: binding.channel,
        generation: binding.delivery.generation,
        revocationRefSha256: (0,__vite_ssr_import_0__.createHash)("sha256").update(binding.delivery.revocationRef, "utf8").digest("hex")
      })),
      next
    );
    for (const replacement of next) {
      const previous = current.find(
        (entry) => entry.channel === replacement.channel
      );
      const bindId = `bind-next-${replacement.channel}`;
      const verifyId = `verify-next-${replacement.channel}`;
      const revokeId = `revoke-previous-${replacement.channel}`;
      const revokedId = `verify-revoked-${replacement.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", replacement, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", replacement, [bindId])
      );
      steps.push(
        lifecycleStep(request, revokeId, "revoke", previous, [verifyId])
      );
      steps.push(
        lifecycleStep(request, revokedId, "verify-revoked", previous, [
          revokeId
        ])
      );
      tail = [revokedId];
    }
  } else if (request.action === "revoke") {
    const current = validateCredentialSet(
      request.currentCredentialRefs,
      request.currentDelivery,
      request.requestedAt,
      request.deliveryCapabilities
    );
    requireCondition(
      request.channels.length > 0 && new Set(request.channels).size === request.channels.length,
      "Revocation channels must be a non-empty unique list"
    );
    for (const channel of request.channels) {
      const binding = current.find((entry) => entry.channel === channel);
      requireCondition(binding, `Cannot revoke unbound ${channel} channel`);
      const revokeId = `revoke-${channel}`;
      const verifyId = `verify-revoked-${channel}`;
      steps.push(lifecycleStep(request, revokeId, "revoke", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-revoked", binding, [revokeId])
      );
      tail = [verifyId];
    }
  } else {
    const refs = request.action === "restore-rebind" ? request.nextCredentialRefs : request.currentCredentialRefs;
    const delivery = request.action === "restore-rebind" ? request.nextDelivery : request.currentDelivery;
    const current = validateCredentialSet(
      refs,
      delivery,
      request.requestedAt,
      request.deliveryCapabilities
    );
    if (request.action === "restore-rebind") {
      validateBackupCredentialManifest(request.backup, request.workspaceId);
      requireCredentialReplacements(
        "Restore",
        request.backup.bindingState,
        current
      );
    };
    for (const binding of current) {
      const bindId = `bind-${binding.channel}`;
      const verifyId = `verify-${binding.channel}`;
      steps.push(lifecycleStep(request, bindId, "bind", binding, tail));
      steps.push(
        lifecycleStep(request, verifyId, "verify-bound", binding, [bindId])
      );
      tail = [verifyId];
    }
  };
  const plan = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    action: request.action,
    requestedAt: request.requestedAt,
    steps
  };
  (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
    plan,
    "workspaceHost.credentialLifecycle.plan"
  );
  return plan;
};
function validateWorkspaceHostInitializationCanary(evidence) {
  const errors = [];
  try {
    (0,__vite_ssr_import_1__.assertWorkspaceHostSecretIsolation)(
      evidence,
      "workspaceHost.initialization.canary"
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  };
  if (evidence.contractVersion !== WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION) {
    errors.push("canary contract version mismatch");
  };
  if (evidence.kind !== "live")
    errors.push("canary evidence must come from a live host");
  for (const [value, label] of [
    [evidence.runId, "runId"],
    [evidence.workspaceId, "workspaceId"],
    [evidence.hostId, "hostId"]
  ]) {
    if (!SAFE_ID.test(value))
      errors.push(`canary ${label} must be a stable identifier`);
  };
  if (!Number.isFinite(Date.parse(evidence.observedAt))) {
    errors.push("canary observedAt must be an ISO timestamp");
  };
  if (evidence.repository?.visibility !== "private" || !evidence.repository.cloned) {
    errors.push("private-repository clone did not pass");
  };
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const result = evidence.channels?.[channel];
    if (!result?.bound || !result.rotated || !result.previousBindingRevoked || !result.reconnected) {
      errors.push(`${channel} credential lifecycle did not pass`);
    }
  };
  for (const agent of (0,__vite_ssr_import_2__.resolveWorkspaceHostRequestedAgents)(evidence.requestedAgents)) {
    const result = evidence.agents?.[agent];
    if (!result?.ready) errors.push(`${agent} live readiness did not pass`);
    if (!(0,__vite_ssr_import_2__.workspaceHostAgentVerificationKindIsAllowed)(
      agent,
      result?.verificationKind
    )) {
      errors.push(`${agent} verification kind is not allowed`);
    }
  };
  if (evidence.backupRestore?.authorizationMaterial !== "excluded" || evidence.backupRestore?.credentialReferences !== "excluded") {
    errors.push("backup retained credential authorization or references");
  };
  if (!sameChannels(
    evidence.backupRestore?.reboundChannels ?? [],
    WORKSPACE_HOST_CREDENTIAL_CHANNELS
  )) {
    errors.push("restore did not rebind all credential channels");
  };
  return { ok: errors.length === 0, errors };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QVcsV0FBVyxvQ0FBb0M7QUFDeEQsVUFBTSxTQUFTLFNBQVMsV0FBVyxPQUFPO0FBQzFDLFFBQ0UsQ0FBQyxRQUFRLFNBQ1QsQ0FBQyxPQUFPLFdBQ1IsQ0FBQyxPQUFPLDBCQUNSLENBQUMsT0FBTyxhQUNSO0FBQ0EsYUFBTyxLQUFLLEdBQUcsT0FBTyxvQ0FBb0M7QUFBQSxJQUM1RDtBQUFBLEVBQ0Y7QUFJQSxhQUFXLFlBQVMsMkRBQW9DLFNBQVMsZUFBZSxHQUFHO0FBQ2pGLFVBQU0sU0FBUyxTQUFTLFNBQVMsS0FBSztBQUN0QyxRQUFJLENBQUMsUUFBUSxNQUFPLFFBQU8sS0FBSyxHQUFHLEtBQUssOEJBQThCO0FBR3RFLFFBQ0UsSUFBQztBQUFBLE1BQ0M7QUFBQSxNQUNBLFFBQVE7QUFBQSxJQUNWLEdBQ0E7QUFDQSxhQUFPLEtBQUssR0FBRyxLQUFLLG1DQUFtQztBQUFBLElBQ3pEO0FBQUEsRUFDRjtBQUNBLE1BQ0UsU0FBUyxlQUFlLDBCQUEwQixjQUNsRCxTQUFTLGVBQWUseUJBQXlCLFlBQ2pEO0FBQ0EsV0FBTyxLQUFLLHdEQUF3RDtBQUFBLEVBQ3RFO0FBQ0EsTUFDRSxDQUFDO0FBQUEsSUFDQyxTQUFTLGVBQWUsbUJBQW1CLENBQUM7QUFBQSxJQUM1QztBQUFBLEVBQ0YsR0FDQTtBQUNBLFdBQU8sS0FBSyxnREFBZ0Q7QUFBQSxFQUM5RDtBQUNBLFNBQU8sRUFBRSxJQUFJLE9BQU8sV0FBVyxHQUFHLE9BQU87QUFDM0MiLCJuYW1lcyI6WyJiaW5kaW5ncyJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJ3b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXphdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24gfSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC10ZXN0LWhhcm5lc3NcIjtcbmltcG9ydCB7XG4gIHJlc29sdmVXb3Jrc3BhY2VIb3N0UmVxdWVzdGVkQWdlbnRzLFxuICB3b3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kSXNBbGxvd2VkLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RBZ2VudFZlcmlmaWNhdGlvbktpbmQsXG4gIHR5cGUgV29ya3NwYWNlSG9zdENhbmFyeUFnZW50LFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1hZ2VudC1hdXRoZW50aWNhdGlvblwiO1xuaW1wb3J0IHR5cGUge1xuICBBZ2VudENyZWRlbnRpYWxSZWYsXG4gIENsb3VkQ3JlZGVudGlhbFJlZixcbiAgR2l0Q3JlZGVudGlhbFJlZixcbiAgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZzLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC10eXBlc1wiO1xuXG4vKiogUGVyc2lzdGVkLCBwcm92aWRlci1uZXV0cmFsIGNvbnRyYWN0IGZvciB3b3JrIHBlcmZvcm1lZCBhZnRlciBob3N0IGJvb3RzdHJhcC4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OID1cbiAgXCJwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtaW5pdGlhbGl6YXRpb24tdjFcIjtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMgPSBbXG4gIFwiY2xvdWRcIixcbiAgXCJnaXRcIixcbiAgXCJhZ2VudFwiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbCA9XG4gICh0eXBlb2YgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9DSEFOTkVMUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0lNUE9SVF9VTklUUyA9IFtcbiAgXCJyZXBvc2l0b3JpZXNcIixcbiAgXCJmaWxlc1wiLFxuICBcImRhdGFiYXNlXCIsXG4gIFwidHJhbnNjcmlwdHNcIixcbiAgXCJhZ2VudHNcIixcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0SW1wb3J0VW5pdCA9XG4gICh0eXBlb2YgV09SS1NQQUNFX0hPU1RfSU1QT1JUX1VOSVRTKVtudW1iZXJdO1xuXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5S2luZCA9XG4gIHwgXCJwcm92aWRlci1pZGVudGl0eVwiXG4gIHwgXCJmb3J3YXJkZWQtYWdlbnRcIlxuICB8IFwic2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiXG4gIHwgXCJlbmNyeXB0ZWQtcmVmZXJlbmNlXCI7XG5cbi8qKlxuICogUHVibGljIGJpbmRpbmcgbWV0YWRhdGEgb25seS4gVGhlIHJlc29sdmVyIG5hbWVkIGJ5IHRoZSB0eXBlZCBjcmVkZW50aWFsXG4gKiByZWZlcmVuY2UgZGVsaXZlcnMgdGhlIGFjdHVhbCBhdXRob3JpemF0aW9uIG1hdGVyaWFsIG91dCBvZiBiYW5kLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnkge1xuICBraW5kOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5S2luZDtcbiAgZ2VuZXJhdGlvbjogbnVtYmVyO1xuICBhdWRpZW5jZTogc3RyaW5nO1xuICByZXZvY2F0aW9uUmVmOiBzdHJpbmc7XG4gIGV4cGlyZXNBdD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5U2V0IHtcbiAgY2xvdWQ6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnk7XG4gIGdpdD86IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnk7XG4gIGFnZW50PzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeTtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgdHJhbnNwb3J0IGRlY2xhcmF0aW9uIHRoZSBjcmVkZW50aWFsIGNoYW5uZWxzIGRlcGVuZCBvbiAoRC0yMTUgcG9pbnQgNikuXG4gKlxuICogRGVsaWJlcmF0ZWx5IHN0cnVjdHVyYWwgYW5kIG1pbmltYWw6IGBXb3Jrc3BhY2VIb3N0VHJhbnNwb3J0RmVhdHVyZVNldGAgaXMgYXNzaWduYWJsZSB0byBpdCwgc29cbiAqIGEgY2FsbGVyIHBhc3NlcyBpdHMgcHJvdmlkZXIncyBSRUFMIHRyYW5zcG9ydCBwcm9maWxlIGZlYXR1cmVzIHN0cmFpZ2h0IHRocm91Z2hcbiAqIChgcHJvZmlsZS50cmFuc3BvcnRQcm9maWxlLmZlYXR1cmVzYCkgaW5zdGVhZCBvZiB0cmFuc2NyaWJpbmcgYSBib29sZWFuIGludG8gYSBzZWNvbmQgcGxhY2UuXG4gKiBUaGUgY29udHJhY3QgcmVhZHMgb25seSB0aGUgb25lIGZlYXR1cmUgaXQgYWN0dWFsbHkgZGVwZW5kcyBvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0RGVsaXZlcnlDYXBhYmlsaXRpZXMge1xuICByZWFkb25seSBmaWxlVHJhbnNmZXI6IGJvb2xlYW47XG59XG5cbi8qKlxuICogQ2hhbm5lbHMgd2hvc2UgY3JlZGVudGlhbCBtYXRlcmlhbCBtdXN0IGJlIFdSSVRURU4gdG8gdGhlIGhvc3QgYmVmb3JlIGBiaW5kKClgIGNhbiBzdWNjZWVkLlxuICpcbiAqIERFUklWRUQsIE5PVCBERUNJREVEIEhFUkUuIFRoZSBzb3VyY2UgaXMgYHJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWxgIG9uIGVhY2ggZmFtaWx5IHNwZWMgaW5cbiAqIGB3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZWAsIHdoaWNoIGltcG9ydHMgdGhpcyBtb2R1bGUg4oCUIHNvIGl0IGNhbm5vdCBiZSBpbXBvcnRlZCBiYWNrXG4gKiB3aXRob3V0IGEgY3ljbGUsIGFuZCB0aGlzIGlzIGEgZGVsaWJlcmF0ZSBsaXRlcmFsIGNvcHkgcGlubmVkIGJ5IGEgZ3VhcmQgdGVzdFxuICogKGB3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZS50ZXN0LnRzYCkgdGhhdCBmYWlscyBpZiB0aGUgZGVyaXZlZCBzZXQgZXZlciBkaWZmZXJzLlxuICogVGhhdCBpcyBydW5nIDIgb2YgdGhlIGRlcml2ZWQtdHJ1dGggbGFkZGVyIHdpdGggaXRzIHJlYXNvbiBzdGF0ZWQsIG5vdCBhIGhhbmQtbWFpbnRhaW5lZCBsaXN0LlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ0hBTk5FTFNfUkVRVUlSSU5HX0ZJTEVfREVMSVZFUlk6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbFtdID1cbiAgT2JqZWN0LmZyZWV6ZShbXCJhZ2VudFwiLCBcImdpdFwiXSBhcyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWxbXSk7XG5cbi8qKlxuICogQSBwcm92aWRlciB3YXMgYXNrZWQgdG8gY2FycnkgYSBjaGFubmVsIGl0cyBkZWNsYXJlZCB0cmFuc3BvcnQgY2Fubm90IGRlbGl2ZXIuXG4gKlxuICogRGlzdGluY3QgZnJvbSB0aGUgY29udHJhY3QncyBnZW5lcmljIHZhbGlkYXRpb24gZXJyb3Igb24gcHVycG9zZTogYW4gQVBJIGVkZ2UgbXVzdCBiZSBhYmxlIHRvXG4gKiB0ZWxsIFwidGhpcyBwcm92aWRlciBzdHJ1Y3R1cmFsbHkgY2Fubm90IGRvIHRoaXNcIiBmcm9tIFwieW91ciByZXF1ZXN0IGlzIG1hbGZvcm1lZFwiLiBUaGUgZmlyc3QgaXNcbiAqIG5vdCBmaXhlZCBieSByZXRyeWluZyB3aXRoIGEgY29ycmVjdGVkIGJvZHkg4oCUIGl0IG5lZWRzIGEgZGlmZmVyZW50IHByb3ZpZGVyIG9yIHRyYW5zcG9ydCDigJQgYW5kXG4gKiBpbmZlcnJpbmcgdGhhdCBmcm9tIGFuIGVycm9yIG1lc3NhZ2UncyBzaGFwZSBpcyBleGFjdGx5IHRoZSBraW5kIG9mIGd1ZXNzIHRoYXQgcm90cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlDYXBhYmlsaXR5RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgcmVhZG9ubHkgY2FwYWJpbGl0eSA9IFwiZmlsZVRyYW5zZmVyXCIgYXMgY29uc3Q7XG5cbiAgY29uc3RydWN0b3IoY2hhbm5lbDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsKSB7XG4gICAgc3VwZXIoXG4gICAgICBgVGhlICR7Y2hhbm5lbH0gY3JlZGVudGlhbCBjaGFubmVsIHJlcXVpcmVzIGRlbGl2ZXJlZCBtYXRlcmlhbCBvbiB0aGUgaG9zdCwgYnV0IHRoaXMgYCArXG4gICAgICAgIGBwcm92aWRlcidzIHRyYW5zcG9ydCBkZWNsYXJlcyBmaWxlVHJhbnNmZXI6IGZhbHNlLiBSZWZ1c2VkIGF0IHBsYW4gdGltZTogYSBydW5uaW5nIGhvc3QgYCArXG4gICAgICAgIGB3b3VsZCBmYWlsIGF0IGJpbmQgd2l0aCBubyB3YXkgdG8gZGlzdGluZ3Vpc2ggYSBtaXNzaW5nIGNhcGFiaWxpdHkgZnJvbSBhIGxvc3QgZGVsaXZlcnkuYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeUNhcGFiaWxpdHlFcnJvclwiO1xuICAgIHRoaXMuY2hhbm5lbCA9IGNoYW5uZWw7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0UGFpcmluZ1JlZmVyZW5jZSB7XG4gIHJlYWRvbmx5IGtpbmQ6IFwicGFpcmluZ1wiO1xuICByZWFkb25seSByZWY6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU291cmNlID1cbiAgfCB7IGtpbmQ6IFwiZW1wdHlcIiB9XG4gIHwgeyBraW5kOiBcInJldGFpbmVkXCI7IHRlbmFudElkZW50aXR5OiBzdHJpbmcgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiZ2l0XCI7XG4gICAgICByZXBvc2l0b3J5VXJsOiBzdHJpbmc7XG4gICAgICB2aXNpYmlsaXR5OiBcInB1YmxpY1wiIHwgXCJwcml2YXRlXCI7XG4gICAgICBkZXN0aW5hdGlvbjogc3RyaW5nO1xuICAgICAgcmV2aXNpb24/OiBzdHJpbmc7XG4gICAgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwicGFpclwiO1xuICAgICAgc291cmNlV29ya3NwYWNlSWQ6IHN0cmluZztcbiAgICAgIHBhaXJpbmdSZWZlcmVuY2U6IFdvcmtzcGFjZUhvc3RQYWlyaW5nUmVmZXJlbmNlO1xuICAgICAgLyoqIEV4cGxpY2l0IHByb2plY3Rpb24gZXhwb3NlZCB0aHJvdWdoIHRoZSBwYWlyOyBuZXZlciBhbiBpbXBsaWNpdCB3aG9sZS13b3Jrc3BhY2Ugc2hhcmUuICovXG4gICAgICBpbmNsdWRlOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0SW1wb3J0VW5pdFtdO1xuICAgIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImltcG9ydFwiO1xuICAgICAgc291cmNlV29ya3NwYWNlSWQ6IHN0cmluZztcbiAgICAgIHNvdXJjZVNuYXBzaG90UmVmOiBzdHJpbmc7XG4gICAgICAvKiogRXhwbGljaXQgY29weSBhbGxvd2xpc3Q7IG9taXR0ZWQgc3RhdGUgcmVtYWlucyBhYnNlbnQgb24gdGhlIGRlc3RpbmF0aW9uLiAqL1xuICAgICAgaW5jbHVkZTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEltcG9ydFVuaXRbXTtcbiAgICB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblJlcXVlc3Qge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICBvcGVyYXRpb25JZDogc3RyaW5nO1xuICB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICBob3N0SWQ6IHN0cmluZztcbiAgcmVxdWVzdGVkQXQ6IHN0cmluZztcbiAgc291cmNlOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25Tb3VyY2U7XG4gIGNyZWRlbnRpYWxSZWZzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZnM7XG4gIGNyZWRlbnRpYWxEZWxpdmVyeTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVNldDtcbiAgLyoqIEFnZW50cyB0byBpbml0aWFsaXplIGFuZCB2ZXJpZnk7IG9taXNzaW9uIHJldGFpbnMgYWxsLXRocmVlIGNvdmVyYWdlLiAqL1xuICByZXF1ZXN0ZWRBZ2VudHM/OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnRbXTtcbiAgLyoqIFRoZSBleGVjdXRpbmcgcHJvdmlkZXIncyBkZWNsYXJlZCB0cmFuc3BvcnQgZmVhdHVyZXM7IGdhdGVzIHRoZSBkZWxpdmVyeS1iZWFyaW5nIGNoYW5uZWxzLiAqL1xuICBkZWxpdmVyeUNhcGFiaWxpdGllczogV29ya3NwYWNlSG9zdERlbGl2ZXJ5Q2FwYWJpbGl0aWVzO1xuICAvKiogUGVyc2lzdGFibGUgbGFiZWxzIG9ubHkuICovXG4gIHB1YmxpY01ldGFkYXRhPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xufVxuXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfSU5JVElBTElaQVRJT05fU1RFUF9LSU5EUyA9IFtcbiAgXCJjcmVhdGUtd29ya3NwYWNlXCIsXG4gIFwidmVyaWZ5LXJldGFpbmVkLXdvcmtzcGFjZVwiLFxuICBcImNsb25lLXJlcG9zaXRvcnlcIixcbiAgXCJwYWlyLXdvcmtzcGFjZVwiLFxuICBcImltcG9ydC13b3Jrc3BhY2VcIixcbiAgXCJiaW5kLWNyZWRlbnRpYWxcIixcbiAgXCJ2ZXJpZnktaW5pdGlhbGl6YXRpb25cIixcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwS2luZCA9XG4gICh0eXBlb2YgV09SS1NQQUNFX0hPU1RfSU5JVElBTElaQVRJT05fU1RFUF9LSU5EUylbbnVtYmVyXTtcblxuLyoqXG4gKiBDYXBhYmlsaXR5IGtpbmRzIGEgaG9zdCBhZGFwdGVyIG1heSBhZHZlcnRpc2UgdG8gdGhlIGluaXRpYWxpemF0aW9uIHNlYW0uXG4gKlxuICogVGhlIGNvbmNyZXRlIHJlbW90ZSBpbml0aWFsaXplciBkZWxpYmVyYXRlbHkgc2VydmVzIGJvdGggdGhlIHNpeCBpbml0aWFsaXphdGlvbiBzdGVwcyBhbmRcbiAqIHRoZSBmb3VyIGNyZWRlbnRpYWwtbGlmZWN5Y2xlIHN0ZXBzLiAgSW5pdGlhbGl6YXRpb24gZXhlY3V0aW9uIHN0aWxsIHJlY2VpdmVzIG9ubHkgYW5cbiAqIGBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwYCwgYnV0IGl0cyBjYXBhYmlsaXR5IG1hbmlmZXN0IGlzIGFsbG93ZWQgdG8gZGVzY3JpYmUgdGhlXG4gKiBjb21wbGV0ZSB3aXJlIHN1cmZhY2Ugc28gb25lIGFkYXB0ZXIgY2FuIGJlIHNoYXJlZCBieSB0aGUgY2FuYXJ5J3MgaW5pdGlhbGl6YXRpb24gYW5kXG4gKiBsaWZlY3ljbGUgcnVubmVycy5cbiAqL1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3VwcG9ydGVkU3RlcEtpbmQgPVxuICB8IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kXG4gIHwgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVTdGVwS2luZDtcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwIHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcEtpbmQ7XG4gIGRlcGVuZHNPbjogcmVhZG9ubHkgc3RyaW5nW107XG4gIGlkZW1wb3RlbmN5S2V5OiBzdHJpbmc7XG4gIGlucHV0OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uUGxhbiB7XG4gIGNvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX0NPTlRSQUNUX1ZFUlNJT047XG4gIG9wZXJhdGlvbklkOiBzdHJpbmc7XG4gIHdvcmtzcGFjZUlkOiBzdHJpbmc7XG4gIGhvc3RJZDogc3RyaW5nO1xuICByZXF1ZXN0ZWRBdDogc3RyaW5nO1xuICBzdGVwczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcFtdO1xuICBwdWJsaWNNZXRhZGF0YT86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwUmVjZWlwdCB7XG4gIHN0ZXBJZDogc3RyaW5nO1xuICBzdGF0dXM6IFwic3VjY2VlZGVkXCI7XG4gIG9ic2VydmVkQXQ6IHN0cmluZztcbiAgLyoqIFN0cnVjdHVyZWQsIHJlZGFjdGVkIGV2aWRlbmNlLiBSYXcgc3Rkb3V0L3N0ZGVyciBhbmQgcmVzb2x2ZWQgYXV0aG9yaXphdGlvbiBhcmUgZm9yYmlkZGVuLiAqL1xuICBwdWJsaWNFdmlkZW5jZT86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cblxuLyoqIEhvc3QgYWRhcHRlciBzZWFtOiBEQk9TL3Byb3ZpZGVyIGNvbnRyb2xsZXJzIGV4ZWN1dGUgb25lIHBlcnNpc3RlZCBzdGVwIGF0IGEgdGltZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uRXhlY3V0b3Ige1xuICBleGVjdXRlKFxuICAgIHN0ZXA6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXAsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcFJlY2VpcHQ+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkhvc3RPcGVyYXRpb25SZXN1bHQge1xuICBvYnNlcnZlZEF0OiBzdHJpbmc7XG4gIC8qKiBQZXJzaXN0YWJsZSwgcmVkYWN0ZWQgZXZpZGVuY2Ugb25seS4gUmF3IHN0cmVhbXMgYW5kIHJlc29sdmVkIGF1dGhvcml6YXRpb24gYXJlIGZvcmJpZGRlbi4gKi9cbiAgcHVibGljRXZpZGVuY2U/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59XG5cbi8qKlxuICogQ29uY3JldGUgaG9zdCBhZGFwdGVycyBtdXN0IGRlY2xhcmUgdGhlIGV4YWN0IGluaXRpYWxpemF0aW9uIG9wZXJhdGlvbnMgdGhleVxuICogaW1wbGVtZW50LiBBIHRyYW5zcG9ydCBraW5kIG5ldmVyIGltcGxpZXMgY29tbWFuZCwgdHJhbnNmZXIsIHBhaXJpbmcsIG9yXG4gKiBjcmVkZW50aWFsLWRlbGl2ZXJ5IHBhcml0eS5cbiAqL1xuLyoqXG4gKiBPcHRpb25zIGZvciB0aGUgYm9vdHN0cmFwLXJlYWRpbmVzcyBnYXRlLiBBbGwgYm91bmRlZDogYSBnYXRlIHRoYXQgY2FuIHdhaXQgZm9yZXZlciBpcyBhXG4gKiBkaWZmZXJlbnQgb3V0YWdlIGZyb20gdGhlIG9uZSBpdCByZXBsYWNlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Qm9vdHN0cmFwUmVhZGluZXNzT3B0aW9ucyB7XG4gIC8qKiBUb3RhbCBidWRnZXQgdG8gd2FpdCBmb3IgdGhlIGhvc3QgYm9vdHN0cmFwIHRvIGZpbmlzaC4gKi9cbiAgcmVhZG9ubHkgdGltZW91dE1zPzogbnVtYmVyO1xuICAvKiogRGVsYXkgYmV0d2VlbiBwcm9iZXMuICovXG4gIHJlYWRvbmx5IHBvbGxJbnRlcnZhbE1zPzogbnVtYmVyO1xuICAvKipcbiAgICogQ2FsbGVkIGFmdGVyIGVhY2ggTk9ULVJFQURZIHByb2JlLCBzbyB0aGUgY2FsbGVyIGNhbiB3cml0ZSBkdXJhYmxlIHByb2dyZXNzLiBXaXRob3V0IHRoaXNcbiAgICogdGhlIHdhaXQgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGhhbmcgdG8gYW55b25lIHJlYWRpbmcgdGhlIG9wZXJhdGlvbiByb3cg4oCUIHdoaWNoIGlzIHRoZVxuICAgKiBmYWlsdXJlIG1vZGUgYSBzaWxlbnQgZ2F0ZSB3b3VsZCBpbnRyb2R1Y2UgaW4gcGxhY2Ugb2YgdGhlIG9uZSBpdCBmaXhlcy5cbiAgICovXG4gIHJlYWRvbmx5IG9uV2FpdGluZz86IChzdGF0dXM6IFdvcmtzcGFjZUhvc3RCb290c3RyYXBSZWFkaW5lc3NQcm9ncmVzcykgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIHJlYWRvbmx5IHNpZ25hbD86IEFib3J0U2lnbmFsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RCb290c3RyYXBSZWFkaW5lc3NQcm9ncmVzcyB7XG4gIHJlYWRvbmx5IGVsYXBzZWRNczogbnVtYmVyO1xuICByZWFkb25seSB0aW1lb3V0TXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcHJvYmVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJvb3RzdHJhcFJlYWRpbmVzc1Jlc3VsdCB7XG4gIHJlYWRvbmx5IHdhaXRlZE1zOiBudW1iZXI7XG4gIHJlYWRvbmx5IHByb2JlczogbnVtYmVyO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoZSBGSVJTVCBwcm9iZSBhbHJlYWR5IGZvdW5kIHRoZSBob3N0IHJlYWR5IOKAlCBpLmUuIG5vIHdhaXRpbmcgd2FzIG5lZWRlZC4gTGV0cyBhXG4gICAqIGNhbGxlciBkaXN0aW5ndWlzaCBcInRoZSBnYXRlIHdhcyBhIG5vLW9wXCIgZnJvbSBcInRoZSBnYXRlIGFic29yYmVkIGEgcmVhbCByYWNlXCIsIHdoaWNoIGlzIHRoZVxuICAgKiBtZWFzdXJlbWVudCB0aGF0IHNheXMgd2hldGhlciB0aGlzIGdhdGUgaXMgc3RpbGwgZWFybmluZyBpdHMgcGxhY2UuXG4gICAqL1xuICByZWFkb25seSByZWFkeUltbWVkaWF0ZWx5OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkhvc3RPcGVyYXRpb25zIHtcbiAgcmVhZG9ubHkgc3VwcG9ydGVkU3RlcEtpbmRzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdXBwb3J0ZWRTdGVwS2luZFtdO1xuICBleGVjdXRlKFxuICAgIHN0ZXA6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXAsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uSG9zdE9wZXJhdGlvblJlc3VsdD47XG4gIC8qKlxuICAgKiBPUFRJT05BTCBnYXRlOiByZXNvbHZlIG9uY2UgdGhlIGhvc3QncyBvd24gYm9vdHN0cmFwIGhhcyBmaW5pc2hlZCBpbnN0YWxsaW5nIHRoZSBwcm9ncmFtc1xuICAgKiBpbml0aWFsaXphdGlvbiBpbnZva2VzLlxuICAgKlxuICAgKiBXSFkgVEhJUyBFWElTVFMgKFdJLTEwMDAxNjc3KS4gYHByb3Zpc2lvbmAgcmVwb3J0cyBzdWNjZXNzIHdoZW4gdGhlIHByb3ZpZGVyJ3MgcmVzb3VyY2VzXG4gICAqIGV4aXN0LCBidXQgdGhlIGhvc3QgYm9vdHN0cmFwIGl0IGRlbGl2ZXJlZCBhcyBpbnN0YW5jZSBzdGFydHVwIG1ldGFkYXRhIGlzIHN0aWxsIFJVTk5JTkcg4oCUXG4gICAqIGl0IGhhcyB0byBta2ZzIHRoZSBkYXRhIGRpc2ssIGRvd25sb2FkIGFuZCB2ZXJpZnkgYSB+MkdCIHNpZ25lZCBidW5kbGUsIGluc3RhbGwgYSBOb2RlXG4gICAqIHJ1bnRpbWUgYW5kIHRoZW4gaW5zdGFsbCB0aGUgdmVuZG9yIGFnZW50IENMSXMsIGFuZCBpdCBpbnN0YWxscyB0aGUgcHJpdmlsZWdlZCBjb25kdWl0cyBuZWFyXG4gICAqIHRoZSBFTkQgb2YgdGhhdCB3b3JrLiBOb3RoaW5nIGdhdGVkIHRoZSBnYXAsIHNvIGFuIGluaXRpYWxpemF0aW9uIHRoYXQgYmVnYW4gcHJvbXB0bHkgYWZ0ZXJcbiAgICogcHJvdmlzaW9uaW5nIGRpZWQgb24gaXRzIHZlcnkgZmlyc3Qgc3RlcCB3aXRoIGEgYmFyZVxuICAgKiBgZXhpdCAxMjcg4oCmIC91c3IvbG9jYWwvYmluL3BhcGVyY3VzcC13b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXplOiBObyBzdWNoIGZpbGUgb3IgZGlyZWN0b3J5YC5cbiAgICpcbiAgICogVGhhdCBlcnJvciBuYW1lcyBhIE1JU1NJTkcgRklMRSwgc28gaXQgcmVhZHMgYXMgYSBwYWNrYWdpbmcgZGVmZWN0IGluIHRoZSBidW5kbGUg4oCUIGFuZCB0aGVcbiAgICogYnVuZGxlIGlzIGZpbmUgYW5kIHZlcmlmaWVkIGV2ZXJ5IHRpbWUuIE1lYXN1cmVkIGFjcm9zcyBldmVyeSBpbml0aWFsaXphdGlvbiBhdHRlbXB0IG9uXG4gICAqIHJlY29yZCwgdGhlIHR3byBjb25kdWl0LW1pc3NpbmcgZmFpbHVyZXMgd2VyZSB0aGUgdHdvIFNIT1JURVNUIHByb3Zpc2lvbuKGkmluaXRpYWxpemUgZ2Fwc1xuICAgKiAoMTE3cyBhbmQgMzA0cykgd2hpbGUgZXZlcnkgYXR0ZW1wdCBhdCA5MDFzIG9yIGxhdGVyIGZvdW5kIHRoZSBjb25kdWl0IHByZXNlbnQuIEEgc3RlcC0wXG4gICAqIG1pc3NpbmctZmlsZSBlcnJvciBpcyBtb3JlIG9mdGVuIGFuIFVORklOSVNIRUQgcHJlZGVjZXNzb3IgdGhhbiBhIGJyb2tlbiBhcnRpZmFjdCwgYW5kIHRoaXNcbiAgICogZ2F0ZSBpcyB3aGF0IG1ha2VzIHRoZSBkaWZmZXJlbmNlIG9ic2VydmFibGUgaW5zdGVhZCBvZiBhIGd1ZXNzLlxuICAgKlxuICAgKiBBZGFwdGVycyB0aGF0IGNhbm5vdCBwcm9iZSB0aGVpciBob3N0IHNpbXBseSBvbWl0IGl0OyB0aGUgcnVubmVyIHRyZWF0cyBhYnNlbmNlIGFzIFwibm8gZ2F0ZVwiXG4gICAqIHJhdGhlciB0aGFuIHJlcXVpcmluZyBldmVyeSBwcm92aWRlciB0byBpbXBsZW1lbnQgb25lLlxuICAgKi9cbiAgYXdhaXRCb290c3RyYXBSZWFkeT8oXG4gICAgb3B0aW9ucz86IFdvcmtzcGFjZUhvc3RCb290c3RyYXBSZWFkaW5lc3NPcHRpb25zLFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RCb290c3RyYXBSZWFkaW5lc3NSZXN1bHQ+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblJlcGxheUlkZW50aXR5IHtcbiAgaWRlbXBvdGVuY3lLZXk6IHN0cmluZztcbiAgLyoqIFNIQS0yNTYgb3ZlciBjYW5vbmljYWwgc3RlcCBKU09OOyBkZXRlY3RzIHNhbWUta2V5L2RpZmZlcmVudC1pbnB1dCByZXVzZS4gKi9cbiAgc3RlcEZpbmdlcnByaW50OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRHVyYWJsZSBjb250cm9sbGVyIHNlYW0uIEltcGxlbWVudGF0aW9ucyBhdG9taWNhbGx5IHJldHVybiB0aGUgcHJpb3IgcmVjZWlwdFxuICogZm9yIGEgY29tcGxldGVkIGlkZW50aXR5IG9yIG93biBhbmQgcGVyc2lzdCBleGFjdGx5IG9uZSBleGVjdXRpb24gb2YgYHJ1bmAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uUmVwbGF5U3RvcmUge1xuICBydW5PbmNlKFxuICAgIGlkZW50aXR5OiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25SZXBsYXlJZGVudGl0eSxcbiAgICBydW46ICgpID0+IFByb21pc2U8V29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcFJlY2VpcHQ+LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBSZWNlaXB0Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXBsYXlTYWZlV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uRXhlY3V0b3JEZXBzIHtcbiAgb3BlcmF0aW9uczogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uSG9zdE9wZXJhdGlvbnM7XG4gIHJlcGxheVN0b3JlOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25SZXBsYXlTdG9yZTtcbn1cblxuZnVuY3Rpb24gY2Fub25pY2FsSW5pdGlhbGl6YXRpb25Kc29uKHZhbHVlOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoXG4gICAgdmFsdWUgPT09IG51bGwgfHxcbiAgICB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgfHxcbiAgICB0eXBlb2YgdmFsdWUgPT09IFwiYm9vbGVhblwiXG4gICkge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJudW1iZXJcIikge1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICBOdW1iZXIuaXNGaW5pdGUodmFsdWUpLFxuICAgICAgYCR7cGF0aH0gbXVzdCBjb250YWluIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIGBbJHt2YWx1ZVxuICAgICAgLm1hcCgoZW50cnksIGluZGV4KSA9PlxuICAgICAgICBjYW5vbmljYWxJbml0aWFsaXphdGlvbkpzb24oZW50cnksIGAke3BhdGh9WyR7aW5kZXh9XWApLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCIsXCIpfV1gO1xuICB9XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmIHZhbHVlICE9PSB1bmRlZmluZWQsXG4gICAgYCR7cGF0aH0gbXVzdCBjb250YWluIEpTT04tY29tcGF0aWJsZSB2YWx1ZXNgLFxuICApO1xuICBjb25zdCBwcm90b3R5cGUgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YodmFsdWUpO1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHByb3RvdHlwZSA9PT0gT2JqZWN0LnByb3RvdHlwZSB8fCBwcm90b3R5cGUgPT09IG51bGwsXG4gICAgYCR7cGF0aH0gbXVzdCBjb250YWluIHBsYWluIEpTT04gb2JqZWN0c2AsXG4gICk7XG4gIHJldHVybiBgeyR7T2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgLnNvcnQoKFtsZWZ0XSwgW3JpZ2h0XSkgPT4gbGVmdC5sb2NhbGVDb21wYXJlKHJpZ2h0KSlcbiAgICAubWFwKChba2V5LCBlbnRyeV0pID0+IHtcbiAgICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICAgIGVudHJ5ICE9PSB1bmRlZmluZWQsXG4gICAgICAgIGAke3BhdGh9LiR7a2V5fSBtdXN0IG5vdCBiZSB1bmRlZmluZWRgLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeShrZXkpfToke2Nhbm9uaWNhbEluaXRpYWxpemF0aW9uSnNvbihlbnRyeSwgYCR7cGF0aH0uJHtrZXl9YCl9YDtcbiAgICB9KVxuICAgIC5qb2luKFwiLFwiKX19YDtcbn1cblxuLyoqIFN0YWJsZSBpZGVudGl0eSBmb3IgcmVwbGF5IGNvbGxpc2lvbiBkZXRlY3Rpb24sIGluZGVwZW5kZW50IG9mIG9iamVjdCBrZXkgb3JkZXIuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcEZpbmdlcnByaW50KFxuICBzdGVwOiBPbWl0PFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXAsICdraW5kJz4gJiB7IGtpbmQ6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kIHwgJ2luc3RhbGwtZGVza3RvcC1wYWNrJyB9LFxuKTogc3RyaW5nIHtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihzdGVwLCBcIndvcmtzcGFjZUhvc3QuaW5pdGlhbGl6YXRpb24uc3RlcFwiKTtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcbiAgICAudXBkYXRlKFxuICAgICAgY2Fub25pY2FsSW5pdGlhbGl6YXRpb25Kc29uKHN0ZXAsIFwid29ya3NwYWNlSG9zdC5pbml0aWFsaXphdGlvbi5zdGVwXCIpLFxuICAgICAgXCJ1dGY4XCIsXG4gICAgKVxuICAgIC5kaWdlc3QoXCJoZXhcIik7XG59XG5cbi8qKlxuICogUHJvZHVjdGlvbiBleGVjdXRvciBmb3IgdGhlIHByb3ZpZGVyLW5ldXRyYWwgcGxhbi4gVGhlIGR1cmFibGUgY29udHJvbGxlclxuICogb3ducyByZXBsYXkgc2VyaWFsaXphdGlvbiB3aGlsZSB0aGUgaG9zdCBhZGFwdGVyIG93bnMgb25seSBkZWNsYXJlZCBzdGVwXG4gKiBraW5kczsgZXZlcnkgZnJlc2ggb3IgcmVwbGF5ZWQgcmVjZWlwdCBjcm9zc2VzIHRoZSBzYW1lIHNlY3JldC1zYWZlIGJvdW5kYXJ5LlxuICovXG5leHBvcnQgY2xhc3MgUmVwbGF5U2FmZVdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkV4ZWN1dG9yIGltcGxlbWVudHMgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uRXhlY3V0b3Ige1xuICBwcml2YXRlIHJlYWRvbmx5IG9wZXJhdGlvbnM6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkhvc3RPcGVyYXRpb25zO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcGxheVN0b3JlOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25SZXBsYXlTdG9yZTtcbiAgcHJpdmF0ZSByZWFkb25seSBzdXBwb3J0ZWRTdGVwS2luZHM6IFJlYWRvbmx5U2V0PFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN1cHBvcnRlZFN0ZXBLaW5kPjtcblxuICBjb25zdHJ1Y3RvcihkZXBzOiBSZXBsYXlTYWZlV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uRXhlY3V0b3JEZXBzKSB7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIGRlcHMub3BlcmF0aW9ucy5zdXBwb3J0ZWRTdGVwS2luZHMubGVuZ3RoID4gMCxcbiAgICAgIFwiV29ya3NwYWNlLWhvc3QgaW5pdGlhbGl6YXRpb24gb3BlcmF0aW9ucyBtdXN0IGRlY2xhcmUgYXQgbGVhc3Qgb25lIHN1cHBvcnRlZCBzdGVwIGtpbmRcIixcbiAgICApO1xuICAgIGNvbnN0IHN1cHBvcnRlZCA9IG5ldyBTZXQ8V29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3VwcG9ydGVkU3RlcEtpbmQ+KFxuICAgICAgZGVwcy5vcGVyYXRpb25zLnN1cHBvcnRlZFN0ZXBLaW5kcyxcbiAgICApO1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICBzdXBwb3J0ZWQuc2l6ZSA9PT0gZGVwcy5vcGVyYXRpb25zLnN1cHBvcnRlZFN0ZXBLaW5kcy5sZW5ndGgsXG4gICAgICBcIldvcmtzcGFjZS1ob3N0IGluaXRpYWxpemF0aW9uIG9wZXJhdGlvbnMgbXVzdCBub3QgZGVjbGFyZSBkdXBsaWNhdGUgc3RlcCBraW5kc1wiLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBraW5kIG9mIHN1cHBvcnRlZCkge1xuICAgICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgICAgKFxuICAgICAgICAgIFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX1NURVBfS0lORFMgYXMgcmVhZG9ubHkgc3RyaW5nW11cbiAgICAgICAgKS5pbmNsdWRlcyhraW5kKSB8fFxuICAgICAgICAgIChcbiAgICAgICAgICAgIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTElGRUNZQ0xFX1NURVBfS0lORFMgYXMgcmVhZG9ubHkgc3RyaW5nW11cbiAgICAgICAgICApLmluY2x1ZGVzKGtpbmQpLFxuICAgICAgICBgVW5zdXBwb3J0ZWQgd29ya3NwYWNlLWhvc3QgaW5pdGlhbGl6YXRpb24gc3RlcCBraW5kICcke2tpbmR9J2AsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLm9wZXJhdGlvbnMgPSBkZXBzLm9wZXJhdGlvbnM7XG4gICAgdGhpcy5yZXBsYXlTdG9yZSA9IGRlcHMucmVwbGF5U3RvcmU7XG4gICAgdGhpcy5zdXBwb3J0ZWRTdGVwS2luZHMgPSBzdXBwb3J0ZWQ7XG4gIH1cblxuICBhc3luYyBleGVjdXRlKFxuICAgIHN0ZXA6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXAsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcFJlY2VpcHQ+IHtcbiAgICByZXF1aXJlSWQoc3RlcC5pZCwgXCJzdGVwLmlkXCIpO1xuICAgIHJlcXVpcmVSZWZlcmVuY2Uoc3RlcC5pZGVtcG90ZW5jeUtleSwgXCJzdGVwLmlkZW1wb3RlbmN5S2V5XCIpO1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICB0aGlzLnN1cHBvcnRlZFN0ZXBLaW5kcy5oYXMoc3RlcC5raW5kKSxcbiAgICAgIGBXb3Jrc3BhY2UtaG9zdCBpbml0aWFsaXphdGlvbiBvcGVyYXRpb24gJyR7c3RlcC5raW5kfScgaXMgbm90IHN1cHBvcnRlZCBieSB0aGlzIGFkYXB0ZXJgLFxuICAgICk7XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICAgIHN0ZXAsXG4gICAgICBgd29ya3NwYWNlSG9zdC5pbml0aWFsaXphdGlvbi5zdGVwLiR7c3RlcC5pZH1gLFxuICAgICk7XG5cbiAgICBjb25zdCByZWNlaXB0ID0gYXdhaXQgdGhpcy5yZXBsYXlTdG9yZS5ydW5PbmNlKFxuICAgICAge1xuICAgICAgICBpZGVtcG90ZW5jeUtleTogc3RlcC5pZGVtcG90ZW5jeUtleSxcbiAgICAgICAgc3RlcEZpbmdlcnByaW50OiB3b3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwRmluZ2VycHJpbnQoc3RlcCksXG4gICAgICB9LFxuICAgICAgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLm9wZXJhdGlvbnMuZXhlY3V0ZShzdGVwKTtcbiAgICAgICAgcmVxdWlyZVRpbWVzdGFtcChyZXN1bHQub2JzZXJ2ZWRBdCwgYHJlY2VpcHQuJHtzdGVwLmlkfS5vYnNlcnZlZEF0YCk7XG4gICAgICAgIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgICAgICAgcmVzdWx0LnB1YmxpY0V2aWRlbmNlID8/IHt9LFxuICAgICAgICAgIGB3b3Jrc3BhY2VIb3N0LmluaXRpYWxpemF0aW9uLnJlY2VpcHQuJHtzdGVwLmlkfWAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RlcElkOiBzdGVwLmlkLFxuICAgICAgICAgIHN0YXR1czogXCJzdWNjZWVkZWRcIixcbiAgICAgICAgICBvYnNlcnZlZEF0OiByZXN1bHQub2JzZXJ2ZWRBdCxcbiAgICAgICAgICAuLi4ocmVzdWx0LnB1YmxpY0V2aWRlbmNlXG4gICAgICAgICAgICA/IHsgcHVibGljRXZpZGVuY2U6IHJlc3VsdC5wdWJsaWNFdmlkZW5jZSB9XG4gICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICByZWNlaXB0LnN0ZXBJZCA9PT0gc3RlcC5pZCAmJiByZWNlaXB0LnN0YXR1cyA9PT0gXCJzdWNjZWVkZWRcIixcbiAgICAgIGBJbml0aWFsaXphdGlvbiByZXBsYXkgZm9yICcke3N0ZXAuaWR9JyByZXR1cm5lZCBhbiBpbnZhbGlkIHJlY2VpcHRgLFxuICAgICk7XG4gICAgcmVxdWlyZVRpbWVzdGFtcChyZWNlaXB0Lm9ic2VydmVkQXQsIGByZWNlaXB0LiR7c3RlcC5pZH0ub2JzZXJ2ZWRBdGApO1xuICAgIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgICByZWNlaXB0LnB1YmxpY0V2aWRlbmNlID8/IHt9LFxuICAgICAgYHdvcmtzcGFjZUhvc3QuaW5pdGlhbGl6YXRpb24ucmVjZWlwdC4ke3N0ZXAuaWR9YCxcbiAgICApO1xuICAgIHJldHVybiByZWNlaXB0O1xuICB9XG59XG5cbnR5cGUgQW55Q3JlZGVudGlhbFJlZiA9XG4gIHwgQ2xvdWRDcmVkZW50aWFsUmVmXG4gIHwgR2l0Q3JlZGVudGlhbFJlZlxuICB8IEFnZW50Q3JlZGVudGlhbFJlZjtcblxuaW50ZXJmYWNlIENyZWRlbnRpYWxCaW5kaW5nIHtcbiAgY2hhbm5lbDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsO1xuICBjcmVkZW50aWFsUmVmOiBBbnlDcmVkZW50aWFsUmVmO1xuICBkZWxpdmVyeTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeTtcbn1cblxuY29uc3QgU0FGRV9JRCA9IC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll86LV17MCwxOTF9JC87XG5jb25zdCBTQUZFX1JFTEFUSVZFX1BBVEggPSAvXltBLVphLXowLTldW0EtWmEtejAtOS5fLy1dezAsNTExfSQvO1xuY29uc3QgU0FGRV9SRVZJU0lPTiA9IC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll8vQDorLV17MCwyNTV9JC87XG5cbmZ1bmN0aW9uIHJlcXVpcmVDb25kaXRpb24oXG4gIGNvbmRpdGlvbjogdW5rbm93bixcbiAgbWVzc2FnZTogc3RyaW5nLFxuKTogYXNzZXJ0cyBjb25kaXRpb24ge1xuICBpZiAoIWNvbmRpdGlvbikgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlSWQodmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICByZXF1aXJlQ29uZGl0aW9uKFNBRkVfSUQudGVzdCh2YWx1ZSksIGAke2xhYmVsfSBtdXN0IGJlIGEgc3RhYmxlIGlkZW50aWZpZXJgKTtcbn1cblxuZnVuY3Rpb24gcmVxdWlyZVRpbWVzdGFtcCh2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgdGltZXN0YW1wID0gRGF0ZS5wYXJzZSh2YWx1ZSk7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgTnVtYmVyLmlzRmluaXRlKHRpbWVzdGFtcCksXG4gICAgYCR7bGFiZWx9IG11c3QgYmUgYW4gSVNPIHRpbWVzdGFtcGAsXG4gICk7XG4gIHJldHVybiB0aW1lc3RhbXA7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVSZWZlcmVuY2UodmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHZhbHVlLnRyaW0oKS5sZW5ndGggPiAwICYmIHZhbHVlLmxlbmd0aCA8PSAxMDI0ICYmICEvW1xcclxcblxcMF0vLnRlc3QodmFsdWUpLFxuICAgIGAke2xhYmVsfSBtdXN0IGJlIGEgbm9uLWVtcHR5IHJlc29sdmVyIHJlZmVyZW5jZWAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVSZWxhdGl2ZVBhdGgodmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIFNBRkVfUkVMQVRJVkVfUEFUSC50ZXN0KHZhbHVlKSAmJlxuICAgICAgIXZhbHVlLnN0YXJ0c1dpdGgoXCIvXCIpICYmXG4gICAgICAhdmFsdWUuc3BsaXQoXCIvXCIpLnNvbWUoKHBhcnQpID0+IHBhcnQgPT09IFwiLlwiIHx8IHBhcnQgPT09IFwiLi5cIiksXG4gICAgYCR7bGFiZWx9IG11c3QgYmUgYSBzYWZlIHJlbGF0aXZlIHdvcmtzcGFjZSBwYXRoYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVxdWlyZVJlcG9zaXRvcnlVcmwodmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzY3BTdHlsZSA9IC9eZ2l0QFtBLVphLXowLTkuLV0rOltBLVphLXowLTkuXy8tXSsoPzpcXC5naXQpPyQvLnRlc3QoXG4gICAgdmFsdWUsXG4gICk7XG4gIGlmIChzY3BTdHlsZSkgcmV0dXJuO1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTCh2YWx1ZSk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic291cmNlLnJlcG9zaXRvcnlVcmwgbXVzdCBiZSBhbiBIVFRQUywgU1NILCBvciBnaXRAIHJlcG9zaXRvcnkgVVJMXCIsXG4gICAgKTtcbiAgfVxuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHBhcnNlZC5wcm90b2NvbCA9PT0gXCJodHRwczpcIiB8fCBwYXJzZWQucHJvdG9jb2wgPT09IFwic3NoOlwiLFxuICAgIFwic291cmNlLnJlcG9zaXRvcnlVcmwgbXVzdCB1c2UgSFRUUFMgb3IgU1NIXCIsXG4gICk7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgIXBhcnNlZC51c2VybmFtZSAmJiAhcGFyc2VkLnBhc3N3b3JkICYmICFwYXJzZWQuc2VhcmNoICYmICFwYXJzZWQuaGFzaCxcbiAgICBcInNvdXJjZS5yZXBvc2l0b3J5VXJsIG11c3Qgbm90IGNvbnRhaW4gY3JlZGVudGlhbHMsIHF1ZXJ5IHBhcmFtZXRlcnMsIG9yIGZyYWdtZW50c1wiLFxuICApO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUltcG9ydFNlbGVjdGlvbihcbiAgaW5jbHVkZTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEltcG9ydFVuaXRbXSxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIGluY2x1ZGUubGVuZ3RoID4gMCxcbiAgICBgJHtsYWJlbH0gbXVzdCBleHBsaWNpdGx5IHNlbGVjdCBhdCBsZWFzdCBvbmUgdW5pdGAsXG4gICk7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgbmV3IFNldChpbmNsdWRlKS5zaXplID09PSBpbmNsdWRlLmxlbmd0aCxcbiAgICBgJHtsYWJlbH0gbXVzdCBub3QgY29udGFpbiBkdXBsaWNhdGUgdW5pdHNgLFxuICApO1xuICBmb3IgKGNvbnN0IHVuaXQgb2YgaW5jbHVkZSkge1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICAoV09SS1NQQUNFX0hPU1RfSU1QT1JUX1VOSVRTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh1bml0KSxcbiAgICAgIGAke2xhYmVsfSBjb250YWlucyB1bnN1cHBvcnRlZCB1bml0ICcke3VuaXR9J2AsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBiaW5kaW5ncyhcbiAgcmVmczogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZzLFxuICBkZWxpdmVyeTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVNldCxcbik6IENyZWRlbnRpYWxCaW5kaW5nW10ge1xuICBjb25zdCByZXN1bHQ6IENyZWRlbnRpYWxCaW5kaW5nW10gPSBbXG4gICAge1xuICAgICAgY2hhbm5lbDogXCJjbG91ZFwiLFxuICAgICAgY3JlZGVudGlhbFJlZjogcmVmcy5jbG91ZENyZWRlbnRpYWxSZWYsXG4gICAgICBkZWxpdmVyeTogZGVsaXZlcnkuY2xvdWQsXG4gICAgfSxcbiAgXTtcbiAgaWYgKHJlZnMuZ2l0Q3JlZGVudGlhbFJlZiAmJiBkZWxpdmVyeS5naXQpIHtcbiAgICByZXN1bHQucHVzaCh7XG4gICAgICBjaGFubmVsOiBcImdpdFwiLFxuICAgICAgY3JlZGVudGlhbFJlZjogcmVmcy5naXRDcmVkZW50aWFsUmVmLFxuICAgICAgZGVsaXZlcnk6IGRlbGl2ZXJ5LmdpdCxcbiAgICB9KTtcbiAgfVxuICBpZiAocmVmcy5hZ2VudENyZWRlbnRpYWxSZWYgJiYgZGVsaXZlcnkuYWdlbnQpIHtcbiAgICByZXN1bHQucHVzaCh7XG4gICAgICBjaGFubmVsOiBcImFnZW50XCIsXG4gICAgICBjcmVkZW50aWFsUmVmOiByZWZzLmFnZW50Q3JlZGVudGlhbFJlZixcbiAgICAgIGRlbGl2ZXJ5OiBkZWxpdmVyeS5hZ2VudCxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5jb25zdCBBTExPV0VEX0RFTElWRVJZOiBSZWFkb25seTxcbiAgUmVjb3JkPFxuICAgIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbCxcbiAgICByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5S2luZFtdXG4gID5cbj4gPSB7XG4gIGNsb3VkOiBbXCJwcm92aWRlci1pZGVudGl0eVwiLCBcInNob3J0LWxpdmVkLWRlbGVnYXRpb25cIiwgXCJlbmNyeXB0ZWQtcmVmZXJlbmNlXCJdLFxuICBnaXQ6IFtcImZvcndhcmRlZC1hZ2VudFwiLCBcInNob3J0LWxpdmVkLWRlbGVnYXRpb25cIiwgXCJlbmNyeXB0ZWQtcmVmZXJlbmNlXCJdLFxuICBhZ2VudDogW1wiZm9yd2FyZGVkLWFnZW50XCIsIFwic2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLCBcImVuY3J5cHRlZC1yZWZlcmVuY2VcIl0sXG59O1xuXG4vKipcbiAqIFJlZnVzZSwgYXQgUExBTiB0aW1lLCBhbnkgY2hhbm5lbCB3aG9zZSBtYXRlcmlhbCBtdXN0IGJlIHdyaXR0ZW4gdG8gYSBob3N0IHRoZSBwcm92aWRlciBjYW5ub3RcbiAqIHdyaXRlIHRvIChELTIxNSBwb2ludCA2KS5cbiAqXG4gKiBUaGlzIGlzIHdoYXQgbWFrZXMgdGhlIGBmaWxlVHJhbnNmZXJgIGNhcGFiaWxpdHkgbG9hZC1iZWFyaW5nIHJhdGhlciB0aGFuIGRlY29yYXRpdmUuIFdpdGhvdXQgaXRcbiAqIHRoZSByZWZ1c2FsIGhhcHBlbnMgb24gYSBSVU5OSU5HIGhvc3QgaW5zaWRlIGBiaW5kKClgLCBhc1xuICogYGRlbGl2ZXJlZCBtYXRlcmlhbCBmb3IgZmFtaWx5ICdYJyBpcyBub3QgcHJlc2VudCBvbiB0aGUgaG9zdGAg4oCUIGEgbWVzc2FnZSB0aGF0IGNhbm5vdFxuICogZGlzdGluZ3Vpc2ggXCJ0aGlzIHByb3ZpZGVyIHdhcyBuZXZlciBhYmxlIHRvIGRlbGl2ZXJcIiBmcm9tIFwiZGVsaXZlcnkgd2FzIGF0dGVtcHRlZCBhbmQgbG9zdFwiLFxuICogYW5kIHdoaWNoIGhhcyBhbHJlYWR5IGNvc3QgYSBwcm92aXNpb25lZCBWTSBieSB0aGUgdGltZSBhbnlvbmUgcmVhZHMgaXQuXG4gKlxuICogQXBwbGllZCB1bmlmb3JtbHkgdG8gZXZlcnkgbGlmZWN5Y2xlIGFjdGlvbiwgcmV2b2NhdGlvbiBpbmNsdWRlZDogaWYgdGhlIHByb3ZpZGVyIGNvdWxkIG5ldmVyXG4gKiBwbGFjZSB0aGUgZmlsZSwgdGhlcmUgaXMgbm8gYXJ0aWZhY3QgZm9yIGEgcmV2b2tlIHRvIHJlbW92ZSwgYW5kIHBsYW5uaW5nIG9uZSB3b3VsZCBhc3NlcnQgYVxuICogY2xlYW51cCB0aGF0IG5ldmVyIGhhZCBhbnl0aGluZyB0byBjbGVhbi5cbiAqL1xuZnVuY3Rpb24gcmVxdWlyZURlbGl2ZXJ5Q2FwYWJpbGl0eShcbiAgYmluZGluZ3M6IHJlYWRvbmx5IENyZWRlbnRpYWxCaW5kaW5nW10sXG4gIGNhcGFiaWxpdGllczogV29ya3NwYWNlSG9zdERlbGl2ZXJ5Q2FwYWJpbGl0aWVzLFxuKTogdm9pZCB7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgdHlwZW9mIGNhcGFiaWxpdGllcz8uZmlsZVRyYW5zZmVyID09PSBcImJvb2xlYW5cIixcbiAgICBcImRlbGl2ZXJ5Q2FwYWJpbGl0aWVzLmZpbGVUcmFuc2ZlciBtdXN0IGJlIGRlY2xhcmVkXCIsXG4gICk7XG4gIGlmIChjYXBhYmlsaXRpZXMuZmlsZVRyYW5zZmVyKSByZXR1cm47XG4gIGZvciAoY29uc3QgYmluZGluZyBvZiBiaW5kaW5ncykge1xuICAgIGlmIChcbiAgICAgIFdPUktTUEFDRV9IT1NUX0NIQU5ORUxTX1JFUVVJUklOR19GSUxFX0RFTElWRVJZLmluY2x1ZGVzKGJpbmRpbmcuY2hhbm5lbClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5Q2FwYWJpbGl0eUVycm9yKGJpbmRpbmcuY2hhbm5lbCk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogQHBhcmFtIGNhcGFiaWxpdGllcyB0aGUgZXhlY3V0aW5nIHByb3ZpZGVyJ3MgZGVjbGFyZWQgdHJhbnNwb3J0LCBvciBgbnVsbGAgZm9yIGEgTUVUQURBVEEtT05MWVxuICogICB2YWxpZGF0aW9uIHRoYXQgcGxhbnMgbm8gaG9zdCB3b3JrIChhIGJhY2t1cCBtYW5pZmVzdCwgYSByZXF1ZXN0IGJvZHkgdGhhdCBhIHBsYW5uZXIgd2lsbFxuICogICBnYXRlIGxhdGVyKS4gVGhlIHBhcmFtZXRlciBpcyByZXF1aXJlZCByYXRoZXIgdGhhbiBvcHRpb25hbCBzbyBldmVyeSBjYWxsIHNpdGUgaGFzIHRvIHNheVxuICogICB3aGljaCBvZiB0aGUgdHdvIGl0IGlzIOKAlCBhbiBvbWl0dGFibGUgY2FwYWJpbGl0eSBjaGVjayBpcyB0aGUgZGVjb3JhdGl2ZSBib29sZWFuIGFnYWluLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUNyZWRlbnRpYWxTZXQoXG4gIHJlZnM6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmcyxcbiAgZGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlTZXQsXG4gIHJlcXVlc3RlZEF0OiBzdHJpbmcsXG4gIGNhcGFiaWxpdGllczogV29ya3NwYWNlSG9zdERlbGl2ZXJ5Q2FwYWJpbGl0aWVzIHwgbnVsbCxcbik6IENyZWRlbnRpYWxCaW5kaW5nW10ge1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHJlZnMuY2xvdWRDcmVkZW50aWFsUmVmPy5raW5kID09PSBcImNsb3VkXCIsXG4gICAgXCJjbG91ZENyZWRlbnRpYWxSZWYgbXVzdCBiZSBhIHR5cGVkIGNsb3VkIHJlZmVyZW5jZVwiLFxuICApO1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHJlZnMuZ2l0Q3JlZGVudGlhbFJlZj8ua2luZCAhPT0gXCJnaXRcIiA/ICFyZWZzLmdpdENyZWRlbnRpYWxSZWYgOiB0cnVlLFxuICAgIFwiZ2l0Q3JlZGVudGlhbFJlZiBtdXN0IGJlIGEgdHlwZWQgR2l0IHJlZmVyZW5jZVwiLFxuICApO1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHJlZnMuYWdlbnRDcmVkZW50aWFsUmVmPy5raW5kICE9PSBcImFnZW50XCIgPyAhcmVmcy5hZ2VudENyZWRlbnRpYWxSZWYgOiB0cnVlLFxuICAgIFwiYWdlbnRDcmVkZW50aWFsUmVmIG11c3QgYmUgYSB0eXBlZCBhZ2VudCByZWZlcmVuY2VcIixcbiAgKTtcbiAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICBCb29sZWFuKHJlZnMuZ2l0Q3JlZGVudGlhbFJlZikgPT09IEJvb2xlYW4oZGVsaXZlcnkuZ2l0KSxcbiAgICBcImdpdENyZWRlbnRpYWxSZWYgYW5kIGNyZWRlbnRpYWxEZWxpdmVyeS5naXQgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICApO1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIEJvb2xlYW4ocmVmcy5hZ2VudENyZWRlbnRpYWxSZWYpID09PSBCb29sZWFuKGRlbGl2ZXJ5LmFnZW50KSxcbiAgICBcImFnZW50Q3JlZGVudGlhbFJlZiBhbmQgY3JlZGVudGlhbERlbGl2ZXJ5LmFnZW50IG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgKTtcblxuICBjb25zdCByZXF1ZXN0ZWRBdE1zID0gcmVxdWlyZVRpbWVzdGFtcChyZXF1ZXN0ZWRBdCwgXCJyZXF1ZXN0ZWRBdFwiKTtcbiAgY29uc3QgcmVzb2x2ZWQgPSBiaW5kaW5ncyhyZWZzLCBkZWxpdmVyeSk7XG4gIGNvbnN0IHNlZW5SZWZzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHNlZW5SZXZvY2F0aW9uUmVmcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGJpbmRpbmcgb2YgcmVzb2x2ZWQpIHtcbiAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgYmluZGluZy5jcmVkZW50aWFsUmVmLmtpbmQgPT09IGJpbmRpbmcuY2hhbm5lbCxcbiAgICAgIGAke2JpbmRpbmcuY2hhbm5lbH0gY3JlZGVudGlhbCByZWZlcmVuY2Uga2luZCBkb2VzIG5vdCBtYXRjaCBpdHMgY2hhbm5lbGAsXG4gICAgKTtcbiAgICByZXF1aXJlUmVmZXJlbmNlKFxuICAgICAgYmluZGluZy5jcmVkZW50aWFsUmVmLnJlZixcbiAgICAgIGAke2JpbmRpbmcuY2hhbm5lbH1DcmVkZW50aWFsUmVmLnJlZmAsXG4gICAgKTtcbiAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgIXNlZW5SZWZzLmhhcyhiaW5kaW5nLmNyZWRlbnRpYWxSZWYucmVmKSxcbiAgICAgIFwiY2xvdWQsIEdpdCwgYW5kIGFnZW50IGNyZWRlbnRpYWwgcmVmZXJlbmNlcyBtdXN0IGJlIGRpc3RpbmN0XCIsXG4gICAgKTtcbiAgICBzZWVuUmVmcy5hZGQoYmluZGluZy5jcmVkZW50aWFsUmVmLnJlZik7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIEFMTE9XRURfREVMSVZFUllbYmluZGluZy5jaGFubmVsXS5pbmNsdWRlcyhiaW5kaW5nLmRlbGl2ZXJ5LmtpbmQpLFxuICAgICAgYGNyZWRlbnRpYWxEZWxpdmVyeS4ke2JpbmRpbmcuY2hhbm5lbH0ua2luZCBpcyBub3QgYWxsb3dlZCBmb3IgdGhhdCBjaGFubmVsYCxcbiAgICApO1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICBOdW1iZXIuaXNTYWZlSW50ZWdlcihiaW5kaW5nLmRlbGl2ZXJ5LmdlbmVyYXRpb24pICYmXG4gICAgICAgIGJpbmRpbmcuZGVsaXZlcnkuZ2VuZXJhdGlvbiA+PSAxLFxuICAgICAgYGNyZWRlbnRpYWxEZWxpdmVyeS4ke2JpbmRpbmcuY2hhbm5lbH0uZ2VuZXJhdGlvbiBtdXN0IGJlIGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyYCxcbiAgICApO1xuICAgIHJlcXVpcmVJZChcbiAgICAgIGJpbmRpbmcuZGVsaXZlcnkuYXVkaWVuY2UsXG4gICAgICBgY3JlZGVudGlhbERlbGl2ZXJ5LiR7YmluZGluZy5jaGFubmVsfS5hdWRpZW5jZWAsXG4gICAgKTtcbiAgICByZXF1aXJlUmVmZXJlbmNlKFxuICAgICAgYmluZGluZy5kZWxpdmVyeS5yZXZvY2F0aW9uUmVmLFxuICAgICAgYGNyZWRlbnRpYWxEZWxpdmVyeS4ke2JpbmRpbmcuY2hhbm5lbH0ucmV2b2NhdGlvblJlZmAsXG4gICAgKTtcbiAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgIXNlZW5SZXZvY2F0aW9uUmVmcy5oYXMoYmluZGluZy5kZWxpdmVyeS5yZXZvY2F0aW9uUmVmKSxcbiAgICAgIFwiY2xvdWQsIEdpdCwgYW5kIGFnZW50IHJldm9jYXRpb24gcmVmZXJlbmNlcyBtdXN0IGJlIGRpc3RpbmN0XCIsXG4gICAgKTtcbiAgICBzZWVuUmV2b2NhdGlvblJlZnMuYWRkKGJpbmRpbmcuZGVsaXZlcnkucmV2b2NhdGlvblJlZik7XG4gICAgaWYgKGJpbmRpbmcuZGVsaXZlcnkua2luZCA9PT0gXCJzaG9ydC1saXZlZC1kZWxlZ2F0aW9uXCIpIHtcbiAgICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICAgIHR5cGVvZiBiaW5kaW5nLmRlbGl2ZXJ5LmV4cGlyZXNBdCA9PT0gXCJzdHJpbmdcIixcbiAgICAgICAgYGNyZWRlbnRpYWxEZWxpdmVyeS4ke2JpbmRpbmcuY2hhbm5lbH0uZXhwaXJlc0F0IGlzIHJlcXVpcmVkIGZvciBzaG9ydC1saXZlZCBkZWxlZ2F0aW9uYCxcbiAgICAgICk7XG4gICAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgICByZXF1aXJlVGltZXN0YW1wKFxuICAgICAgICAgIGJpbmRpbmcuZGVsaXZlcnkuZXhwaXJlc0F0ISxcbiAgICAgICAgICBgY3JlZGVudGlhbERlbGl2ZXJ5LiR7YmluZGluZy5jaGFubmVsfS5leHBpcmVzQXRgLFxuICAgICAgICApID4gcmVxdWVzdGVkQXRNcyxcbiAgICAgICAgYGNyZWRlbnRpYWxEZWxpdmVyeS4ke2JpbmRpbmcuY2hhbm5lbH0uZXhwaXJlc0F0IG11c3QgYmUgYWZ0ZXIgcmVxdWVzdGVkQXRgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKGNhcGFiaWxpdGllcykgcmVxdWlyZURlbGl2ZXJ5Q2FwYWJpbGl0eShyZXNvbHZlZCwgY2FwYWJpbGl0aWVzKTtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICB7IHJlZnMsIGRlbGl2ZXJ5IH0sXG4gICAgXCJ3b3Jrc3BhY2VIb3N0LmNyZWRlbnRpYWxCaW5kaW5nc1wiLFxuICApO1xuICByZXR1cm4gcmVzb2x2ZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlU291cmNlKFxuICBzb3VyY2U6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblNvdXJjZSxcbiAgcmVmczogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZzLFxuKTogdm9pZCB7XG4gIGlmIChzb3VyY2Uua2luZCA9PT0gXCJlbXB0eVwiKSByZXR1cm47XG4gIGlmIChzb3VyY2Uua2luZCA9PT0gXCJyZXRhaW5lZFwiKSB7XG4gICAgcmVxdWlyZUNvbmRpdGlvbigvXlthLWYwLTldezY0fSQvLnRlc3Qoc291cmNlLnRlbmFudElkZW50aXR5KSwgXCJzb3VyY2UudGVuYW50SWRlbnRpdHkgbXVzdCBiZSBhIFNIQTI1NiB0ZW5hbnQgaWRlbnRpdHlcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzb3VyY2Uua2luZCA9PT0gXCJnaXRcIikge1xuICAgIHJlcXVpcmVSZXBvc2l0b3J5VXJsKHNvdXJjZS5yZXBvc2l0b3J5VXJsKTtcbiAgICByZXF1aXJlUmVsYXRpdmVQYXRoKHNvdXJjZS5kZXN0aW5hdGlvbiwgXCJzb3VyY2UuZGVzdGluYXRpb25cIik7XG4gICAgaWYgKHNvdXJjZS5yZXZpc2lvbikge1xuICAgICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgICAgU0FGRV9SRVZJU0lPTi50ZXN0KHNvdXJjZS5yZXZpc2lvbiksXG4gICAgICAgIFwic291cmNlLnJldmlzaW9uIG11c3QgYmUgYSBzYWZlIEdpdCByZXZpc2lvblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIHNvdXJjZS52aXNpYmlsaXR5ICE9PSBcInByaXZhdGVcIiB8fCBCb29sZWFuKHJlZnMuZ2l0Q3JlZGVudGlhbFJlZiksXG4gICAgICBcIkEgcHJpdmF0ZSByZXBvc2l0b3J5IHJlcXVpcmVzIGdpdENyZWRlbnRpYWxSZWZcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuICByZXF1aXJlSWQoc291cmNlLnNvdXJjZVdvcmtzcGFjZUlkLCBcInNvdXJjZS5zb3VyY2VXb3Jrc3BhY2VJZFwiKTtcbiAgdmFsaWRhdGVJbXBvcnRTZWxlY3Rpb24oc291cmNlLmluY2x1ZGUsIFwic291cmNlLmluY2x1ZGVcIik7XG4gIGlmIChzb3VyY2Uua2luZCA9PT0gXCJwYWlyXCIpIHtcbiAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgc291cmNlLnBhaXJpbmdSZWZlcmVuY2Uua2luZCA9PT0gXCJwYWlyaW5nXCIsXG4gICAgICBcInNvdXJjZS5wYWlyaW5nUmVmZXJlbmNlIG11c3QgYmUgYSB0eXBlZCBwYWlyaW5nIHJlZmVyZW5jZVwiLFxuICAgICk7XG4gICAgcmVxdWlyZVJlZmVyZW5jZShcbiAgICAgIHNvdXJjZS5wYWlyaW5nUmVmZXJlbmNlLnJlZixcbiAgICAgIFwic291cmNlLnBhaXJpbmdSZWZlcmVuY2UucmVmXCIsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICByZXF1aXJlUmVmZXJlbmNlKHNvdXJjZS5zb3VyY2VTbmFwc2hvdFJlZiwgXCJzb3VyY2Uuc291cmNlU25hcHNob3RSZWZcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gaW5pdFN0ZXAoXG4gIHJlcXVlc3Q6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblJlcXVlc3QsXG4gIGlkOiBzdHJpbmcsXG4gIGtpbmQ6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kLFxuICBkZXBlbmRzT246IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBpbnB1dDogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+LFxuKTogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcCB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAga2luZCxcbiAgICBkZXBlbmRzT24sXG4gICAgaWRlbXBvdGVuY3lLZXk6IGB3b3Jrc3BhY2UtaW5pdDoke3JlcXVlc3Qub3BlcmF0aW9uSWR9OiR7aWR9YCxcbiAgICBpbnB1dCxcbiAgfTtcbn1cblxuLyoqIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYywgcGVyc2lzdGFibGUgcG9zdC1ib290c3RyYXAgcGxhbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uKFxuICByZXF1ZXN0OiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25SZXF1ZXN0LFxuKTogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uUGxhbiB7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgcmVxdWVzdC5jb250cmFjdFZlcnNpb24gPT09IFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgYFVuc3VwcG9ydGVkIHdvcmtzcGFjZS1ob3N0IGluaXRpYWxpemF0aW9uIGNvbnRyYWN0ICcke3JlcXVlc3QuY29udHJhY3RWZXJzaW9ufSdgLFxuICApO1xuICByZXF1aXJlSWQocmVxdWVzdC5vcGVyYXRpb25JZCwgXCJvcGVyYXRpb25JZFwiKTtcbiAgcmVxdWlyZUlkKHJlcXVlc3Qud29ya3NwYWNlSWQsIFwid29ya3NwYWNlSWRcIik7XG4gIHJlcXVpcmVJZChyZXF1ZXN0Lmhvc3RJZCwgXCJob3N0SWRcIik7XG4gIHJlcXVpcmVUaW1lc3RhbXAocmVxdWVzdC5yZXF1ZXN0ZWRBdCwgXCJyZXF1ZXN0ZWRBdFwiKTtcbiAgdmFsaWRhdGVTb3VyY2UocmVxdWVzdC5zb3VyY2UsIHJlcXVlc3QuY3JlZGVudGlhbFJlZnMpO1xuICBjb25zdCBjcmVkZW50aWFsQmluZGluZ3MgPSB2YWxpZGF0ZUNyZWRlbnRpYWxTZXQoXG4gICAgcmVxdWVzdC5jcmVkZW50aWFsUmVmcyxcbiAgICByZXF1ZXN0LmNyZWRlbnRpYWxEZWxpdmVyeSxcbiAgICByZXF1ZXN0LnJlcXVlc3RlZEF0LFxuICAgIHJlcXVlc3QuZGVsaXZlcnlDYXBhYmlsaXRpZXMsXG4gICk7XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgcmVxdWVzdC5wdWJsaWNNZXRhZGF0YSA/PyB7fSxcbiAgICBcIndvcmtzcGFjZUhvc3QuaW5pdGlhbGl6YXRpb24ucHVibGljTWV0YWRhdGFcIixcbiAgKTtcblxuICBjb25zdCBzdGVwczogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcFtdID0gW1xuICAgIGluaXRTdGVwKHJlcXVlc3QsIFwid29ya3NwYWNlXCIsIHJlcXVlc3Quc291cmNlLmtpbmQgPT09IFwicmV0YWluZWRcIiA/IFwidmVyaWZ5LXJldGFpbmVkLXdvcmtzcGFjZVwiIDogXCJjcmVhdGUtd29ya3NwYWNlXCIsIFtdLCB7XG4gICAgICB3b3Jrc3BhY2VJZDogcmVxdWVzdC53b3Jrc3BhY2VJZCxcbiAgICAgIGhvc3RJZDogcmVxdWVzdC5ob3N0SWQsXG4gICAgICAuLi4ocmVxdWVzdC5zb3VyY2Uua2luZCA9PT0gXCJyZXRhaW5lZFwiID8geyB0ZW5hbnRJZGVudGl0eTogcmVxdWVzdC5zb3VyY2UudGVuYW50SWRlbnRpdHkgfSA6IHt9KSxcbiAgICB9KSxcbiAgXTtcbiAgY29uc3QgYmluZGluZ1N0ZXBJZHMgPSBjcmVkZW50aWFsQmluZGluZ3MubWFwKFxuICAgIChiaW5kaW5nKSA9PiBgYmluZC0ke2JpbmRpbmcuY2hhbm5lbH1gLFxuICApO1xuICBjb25zdCBhZGRCaW5kaW5nU3RlcCA9IChcbiAgICBiaW5kaW5nOiBDcmVkZW50aWFsQmluZGluZyxcbiAgICBkZXBlbmRzT246IHJlYWRvbmx5IHN0cmluZ1tdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBpZCA9IGBiaW5kLSR7YmluZGluZy5jaGFubmVsfWA7XG4gICAgc3RlcHMucHVzaChcbiAgICAgIGluaXRTdGVwKHJlcXVlc3QsIGlkLCBcImJpbmQtY3JlZGVudGlhbFwiLCBkZXBlbmRzT24sIHtcbiAgICAgICAgY2hhbm5lbDogYmluZGluZy5jaGFubmVsLFxuICAgICAgICBjcmVkZW50aWFsUmVmOiBiaW5kaW5nLmNyZWRlbnRpYWxSZWYsXG4gICAgICAgIGRlbGl2ZXJ5OiBiaW5kaW5nLmRlbGl2ZXJ5LFxuICAgICAgfSksXG4gICAgKTtcbiAgfTtcbiAgY29uc3QgcHJpdmF0ZUdpdEJpbmRpbmcgPVxuICAgIHJlcXVlc3Quc291cmNlLmtpbmQgPT09IFwiZ2l0XCIgJiYgcmVxdWVzdC5zb3VyY2UudmlzaWJpbGl0eSA9PT0gXCJwcml2YXRlXCJcbiAgICAgID8gY3JlZGVudGlhbEJpbmRpbmdzLmZpbmQoKGJpbmRpbmcpID0+IGJpbmRpbmcuY2hhbm5lbCA9PT0gXCJnaXRcIilcbiAgICAgIDogdW5kZWZpbmVkO1xuICBpZiAocHJpdmF0ZUdpdEJpbmRpbmcpIHtcbiAgICBhZGRCaW5kaW5nU3RlcChwcml2YXRlR2l0QmluZGluZywgW1wid29ya3NwYWNlXCJdKTtcbiAgfVxuXG4gIGxldCBzb3VyY2VTdGVwSWQgPSBcIndvcmtzcGFjZVwiO1xuICBpZiAocmVxdWVzdC5zb3VyY2Uua2luZCAhPT0gXCJlbXB0eVwiICYmIHJlcXVlc3Quc291cmNlLmtpbmQgIT09IFwicmV0YWluZWRcIikge1xuICAgIGNvbnN0IGtpbmQgPVxuICAgICAgcmVxdWVzdC5zb3VyY2Uua2luZCA9PT0gXCJnaXRcIlxuICAgICAgICA/IFwiY2xvbmUtcmVwb3NpdG9yeVwiXG4gICAgICAgIDogcmVxdWVzdC5zb3VyY2Uua2luZCA9PT0gXCJwYWlyXCJcbiAgICAgICAgICA/IFwicGFpci13b3Jrc3BhY2VcIlxuICAgICAgICAgIDogXCJpbXBvcnQtd29ya3NwYWNlXCI7XG4gICAgc291cmNlU3RlcElkID0gXCJzb3VyY2VcIjtcbiAgICBzdGVwcy5wdXNoKFxuICAgICAgaW5pdFN0ZXAoXG4gICAgICAgIHJlcXVlc3QsXG4gICAgICAgIHNvdXJjZVN0ZXBJZCxcbiAgICAgICAga2luZCxcbiAgICAgICAgcHJpdmF0ZUdpdEJpbmRpbmcgPyBbXCJiaW5kLWdpdFwiXSA6IFtcIndvcmtzcGFjZVwiXSxcbiAgICAgICAgcmVxdWVzdC5zb3VyY2Uua2luZCA9PT0gXCJnaXRcIiAmJiByZXF1ZXN0LnNvdXJjZS52aXNpYmlsaXR5ID09PSBcInByaXZhdGVcIlxuICAgICAgICAgID8geyAuLi5yZXF1ZXN0LnNvdXJjZSwgY3JlZGVudGlhbENoYW5uZWw6IFwiZ2l0XCIgfVxuICAgICAgICAgIDogeyAuLi5yZXF1ZXN0LnNvdXJjZSB9LFxuICAgICAgKSxcbiAgICApO1xuICB9XG5cbiAgZm9yIChjb25zdCBiaW5kaW5nIG9mIGNyZWRlbnRpYWxCaW5kaW5ncykge1xuICAgIGlmIChiaW5kaW5nID09PSBwcml2YXRlR2l0QmluZGluZykgY29udGludWU7XG4gICAgYWRkQmluZGluZ1N0ZXAoYmluZGluZywgW3NvdXJjZVN0ZXBJZF0pO1xuICB9XG4gIHN0ZXBzLnB1c2goXG4gICAgaW5pdFN0ZXAocmVxdWVzdCwgXCJ2ZXJpZnlcIiwgXCJ2ZXJpZnktaW5pdGlhbGl6YXRpb25cIiwgYmluZGluZ1N0ZXBJZHMsIHtcbiAgICAgIHNvdXJjZUtpbmQ6IHJlcXVlc3Quc291cmNlLmtpbmQsXG4gICAgICAuLi4ocmVxdWVzdC5yZXF1ZXN0ZWRBZ2VudHMgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgcmVxdWVzdGVkQWdlbnRzOiByZXNvbHZlV29ya3NwYWNlSG9zdFJlcXVlc3RlZEFnZW50cyhyZXF1ZXN0LnJlcXVlc3RlZEFnZW50cykgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIHJlcXVpcmVkQ2hhbm5lbHM6IGNyZWRlbnRpYWxCaW5kaW5ncy5tYXAoKGJpbmRpbmcpID0+IGJpbmRpbmcuY2hhbm5lbCksXG4gICAgICAuLi4ocmVxdWVzdC5zb3VyY2Uua2luZCA9PT0gXCJnaXRcIlxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlcG9zaXRvcnk6IHtcbiAgICAgICAgICAgICAgZGVzdGluYXRpb246IHJlcXVlc3Quc291cmNlLmRlc3RpbmF0aW9uLFxuICAgICAgICAgICAgICB2aXNpYmlsaXR5OiByZXF1ZXN0LnNvdXJjZS52aXNpYmlsaXR5LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pLFxuICApO1xuXG4gIGNvbnN0IHBsYW46IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblBsYW4gPSB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OLFxuICAgIG9wZXJhdGlvbklkOiByZXF1ZXN0Lm9wZXJhdGlvbklkLFxuICAgIHdvcmtzcGFjZUlkOiByZXF1ZXN0LndvcmtzcGFjZUlkLFxuICAgIGhvc3RJZDogcmVxdWVzdC5ob3N0SWQsXG4gICAgcmVxdWVzdGVkQXQ6IHJlcXVlc3QucmVxdWVzdGVkQXQsXG4gICAgc3RlcHMsXG4gICAgLi4uKHJlcXVlc3QucHVibGljTWV0YWRhdGFcbiAgICAgID8geyBwdWJsaWNNZXRhZGF0YTogcmVxdWVzdC5wdWJsaWNNZXRhZGF0YSB9XG4gICAgICA6IHt9KSxcbiAgfTtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihwbGFuLCBcIndvcmtzcGFjZUhvc3QuaW5pdGlhbGl6YXRpb24ucGxhblwiKTtcbiAgcmV0dXJuIHBsYW47XG59XG5cbi8qKiBFeGVjdXRlIGEgcGxhbiB0aHJvdWdoIHRoZSBleGlzdGluZyBkdXJhYmxlIGhvc3QgY29udHJvbGxlcidzIGluamVjdGVkIGFkYXB0ZXIgc2VhbS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uKFxuICBwbGFuOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25QbGFuLFxuICBleGVjdXRvcjogV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uRXhlY3V0b3IsXG4pOiBQcm9taXNlPHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBSZWNlaXB0W10+IHtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihwbGFuLCBcIndvcmtzcGFjZUhvc3QuaW5pdGlhbGl6YXRpb24ucGxhblwiKTtcbiAgY29uc3QgY29tcGxldGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHJlY2VpcHRzOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwUmVjZWlwdFtdID0gW107XG4gIGZvciAoY29uc3Qgc3RlcCBvZiBwbGFuLnN0ZXBzKSB7XG4gICAgZm9yIChjb25zdCBkZXBlbmRlbmN5IG9mIHN0ZXAuZGVwZW5kc09uKSB7XG4gICAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgICBjb21wbGV0ZWQuaGFzKGRlcGVuZGVuY3kpLFxuICAgICAgICBgSW5pdGlhbGl6YXRpb24gc3RlcCAnJHtzdGVwLmlkfScgZGVwZW5kZW5jeSAnJHtkZXBlbmRlbmN5fScgaGFzIG5vdCBjb21wbGV0ZWRgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IGV4ZWN1dG9yLmV4ZWN1dGUoc3RlcCk7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIHJlY2VpcHQuc3RlcElkID09PSBzdGVwLmlkICYmIHJlY2VpcHQuc3RhdHVzID09PSBcInN1Y2NlZWRlZFwiLFxuICAgICAgYEluaXRpYWxpemF0aW9uIHN0ZXAgJyR7c3RlcC5pZH0nIHJldHVybmVkIGFuIGludmFsaWQgcmVjZWlwdGAsXG4gICAgKTtcbiAgICByZXF1aXJlVGltZXN0YW1wKHJlY2VpcHQub2JzZXJ2ZWRBdCwgYHJlY2VpcHQuJHtzdGVwLmlkfS5vYnNlcnZlZEF0YCk7XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICAgIHJlY2VpcHQucHVibGljRXZpZGVuY2UgPz8ge30sXG4gICAgICBgd29ya3NwYWNlSG9zdC5pbml0aWFsaXphdGlvbi5yZWNlaXB0LiR7c3RlcC5pZH1gLFxuICAgICk7XG4gICAgcmVjZWlwdHMucHVzaChyZWNlaXB0KTtcbiAgICBjb21wbGV0ZWQuYWRkKHN0ZXAuaWQpO1xuICB9XG4gIHJldHVybiByZWNlaXB0cztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QmFja3VwQ3JlZGVudGlhbE1hbmlmZXN0IHtcbiAgY29udHJhY3RWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfSU5JVElBTElaQVRJT05fQ09OVFJBQ1RfVkVSU0lPTjtcbiAgd29ya3NwYWNlSWQ6IHN0cmluZztcbiAgY2FwdHVyZWRBdDogc3RyaW5nO1xuICBhdXRob3JpemF0aW9uTWF0ZXJpYWw6IFwiZXhjbHVkZWRcIjtcbiAgY3JlZGVudGlhbFJlZmVyZW5jZXM6IFwiZXhjbHVkZWRcIjtcbiAgcmViaW5kUmVxdWlyZWQ6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbFtdO1xuICAvKiogUHVibGljIGNvbXBhcmlzb24gbWV0YWRhdGEgb25seTsgbmVpdGhlciByZWZlcmVuY2UgaXMgcmV0YWluZWQuICovXG4gIGJpbmRpbmdTdGF0ZTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdEJhY2t1cENyZWRlbnRpYWxCaW5kaW5nU3RhdGVbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QmFja3VwQ3JlZGVudGlhbEJpbmRpbmdTdGF0ZSB7XG4gIGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgZ2VuZXJhdGlvbjogbnVtYmVyO1xuICByZXZvY2F0aW9uUmVmU2hhMjU2OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQmFja3VwcyByZW1lbWJlciB3aGljaCBydW50aW1lIGNoYW5uZWxzIG11c3QgYmUgcmVib3VuZCBhbmQgb25seSBlbm91Z2hcbiAqIG9uZS13YXkgbWV0YWRhdGEgdG8gcHJvdmUgdGhlIHJlcGxhY2VtZW50IGlzIG5ld2VyLiBOZWl0aGVyIHJlc29sdmVkXG4gKiBhdXRob3JpemF0aW9uIG5vciBjcmVkZW50aWFsLXJlZmVyZW5jZSBsb2NhdGlvbnMgZW50ZXIgdGhlIGJhY2t1cC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkV29ya3NwYWNlSG9zdEJhY2t1cENyZWRlbnRpYWxNYW5pZmVzdChcbiAgd29ya3NwYWNlSWQ6IHN0cmluZyxcbiAgY2FwdHVyZWRBdDogc3RyaW5nLFxuICByZWZzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZnMsXG4gIGRlbGl2ZXJ5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5U2V0LFxuKTogV29ya3NwYWNlSG9zdEJhY2t1cENyZWRlbnRpYWxNYW5pZmVzdCB7XG4gIHJlcXVpcmVJZCh3b3Jrc3BhY2VJZCwgXCJ3b3Jrc3BhY2VJZFwiKTtcbiAgLy8gTWV0YWRhdGEtb25seTogcmVjb3JkaW5nIFdISUNIIGNoYW5uZWxzIGEgcmVzdG9yZSBtdXN0IHJlYmluZCBwbGFucyBubyBob3N0IHdvcmssIGFuZCBhXG4gIC8vIHByb3ZpZGVyIHRoYXQgY2Fubm90IGRlbGl2ZXIgbXVzdCBzdGlsbCBiZSBhYmxlIHRvIGJhY2sgdXAgdGhlIHJlY29yZCBvZiB3aGF0IHdhcyBib3VuZC5cbiAgY29uc3QgY3VycmVudCA9IHZhbGlkYXRlQ3JlZGVudGlhbFNldChyZWZzLCBkZWxpdmVyeSwgY2FwdHVyZWRBdCwgbnVsbCk7XG4gIGNvbnN0IG1hbmlmZXN0OiBXb3Jrc3BhY2VIb3N0QmFja3VwQ3JlZGVudGlhbE1hbmlmZXN0ID0ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogV09SS1NQQUNFX0hPU1RfSU5JVElBTElaQVRJT05fQ09OVFJBQ1RfVkVSU0lPTixcbiAgICB3b3Jrc3BhY2VJZCxcbiAgICBjYXB0dXJlZEF0LFxuICAgIGF1dGhvcml6YXRpb25NYXRlcmlhbDogXCJleGNsdWRlZFwiLFxuICAgIGNyZWRlbnRpYWxSZWZlcmVuY2VzOiBcImV4Y2x1ZGVkXCIsXG4gICAgcmViaW5kUmVxdWlyZWQ6IGN1cnJlbnQubWFwKChiaW5kaW5nKSA9PiBiaW5kaW5nLmNoYW5uZWwpLFxuICAgIGJpbmRpbmdTdGF0ZTogY3VycmVudC5tYXAoKGJpbmRpbmcpID0+ICh7XG4gICAgICBjaGFubmVsOiBiaW5kaW5nLmNoYW5uZWwsXG4gICAgICBnZW5lcmF0aW9uOiBiaW5kaW5nLmRlbGl2ZXJ5LmdlbmVyYXRpb24sXG4gICAgICByZXZvY2F0aW9uUmVmU2hhMjU2OiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgIC51cGRhdGUoYmluZGluZy5kZWxpdmVyeS5yZXZvY2F0aW9uUmVmLCBcInV0ZjhcIilcbiAgICAgICAgLmRpZ2VzdChcImhleFwiKSxcbiAgICB9KSksXG4gIH07XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgbWFuaWZlc3QsXG4gICAgXCJ3b3Jrc3BhY2VIb3N0LmJhY2t1cENyZWRlbnRpYWxNYW5pZmVzdFwiLFxuICApO1xuICByZXR1cm4gbWFuaWZlc3Q7XG59XG5cbmludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZUJhc2Uge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICBvcGVyYXRpb25JZDogc3RyaW5nO1xuICB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICBob3N0SWQ6IHN0cmluZztcbiAgcmVxdWVzdGVkQXQ6IHN0cmluZztcbiAgLyoqIFRoZSBleGVjdXRpbmcgcHJvdmlkZXIncyBkZWNsYXJlZCB0cmFuc3BvcnQgZmVhdHVyZXM7IGdhdGVzIHRoZSBkZWxpdmVyeS1iZWFyaW5nIGNoYW5uZWxzLiAqL1xuICBkZWxpdmVyeUNhcGFiaWxpdGllczogV29ya3NwYWNlSG9zdERlbGl2ZXJ5Q2FwYWJpbGl0aWVzO1xufVxuXG4vKiogUm91dGUtcmVhZHkgcmVzdG9yZSBib2R5OyBjb250cm9sbGVyLW93bmVkIGlkcyBhbmQgdGltZXN0YW1wcyBhcmUgYWRkZWQgYnkgdGhlIHJ1bm5lci4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEJhY2t1cFJlc3RvcmVDcmVkZW50aWFsUmViaW5kUmVxdWVzdCB7XG4gIGFjdGlvbjogXCJyZXN0b3JlLXJlYmluZFwiO1xuICBiYWNrdXA6IFdvcmtzcGFjZUhvc3RCYWNrdXBDcmVkZW50aWFsTWFuaWZlc3Q7XG4gIG5leHRDcmVkZW50aWFsUmVmczogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZzO1xuICBuZXh0RGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlTZXQ7XG59XG5cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlUmVxdWVzdCA9XG4gIHwgKFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlQmFzZSAmIHtcbiAgICAgIGFjdGlvbjogXCJyb3RhdGVcIjtcbiAgICAgIGN1cnJlbnRDcmVkZW50aWFsUmVmczogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZzO1xuICAgICAgY3VycmVudERlbGl2ZXJ5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5U2V0O1xuICAgICAgbmV4dENyZWRlbnRpYWxSZWZzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZnM7XG4gICAgICBuZXh0RGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlTZXQ7XG4gICAgfSlcbiAgfCAoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVCYXNlICYge1xuICAgICAgYWN0aW9uOiBcInJldm9rZVwiO1xuICAgICAgY3VycmVudENyZWRlbnRpYWxSZWZzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZnM7XG4gICAgICBjdXJyZW50RGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlTZXQ7XG4gICAgICBjaGFubmVsczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsW107XG4gICAgfSlcbiAgfCAoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVCYXNlICYge1xuICAgICAgYWN0aW9uOiBcInJlY29ubmVjdFwiO1xuICAgICAgY3VycmVudENyZWRlbnRpYWxSZWZzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZnM7XG4gICAgICBjdXJyZW50RGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlTZXQ7XG4gICAgfSlcbiAgfCAoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVCYXNlICZcbiAgICAgIFdvcmtzcGFjZUhvc3RCYWNrdXBSZXN0b3JlQ3JlZGVudGlhbFJlYmluZFJlcXVlc3QpO1xuXG4vKipcbiAqIFRoZSBmb3VyIGxpZmVjeWNsZSBzdGVwIGtpbmRzLCBhcyBhIFJVTlRJTUUgYXJyYXkuXG4gKlxuICogVGhpcyB1c2VkIHRvIGJlIGEgaGFuZC13cml0dGVuIHR5cGUgdW5pb24sIHdoaWNoIG1lYW50IG5vIGNhbGxlciBjb3VsZCB2YWxpZGF0ZSBhbiBpbmJvdW5kXG4gKiBga2luZGAgc3RyaW5nIGFnYWluc3QgaXQg4oCUIGEgd2lyZSBwYXJzZXIgaGFkIHRvIHJlc3RhdGUgdGhlIGZvdXIgbGl0ZXJhbHMgdG8gY2hlY2sgbWVtYmVyc2hpcCxcbiAqIGFuZCBhIHJlc3RhdGVkIGxpc3QgaXMgdGhlIGNvcHkgdGhhdCBzaWxlbnRseSBzdG9wcyBtYXRjaGluZy4gVGhlIGluaXRpYWxpemF0aW9uIHN0ZXAga2luZHNcbiAqIG5leHQgZG9vciB3ZXJlIGFscmVhZHkgZGVjbGFyZWQgdGhpcyB3YXk7IHRoaXMgbWlycm9ycyB0aGVtIHNvIHRoZSByZW1vdGUtaW5pdGlhbGl6ZXIgcHJvdG9jb2xcbiAqIGNhbiB2YWxpZGF0ZSBsaWZlY3ljbGUgc3RlcHMgZnJvbSB0aGUgc2FtZSBzb3VyY2UgdGhhdCBkZWZpbmVzIHRoZW0uXG4gKlxuICogVGhlIHZhbHVlcyBkZWxpYmVyYXRlbHkgZXF1YWwgYFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsT3BlcmF0aW9uYCBpbiB3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLVxuICogbmFtZXNwYWNlLnRzOiBhIGxpZmVjeWNsZSBzdGVwIElTIGEgcmVxdWVzdCB0byBydW4gb25lIGNyZWRlbnRpYWwgb3BlcmF0aW9uLCB3aGljaCBpcyB3aHlcbiAqIGBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlc29sdmVyLmV4ZWN1dGVMaWZlY3ljbGVTdGVwYCBjYW4gZGlzcGF0Y2ggb24gYHN0ZXAua2luZGAgZGlyZWN0bHkuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0xJRkVDWUNMRV9TVEVQX0tJTkRTID0gW1xuICBcImJpbmRcIixcbiAgXCJ2ZXJpZnktYm91bmRcIixcbiAgXCJyZXZva2VcIixcbiAgXCJ2ZXJpZnktcmV2b2tlZFwiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcEtpbmQgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTElGRUNZQ0xFX1NURVBfS0lORFMpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVTdGVwIHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVTdGVwS2luZDtcbiAgY2hhbm5lbDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsO1xuICBkZXBlbmRzT246IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBpZGVtcG90ZW5jeUtleTogc3RyaW5nO1xuICBjcmVkZW50aWFsUmVmOiBBbnlDcmVkZW50aWFsUmVmO1xuICAvKiogUHVibGljIHJlc29sdmVyIG1ldGFkYXRhIHJlcXVpcmVkIGZvciBiaW5kaW5nIGFuZCByZXZvY2F0aW9uLiAqL1xuICBkZWxpdmVyeTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVBsYW4ge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICBvcGVyYXRpb25JZDogc3RyaW5nO1xuICB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICBob3N0SWQ6IHN0cmluZztcbiAgYWN0aW9uOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVJlcXVlc3RbXCJhY3Rpb25cIl07XG4gIHJlcXVlc3RlZEF0OiBzdHJpbmc7XG4gIHN0ZXBzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBbXTtcbn1cblxuZnVuY3Rpb24gbGlmZWN5Y2xlU3RlcChcbiAgcmVxdWVzdDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVSZXF1ZXN0LFxuICBpZDogc3RyaW5nLFxuICBraW5kOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBLaW5kLFxuICBiaW5kaW5nOiBDcmVkZW50aWFsQmluZGluZyxcbiAgZGVwZW5kc09uOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcCB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAga2luZCxcbiAgICBjaGFubmVsOiBiaW5kaW5nLmNoYW5uZWwsXG4gICAgZGVwZW5kc09uLFxuICAgIGlkZW1wb3RlbmN5S2V5OiBgd29ya3NwYWNlLWNyZWRlbnRpYWw6JHtyZXF1ZXN0Lm9wZXJhdGlvbklkfToke2lkfWAsXG4gICAgY3JlZGVudGlhbFJlZjogYmluZGluZy5jcmVkZW50aWFsUmVmLFxuICAgIGRlbGl2ZXJ5OiBiaW5kaW5nLmRlbGl2ZXJ5LFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUxpZmVjeWNsZUJhc2UoXG4gIHJlcXVlc3Q6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlUmVxdWVzdCxcbik6IHZvaWQge1xuICByZXF1aXJlQ29uZGl0aW9uKFxuICAgIHJlcXVlc3QuY29udHJhY3RWZXJzaW9uID09PSBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OLFxuICAgIGBVbnN1cHBvcnRlZCB3b3Jrc3BhY2UtaG9zdCBpbml0aWFsaXphdGlvbiBjb250cmFjdCAnJHtyZXF1ZXN0LmNvbnRyYWN0VmVyc2lvbn0nYCxcbiAgKTtcbiAgcmVxdWlyZUlkKHJlcXVlc3Qub3BlcmF0aW9uSWQsIFwib3BlcmF0aW9uSWRcIik7XG4gIHJlcXVpcmVJZChyZXF1ZXN0LndvcmtzcGFjZUlkLCBcIndvcmtzcGFjZUlkXCIpO1xuICByZXF1aXJlSWQocmVxdWVzdC5ob3N0SWQsIFwiaG9zdElkXCIpO1xuICByZXF1aXJlVGltZXN0YW1wKHJlcXVlc3QucmVxdWVzdGVkQXQsIFwicmVxdWVzdGVkQXRcIik7XG59XG5cbmZ1bmN0aW9uIHNhbWVDaGFubmVscyhcbiAgYTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsW10sXG4gIGI6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbFtdLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhLmxlbmd0aCA9PT0gYi5sZW5ndGggJiYgYS5ldmVyeSgoY2hhbm5lbCkgPT4gYi5pbmNsdWRlcyhjaGFubmVsKSk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQmFja3VwQ3JlZGVudGlhbE1hbmlmZXN0KFxuICBiYWNrdXA6IFdvcmtzcGFjZUhvc3RCYWNrdXBDcmVkZW50aWFsTWFuaWZlc3QsXG4gIHdvcmtzcGFjZUlkOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICBiYWNrdXAuY29udHJhY3RWZXJzaW9uID09PSBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OICYmXG4gICAgICBiYWNrdXAud29ya3NwYWNlSWQgPT09IHdvcmtzcGFjZUlkICYmXG4gICAgICBiYWNrdXAuYXV0aG9yaXphdGlvbk1hdGVyaWFsID09PSBcImV4Y2x1ZGVkXCIgJiZcbiAgICAgIGJhY2t1cC5jcmVkZW50aWFsUmVmZXJlbmNlcyA9PT0gXCJleGNsdWRlZFwiLFxuICAgIFwiUmVzdG9yZSByZXF1aXJlcyBhIG1hdGNoaW5nIGNyZWRlbnRpYWwtZnJlZSBiYWNrdXAgbWFuaWZlc3RcIixcbiAgKTtcbiAgcmVxdWlyZVRpbWVzdGFtcChiYWNrdXAuY2FwdHVyZWRBdCwgXCJiYWNrdXAuY2FwdHVyZWRBdFwiKTtcbiAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICBBcnJheS5pc0FycmF5KGJhY2t1cC5iaW5kaW5nU3RhdGUpICYmIGJhY2t1cC5iaW5kaW5nU3RhdGUubGVuZ3RoID4gMCxcbiAgICBcIlJlc3RvcmUgYmFja3VwIG11c3QgaW5jbHVkZSBjcmVkZW50aWFsIHJlcGxhY2VtZW50IG1ldGFkYXRhXCIsXG4gICk7XG4gIGNvbnN0IGNoYW5uZWxzID0gYmFja3VwLmJpbmRpbmdTdGF0ZS5tYXAoKGJpbmRpbmcpID0+IGJpbmRpbmcuY2hhbm5lbCk7XG4gIHJlcXVpcmVDb25kaXRpb24oXG4gICAgbmV3IFNldChjaGFubmVscykuc2l6ZSA9PT0gY2hhbm5lbHMubGVuZ3RoICYmXG4gICAgICBjaGFubmVscy5ldmVyeSgoY2hhbm5lbCkgPT5cbiAgICAgICAgKFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKFxuICAgICAgICAgIGNoYW5uZWwsXG4gICAgICAgICksXG4gICAgICApICYmXG4gICAgICBzYW1lQ2hhbm5lbHMoYmFja3VwLnJlYmluZFJlcXVpcmVkLCBjaGFubmVscyksXG4gICAgXCJSZXN0b3JlIGJhY2t1cCByZXBsYWNlbWVudCBtZXRhZGF0YSBtdXN0IGNvdmVyIGV2ZXJ5IGNoYW5uZWwgbmFtZWQgYnkgdGhlIG1hbmlmZXN0XCIsXG4gICk7XG4gIGZvciAoY29uc3QgYmluZGluZyBvZiBiYWNrdXAuYmluZGluZ1N0YXRlKSB7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIE51bWJlci5pc1NhZmVJbnRlZ2VyKGJpbmRpbmcuZ2VuZXJhdGlvbikgJiYgYmluZGluZy5nZW5lcmF0aW9uID49IDEsXG4gICAgICBgUmVzdG9yZSBiYWNrdXAgZ2VuZXJhdGlvbiBmb3IgJHtiaW5kaW5nLmNoYW5uZWx9IG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXJgLFxuICAgICk7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIC9eW2EtZjAtOV17NjR9JC8udGVzdChiaW5kaW5nLnJldm9jYXRpb25SZWZTaGEyNTYpLFxuICAgICAgYFJlc3RvcmUgYmFja3VwIHJldm9jYXRpb24gZmluZ2VycHJpbnQgZm9yICR7YmluZGluZy5jaGFubmVsfSBtdXN0IGJlIFNIQS0yNTZgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZUNyZWRlbnRpYWxSZXBsYWNlbWVudHMoXG4gIGxhYmVsOiBcIlJvdGF0aW9uXCIgfCBcIlJlc3RvcmVcIixcbiAgcHJldmlvdXM6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RCYWNrdXBDcmVkZW50aWFsQmluZGluZ1N0YXRlW10sXG4gIG5leHQ6IHJlYWRvbmx5IENyZWRlbnRpYWxCaW5kaW5nW10sXG4pOiB2b2lkIHtcbiAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICBzYW1lQ2hhbm5lbHMoXG4gICAgICBwcmV2aW91cy5tYXAoKGVudHJ5KSA9PiBlbnRyeS5jaGFubmVsKSxcbiAgICAgIG5leHQubWFwKChlbnRyeSkgPT4gZW50cnkuY2hhbm5lbCksXG4gICAgKSxcbiAgICBgJHtsYWJlbH0gbXVzdCAke2xhYmVsID09PSBcIlJlc3RvcmVcIiA/IFwicmViaW5kXCIgOiBcInJlcGxhY2VcIn0gZXZlcnkgY3VycmVudGx5IGJvdW5kIGNyZWRlbnRpYWwgY2hhbm5lbGAsXG4gICk7XG4gIGZvciAoY29uc3QgcmVwbGFjZW1lbnQgb2YgbmV4dCkge1xuICAgIGNvbnN0IHByaW9yID0gcHJldmlvdXMuZmluZChcbiAgICAgIChlbnRyeSkgPT4gZW50cnkuY2hhbm5lbCA9PT0gcmVwbGFjZW1lbnQuY2hhbm5lbCxcbiAgICApITtcbiAgICByZXF1aXJlQ29uZGl0aW9uKFxuICAgICAgcmVwbGFjZW1lbnQuZGVsaXZlcnkuZ2VuZXJhdGlvbiA+IHByaW9yLmdlbmVyYXRpb24sXG4gICAgICBgJHtsYWJlbH0gZ2VuZXJhdGlvbiBmb3IgJHtyZXBsYWNlbWVudC5jaGFubmVsfSBtdXN0IGluY3JlYXNlYCxcbiAgICApO1xuICAgIHJlcXVpcmVDb25kaXRpb24oXG4gICAgICBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgIC51cGRhdGUocmVwbGFjZW1lbnQuZGVsaXZlcnkucmV2b2NhdGlvblJlZiwgXCJ1dGY4XCIpXG4gICAgICAgIC5kaWdlc3QoXCJoZXhcIikgIT09IHByaW9yLnJldm9jYXRpb25SZWZTaGEyNTYsXG4gICAgICBgJHtsYWJlbH0gcmV2b2NhdGlvbiByZWZlcmVuY2UgZm9yICR7cmVwbGFjZW1lbnQuY2hhbm5lbH0gbXVzdCBjaGFuZ2VgLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZXhhY3QgcmVzdG9yZS1yZWJpbmQgYm9keSBhY2NlcHRlZCBieSB0aGUgb3BlcmF0b3Igcm91dGUuIFRoZVxuICogYmFja3VwJ3Mgb25lLXdheSBiaW5kaW5nIG1ldGFkYXRhIGlzIHRoZSBhdXRob3JpdHkgZm9yIHRoZSByZXBsYWNlbWVudFxuICogY2hlY2tzLCBzbyBjYWxsZXJzIGNhbm5vdCBieXBhc3MgdGhlbSBieSBjb25zdHJ1Y3RpbmcgdGhlIGJvZHkgdGhlbXNlbHZlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkV29ya3NwYWNlSG9zdEJhY2t1cFJlc3RvcmVDcmVkZW50aWFsUmViaW5kUmVxdWVzdChcbiAgYmFja3VwOiBXb3Jrc3BhY2VIb3N0QmFja3VwQ3JlZGVudGlhbE1hbmlmZXN0LFxuICBuZXh0Q3JlZGVudGlhbFJlZnM6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmcyxcbiAgbmV4dERlbGl2ZXJ5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5U2V0LFxuICByZXF1ZXN0ZWRBdDogc3RyaW5nLFxuKTogV29ya3NwYWNlSG9zdEJhY2t1cFJlc3RvcmVDcmVkZW50aWFsUmViaW5kUmVxdWVzdCB7XG4gIHZhbGlkYXRlQmFja3VwQ3JlZGVudGlhbE1hbmlmZXN0KGJhY2t1cCwgYmFja3VwLndvcmtzcGFjZUlkKTtcbiAgLy8gTWV0YWRhdGEtb25seTogdGhpcyBidWlsZHMgYSByZXF1ZXN0IEJPRFkuIGBwbGFuV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVgIGFwcGxpZXMgdGhlXG4gIC8vIGNhcGFiaWxpdHkgZ2F0ZSB3aGVuIHRoYXQgYm9keSBpcyBhY3R1YWxseSBwbGFubmVkLCB3aGljaCBpcyB3aGVyZSBELTIxNSBwdXRzIHRoZSByZWZ1c2FsLlxuICBjb25zdCBuZXh0ID0gdmFsaWRhdGVDcmVkZW50aWFsU2V0KFxuICAgIG5leHRDcmVkZW50aWFsUmVmcyxcbiAgICBuZXh0RGVsaXZlcnksXG4gICAgcmVxdWVzdGVkQXQsXG4gICAgbnVsbCxcbiAgKTtcbiAgcmVxdWlyZUNyZWRlbnRpYWxSZXBsYWNlbWVudHMoXCJSZXN0b3JlXCIsIGJhY2t1cC5iaW5kaW5nU3RhdGUsIG5leHQpO1xuICByZXR1cm4ge1xuICAgIGFjdGlvbjogXCJyZXN0b3JlLXJlYmluZFwiLFxuICAgIGJhY2t1cCxcbiAgICBuZXh0Q3JlZGVudGlhbFJlZnMsXG4gICAgbmV4dERlbGl2ZXJ5LFxuICB9O1xufVxuXG4vKipcbiAqIFBsYW4gcm90YXRpb24vcmV2b2NhdGlvbi9yZWNvbm5lY3QvcmVzdG9yZSByZWJpbmRpbmcgd2l0aG91dCBldmVyIHBlcnNpc3RpbmdcbiAqIHJlc29sdmVkIGF1dGhvcml6YXRpb24uIFJvdGF0aW9uIHZlcmlmaWVzIHRoZSByZXBsYWNlbWVudCBiZWZvcmUgcmV2b2tpbmdcbiAqIHRoZSBwcmV2aW91cyBiaW5kaW5nOyByZXN0b3JlIHN0YXJ0cyBmcm9tIGEgcmVmZXJlbmNlLWZyZWUgYmFja3VwIG1hbmlmZXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbldvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlKFxuICByZXF1ZXN0OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVJlcXVlc3QsXG4pOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVBsYW4ge1xuICB2YWxpZGF0ZUxpZmVjeWNsZUJhc2UocmVxdWVzdCk7XG4gIGNvbnN0IHN0ZXBzOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBbXSA9IFtdO1xuICBsZXQgdGFpbDogc3RyaW5nW10gPSBbXTtcblxuICBpZiAocmVxdWVzdC5hY3Rpb24gPT09IFwicm90YXRlXCIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdmFsaWRhdGVDcmVkZW50aWFsU2V0KFxuICAgICAgcmVxdWVzdC5jdXJyZW50Q3JlZGVudGlhbFJlZnMsXG4gICAgICByZXF1ZXN0LmN1cnJlbnREZWxpdmVyeSxcbiAgICAgIHJlcXVlc3QucmVxdWVzdGVkQXQsXG4gICAgICByZXF1ZXN0LmRlbGl2ZXJ5Q2FwYWJpbGl0aWVzLFxuICAgICk7XG4gICAgY29uc3QgbmV4dCA9IHZhbGlkYXRlQ3JlZGVudGlhbFNldChcbiAgICAgIHJlcXVlc3QubmV4dENyZWRlbnRpYWxSZWZzLFxuICAgICAgcmVxdWVzdC5uZXh0RGVsaXZlcnksXG4gICAgICByZXF1ZXN0LnJlcXVlc3RlZEF0LFxuICAgICAgcmVxdWVzdC5kZWxpdmVyeUNhcGFiaWxpdGllcyxcbiAgICApO1xuICAgIHJlcXVpcmVDcmVkZW50aWFsUmVwbGFjZW1lbnRzKFxuICAgICAgXCJSb3RhdGlvblwiLFxuICAgICAgY3VycmVudC5tYXAoKGJpbmRpbmcpID0+ICh7XG4gICAgICAgIGNoYW5uZWw6IGJpbmRpbmcuY2hhbm5lbCxcbiAgICAgICAgZ2VuZXJhdGlvbjogYmluZGluZy5kZWxpdmVyeS5nZW5lcmF0aW9uLFxuICAgICAgICByZXZvY2F0aW9uUmVmU2hhMjU2OiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgICAgICAgLnVwZGF0ZShiaW5kaW5nLmRlbGl2ZXJ5LnJldm9jYXRpb25SZWYsIFwidXRmOFwiKVxuICAgICAgICAgIC5kaWdlc3QoXCJoZXhcIiksXG4gICAgICB9KSksXG4gICAgICBuZXh0LFxuICAgICk7XG4gICAgZm9yIChjb25zdCByZXBsYWNlbWVudCBvZiBuZXh0KSB7XG4gICAgICBjb25zdCBwcmV2aW91cyA9IGN1cnJlbnQuZmluZChcbiAgICAgICAgKGVudHJ5KSA9PiBlbnRyeS5jaGFubmVsID09PSByZXBsYWNlbWVudC5jaGFubmVsLFxuICAgICAgKSE7XG4gICAgICBjb25zdCBiaW5kSWQgPSBgYmluZC1uZXh0LSR7cmVwbGFjZW1lbnQuY2hhbm5lbH1gO1xuICAgICAgY29uc3QgdmVyaWZ5SWQgPSBgdmVyaWZ5LW5leHQtJHtyZXBsYWNlbWVudC5jaGFubmVsfWA7XG4gICAgICBjb25zdCByZXZva2VJZCA9IGByZXZva2UtcHJldmlvdXMtJHtyZXBsYWNlbWVudC5jaGFubmVsfWA7XG4gICAgICBjb25zdCByZXZva2VkSWQgPSBgdmVyaWZ5LXJldm9rZWQtJHtyZXBsYWNlbWVudC5jaGFubmVsfWA7XG4gICAgICBzdGVwcy5wdXNoKGxpZmVjeWNsZVN0ZXAocmVxdWVzdCwgYmluZElkLCBcImJpbmRcIiwgcmVwbGFjZW1lbnQsIHRhaWwpKTtcbiAgICAgIHN0ZXBzLnB1c2goXG4gICAgICAgIGxpZmVjeWNsZVN0ZXAocmVxdWVzdCwgdmVyaWZ5SWQsIFwidmVyaWZ5LWJvdW5kXCIsIHJlcGxhY2VtZW50LCBbYmluZElkXSksXG4gICAgICApO1xuICAgICAgc3RlcHMucHVzaChcbiAgICAgICAgbGlmZWN5Y2xlU3RlcChyZXF1ZXN0LCByZXZva2VJZCwgXCJyZXZva2VcIiwgcHJldmlvdXMsIFt2ZXJpZnlJZF0pLFxuICAgICAgKTtcbiAgICAgIHN0ZXBzLnB1c2goXG4gICAgICAgIGxpZmVjeWNsZVN0ZXAocmVxdWVzdCwgcmV2b2tlZElkLCBcInZlcmlmeS1yZXZva2VkXCIsIHByZXZpb3VzLCBbXG4gICAgICAgICAgcmV2b2tlSWQsXG4gICAgICAgIF0pLFxuICAgICAgKTtcbiAgICAgIHRhaWwgPSBbcmV2b2tlZElkXTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocmVxdWVzdC5hY3Rpb24gPT09IFwicmV2b2tlXCIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdmFsaWRhdGVDcmVkZW50aWFsU2V0KFxuICAgICAgcmVxdWVzdC5jdXJyZW50Q3JlZGVudGlhbFJlZnMsXG4gICAgICByZXF1ZXN0LmN1cnJlbnREZWxpdmVyeSxcbiAgICAgIHJlcXVlc3QucmVxdWVzdGVkQXQsXG4gICAgICByZXF1ZXN0LmRlbGl2ZXJ5Q2FwYWJpbGl0aWVzLFxuICAgICk7XG4gICAgcmVxdWlyZUNvbmRpdGlvbihcbiAgICAgIHJlcXVlc3QuY2hhbm5lbHMubGVuZ3RoID4gMCAmJlxuICAgICAgICBuZXcgU2V0KHJlcXVlc3QuY2hhbm5lbHMpLnNpemUgPT09IHJlcXVlc3QuY2hhbm5lbHMubGVuZ3RoLFxuICAgICAgXCJSZXZvY2F0aW9uIGNoYW5uZWxzIG11c3QgYmUgYSBub24tZW1wdHkgdW5pcXVlIGxpc3RcIixcbiAgICApO1xuICAgIGZvciAoY29uc3QgY2hhbm5lbCBvZiByZXF1ZXN0LmNoYW5uZWxzKSB7XG4gICAgICBjb25zdCBiaW5kaW5nID0gY3VycmVudC5maW5kKChlbnRyeSkgPT4gZW50cnkuY2hhbm5lbCA9PT0gY2hhbm5lbCk7XG4gICAgICByZXF1aXJlQ29uZGl0aW9uKGJpbmRpbmcsIGBDYW5ub3QgcmV2b2tlIHVuYm91bmQgJHtjaGFubmVsfSBjaGFubmVsYCk7XG4gICAgICBjb25zdCByZXZva2VJZCA9IGByZXZva2UtJHtjaGFubmVsfWA7XG4gICAgICBjb25zdCB2ZXJpZnlJZCA9IGB2ZXJpZnktcmV2b2tlZC0ke2NoYW5uZWx9YDtcbiAgICAgIHN0ZXBzLnB1c2gobGlmZWN5Y2xlU3RlcChyZXF1ZXN0LCByZXZva2VJZCwgXCJyZXZva2VcIiwgYmluZGluZywgdGFpbCkpO1xuICAgICAgc3RlcHMucHVzaChcbiAgICAgICAgbGlmZWN5Y2xlU3RlcChyZXF1ZXN0LCB2ZXJpZnlJZCwgXCJ2ZXJpZnktcmV2b2tlZFwiLCBiaW5kaW5nLCBbcmV2b2tlSWRdKSxcbiAgICAgICk7XG4gICAgICB0YWlsID0gW3ZlcmlmeUlkXTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgcmVmcyA9XG4gICAgICByZXF1ZXN0LmFjdGlvbiA9PT0gXCJyZXN0b3JlLXJlYmluZFwiXG4gICAgICAgID8gcmVxdWVzdC5uZXh0Q3JlZGVudGlhbFJlZnNcbiAgICAgICAgOiByZXF1ZXN0LmN1cnJlbnRDcmVkZW50aWFsUmVmcztcbiAgICBjb25zdCBkZWxpdmVyeSA9XG4gICAgICByZXF1ZXN0LmFjdGlvbiA9PT0gXCJyZXN0b3JlLXJlYmluZFwiXG4gICAgICAgID8gcmVxdWVzdC5uZXh0RGVsaXZlcnlcbiAgICAgICAgOiByZXF1ZXN0LmN1cnJlbnREZWxpdmVyeTtcbiAgICBjb25zdCBjdXJyZW50ID0gdmFsaWRhdGVDcmVkZW50aWFsU2V0KFxuICAgICAgcmVmcyxcbiAgICAgIGRlbGl2ZXJ5LFxuICAgICAgcmVxdWVzdC5yZXF1ZXN0ZWRBdCxcbiAgICAgIHJlcXVlc3QuZGVsaXZlcnlDYXBhYmlsaXRpZXMsXG4gICAgKTtcbiAgICBpZiAocmVxdWVzdC5hY3Rpb24gPT09IFwicmVzdG9yZS1yZWJpbmRcIikge1xuICAgICAgdmFsaWRhdGVCYWNrdXBDcmVkZW50aWFsTWFuaWZlc3QocmVxdWVzdC5iYWNrdXAsIHJlcXVlc3Qud29ya3NwYWNlSWQpO1xuICAgICAgcmVxdWlyZUNyZWRlbnRpYWxSZXBsYWNlbWVudHMoXG4gICAgICAgIFwiUmVzdG9yZVwiLFxuICAgICAgICByZXF1ZXN0LmJhY2t1cC5iaW5kaW5nU3RhdGUsXG4gICAgICAgIGN1cnJlbnQsXG4gICAgICApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGJpbmRpbmcgb2YgY3VycmVudCkge1xuICAgICAgY29uc3QgYmluZElkID0gYGJpbmQtJHtiaW5kaW5nLmNoYW5uZWx9YDtcbiAgICAgIGNvbnN0IHZlcmlmeUlkID0gYHZlcmlmeS0ke2JpbmRpbmcuY2hhbm5lbH1gO1xuICAgICAgc3RlcHMucHVzaChsaWZlY3ljbGVTdGVwKHJlcXVlc3QsIGJpbmRJZCwgXCJiaW5kXCIsIGJpbmRpbmcsIHRhaWwpKTtcbiAgICAgIHN0ZXBzLnB1c2goXG4gICAgICAgIGxpZmVjeWNsZVN0ZXAocmVxdWVzdCwgdmVyaWZ5SWQsIFwidmVyaWZ5LWJvdW5kXCIsIGJpbmRpbmcsIFtiaW5kSWRdKSxcbiAgICAgICk7XG4gICAgICB0YWlsID0gW3ZlcmlmeUlkXTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBwbGFuOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVBsYW4gPSB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OLFxuICAgIG9wZXJhdGlvbklkOiByZXF1ZXN0Lm9wZXJhdGlvbklkLFxuICAgIHdvcmtzcGFjZUlkOiByZXF1ZXN0LndvcmtzcGFjZUlkLFxuICAgIGhvc3RJZDogcmVxdWVzdC5ob3N0SWQsXG4gICAgYWN0aW9uOiByZXF1ZXN0LmFjdGlvbixcbiAgICByZXF1ZXN0ZWRBdDogcmVxdWVzdC5yZXF1ZXN0ZWRBdCxcbiAgICBzdGVwcyxcbiAgfTtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICBwbGFuLFxuICAgIFwid29ya3NwYWNlSG9zdC5jcmVkZW50aWFsTGlmZWN5Y2xlLnBsYW5cIixcbiAgKTtcbiAgcmV0dXJuIHBsYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uQ2FuYXJ5RXZpZGVuY2Uge1xuICBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OO1xuICBraW5kOiBcImxpdmVcIjtcbiAgcnVuSWQ6IHN0cmluZztcbiAgd29ya3NwYWNlSWQ6IHN0cmluZztcbiAgaG9zdElkOiBzdHJpbmc7XG4gIG9ic2VydmVkQXQ6IHN0cmluZztcbiAgcmVwb3NpdG9yeTogeyB2aXNpYmlsaXR5OiBcInByaXZhdGVcIjsgY2xvbmVkOiB0cnVlIH07XG4gIGNoYW5uZWxzOiBSZWFkb25seTxcbiAgICBSZWNvcmQ8XG4gICAgICBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWwsXG4gICAgICB7XG4gICAgICAgIGJvdW5kOiB0cnVlO1xuICAgICAgICByb3RhdGVkOiB0cnVlO1xuICAgICAgICBwcmV2aW91c0JpbmRpbmdSZXZva2VkOiB0cnVlO1xuICAgICAgICByZWNvbm5lY3RlZDogdHJ1ZTtcbiAgICAgIH1cbiAgICA+XG4gID47XG4gIC8qKlxuICAgKiBFeHBsaWNpdCBhZ2VudCBjb3ZlcmFnZSwgbWlycm9yaW5nIGBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25SZXBvcnQucmVxdWVzdGVkQWdlbnRzYDpcbiAgICogb21pdHRlZCBvbiBhIGRlZmF1bHQgYWxsLWFnZW50IGFydGlmYWN0LCBzbyBleGlzdGluZyBldmlkZW5jZSBpcyB1bmNoYW5nZWQuXG4gICAqXG4gICAqIEEgZGVsaWJlcmF0ZWx5IHNraXBwZWQgYWdlbnQgKEQtMzM4J3MgQ29kZXggbGVnKSBpcyBBQlNFTlQgZnJvbSBgYWdlbnRzYCDigJQgbmV2ZXIgcHJlc2VudCBhbmRcbiAgICogcGFzc2luZy4gS2VlcGluZyB0aGUgZGVjbGFyYXRpb24gT04gdGhlIGFydGlmYWN0IGlzIHdoYXQgbGV0cyBhIGxhdGVyIHJlYWRlciB0ZWxsIGEgc2NvcGVkXG4gICAqIHJ1biBmcm9tIGEgdHJ1bmNhdGVkIG9uZTsgYGFnZW50c2AgYWxvbmUgY2Fubm90LlxuICAgKi9cbiAgcmVxdWVzdGVkQWdlbnRzPzogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENhbmFyeUFnZW50W107XG4gIGFnZW50czogUmVhZG9ubHk8XG4gICAgUGFydGlhbDx7XG4gICAgICAvLyBXSS0xMDAwMjQwMjogdGhlIHBlci1hZ2VudCBraW5kIGlzIE5PVCBwaW5uZWQgaGVyZS4gUGlubmluZyBjbGF1ZGUvY29kZXggdG9cbiAgICAgIC8vIGBhdXRoZW50aWNhdGVkLWFjY291bnRgIG1hZGUgdGhpcyB0eXBlIHVuYWJsZSB0byBSRVBSRVNFTlQgdGhlIGV2aWRlbmNlIHRob3NlIGFnZW50c1xuICAgICAgLy8gYWN0dWFsbHkgcHJvZHVjZSDigJQgY2xhdWRlIGVtaXRzIGBsaXZlLWluZmVyZW5jZWAgYW5kIGhhcyBubyBhdXRoZW50aWNhdGVkLWFjY291bnQgcHJvYmVcbiAgICAgIC8vIGF0IGFsbCAoV0ktMTAwMDE2ODkpIOKAlCBzbyByZWFsIGV2aWRlbmNlIHdhcyB1bmFzc2lnbmFibGUgd2hpbGUgZm9yZ2VkLXNoYXBlZCBldmlkZW5jZVxuICAgICAgLy8gdHlwZWNoZWNrZWQuIFdoaWNoIGtpbmRzIGFyZSBhZG1pc3NpYmxlIGlzIGEgcnVudGltZSBxdWVzdGlvbiBhbnN3ZXJlZCBmcm9tIHRoZSBwcm9iZVxuICAgICAgLy8gdGFibGUgYnkgd29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uS2luZElzQWxsb3dlZCwgbm90IGEgbGl0ZXJhbCByZXN0YXRlZCBoZXJlLlxuICAgICAgY2xhdWRlOiB7IHJlYWR5OiB0cnVlOyB2ZXJpZmljYXRpb25LaW5kOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kIH07XG4gICAgICBjb2RleDogeyByZWFkeTogdHJ1ZTsgdmVyaWZpY2F0aW9uS2luZDogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uS2luZCB9O1xuICAgICAgb21wOiB7IHJlYWR5OiB0cnVlOyB2ZXJpZmljYXRpb25LaW5kOiBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kIH07XG4gICAgfT5cbiAgPjtcbiAgYmFja3VwUmVzdG9yZToge1xuICAgIGF1dGhvcml6YXRpb25NYXRlcmlhbDogXCJleGNsdWRlZFwiO1xuICAgIGNyZWRlbnRpYWxSZWZlcmVuY2VzOiBcImV4Y2x1ZGVkXCI7XG4gICAgcmVib3VuZENoYW5uZWxzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWxbXTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlWYWxpZGF0aW9uIHtcbiAgb2s6IGJvb2xlYW47XG4gIGVycm9yczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBWYWxpZGF0ZSBvbmx5IHN0cnVjdHVyZWQsIG5vbi1zZWNyZXQgZXZpZGVuY2UgZnJvbSBhIHJlYWwgaG9zdCBjYW5hcnkuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnkoXG4gIGV2aWRlbmNlOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZSxcbik6IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeVZhbGlkYXRpb24ge1xuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICAgIGV2aWRlbmNlLFxuICAgICAgXCJ3b3Jrc3BhY2VIb3N0LmluaXRpYWxpemF0aW9uLmNhbmFyeVwiLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZXJyb3JzLnB1c2goZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcbiAgfVxuICBpZiAoXG4gICAgZXZpZGVuY2UuY29udHJhY3RWZXJzaW9uICE9PSBXT1JLU1BBQ0VfSE9TVF9JTklUSUFMSVpBVElPTl9DT05UUkFDVF9WRVJTSU9OXG4gICkge1xuICAgIGVycm9ycy5wdXNoKFwiY2FuYXJ5IGNvbnRyYWN0IHZlcnNpb24gbWlzbWF0Y2hcIik7XG4gIH1cbiAgaWYgKGV2aWRlbmNlLmtpbmQgIT09IFwibGl2ZVwiKVxuICAgIGVycm9ycy5wdXNoKFwiY2FuYXJ5IGV2aWRlbmNlIG11c3QgY29tZSBmcm9tIGEgbGl2ZSBob3N0XCIpO1xuICBmb3IgKGNvbnN0IFt2YWx1ZSwgbGFiZWxdIG9mIFtcbiAgICBbZXZpZGVuY2UucnVuSWQsIFwicnVuSWRcIl0sXG4gICAgW2V2aWRlbmNlLndvcmtzcGFjZUlkLCBcIndvcmtzcGFjZUlkXCJdLFxuICAgIFtldmlkZW5jZS5ob3N0SWQsIFwiaG9zdElkXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgaWYgKCFTQUZFX0lELnRlc3QodmFsdWUpKVxuICAgICAgZXJyb3JzLnB1c2goYGNhbmFyeSAke2xhYmVsfSBtdXN0IGJlIGEgc3RhYmxlIGlkZW50aWZpZXJgKTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKGV2aWRlbmNlLm9ic2VydmVkQXQpKSkge1xuICAgIGVycm9ycy5wdXNoKFwiY2FuYXJ5IG9ic2VydmVkQXQgbXVzdCBiZSBhbiBJU08gdGltZXN0YW1wXCIpO1xuICB9XG4gIGlmIChcbiAgICBldmlkZW5jZS5yZXBvc2l0b3J5Py52aXNpYmlsaXR5ICE9PSBcInByaXZhdGVcIiB8fFxuICAgICFldmlkZW5jZS5yZXBvc2l0b3J5LmNsb25lZFxuICApIHtcbiAgICBlcnJvcnMucHVzaChcInByaXZhdGUtcmVwb3NpdG9yeSBjbG9uZSBkaWQgbm90IHBhc3NcIik7XG4gIH1cbiAgZm9yIChjb25zdCBjaGFubmVsIG9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBldmlkZW5jZS5jaGFubmVscz8uW2NoYW5uZWxdO1xuICAgIGlmIChcbiAgICAgICFyZXN1bHQ/LmJvdW5kIHx8XG4gICAgICAhcmVzdWx0LnJvdGF0ZWQgfHxcbiAgICAgICFyZXN1bHQucHJldmlvdXNCaW5kaW5nUmV2b2tlZCB8fFxuICAgICAgIXJlc3VsdC5yZWNvbm5lY3RlZFxuICAgICkge1xuICAgICAgZXJyb3JzLnB1c2goYCR7Y2hhbm5lbH0gY3JlZGVudGlhbCBsaWZlY3ljbGUgZGlkIG5vdCBwYXNzYCk7XG4gICAgfVxuICB9XG4gIC8vIERlcml2ZSBjb3ZlcmFnZSBmcm9tIHRoZSBhcnRpZmFjdCdzIG93biBkZWNsYXJhdGlvbiAoYWJzZW50ID0+IGFsbCB0aHJlZSwgc28gZGVmYXVsdCBldmlkZW5jZVxuICAvLyB2YWxpZGF0ZXMgZXhhY3RseSBhcyBiZWZvcmUpLiBBIHNraXBwZWQgYWdlbnQgaXMgbm90IHZhbGlkYXRlZCBoZXJlIGJlY2F1c2UgaXQgY2FycmllcyBub1xuICAvLyBldmlkZW5jZSB0byB2YWxpZGF0ZSDigJQgaXQgaXMgbmV2ZXIgdHJlYXRlZCBhcyBoYXZpbmcgcGFzc2VkLlxuICBmb3IgKGNvbnN0IGFnZW50IG9mIHJlc29sdmVXb3Jrc3BhY2VIb3N0UmVxdWVzdGVkQWdlbnRzKGV2aWRlbmNlLnJlcXVlc3RlZEFnZW50cykpIHtcbiAgICBjb25zdCByZXN1bHQgPSBldmlkZW5jZS5hZ2VudHM/LlthZ2VudF07XG4gICAgaWYgKCFyZXN1bHQ/LnJlYWR5KSBlcnJvcnMucHVzaChgJHthZ2VudH0gbGl2ZSByZWFkaW5lc3MgZGlkIG5vdCBwYXNzYCk7XG4gICAgLy8gV0ktMTAwMDI0MDI6IERFUklWRUQgZnJvbSB0aGUgYWdlbnQncyBwcm9iZSB0YWJsZSDigJQgc2VlXG4gICAgLy8gd29ya3NwYWNlSG9zdEFnZW50QWxsb3dlZFZlcmlmaWNhdGlvbktpbmRzLlxuICAgIGlmIChcbiAgICAgICF3b3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kSXNBbGxvd2VkKFxuICAgICAgICBhZ2VudCxcbiAgICAgICAgcmVzdWx0Py52ZXJpZmljYXRpb25LaW5kLFxuICAgICAgKVxuICAgICkge1xuICAgICAgZXJyb3JzLnB1c2goYCR7YWdlbnR9IHZlcmlmaWNhdGlvbiBraW5kIGlzIG5vdCBhbGxvd2VkYCk7XG4gICAgfVxuICB9XG4gIGlmIChcbiAgICBldmlkZW5jZS5iYWNrdXBSZXN0b3JlPy5hdXRob3JpemF0aW9uTWF0ZXJpYWwgIT09IFwiZXhjbHVkZWRcIiB8fFxuICAgIGV2aWRlbmNlLmJhY2t1cFJlc3RvcmU/LmNyZWRlbnRpYWxSZWZlcmVuY2VzICE9PSBcImV4Y2x1ZGVkXCJcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXCJiYWNrdXAgcmV0YWluZWQgY3JlZGVudGlhbCBhdXRob3JpemF0aW9uIG9yIHJlZmVyZW5jZXNcIik7XG4gIH1cbiAgaWYgKFxuICAgICFzYW1lQ2hhbm5lbHMoXG4gICAgICBldmlkZW5jZS5iYWNrdXBSZXN0b3JlPy5yZWJvdW5kQ2hhbm5lbHMgPz8gW10sXG4gICAgICBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0NIQU5ORUxTLFxuICAgIClcbiAgKSB7XG4gICAgZXJyb3JzLnB1c2goXCJyZXN0b3JlIGRpZCBub3QgcmViaW5kIGFsbCBjcmVkZW50aWFsIGNoYW5uZWxzXCIpO1xuICB9XG4gIHJldHVybiB7IG9rOiBlcnJvcnMubGVuZ3RoID09PSAwLCBlcnJvcnMgfTtcbn1cbiJdLCJmaWxlIjoiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXphdGlvbi50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXphdGlvbi50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtaW5pdGlhbGl6YXRpb24udHMiLFtdXQ==
}}