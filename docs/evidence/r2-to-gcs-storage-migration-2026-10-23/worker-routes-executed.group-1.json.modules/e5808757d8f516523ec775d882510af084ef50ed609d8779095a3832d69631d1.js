'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION", () => { try { return WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS", () => { try { return WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV", () => { try { return WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV } catch {} });
__vite_ssr_exportName__("encodeWorkspaceHostCredentialLifecycleStep", () => { try { return encodeWorkspaceHostCredentialLifecycleStep } catch {} });
__vite_ssr_exportName__("WorkspaceHostRemoteInitializerProtocolError", () => { try { return WorkspaceHostRemoteInitializerProtocolError } catch {} });
__vite_ssr_exportName__("UnsupportedWorkspaceHostInitializationStepKindError", () => { try { return UnsupportedWorkspaceHostInitializationStepKindError } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostRemoteInitializerRequest", () => { try { return parseWorkspaceHostRemoteInitializerRequest } catch {} });
__vite_ssr_exportName__("executeWorkspaceHostRemoteInitializerStep", () => { try { return executeWorkspaceHostRemoteInitializerStep } catch {} });
__vite_ssr_exportName__("handleWorkspaceHostRemoteInitializerPayload", () => { try { return handleWorkspaceHostRemoteInitializerPayload } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostRemoteInitializerArgv", () => { try { return assertWorkspaceHostRemoteInitializerArgv } catch {} });
__vite_ssr_exportName__("WorkspaceHostInitializationCanaryEvidenceError", () => { try { return WorkspaceHostInitializationCanaryEvidenceError } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostInitializationCanaryEvidence", () => { try { return buildWorkspaceHostInitializationCanaryEvidence } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-initialization.ts", {"importedNames":["WORKSPACE_HOST_CREDENTIAL_CHANNELS","WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS","WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION","WORKSPACE_HOST_INITIALIZATION_STEP_KINDS"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-agent-authentication.ts", {"importedNames":["WORKSPACE_HOST_CANARY_AGENTS","resolveWorkspaceHostRequestedAgents","workspaceHostAgentAllowedVerificationKinds","workspaceHostAgentVerificationKindIsAllowed"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});



const WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION = "papercusp-gcp-iap-initialization-v4";
const WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS = [
  ...__vite_ssr_import_0__.WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  ...__vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  "install-desktop-pack"
];
const WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV = [
  "--protocol-version",
  WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
  "--json-stdin"
];
function encodeWorkspaceHostCredentialLifecycleStep(step) {
  return {
    id: step.id,
    kind: step.kind,
    dependsOn: step.dependsOn,
    idempotencyKey: step.idempotencyKey,
    input: {
      channel: step.channel,
      credentialRef: step.credentialRef,
      delivery: step.delivery
    }
  };
};
class WorkspaceHostRemoteInitializerProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceHostRemoteInitializerProtocolError";
  }
};
class UnsupportedWorkspaceHostInitializationStepKindError extends Error {
  kind;
  constructor(kind) {
    super(
      `Remote initializer has no handler for step kind '${kind}'. Supported: ${WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS.join(", ")}.`
    );
    this.name = "UnsupportedWorkspaceHostInitializationStepKindError";
    this.kind = kind;
  }
};
function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be an object`
    );
  };
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be a non-empty string`
    );
  };
  return value;
}
function parseWorkspaceHostRemoteInitializerRequest(raw) {
  const body = requireObject(raw, "request");
  if (body.protocolVersion !== WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `unsupported protocol version '${String(body.protocolVersion)}'; this initializer speaks '${WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION}'`
    );
  };
  const step = requireObject(body.step, "request.step");
  const id = requireString(step.id, "request.step.id");
  const kind = requireString(step.kind, "request.step.kind");
  if (!WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS.includes(kind)) {
    throw new UnsupportedWorkspaceHostInitializationStepKindError(kind);
  };
  requireString(step.idempotencyKey, "request.step.idempotencyKey");
  if (!Array.isArray(step.dependsOn)) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      "request.step.dependsOn must be an array"
    );
  };
  requireObject(step.input, "request.step.input");
  (0,__vite_ssr_import_2__.assertWorkspaceHostSecretIsolation)(
    step,
    `workspaceHost.remoteInitializer.request.${id}`
  );
  return {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    step: {
      id,
      kind,
      dependsOn: step.dependsOn,
      idempotencyKey: step.idempotencyKey,
      input: step.input
    }
  };
};
function readInclude(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `${label} must be an array of strings`
    );
  };
  return value;
}
async function runCredentialOperation(operation, input, deps, now) {
  const channel = requireString(input.channel, "step.input.channel");
  if (!__vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
    channel
  )) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `step.input.channel '${channel}' is not a credential channel`
    );
  };
  const credentialRef = requireObject(
    input.credentialRef,
    "step.input.credentialRef"
  );
  const delivery = requireObject(input.delivery, "step.input.delivery");
  const requestedAt = new Date(now().getTime() - 1).toISOString();
  const evidence = await deps.credentials.run(
    operation,
    {
      channel,
      credentialRef: {
        kind: requireString(
          credentialRef.kind,
          "step.input.credentialRef.kind"
        ),
        ref: requireString(credentialRef.ref, "step.input.credentialRef.ref")
      },
      delivery,
      requestedAt
    }
  );
  return {
    channel: evidence.channel,
    family: evidence.family,
    operation: evidence.operation,
    deliveryKind: evidence.deliveryKind,
    generation: evidence.generation,
    audience: evidence.audience,
    referenceDigest: evidence.referenceDigest,
    detail: evidence.detail
  };
}
async function executeWorkspaceHostRemoteInitializerStep(request, deps) {
  const { step } = request;
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  const input = step.input;
  let publicEvidence;
  switch (step.kind) {
    case "install-desktop-pack": {
      if (Object.keys(input).some((key) => key !== "hostId")) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "install-desktop-pack accepts only step.input.hostId"
        );
      };
      const hostId = requireString(input.hostId, "step.input.hostId");
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(hostId)) {
        throw new WorkspaceHostRemoteInitializerProtocolError("invalid desktop-pack hostId");
      };
      if (!deps.host.installDesktopPack) {
        throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
      };
      publicEvidence = await deps.host.installDesktopPack({ hostId });
      break;
    }
    case "verify-retained-workspace": {
      const tenantIdentity = requireString(input.tenantIdentity, "step.input.tenantIdentity");
      if (!/^[a-f0-9]{64}$/.test(tenantIdentity)) {
        throw new WorkspaceHostRemoteInitializerProtocolError("invalid retained tenant identity");
      };
      if (!deps.host.verifyRetainedWorkspace) throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
      publicEvidence = await deps.host.verifyRetainedWorkspace({
        workspaceId: requireString(input.workspaceId, "step.input.workspaceId"),
        hostId: requireString(input.hostId, "step.input.hostId"),
        tenantIdentity
      });
      break;
    }
    case "create-workspace": {
      publicEvidence = await deps.host.createWorkspace({
        workspaceId: requireString(input.workspaceId, "step.input.workspaceId"),
        hostId: requireString(input.hostId, "step.input.hostId")
      });
      break;
    }
    case "clone-repository": {
      const visibility = requireString(
        input.visibility,
        "step.input.visibility"
      );
      if (visibility !== "public" && visibility !== "private") {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.visibility must be 'public' or 'private'"
        );
      };
      const credentialChannel = input.credentialChannel;
      if (credentialChannel !== void 0 && !__vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
        credentialChannel
      )) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          `step.input.credentialChannel '${String(credentialChannel)}' is not a credential channel`
        );
      };
      if (visibility === "private" && credentialChannel === void 0) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "a private clone step must name the credential channel it authenticates with"
        );
      };
      publicEvidence = await deps.host.cloneRepository({
        repositoryUrl: requireString(
          input.repositoryUrl,
          "step.input.repositoryUrl"
        ),
        visibility,
        destination: requireString(input.destination, "step.input.destination"),
        ...typeof input.revision === "string" ? { revision: input.revision } : {},
        ...credentialChannel ? {
          credentialChannel
        } : {}
      });
      break;
    }
    case "pair-workspace": {
      const pairing = requireObject(
        input.pairingReference,
        "step.input.pairingReference"
      );
      if (pairing.kind !== "pairing") {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.pairingReference.kind must be 'pairing'"
        );
      };
      publicEvidence = await deps.host.pairWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          "step.input.sourceWorkspaceId"
        ),
        pairingReference: {
          kind: "pairing",
          ref: requireString(pairing.ref, "step.input.pairingReference.ref")
        },
        include: readInclude(input.include, "step.input.include")
      });
      break;
    }
    case "import-workspace": {
      publicEvidence = await deps.host.importWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          "step.input.sourceWorkspaceId"
        ),
        sourceSnapshotRef: requireString(
          input.sourceSnapshotRef,
          "step.input.sourceSnapshotRef"
        ),
        include: readInclude(input.include, "step.input.include")
      });
      break;
    }
    case "bind-credential": {
      publicEvidence = await runCredentialOperation("bind", input, deps, now);
      break;
    }
    // The four CREDENTIAL-LIFECYCLE kinds (D-114). A lifecycle step is exactly a request to run
    // one credential operation against one channel, and `WorkspaceHostCredentialOperation` has
    // the same four members as `WorkspaceHostCredentialLifecycleStepKind` — so the kind IS the
    // operation and needs no mapping table. That identity is asserted by a test rather than
    // assumed here, because a table nobody checks is how the two lists drift apart.
    //
    // Note `bind-credential` above and `bind` here differ only in provenance: the first is the
    // initial binding planned by `planWorkspaceHostInitialization`, the second is a binding
    // planned by `planWorkspaceHostCredentialLifecycle` (a rotation's new generation, or a
    // restore's rebind). They execute identically and deliberately share one implementation.
    case "bind":
    case "verify-bound":
    case "revoke":
    case "verify-revoked": {
      publicEvidence = await runCredentialOperation(
        step.kind,
        input,
        deps,
        now
      );
      break;
    }
    case "verify-initialization": {
      const requestedAgents = (0,__vite_ssr_import_1__.resolveWorkspaceHostRequestedAgents)(input.requestedAgents);
      const sourceKind = requireString(
        input.sourceKind,
        "step.input.sourceKind"
      );
      const requiredChannels = readInclude(
        input.requiredChannels,
        "step.input.requiredChannels"
      );
      let repositoryInput;
      if (sourceKind === "git") {
        const repository2 = requireObject(
          input.repository,
          "step.input.repository"
        );
        const visibility = requireString(
          repository2.visibility,
          "step.input.repository.visibility"
        );
        if (visibility !== "public" && visibility !== "private") {
          throw new WorkspaceHostRemoteInitializerProtocolError(
            "step.input.repository.visibility must be 'public' or 'private'"
          );
        };
        repositoryInput = {
          destination: requireString(
            repository2.destination,
            "step.input.repository.destination"
          ),
          visibility
        };
      } else if (input.repository !== void 0) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.repository is allowed only for a git source"
        );
      };
      const report = await deps.host.probeAgentVerification(
        input.requestedAgents !== void 0 ? requestedAgents : void 0
      );
      const reportedAgents = (0,__vite_ssr_import_1__.resolveWorkspaceHostRequestedAgents)(report.requestedAgents);
      if (JSON.stringify(reportedAgents) !== JSON.stringify(requestedAgents) || Object.keys(report.agents).some((agent) => !requestedAgents.includes(agent))) {
        throw new Error("agent verification requestedAgents coverage does not match initialization");
      };
      const repository = await deps.host.describeClonedRepository(repositoryInput);
      const failed = requestedAgents.filter(
        (agent) => !report.agents[agent]?.ready
      );
      if (failed.length > 0) {
        const detail = failed.map((agent) => {
          const evidence = report.agents[agent];
          const failure = evidence?.failure ?? "not-reported";
          const stderrBytes = evidence?.stderrByteCount;
          const stderrDetail = typeof stderrBytes !== "number" ? "" : evidence?.stderrByteCountTruncated ? `; stderr-bytes-at-least=${stderrBytes}` : `; stderr-bytes=${stderrBytes}`;
          return `${agent} (${failure}${stderrDetail})`;
        }).join(", ");
        throw new Error(`agent readiness did not pass for: ${detail}`);
      };
      publicEvidence = {
        sourceKind,
        requiredChannels,
        repository,
        agents: report.agents,
        ...input.requestedAgents !== void 0 ? { requestedAgents } : {},
        allReady: __vite_ssr_import_1__.WORKSPACE_HOST_CANARY_AGENTS.every((agent) => report.agents[agent]?.ready === true),
        agentContractVersion: report.contractVersion
      };
      break;
    }
    default: {
      throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
    }
  };
  const observedAt = now().toISOString();
  const response = {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    stepId: step.id,
    status: "succeeded",
    observedAt,
    ...publicEvidence && Object.keys(publicEvidence).length > 0 ? { publicEvidence } : {}
  };
  (0,__vite_ssr_import_2__.assertWorkspaceHostSecretIsolation)(
    response,
    `workspaceHost.remoteInitializer.response.${step.id}`
  );
  return response;
};
async function handleWorkspaceHostRemoteInitializerPayload(payload, deps) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      "request body is not valid JSON"
    );
  };
  const request = parseWorkspaceHostRemoteInitializerRequest(parsed);
  const response = await executeWorkspaceHostRemoteInitializerStep(
    request,
    deps
  );
  return `${JSON.stringify(response)}
`;
};
function assertWorkspaceHostRemoteInitializerArgv(argv) {
  const expected = WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV;
  const matches = argv.length === expected.length && expected.every((value, index) => argv[index] === value);
  if (!matches) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `remote initializer expects argv ${expected.join(" ")}, got ${argv.join(" ") || "(none)"}`
    );
  }
};
class WorkspaceHostInitializationCanaryEvidenceError extends Error {
  problems;
  constructor(problems) {
    super(`Canary evidence cannot be constructed: ${problems.join("; ")}`);
    this.name = "WorkspaceHostInitializationCanaryEvidenceError";
    this.problems = problems;
  }
};
function buildWorkspaceHostInitializationCanaryEvidence(input) {
  const problems = [];
  if (input.repository.visibility !== "private") {
    problems.push("canary repository must be private");
  };
  if (!input.repository.cloned)
    problems.push("private-repository clone was not observed");
  for (const channel of __vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const observed = input.channelLifecycle?.[channel];
    if (!observed) {
      problems.push(`no lifecycle evidence for the '${channel}' channel`);
      continue;
    };
    for (const [flag, value] of Object.entries(observed)) {
      if (value !== true)
        problems.push(`${channel} channel did not observe '${flag}'`);
    }
  };
  const coveredAgents = (0,__vite_ssr_import_1__.resolveWorkspaceHostRequestedAgents)(input.agents?.requestedAgents);
  for (const agent of coveredAgents) {
    const evidence2 = input.agents?.agents?.[agent];
    if (!evidence2) {
      problems.push(`no readiness probe was run for '${agent}'`);
      continue;
    };
    if (!evidence2.ready) {
      problems.push(
        `${agent} live readiness did not pass (${evidence2.failure ?? "unknown"}, exit ${evidence2.exitStatus})`
      );
    };
    if (!(0,__vite_ssr_import_1__.workspaceHostAgentVerificationKindIsAllowed)(
      agent,
      evidence2.verificationKind
    )) {
      problems.push(
        `${agent} verification kind '${evidence2.verificationKind}' is not allowed (allowed: ${[
          ...(0,__vite_ssr_import_1__.workspaceHostAgentAllowedVerificationKinds)(agent)
        ].join(", ")})`
      );
    }
  };
  if (!input.backupRestore.authorizationMaterialExcluded) {
    problems.push("backup retained authorization material");
  };
  if (!input.backupRestore.credentialReferencesExcluded) {
    problems.push("backup retained credential references");
  };
  const rebound = new Set(input.backupRestore.reboundChannels);
  for (const channel of __vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    if (!rebound.has(channel))
      problems.push(`restore did not rebind the '${channel}' channel`);
  };
  for (const channel of rebound) {
    if (!__vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel)) {
      problems.push(`restore rebound an unknown channel '${channel}'`);
    }
  };
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    problems.push("canary observedAt must be an ISO timestamp");
  };
  if (problems.length > 0)
    throw new WorkspaceHostInitializationCanaryEvidenceError(problems);
  const channels = Object.fromEntries(
    __vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => [
      channel,
      {
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true
      }
    ])
  );
  const agents = Object.fromEntries(
    coveredAgents.map((agent) => [
      agent,
      {
        ready: true,
        verificationKind: input.agents.agents[agent].verificationKind
      }
    ])
  );
  const evidence = {
    contractVersion: __vite_ssr_import_0__.WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    kind: "live",
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    observedAt: input.observedAt,
    repository: { visibility: "private", cloned: true },
    channels,
    // Propagate the report's declared coverage onto the assembled artifact so the validator (and
    // any later reader of ratified evidence) can tell a deliberately scoped run from a truncated
    // one. Omitted when the report was unscoped, preserving the default artifact shape byte for byte.
    ...input.agents?.requestedAgents !== void 0 ? { requestedAgents: coveredAgents } : {},
    agents,
    backupRestore: {
      authorizationMaterial: "excluded",
      credentialReferences: "excluded",
      reboundChannels: [...__vite_ssr_import_0__.WORKSPACE_HOST_CREDENTIAL_CHANNELS]
    }
  };
  (0,__vite_ssr_import_2__.assertWorkspaceHostSecretIsolation)(
    evidence,
    "workspaceHost.initialization.canary"
  );
  return evidence;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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IiwiZXZpZGVuY2UiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsid29ya3NwYWNlLWhvc3QtcmVtb3RlLWluaXRpYWxpemVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGhvc3QtaW5zdGFsbGVkIHJlbW90ZSBpbml0aWFsaXplciAoUC0wNDYgLyBXSS00MTcxMSkuXG4gKlxuICogV0hBVCBXQVMgTUlTU0lORy4gVGhlIGNvbnRyb2xsZXIgYWxyZWFkeSBrbm93cyBob3cgdG8gcmVhY2ggYSB3b3Jrc3BhY2UgaG9zdDogaXQgb3BlbnMgb25lXG4gKiBub24taW50ZXJhY3RpdmUgT3BlblNTSCBpbnZvY2F0aW9uIG92ZXIgYW4gSUFQIHR1bm5lbCBhbmQgd3JpdGVzXG4gKiBge1wicHJvdG9jb2xWZXJzaW9uXCI6XCJwYXBlcmN1c3AtZ2NwLWlhcC1pbml0aWFsaXphdGlvbi12NFwiLFwic3RlcFwiOjxzdGVwPn1gIHRvIHRoZSByZW1vdGVcbiAqIHByb2dyYW0ncyBzdGRpbiwgZXhwZWN0aW5nIGB7cHJvdG9jb2xWZXJzaW9uLCBzdGVwSWQsIHN0YXR1czpcInN1Y2NlZWRlZFwiLCBvYnNlcnZlZEF0LFxuICogcHVibGljRXZpZGVuY2U/fWAgYmFjayBvbiBzdGRvdXQuIFRoYXQgcmVtb3RlIHByb2dyYW0gZGlkIG5vdCBleGlzdCBhbnl3aGVyZSBpbiB0aGUgdHJlZSDigJQgdGhlXG4gKiBwcm90b2NvbCBzdHJpbmcgbWF0Y2hlZCBvbmx5IHRoZSBjb250cm9sbGVyLXNpZGUgY29tbWFuZCBidWlsZGVyIOKAlCBzbyBldmVyeSBpbml0aWFsaXphdGlvbiBzdGVwXG4gKiBmYWlsZWQgYXQgdGhlIGhvc3QgYW5kIHRoZSByb3V0ZSBjb3VsZCBvbmx5IGV2ZXIgYW5zd2VyIDUwMC4gVGhpcyBtb2R1bGUgaXMgdGhlIG90aGVyIGVuZCBvZlxuICogdGhhdCBwaXBlLlxuICpcbiAqIFRIRSBSRVNQT05TRSBWT0NBQlVMQVJZIElTIERFTElCRVJBVEVMWSBPTkUgV09SRC4gVGhlIGNvbnRyb2xsZXIncyBwYXJzZXIgYWNjZXB0c1xuICogYHN0YXR1czogXCJzdWNjZWVkZWRcImAgYW5kIG5vdGhpbmcgZWxzZSwgYW5kIHRocm93cyBvbiBhIG5vbi16ZXJvIGV4aXQuIFNvIGZhaWx1cmUgaXMgc2lnbmFsbGVkXG4gKiBieSBFWElUSU5HIE5PTi1aRVJPIHdpdGggYSBkaWFnbm9zdGljIG9uIHN0ZGVyciDigJQgbmV2ZXIgYnkgd3JpdGluZyBhIGBcImZhaWxlZFwiYCBlbnZlbG9wZSB0aGF0XG4gKiB0aGUgY29udHJvbGxlciB3b3VsZCByZWplY3QgYXMgYSBwcm90b2NvbCB2aW9sYXRpb24gYW5kIG1pc3JlcG9ydCBhcyBhIG1hbGZvcm1lZCByZXNwb25zZS4gT25lXG4gKiBmYWlsdXJlIGNoYW5uZWwsIG5vdCB0d28gdGhhdCBkaXNhZ3JlZSBhYm91dCB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogU0VDUkVUIElTT0xBVElPTiBSVU5TIE9OIFRIRSBXQVkgSU4gQU5EIE9OIFRIRSBXQVkgT1VULiBUaGUgaW5ib3VuZCBzdGVwIGlzIGFzc2VydGVkIGJlY2F1c2UgYVxuICogaG9zdCBzaG91bGQgcmVmdXNlIHRvIGFjdCBvbiBhIHJlcXVlc3QgdGhhdCBhbHJlYWR5IGNvbnRhaW5zIG1hdGVyaWFsIGl0IG11c3QgbmV2ZXIgc2VlLCBhbmRcbiAqIHRoZSBvdXRib3VuZCBldmlkZW5jZSBpcyBhc3NlcnRlZCBiZWNhdXNlIHRoYXQgaXMgdGhlIHZhbHVlIHRoZSBjb250cm9sbGVyIHdpbGwgcGVyc2lzdCBpbnRvIGFcbiAqIGR1cmFibGUgcmVjZWlwdC4gVGhlIGNvbnRyb2xsZXIgYXNzZXJ0cyB0aGUgc2FtZSB0aGluZyBvbiBpdHMgc2lkZTsgYWdyZWVpbmcgYXQgYm90aCBlbmRzIGlzXG4gKiB3aGF0IG1ha2VzIGEgbGVhayBhIGxvdWQgZmFpbHVyZSBhdCB3aGljaGV2ZXIgZW5kIGludHJvZHVjZWQgaXQuXG4gKi9cbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMsXG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTElGRUNZQ0xFX1NURVBfS0lORFMsXG4gIFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX0NPTlRSQUNUX1ZFUlNJT04sXG4gIFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX1NURVBfS0lORFMsXG4gIHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcCxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBLaW5kLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXAsXG4gIHR5cGUgV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcEtpbmQsXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWluaXRpYWxpemF0aW9uXCI7XG5pbXBvcnQge1xuICBXT1JLU1BBQ0VfSE9TVF9DQU5BUllfQUdFTlRTLFxuICByZXNvbHZlV29ya3NwYWNlSG9zdFJlcXVlc3RlZEFnZW50cyxcbiAgd29ya3NwYWNlSG9zdEFnZW50QWxsb3dlZFZlcmlmaWNhdGlvbktpbmRzLFxuICB3b3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kSXNBbGxvd2VkLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25SZXBvcnQsXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWFnZW50LWF1dGhlbnRpY2F0aW9uXCI7XG5pbXBvcnQge1xuICBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlc29sdmVyLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRXZpZGVuY2UsXG4gIHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxPcGVyYXRpb24sXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWNyZWRlbnRpYWwtbmFtZXNwYWNlXCI7XG5pbXBvcnQgeyBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uIH0gZnJvbSBcIi4vd29ya3NwYWNlLWhvc3QtdGVzdC1oYXJuZXNzXCI7XG5cbi8qKlxuICogVGhlIHdpcmUgcHJvdG9jb2wgdmVyc2lvbi4gVGhpcyBpcyB0aGUgc2luZ2xlIHNvdXJjZSBvZiB0cnV0aDsgdGhlIGNvbnRyb2xsZXItc2lkZSBjb21tYW5kXG4gKiBidWlsZGVyIGRlcml2ZXMgaXRzIGNvbnN0YW50IGZyb20gaGVyZSBzbyB0aGUgdHdvIGVuZHMgY2Fubm90IGRyaWZ0IGFwYXJ0IGluIGEgd2F5IHRoYXQgb25seVxuICogc2hvd3MgdXAgYWdhaW5zdCBhIHJlYWwgaG9zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1JFTU9URV9JTklUSUFMSVpFUl9QUk9UT0NPTF9WRVJTSU9OID1cbiAgXCJwYXBlcmN1c3AtZ2NwLWlhcC1pbml0aWFsaXphdGlvbi12NFwiO1xuXG4vKipcbiAqIEV2ZXJ5IHN0ZXAga2luZCB0aGlzIGluaXRpYWxpemVyIGNhbiBleGVjdXRlOiB0aGUgc2l4IElOSVRJQUxJWkFUSU9OIGtpbmRzIHBsdXMgdGhlIGZvdXJcbiAqIENSRURFTlRJQUwtTElGRUNZQ0xFIGtpbmRzIChQLTA0NiAvIFdJLTQwNDc0LCBwbGFuIGRlY2lzaW9uIEQtMTE0KS5cbiAqXG4gKiBXSFkgVEhFIExJRkVDWUNMRSBLSU5EUyBIQUQgVE8gSk9JTiBUSEUgV0lSRS4gYHBsYW5Xb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZWAgYW5kXG4gKiBgZXhlY3V0ZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlYCB3ZXJlIGJvdGggY29tcGxldGUsIGFuZCB0aGUgaG9zdC1zaWRlIHJlc29sdmVyXG4gKiBhbHJlYWR5IGV4cG9zZWQgYGV4ZWN1dGVMaWZlY3ljbGVTdGVwYCDigJQgYnV0IHRoZSBwcm90b2NvbCBjYXJyaWVkIG9ubHkgdGhlIGluaXRpYWxpemF0aW9uXG4gKiBraW5kcywgc28gYSBwbGFubmVkIHJvdGF0aW9uIGNvdWxkIG5vdCByZWFjaCBhIGhvc3QgYXQgYWxsLiBUaGF0IG1hdHRlcmVkIGJleW9uZCB0aWRpbmVzczpcbiAqIGB2YWxpZGF0ZVdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeWAgcmVmdXNlcyB1bmxlc3MgZXZlcnkgY3JlZGVudGlhbCBjaGFubmVsIHNob3dzXG4gKiBib3VuZCArIHJvdGF0ZWQgKyBwcmV2aW91c0JpbmRpbmdSZXZva2VkICsgcmVjb25uZWN0ZWQsIGFuZCB0aGUgZXZpZGVuY2UgYnVpbGRlciByZWZ1c2VzIHRvXG4gKiB3aWRlbiBhIGZhbHNlIG9ic2VydmF0aW9uIGludG8gYHRydWVgLiBTbyB0aGUgY2FuYXJ5IHdhcyB1bnJlYWNoYWJsZSBCWSBDT05TVFJVQ1RJT04gdW50aWxcbiAqIGxpZmVjeWNsZSBzdGVwcyBjb3VsZCBiZSBzZW50LiBUaGlzIGlzIHRoZSBjYXJyaWFnZSB0aGF0IGNsb3NlcyBpdC5cbiAqXG4gKiBXSFkgVEhFIFZFUlNJT04gQlVNUEVEIFJBVEhFUiBUSEFOIEFDQ0VQVElORyBCT1RILiBBIHYxIGhvc3QgcmVjZWl2aW5nIGEgbGlmZWN5Y2xlIGtpbmQgd291bGRcbiAqIHRocm93IGBVbnN1cHBvcnRlZFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kRXJyb3JgIOKAlCBhIHBlci1zdGVwIGZhaWx1cmUgdGhhdCByZWFkc1xuICogbGlrZSBhIGJyb2tlbiBzdGVwIHJhdGhlciB0aGFuIGFuIG91dC1vZi1kYXRlIGhvc3QuIFRoZSB2ZXJzaW9uIGNoZWNrIGlzIGZpcnN0IGFuZCB0b3RhbCBmb3JcbiAqIGV4YWN0bHkgdGhpcyByZWFzb24gKHNlZSBgcGFyc2VXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJSZXF1ZXN0YCk6IHNrZXcgc2hvdWxkIGFubm91bmNlXG4gKiBpdHNlbGYgYXMgc2tldy4gQSBob3N0IHBhY2thZ2VkIGJlZm9yZSB0aGlzIGNoYW5nZSBpcyBleHBlY3RlZCB0byBiZSByZXBsYWNlZCwgbm90IG5lZ290aWF0ZWRcbiAqIHdpdGguXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfU1RFUF9LSU5EUyA9IFtcbiAgLi4uV09SS1NQQUNFX0hPU1RfSU5JVElBTElaQVRJT05fU1RFUF9LSU5EUyxcbiAgLi4uV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9MSUZFQ1lDTEVfU1RFUF9LSU5EUyxcbiAgXCJpbnN0YWxsLWRlc2t0b3AtcGFja1wiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclN0ZXBLaW5kID1cbiAgKHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfU1RFUF9LSU5EUylbbnVtYmVyXTtcblxuLyoqIEZpeGVkIGFyZ3YgdGhlIGNvbnRyb2xsZXIgcGFzc2VzOyB0aGUgQ0xJIHJlZnVzZXMgYW55dGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfQVJHViA9IFtcbiAgXCItLXByb3RvY29sLXZlcnNpb25cIixcbiAgV09SS1NQQUNFX0hPU1RfUkVNT1RFX0lOSVRJQUxJWkVSX1BST1RPQ09MX1ZFUlNJT04sXG4gIFwiLS1qc29uLXN0ZGluXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIFRoZSB3aXJlIHN0ZXAuIERlbGliZXJhdGVseSBPTkUgZW52ZWxvcGUgc2hhcGUgZm9yIGJvdGggc3RlcCBmYW1pbGllcy5cbiAqXG4gKiBBIGBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBgIGNhcnJpZXMgYGNoYW5uZWxgL2BjcmVkZW50aWFsUmVmYC9gZGVsaXZlcnlgIGF0IHRoZVxuICogdG9wIGxldmVsIHJhdGhlciB0aGFuIGluc2lkZSBgaW5wdXRgLiBSYXRoZXIgdGhhbiB0ZWFjaCB0aGUgd2lyZSB0d28gZW52ZWxvcGUgc2hhcGVzIOKAlCB3aGljaFxuICogd291bGQgZm9yayB0aGUgcGFyc2VyLCB0aGUgc2VjcmV0LWlzb2xhdGlvbiBhc3NlcnQsIGFuZCBldmVyeSB0ZXN0IHRoYXQgZXhlcmNpc2VzIHRoZW0g4oCUIHRoZVxuICogY29udHJvbGxlci1zaWRlIGFkYXB0ZXIgZmxhdHRlbnMgdGhvc2UgZmllbGRzIElOVE8gYGlucHV0YC4gU28gYGlucHV0YCByZW1haW5zIHByZXNlbnQgYW5kXG4gKiBvYmplY3QtdHlwZWQgZm9yIGV2ZXJ5IGtpbmQsIG9uZSBwYXJzZSBwYXRoIHNlcnZlcyBib3RoIGZhbWlsaWVzLCBhbmRcbiAqIGBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uYCBrZWVwcyBjb3ZlcmluZyB0aGUgd2hvbGUgc3RlcCBleGFjdGx5IGFzIGJlZm9yZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJTdGVwIHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyU3RlcEtpbmQ7XG4gIGRlcGVuZHNPbjogcmVhZG9ubHkgc3RyaW5nW107XG4gIGlkZW1wb3RlbmN5S2V5OiBzdHJpbmc7XG4gIGlucHV0OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVxdWVzdCB7XG4gIHByb3RvY29sVmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX1JFTU9URV9JTklUSUFMSVpFUl9QUk9UT0NPTF9WRVJTSU9OO1xuICBzdGVwOiBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJTdGVwO1xufVxuXG4vKipcbiAqIEVuY29kZSBhIHBsYW5uZWQgY3JlZGVudGlhbC1saWZlY3ljbGUgc3RlcCBmb3IgdGhlIHdpcmUuXG4gKlxuICogVGhpcyBsaXZlcyBIRVJFLCBiZXNpZGUgdGhlIHBhcnNlciB0aGF0IHdpbGwgcmVhZCBpdCBiYWNrLCByYXRoZXIgdGhhbiBpbiB0aGUgY29udHJvbGxlciB0aGF0XG4gKiBjYWxscyBpdC4gVGhlIGZsYXR0ZW5pbmcgZGVzY3JpYmVkIG9uIGBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJTdGVwYCBpcyBhIHByb3BlcnR5IG9mIHRoZVxuICogcHJvdG9jb2wsIG5vdCBvZiBhbnkgb25lIGNhbGxlciwgYW5kIGEgY29udHJvbGxlciB0aGF0IG9wZW4tY29kZWQgaXQgd291bGQgYmUgYSBzZWNvbmRcbiAqIGRlZmluaXRpb24gb2YgdGhlIHdpcmUgZm9ybWF0IHNpdHRpbmcgd2hlcmUgbm9ib2R5IHdvdWxkIHRoaW5rIHRvIGxvb2sgd2hlbiB0aGUgZm9ybWF0IGNoYW5nZWQuXG4gKiBFbmNvZGVyIGFuZCBwYXJzZXIgYmVpbmcgYWRqYWNlbnQgaXMgd2hhdCBsZXRzIGEgcm91bmQtdHJpcCB0ZXN0IGNvdmVyIGJvdGggYXQgb25jZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuY29kZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcChcbiAgc3RlcDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVTdGVwLFxuKTogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyU3RlcCB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHN0ZXAuaWQsXG4gICAga2luZDogc3RlcC5raW5kLFxuICAgIGRlcGVuZHNPbjogc3RlcC5kZXBlbmRzT24sXG4gICAgaWRlbXBvdGVuY3lLZXk6IHN0ZXAuaWRlbXBvdGVuY3lLZXksXG4gICAgaW5wdXQ6IHtcbiAgICAgIGNoYW5uZWw6IHN0ZXAuY2hhbm5lbCxcbiAgICAgIGNyZWRlbnRpYWxSZWY6IHN0ZXAuY3JlZGVudGlhbFJlZixcbiAgICAgIGRlbGl2ZXJ5OiBzdGVwLmRlbGl2ZXJ5LFxuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVzcG9uc2Uge1xuICBwcm90b2NvbFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfUFJPVE9DT0xfVkVSU0lPTjtcbiAgc3RlcElkOiBzdHJpbmc7XG4gIHN0YXR1czogXCJzdWNjZWVkZWRcIjtcbiAgb2JzZXJ2ZWRBdDogc3RyaW5nO1xuICBwdWJsaWNFdmlkZW5jZT86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cblxuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclByb3RvY29sRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvclwiO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBVbnN1cHBvcnRlZFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihraW5kOiBzdHJpbmcpIHtcbiAgICBzdXBlcihcbiAgICAgIGBSZW1vdGUgaW5pdGlhbGl6ZXIgaGFzIG5vIGhhbmRsZXIgZm9yIHN0ZXAga2luZCAnJHtraW5kfScuIFN1cHBvcnRlZDogYCArXG4gICAgICAgIGAke1dPUktTUEFDRV9IT1NUX1JFTU9URV9JTklUSUFMSVpFUl9TVEVQX0tJTkRTLmpvaW4oXCIsIFwiKX0uYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiVW5zdXBwb3J0ZWRXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25TdGVwS2luZEVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgfVxufVxuXG4vKiogUHVibGljIGV2aWRlbmNlIHJldHVybmVkIGJ5IGEgaGFuZGxlcjsgdGhlIGVudmVsb3BlIGFkZHMgYHN0ZXBJZGAvYG9ic2VydmVkQXRgLiAqL1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZSA9IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlYXRlV29ya3NwYWNlSW5wdXQge1xuICByZWFkb25seSB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICByZWFkb25seSBob3N0SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q2xvbmVSZXBvc2l0b3J5SW5wdXQge1xuICByZWFkb25seSByZXBvc2l0b3J5VXJsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHZpc2liaWxpdHk6IFwicHVibGljXCIgfCBcInByaXZhdGVcIjtcbiAgcmVhZG9ubHkgZGVzdGluYXRpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcmV2aXNpb24/OiBzdHJpbmc7XG4gIC8qKiBQcmVzZW50IGV4YWN0bHkgd2hlbiB0aGUgY2xvbmUgbXVzdCBhdXRoZW50aWNhdGU7IHRoZSBwbGFubmVyIGhvaXN0cyB0aGUgZ2l0IGJpbmQgZmlyc3QuICovXG4gIHJlYWRvbmx5IGNyZWRlbnRpYWxDaGFubmVsPzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RQYWlyV29ya3NwYWNlSW5wdXQge1xuICByZWFkb25seSBzb3VyY2VXb3Jrc3BhY2VJZDogc3RyaW5nO1xuICByZWFkb25seSBwYWlyaW5nUmVmZXJlbmNlOiB7IHJlYWRvbmx5IGtpbmQ6IFwicGFpcmluZ1wiOyByZWFkb25seSByZWY6IHN0cmluZyB9O1xuICByZWFkb25seSBpbmNsdWRlOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW1wb3J0V29ya3NwYWNlSW5wdXQge1xuICByZWFkb25seSBzb3VyY2VXb3Jrc3BhY2VJZDogc3RyaW5nO1xuICByZWFkb25seSBzb3VyY2VTbmFwc2hvdFJlZjogc3RyaW5nO1xuICByZWFkb25seSBpbmNsdWRlOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0VmVyaWZ5SW5pdGlhbGl6YXRpb25JbnB1dCB7XG4gIHJlYWRvbmx5IHNvdXJjZUtpbmQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVxdWlyZWRDaGFubmVsczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsW107XG4gIC8qKiBSZS1jYXJyaWVkIGJlY2F1c2UgZXZlcnkgcmVtb3RlIHN0ZXAgaXMgYSBmcmVzaCBwcm9jZXNzIHdpdGggbm8gcHJpb3IgY2xvbmUgb2JqZWN0LiAqL1xuICByZWFkb25seSByZXBvc2l0b3J5Pzoge1xuICAgIHJlYWRvbmx5IGRlc3RpbmF0aW9uOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdmlzaWJpbGl0eTogXCJwdWJsaWNcIiB8IFwicHJpdmF0ZVwiO1xuICB9O1xufVxuXG4vKipcbiAqIFRoZSBob3N0LXNpZGUgb3BlcmF0aW9ucyB0aGUgaW5pdGlhbGl6ZXIgcGVyZm9ybXMuIEV2ZXJ5dGhpbmcgdGhhdCB0b3VjaGVzIHRoZSBmaWxlc3lzdGVtLCBnaXQsXG4gKiBvciBhbm90aGVyIHdvcmtzcGFjZSBsaXZlcyBiZWhpbmQgdGhpcyBzZWFtIHNvIHRoZSBwcm90b2NvbCBlbmdpbmUgYWJvdmUgaXQgaXMgYSBwdXJlIGZ1bmN0aW9uXG4gKiBvZiBpdHMgaW5wdXRzIGFuZCBjYW4gYmUgdGVzdGVkIGV4aGF1c3RpdmVseSB3aXRob3V0IGEgVk0uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVySG9zdCB7XG4gIC8qKiBSZWFkLW9ubHkgcmV0YWluZWQtZGF0YSBhZG1pc3Npb247IGFuIG9sZGVyIGFkYXB0ZXIgbXVzdCByZWZ1c2UsIG5ldmVyIGNyZWF0ZSBhIHdvcmtzcGFjZS4gKi9cbiAgdmVyaWZ5UmV0YWluZWRXb3Jrc3BhY2U/KGlucHV0OiBXb3Jrc3BhY2VIb3N0Q3JlYXRlV29ya3NwYWNlSW5wdXQgJiB7IHRlbmFudElkZW50aXR5OiBzdHJpbmcgfSk6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZT47XG4gIC8qKiBPcHRpb25hbCBwb3N0LXByb3Zpc2lvbiBwYWNrOyBuZXZlciBwYXJ0IG9mIG9yZGluYXJ5IGhlYWRsZXNzIGluaXRpYWxpemF0aW9uLiAqL1xuICBpbnN0YWxsRGVza3RvcFBhY2s/KGlucHV0OiB7IGhvc3RJZDogc3RyaW5nIH0pOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RSZW1vdGVTdGVwRXZpZGVuY2U+O1xuICBjcmVhdGVXb3Jrc3BhY2UoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDcmVhdGVXb3Jrc3BhY2VJbnB1dCxcbiAgKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0UmVtb3RlU3RlcEV2aWRlbmNlPjtcbiAgY2xvbmVSZXBvc2l0b3J5KFxuICAgIGlucHV0OiBXb3Jrc3BhY2VIb3N0Q2xvbmVSZXBvc2l0b3J5SW5wdXQsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZT47XG4gIHBhaXJXb3Jrc3BhY2UoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RQYWlyV29ya3NwYWNlSW5wdXQsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZT47XG4gIGltcG9ydFdvcmtzcGFjZShcbiAgICBpbnB1dDogV29ya3NwYWNlSG9zdEltcG9ydFdvcmtzcGFjZUlucHV0LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RSZW1vdGVTdGVwRXZpZGVuY2U+O1xuICAvKiogUHJvYmUgdGhlIHJlcXVlc3RlZCBhZ2VudHMuIE9taXNzaW9uIHJldGFpbnMgYWxsLXRocmVlIGNvdmVyYWdlLiAqL1xuICBwcm9iZUFnZW50VmVyaWZpY2F0aW9uKHJlcXVlc3RlZEFnZW50cz86IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudFtdKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25SZXBvcnQ+O1xuICAvKiogQ29uZmlybSB0aGUgcHJpdmF0ZSBjbG9uZSBsYW5kZWQsIGZvciB0aGUgdmVyaWZ5IHN0ZXAncyByZXBvc2l0b3J5IGV2aWRlbmNlLiAqL1xuICBkZXNjcmliZUNsb25lZFJlcG9zaXRvcnkoaW5wdXQ/OiB7XG4gICAgcmVhZG9ubHkgZGVzdGluYXRpb246IHN0cmluZztcbiAgICByZWFkb25seSB2aXNpYmlsaXR5OiBcInB1YmxpY1wiIHwgXCJwcml2YXRlXCI7XG4gIH0pOiBQcm9taXNlPHtcbiAgICByZWFkb25seSB2aXNpYmlsaXR5OiBcInB1YmxpY1wiIHwgXCJwcml2YXRlXCI7XG4gICAgcmVhZG9ubHkgY2xvbmVkOiBib29sZWFuO1xuICB9Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJEZXBzIHtcbiAgcmVhZG9ubHkgaG9zdDogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVySG9zdDtcbiAgcmVhZG9ubHkgY3JlZGVudGlhbHM6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVzb2x2ZXI7XG4gIHJlYWRvbmx5IG5vdz86ICgpID0+IERhdGU7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVPYmplY3QoXG4gIHZhbHVlOiB1bmtub3duLFxuICBsYWJlbDogc3RyaW5nLFxuKTogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgIGAke2xhYmVsfSBtdXN0IGJlIGFuIG9iamVjdGAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xufVxuXG5mdW5jdGlvbiByZXF1aXJlU3RyaW5nKHZhbHVlOiB1bmtub3duLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgIGAke2xhYmVsfSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ2AsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYW4gaW5ib3VuZCByZXF1ZXN0IGVudmVsb3BlLlxuICpcbiAqIFRoZSBwcm90b2NvbC12ZXJzaW9uIGNoZWNrIGlzIEZJUlNUIGFuZCB0b3RhbC4gQSBob3N0IHRoYXQgZXhlY3V0ZWQgYSBzdGVwIGZyb20gYW4gZW52ZWxvcGUgaXRcbiAqIGRpZCBub3QgdW5kZXJzdGFuZCB3b3VsZCBiZSBhY3Rpbmcgb24gYSBjb250cmFjdCBpdCBjYW5ub3QgdmVyaWZ5IOKAlCBhbmQgdW5saWtlIGEgbWFsZm9ybWVkXG4gKiBmaWVsZCwgYSB2ZXJzaW9uIHNrZXcgbWVhbnMgZXZlcnkgbGF0ZXIgYXNzdW1wdGlvbiBpbiB0aGlzIGZpbGUgbWF5IGJlIHdyb25nIHRvby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVxdWVzdChcbiAgcmF3OiB1bmtub3duLFxuKTogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVxdWVzdCB7XG4gIGNvbnN0IGJvZHkgPSByZXF1aXJlT2JqZWN0KHJhdywgXCJyZXF1ZXN0XCIpO1xuICBpZiAoXG4gICAgYm9keS5wcm90b2NvbFZlcnNpb24gIT09IFdPUktTUEFDRV9IT1NUX1JFTU9URV9JTklUSUFMSVpFUl9QUk9UT0NPTF9WRVJTSU9OXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgYHVuc3VwcG9ydGVkIHByb3RvY29sIHZlcnNpb24gJyR7U3RyaW5nKGJvZHkucHJvdG9jb2xWZXJzaW9uKX0nOyB0aGlzIGluaXRpYWxpemVyIHNwZWFrcyBgICtcbiAgICAgICAgYCcke1dPUktTUEFDRV9IT1NUX1JFTU9URV9JTklUSUFMSVpFUl9QUk9UT0NPTF9WRVJTSU9OfSdgLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc3RlcCA9IHJlcXVpcmVPYmplY3QoYm9keS5zdGVwLCBcInJlcXVlc3Quc3RlcFwiKTtcbiAgY29uc3QgaWQgPSByZXF1aXJlU3RyaW5nKHN0ZXAuaWQsIFwicmVxdWVzdC5zdGVwLmlkXCIpO1xuICBjb25zdCBraW5kID0gcmVxdWlyZVN0cmluZyhzdGVwLmtpbmQsIFwicmVxdWVzdC5zdGVwLmtpbmRcIik7XG4gIGlmIChcbiAgICAhKFxuICAgICAgV09SS1NQQUNFX0hPU1RfUkVNT1RFX0lOSVRJQUxJWkVSX1NURVBfS0lORFMgYXMgcmVhZG9ubHkgc3RyaW5nW11cbiAgICApLmluY2x1ZGVzKGtpbmQpXG4gICkge1xuICAgIHRocm93IG5ldyBVbnN1cHBvcnRlZFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kRXJyb3Ioa2luZCk7XG4gIH1cbiAgcmVxdWlyZVN0cmluZyhzdGVwLmlkZW1wb3RlbmN5S2V5LCBcInJlcXVlc3Quc3RlcC5pZGVtcG90ZW5jeUtleVwiKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHN0ZXAuZGVwZW5kc09uKSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgXCJyZXF1ZXN0LnN0ZXAuZGVwZW5kc09uIG11c3QgYmUgYW4gYXJyYXlcIixcbiAgICApO1xuICB9XG4gIHJlcXVpcmVPYmplY3Qoc3RlcC5pbnB1dCwgXCJyZXF1ZXN0LnN0ZXAuaW5wdXRcIik7XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgc3RlcCxcbiAgICBgd29ya3NwYWNlSG9zdC5yZW1vdGVJbml0aWFsaXplci5yZXF1ZXN0LiR7aWR9YCxcbiAgKTtcblxuICByZXR1cm4ge1xuICAgIHByb3RvY29sVmVyc2lvbjogV09SS1NQQUNFX0hPU1RfUkVNT1RFX0lOSVRJQUxJWkVSX1BST1RPQ09MX1ZFUlNJT04sXG4gICAgc3RlcDoge1xuICAgICAgaWQsXG4gICAgICBraW5kOiBraW5kIGFzIFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclN0ZXBLaW5kLFxuICAgICAgZGVwZW5kc09uOiBzdGVwLmRlcGVuZHNPbiBhcyByZWFkb25seSBzdHJpbmdbXSxcbiAgICAgIGlkZW1wb3RlbmN5S2V5OiBzdGVwLmlkZW1wb3RlbmN5S2V5IGFzIHN0cmluZyxcbiAgICAgIGlucHV0OiBzdGVwLmlucHV0IGFzIFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PixcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZWFkSW5jbHVkZSh2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZyk6IHJlYWRvbmx5IHN0cmluZ1tdIHtcbiAgaWYgKFxuICAgICFBcnJheS5pc0FycmF5KHZhbHVlKSB8fFxuICAgIHZhbHVlLnNvbWUoKGVudHJ5KSA9PiB0eXBlb2YgZW50cnkgIT09IFwic3RyaW5nXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgYCR7bGFiZWx9IG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5nc2AsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKlxuICogRXhlY3V0ZSBPTkUgY3JlZGVudGlhbCBvcGVyYXRpb24gbmFtZWQgYnkgYSBzdGVwLCBhbmQgcHJvamVjdCBpdHMgZXZpZGVuY2UgZm9yIHRoZSB3aXJlLlxuICpcbiAqIFNoYXJlZCBieSB0aGUgaW5pdGlhbGl6YXRpb24gYGJpbmQtY3JlZGVudGlhbGAgc3RlcCBhbmQgYnkgYWxsIGZvdXIgY3JlZGVudGlhbC1saWZlY3ljbGVcbiAqIHN0ZXBzLCBiZWNhdXNlIHRoZXkgYXJlIHRoZSBzYW1lIGFjdDogcmVzb2x2ZSB0aGUgY2hhbm5lbCdzIG1hdGVyaWFsaXplciBhbmQgcnVuIG9uZSBvcGVyYXRpb25cbiAqIGFnYWluc3QgaXQuIFNoYXJpbmcgbWF0dGVycyBtb3JlIHRoYW4gdGhlIGZldyBzYXZlZCBsaW5lcyDigJQgdGhlIHByb2plY3Rpb24gYmVsb3cgaXMgdGhlXG4gKiBhbGxvd2xpc3QgdGhhdCBkZWNpZGVzIHdoYXQgbGVhdmVzIHRoZSBob3N0LCBzbyBhIHNlY29uZCBjb3B5IG9mIGl0IGlzIGEgc2Vjb25kIHBsYWNlIGZvciBhXG4gKiBmaWVsZCB0byBiZSBhZGRlZCB3aXRob3V0IGFueW9uZSByZS1hc2tpbmcgd2hldGhlciBpdCBpcyBzYWZlIHRvIGVtaXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1bkNyZWRlbnRpYWxPcGVyYXRpb24oXG4gIG9wZXJhdGlvbjogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxPcGVyYXRpb24sXG4gIGlucHV0OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4sXG4gIGRlcHM6IFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplckRlcHMsXG4gIG5vdzogKCkgPT4gRGF0ZSxcbik6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZT4ge1xuICBjb25zdCBjaGFubmVsID0gcmVxdWlyZVN0cmluZyhpbnB1dC5jaGFubmVsLCBcInN0ZXAuaW5wdXQuY2hhbm5lbFwiKTtcbiAgaWYgKFxuICAgICFXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0NIQU5ORUxTLmluY2x1ZGVzKFxuICAgICAgY2hhbm5lbCBhcyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWwsXG4gICAgKVxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgIGBzdGVwLmlucHV0LmNoYW5uZWwgJyR7Y2hhbm5lbH0nIGlzIG5vdCBhIGNyZWRlbnRpYWwgY2hhbm5lbGAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBjcmVkZW50aWFsUmVmID0gcmVxdWlyZU9iamVjdChcbiAgICBpbnB1dC5jcmVkZW50aWFsUmVmLFxuICAgIFwic3RlcC5pbnB1dC5jcmVkZW50aWFsUmVmXCIsXG4gICk7XG4gIGNvbnN0IGRlbGl2ZXJ5ID0gcmVxdWlyZU9iamVjdChpbnB1dC5kZWxpdmVyeSwgXCJzdGVwLmlucHV0LmRlbGl2ZXJ5XCIpO1xuICAvLyBgcmVxdWVzdGVkQXRgIGlzIG5vdCBjYXJyaWVkIG9uIHRoZSBzdGVwLCBzbyB0aGUgYmluZGluZydzIGV4cGlyeSBpcyBqdWRnZWQgYWdhaW5zdCB0aGVcbiAgLy8gZGVsaXZlcnkncyBvd24gd2luZG93IHJhdGhlciB0aGFuIGFnYWluc3QgYSBjbG9jayB0aGUgY29udHJvbGxlciBuZXZlciBzYXcuIFVzaW5nIHRoZVxuICAvLyBob3N0IGNsb2NrIGhlcmUgd291bGQgbGV0IGEgaG9zdCBhY2NlcHQgYSBkZWxlZ2F0aW9uIHRoZSBjb250cm9sbGVyIGhhZCBhbHJlYWR5IHJlZnVzZWQuXG4gIGNvbnN0IHJlcXVlc3RlZEF0ID0gbmV3IERhdGUobm93KCkuZ2V0VGltZSgpIC0gMSkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgZXZpZGVuY2U6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRXZpZGVuY2UgPSBhd2FpdCBkZXBzLmNyZWRlbnRpYWxzLnJ1bihcbiAgICBvcGVyYXRpb24sXG4gICAge1xuICAgICAgY2hhbm5lbDogY2hhbm5lbCBhcyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWwsXG4gICAgICBjcmVkZW50aWFsUmVmOiB7XG4gICAgICAgIGtpbmQ6IHJlcXVpcmVTdHJpbmcoXG4gICAgICAgICAgY3JlZGVudGlhbFJlZi5raW5kLFxuICAgICAgICAgIFwic3RlcC5pbnB1dC5jcmVkZW50aWFsUmVmLmtpbmRcIixcbiAgICAgICAgKSxcbiAgICAgICAgcmVmOiByZXF1aXJlU3RyaW5nKGNyZWRlbnRpYWxSZWYucmVmLCBcInN0ZXAuaW5wdXQuY3JlZGVudGlhbFJlZi5yZWZcIiksXG4gICAgICB9LFxuICAgICAgZGVsaXZlcnk6IGRlbGl2ZXJ5IGFzIG5ldmVyLFxuICAgICAgcmVxdWVzdGVkQXQsXG4gICAgfSxcbiAgKTtcbiAgcmV0dXJuIHtcbiAgICBjaGFubmVsOiBldmlkZW5jZS5jaGFubmVsLFxuICAgIGZhbWlseTogZXZpZGVuY2UuZmFtaWx5LFxuICAgIG9wZXJhdGlvbjogZXZpZGVuY2Uub3BlcmF0aW9uLFxuICAgIGRlbGl2ZXJ5S2luZDogZXZpZGVuY2UuZGVsaXZlcnlLaW5kLFxuICAgIGdlbmVyYXRpb246IGV2aWRlbmNlLmdlbmVyYXRpb24sXG4gICAgYXVkaWVuY2U6IGV2aWRlbmNlLmF1ZGllbmNlLFxuICAgIHJlZmVyZW5jZURpZ2VzdDogZXZpZGVuY2UucmVmZXJlbmNlRGlnZXN0LFxuICAgIGRldGFpbDogZXZpZGVuY2UuZGV0YWlsLFxuICB9O1xufVxuXG4vKipcbiAqIEV4ZWN1dGUgb25lIHN0ZXAgYW5kIHByb2R1Y2UgdGhlIHJlc3BvbnNlIHRoZSBjb250cm9sbGVyIGV4cGVjdHMuXG4gKlxuICogYG9ic2VydmVkQXRgIGlzIHN0YW1wZWQgQUZURVIgdGhlIGhhbmRsZXIgcmV0dXJucywgc28gaXQgcmVjb3JkcyB3aGVuIHRoZSB3b3JrIGZpbmlzaGVkIHJhdGhlclxuICogdGhhbiB3aGVuIHRoZSByZXF1ZXN0IHdhcyBwYXJzZWQuIFRoZSBjb250cm9sbGVyIHZhbGlkYXRlcyBpdCBhcyBhbiBJU08gdGltZXN0YW1wIGFuZCBwZXJzaXN0c1xuICogaXQgYXMgdGhlIHJlY2VpcHQncyBvYnNlcnZhdGlvbiB0aW1lOyBhIHN0YW1wIHRha2VuIGJlZm9yZSBhIHR3by1taW51dGUgY2xvbmUgd291bGQgZGVzY3JpYmUgYW5cbiAqIGluc3RhbnQgYXQgd2hpY2ggdGhlIGV2aWRlbmNlIHdhcyBub3QgeWV0IHRydWUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyU3RlcChcbiAgcmVxdWVzdDogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVxdWVzdCxcbiAgZGVwczogV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyRGVwcyxcbik6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUmVzcG9uc2U+IHtcbiAgY29uc3QgeyBzdGVwIH0gPSByZXF1ZXN0O1xuICBjb25zdCBub3cgPSBkZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSk7XG4gIGNvbnN0IGlucHV0ID0gc3RlcC5pbnB1dDtcblxuICBsZXQgcHVibGljRXZpZGVuY2U6IFdvcmtzcGFjZUhvc3RSZW1vdGVTdGVwRXZpZGVuY2U7XG4gIHN3aXRjaCAoc3RlcC5raW5kKSB7XG4gICAgY2FzZSBcImluc3RhbGwtZGVza3RvcC1wYWNrXCI6IHtcbiAgICAgIC8vIFRoaXMgY3Jvc3NlcyB0aGUgZXhpc3RpbmcgcHJpdmlsZWdlZCBjb25kdWl0LiBUaGUgY2FsbGVyIHNlbGVjdHMgT05MWSB0aGUgaG9zdCxcbiAgICAgIC8vIG5ldmVyIGEgc2NyaXB0LCBkb3dubG9hZCBVUkwsIGNoZWNrc3VtLCBvciBVbml4IGFjY291bnQgZm9yIHJvb3QgdG8gZXhlY3V0ZS5cbiAgICAgIGlmIChPYmplY3Qua2V5cyhpbnB1dCkuc29tZSgoa2V5KSA9PiBrZXkgIT09IFwiaG9zdElkXCIpKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgICAgIFwiaW5zdGFsbC1kZXNrdG9wLXBhY2sgYWNjZXB0cyBvbmx5IHN0ZXAuaW5wdXQuaG9zdElkXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBob3N0SWQgPSByZXF1aXJlU3RyaW5nKGlucHV0Lmhvc3RJZCwgXCJzdGVwLmlucHV0Lmhvc3RJZFwiKTtcbiAgICAgIGlmICghL15bYS16MC05XVthLXowLTkuXy1dezAsMTI3fSQvaS50ZXN0KGhvc3RJZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclByb3RvY29sRXJyb3IoXCJpbnZhbGlkIGRlc2t0b3AtcGFjayBob3N0SWRcIik7XG4gICAgICB9XG4gICAgICBpZiAoIWRlcHMuaG9zdC5pbnN0YWxsRGVza3RvcFBhY2spIHtcbiAgICAgICAgdGhyb3cgbmV3IFVuc3VwcG9ydGVkV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcEtpbmRFcnJvcihzdGVwLmtpbmQpO1xuICAgICAgfVxuICAgICAgcHVibGljRXZpZGVuY2UgPSBhd2FpdCBkZXBzLmhvc3QuaW5zdGFsbERlc2t0b3BQYWNrKHsgaG9zdElkIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJ2ZXJpZnktcmV0YWluZWQtd29ya3NwYWNlXCI6IHtcbiAgICAgIGNvbnN0IHRlbmFudElkZW50aXR5ID0gcmVxdWlyZVN0cmluZyhpbnB1dC50ZW5hbnRJZGVudGl0eSwgXCJzdGVwLmlucHV0LnRlbmFudElkZW50aXR5XCIpO1xuICAgICAgaWYgKCEvXlthLWYwLTldezY0fSQvLnRlc3QodGVuYW50SWRlbnRpdHkpKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFwiaW52YWxpZCByZXRhaW5lZCB0ZW5hbnQgaWRlbnRpdHlcIik7XG4gICAgICB9XG4gICAgICBpZiAoIWRlcHMuaG9zdC52ZXJpZnlSZXRhaW5lZFdvcmtzcGFjZSkgdGhyb3cgbmV3IFVuc3VwcG9ydGVkV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uU3RlcEtpbmRFcnJvcihzdGVwLmtpbmQpO1xuICAgICAgcHVibGljRXZpZGVuY2UgPSBhd2FpdCBkZXBzLmhvc3QudmVyaWZ5UmV0YWluZWRXb3Jrc3BhY2Uoe1xuICAgICAgICB3b3Jrc3BhY2VJZDogcmVxdWlyZVN0cmluZyhpbnB1dC53b3Jrc3BhY2VJZCwgXCJzdGVwLmlucHV0LndvcmtzcGFjZUlkXCIpLFxuICAgICAgICBob3N0SWQ6IHJlcXVpcmVTdHJpbmcoaW5wdXQuaG9zdElkLCBcInN0ZXAuaW5wdXQuaG9zdElkXCIpLFxuICAgICAgICB0ZW5hbnRJZGVudGl0eSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJjcmVhdGUtd29ya3NwYWNlXCI6IHtcbiAgICAgIHB1YmxpY0V2aWRlbmNlID0gYXdhaXQgZGVwcy5ob3N0LmNyZWF0ZVdvcmtzcGFjZSh7XG4gICAgICAgIHdvcmtzcGFjZUlkOiByZXF1aXJlU3RyaW5nKGlucHV0LndvcmtzcGFjZUlkLCBcInN0ZXAuaW5wdXQud29ya3NwYWNlSWRcIiksXG4gICAgICAgIGhvc3RJZDogcmVxdWlyZVN0cmluZyhpbnB1dC5ob3N0SWQsIFwic3RlcC5pbnB1dC5ob3N0SWRcIiksXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY2xvbmUtcmVwb3NpdG9yeVwiOiB7XG4gICAgICBjb25zdCB2aXNpYmlsaXR5ID0gcmVxdWlyZVN0cmluZyhcbiAgICAgICAgaW5wdXQudmlzaWJpbGl0eSxcbiAgICAgICAgXCJzdGVwLmlucHV0LnZpc2liaWxpdHlcIixcbiAgICAgICk7XG4gICAgICBpZiAodmlzaWJpbGl0eSAhPT0gXCJwdWJsaWNcIiAmJiB2aXNpYmlsaXR5ICE9PSBcInByaXZhdGVcIikge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgICAgICBcInN0ZXAuaW5wdXQudmlzaWJpbGl0eSBtdXN0IGJlICdwdWJsaWMnIG9yICdwcml2YXRlJ1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgY3JlZGVudGlhbENoYW5uZWwgPSBpbnB1dC5jcmVkZW50aWFsQ2hhbm5lbDtcbiAgICAgIGlmIChcbiAgICAgICAgY3JlZGVudGlhbENoYW5uZWwgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAhV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9DSEFOTkVMUy5pbmNsdWRlcyhcbiAgICAgICAgICBjcmVkZW50aWFsQ2hhbm5lbCBhcyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWwsXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgICAgICBgc3RlcC5pbnB1dC5jcmVkZW50aWFsQ2hhbm5lbCAnJHtTdHJpbmcoY3JlZGVudGlhbENoYW5uZWwpfScgaXMgbm90IGEgY3JlZGVudGlhbCBjaGFubmVsYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIEEgcHJpdmF0ZSBjbG9uZSB3aXRoIG5vIGNoYW5uZWwgd291bGQgc2lsZW50bHkgYXR0ZW1wdCBhbiB1bmF1dGhlbnRpY2F0ZWQgZmV0Y2ggYW5kIGZhaWxcbiAgICAgIC8vIGFzIFwicmVwb3NpdG9yeSBub3QgZm91bmRcIiwgd2hpY2ggcmVhZHMgbGlrZSBhIHdyb25nIFVSTCByYXRoZXIgdGhhbiBhIG1pc3NpbmcgYmluZGluZy5cbiAgICAgIGlmICh2aXNpYmlsaXR5ID09PSBcInByaXZhdGVcIiAmJiBjcmVkZW50aWFsQ2hhbm5lbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgICAgIFwiYSBwcml2YXRlIGNsb25lIHN0ZXAgbXVzdCBuYW1lIHRoZSBjcmVkZW50aWFsIGNoYW5uZWwgaXQgYXV0aGVudGljYXRlcyB3aXRoXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBwdWJsaWNFdmlkZW5jZSA9IGF3YWl0IGRlcHMuaG9zdC5jbG9uZVJlcG9zaXRvcnkoe1xuICAgICAgICByZXBvc2l0b3J5VXJsOiByZXF1aXJlU3RyaW5nKFxuICAgICAgICAgIGlucHV0LnJlcG9zaXRvcnlVcmwsXG4gICAgICAgICAgXCJzdGVwLmlucHV0LnJlcG9zaXRvcnlVcmxcIixcbiAgICAgICAgKSxcbiAgICAgICAgdmlzaWJpbGl0eSxcbiAgICAgICAgZGVzdGluYXRpb246IHJlcXVpcmVTdHJpbmcoaW5wdXQuZGVzdGluYXRpb24sIFwic3RlcC5pbnB1dC5kZXN0aW5hdGlvblwiKSxcbiAgICAgICAgLi4uKHR5cGVvZiBpbnB1dC5yZXZpc2lvbiA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyByZXZpc2lvbjogaW5wdXQucmV2aXNpb24gfVxuICAgICAgICAgIDoge30pLFxuICAgICAgICAuLi4oY3JlZGVudGlhbENoYW5uZWxcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgY3JlZGVudGlhbENoYW5uZWw6XG4gICAgICAgICAgICAgICAgY3JlZGVudGlhbENoYW5uZWwgYXMgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsLFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInBhaXItd29ya3NwYWNlXCI6IHtcbiAgICAgIGNvbnN0IHBhaXJpbmcgPSByZXF1aXJlT2JqZWN0KFxuICAgICAgICBpbnB1dC5wYWlyaW5nUmVmZXJlbmNlLFxuICAgICAgICBcInN0ZXAuaW5wdXQucGFpcmluZ1JlZmVyZW5jZVwiLFxuICAgICAgKTtcbiAgICAgIGlmIChwYWlyaW5nLmtpbmQgIT09IFwicGFpcmluZ1wiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgICAgIFwic3RlcC5pbnB1dC5wYWlyaW5nUmVmZXJlbmNlLmtpbmQgbXVzdCBiZSAncGFpcmluZydcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHB1YmxpY0V2aWRlbmNlID0gYXdhaXQgZGVwcy5ob3N0LnBhaXJXb3Jrc3BhY2Uoe1xuICAgICAgICBzb3VyY2VXb3Jrc3BhY2VJZDogcmVxdWlyZVN0cmluZyhcbiAgICAgICAgICBpbnB1dC5zb3VyY2VXb3Jrc3BhY2VJZCxcbiAgICAgICAgICBcInN0ZXAuaW5wdXQuc291cmNlV29ya3NwYWNlSWRcIixcbiAgICAgICAgKSxcbiAgICAgICAgcGFpcmluZ1JlZmVyZW5jZToge1xuICAgICAgICAgIGtpbmQ6IFwicGFpcmluZ1wiLFxuICAgICAgICAgIHJlZjogcmVxdWlyZVN0cmluZyhwYWlyaW5nLnJlZiwgXCJzdGVwLmlucHV0LnBhaXJpbmdSZWZlcmVuY2UucmVmXCIpLFxuICAgICAgICB9LFxuICAgICAgICBpbmNsdWRlOiByZWFkSW5jbHVkZShpbnB1dC5pbmNsdWRlLCBcInN0ZXAuaW5wdXQuaW5jbHVkZVwiKSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJpbXBvcnQtd29ya3NwYWNlXCI6IHtcbiAgICAgIHB1YmxpY0V2aWRlbmNlID0gYXdhaXQgZGVwcy5ob3N0LmltcG9ydFdvcmtzcGFjZSh7XG4gICAgICAgIHNvdXJjZVdvcmtzcGFjZUlkOiByZXF1aXJlU3RyaW5nKFxuICAgICAgICAgIGlucHV0LnNvdXJjZVdvcmtzcGFjZUlkLFxuICAgICAgICAgIFwic3RlcC5pbnB1dC5zb3VyY2VXb3Jrc3BhY2VJZFwiLFxuICAgICAgICApLFxuICAgICAgICBzb3VyY2VTbmFwc2hvdFJlZjogcmVxdWlyZVN0cmluZyhcbiAgICAgICAgICBpbnB1dC5zb3VyY2VTbmFwc2hvdFJlZixcbiAgICAgICAgICBcInN0ZXAuaW5wdXQuc291cmNlU25hcHNob3RSZWZcIixcbiAgICAgICAgKSxcbiAgICAgICAgaW5jbHVkZTogcmVhZEluY2x1ZGUoaW5wdXQuaW5jbHVkZSwgXCJzdGVwLmlucHV0LmluY2x1ZGVcIiksXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYmluZC1jcmVkZW50aWFsXCI6IHtcbiAgICAgIHB1YmxpY0V2aWRlbmNlID0gYXdhaXQgcnVuQ3JlZGVudGlhbE9wZXJhdGlvbihcImJpbmRcIiwgaW5wdXQsIGRlcHMsIG5vdyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgLy8gVGhlIGZvdXIgQ1JFREVOVElBTC1MSUZFQ1lDTEUga2luZHMgKEQtMTE0KS4gQSBsaWZlY3ljbGUgc3RlcCBpcyBleGFjdGx5IGEgcmVxdWVzdCB0byBydW5cbiAgICAvLyBvbmUgY3JlZGVudGlhbCBvcGVyYXRpb24gYWdhaW5zdCBvbmUgY2hhbm5lbCwgYW5kIGBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE9wZXJhdGlvbmAgaGFzXG4gICAgLy8gdGhlIHNhbWUgZm91ciBtZW1iZXJzIGFzIGBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBLaW5kYCDigJQgc28gdGhlIGtpbmQgSVMgdGhlXG4gICAgLy8gb3BlcmF0aW9uIGFuZCBuZWVkcyBubyBtYXBwaW5nIHRhYmxlLiBUaGF0IGlkZW50aXR5IGlzIGFzc2VydGVkIGJ5IGEgdGVzdCByYXRoZXIgdGhhblxuICAgIC8vIGFzc3VtZWQgaGVyZSwgYmVjYXVzZSBhIHRhYmxlIG5vYm9keSBjaGVja3MgaXMgaG93IHRoZSB0d28gbGlzdHMgZHJpZnQgYXBhcnQuXG4gICAgLy9cbiAgICAvLyBOb3RlIGBiaW5kLWNyZWRlbnRpYWxgIGFib3ZlIGFuZCBgYmluZGAgaGVyZSBkaWZmZXIgb25seSBpbiBwcm92ZW5hbmNlOiB0aGUgZmlyc3QgaXMgdGhlXG4gICAgLy8gaW5pdGlhbCBiaW5kaW5nIHBsYW5uZWQgYnkgYHBsYW5Xb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25gLCB0aGUgc2Vjb25kIGlzIGEgYmluZGluZ1xuICAgIC8vIHBsYW5uZWQgYnkgYHBsYW5Xb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZWAgKGEgcm90YXRpb24ncyBuZXcgZ2VuZXJhdGlvbiwgb3IgYVxuICAgIC8vIHJlc3RvcmUncyByZWJpbmQpLiBUaGV5IGV4ZWN1dGUgaWRlbnRpY2FsbHkgYW5kIGRlbGliZXJhdGVseSBzaGFyZSBvbmUgaW1wbGVtZW50YXRpb24uXG4gICAgY2FzZSBcImJpbmRcIjpcbiAgICBjYXNlIFwidmVyaWZ5LWJvdW5kXCI6XG4gICAgY2FzZSBcInJldm9rZVwiOlxuICAgIGNhc2UgXCJ2ZXJpZnktcmV2b2tlZFwiOiB7XG4gICAgICBwdWJsaWNFdmlkZW5jZSA9IGF3YWl0IHJ1bkNyZWRlbnRpYWxPcGVyYXRpb24oXG4gICAgICAgIHN0ZXAua2luZCxcbiAgICAgICAgaW5wdXQsXG4gICAgICAgIGRlcHMsXG4gICAgICAgIG5vdyxcbiAgICAgICk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInZlcmlmeS1pbml0aWFsaXphdGlvblwiOiB7XG4gICAgICBjb25zdCByZXF1ZXN0ZWRBZ2VudHMgPSByZXNvbHZlV29ya3NwYWNlSG9zdFJlcXVlc3RlZEFnZW50cyhpbnB1dC5yZXF1ZXN0ZWRBZ2VudHMpO1xuICAgICAgY29uc3Qgc291cmNlS2luZCA9IHJlcXVpcmVTdHJpbmcoXG4gICAgICAgIGlucHV0LnNvdXJjZUtpbmQsXG4gICAgICAgIFwic3RlcC5pbnB1dC5zb3VyY2VLaW5kXCIsXG4gICAgICApO1xuICAgICAgY29uc3QgcmVxdWlyZWRDaGFubmVscyA9IHJlYWRJbmNsdWRlKFxuICAgICAgICBpbnB1dC5yZXF1aXJlZENoYW5uZWxzLFxuICAgICAgICBcInN0ZXAuaW5wdXQucmVxdWlyZWRDaGFubmVsc1wiLFxuICAgICAgKSBhcyByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWxbXTtcbiAgICAgIGxldCByZXBvc2l0b3J5SW5wdXQ6XG4gICAgICAgIHwge1xuICAgICAgICAgICAgcmVhZG9ubHkgZGVzdGluYXRpb246IHN0cmluZztcbiAgICAgICAgICAgIHJlYWRvbmx5IHZpc2liaWxpdHk6IFwicHVibGljXCIgfCBcInByaXZhdGVcIjtcbiAgICAgICAgICB9XG4gICAgICAgIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHNvdXJjZUtpbmQgPT09IFwiZ2l0XCIpIHtcbiAgICAgICAgY29uc3QgcmVwb3NpdG9yeSA9IHJlcXVpcmVPYmplY3QoXG4gICAgICAgICAgaW5wdXQucmVwb3NpdG9yeSxcbiAgICAgICAgICBcInN0ZXAuaW5wdXQucmVwb3NpdG9yeVwiLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCB2aXNpYmlsaXR5ID0gcmVxdWlyZVN0cmluZyhcbiAgICAgICAgICByZXBvc2l0b3J5LnZpc2liaWxpdHksXG4gICAgICAgICAgXCJzdGVwLmlucHV0LnJlcG9zaXRvcnkudmlzaWJpbGl0eVwiLFxuICAgICAgICApO1xuICAgICAgICBpZiAodmlzaWJpbGl0eSAhPT0gXCJwdWJsaWNcIiAmJiB2aXNpYmlsaXR5ICE9PSBcInByaXZhdGVcIikge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgICAgICAgXCJzdGVwLmlucHV0LnJlcG9zaXRvcnkudmlzaWJpbGl0eSBtdXN0IGJlICdwdWJsaWMnIG9yICdwcml2YXRlJ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmVwb3NpdG9yeUlucHV0ID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uOiByZXF1aXJlU3RyaW5nKFxuICAgICAgICAgICAgcmVwb3NpdG9yeS5kZXN0aW5hdGlvbixcbiAgICAgICAgICAgIFwic3RlcC5pbnB1dC5yZXBvc2l0b3J5LmRlc3RpbmF0aW9uXCIsXG4gICAgICAgICAgKSxcbiAgICAgICAgICB2aXNpYmlsaXR5LFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIGlmIChpbnB1dC5yZXBvc2l0b3J5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclByb3RvY29sRXJyb3IoXG4gICAgICAgICAgXCJzdGVwLmlucHV0LnJlcG9zaXRvcnkgaXMgYWxsb3dlZCBvbmx5IGZvciBhIGdpdCBzb3VyY2VcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGRlcHMuaG9zdC5wcm9iZUFnZW50VmVyaWZpY2F0aW9uKFxuICAgICAgICBpbnB1dC5yZXF1ZXN0ZWRBZ2VudHMgIT09IHVuZGVmaW5lZCA/IHJlcXVlc3RlZEFnZW50cyA6IHVuZGVmaW5lZCxcbiAgICAgICk7XG4gICAgICBjb25zdCByZXBvcnRlZEFnZW50cyA9IHJlc29sdmVXb3Jrc3BhY2VIb3N0UmVxdWVzdGVkQWdlbnRzKHJlcG9ydC5yZXF1ZXN0ZWRBZ2VudHMpO1xuICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KHJlcG9ydGVkQWdlbnRzKSAhPT0gSlNPTi5zdHJpbmdpZnkocmVxdWVzdGVkQWdlbnRzKSB8fFxuICAgICAgICAgIE9iamVjdC5rZXlzKHJlcG9ydC5hZ2VudHMpLnNvbWUoKGFnZW50KSA9PiAhcmVxdWVzdGVkQWdlbnRzLmluY2x1ZGVzKGFnZW50IGFzIFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCkpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFnZW50IHZlcmlmaWNhdGlvbiByZXF1ZXN0ZWRBZ2VudHMgY292ZXJhZ2UgZG9lcyBub3QgbWF0Y2ggaW5pdGlhbGl6YXRpb25cIik7XG4gICAgICB9XG4gICAgICBjb25zdCByZXBvc2l0b3J5ID1cbiAgICAgICAgYXdhaXQgZGVwcy5ob3N0LmRlc2NyaWJlQ2xvbmVkUmVwb3NpdG9yeShyZXBvc2l0b3J5SW5wdXQpO1xuICAgICAgY29uc3QgZmFpbGVkID0gcmVxdWVzdGVkQWdlbnRzLmZpbHRlcihcbiAgICAgICAgKGFnZW50KSA9PiAhcmVwb3J0LmFnZW50c1thZ2VudF0/LnJlYWR5LFxuICAgICAgKTtcbiAgICAgIC8vIFRoZSB2ZXJpZnkgc3RlcCBpcyB0aGUgbGFzdCBnYXRlIGJlZm9yZSB0aGUgY29udHJvbGxlciByZWNvcmRzIGEgc3VjY2Vzc2Z1bFxuICAgICAgLy8gaW5pdGlhbGl6YXRpb24sIHNvIGFuIHVucmVhZHkgYWdlbnQgaGFzIHRvIHN0b3AgaXQgaGVyZS4gU3VjY2VlZGluZyBhbmQgbWVyZWx5XG4gICAgICAvLyByZXBvcnRpbmcgdGhlIGZhaWx1cmUgaW4gZXZpZGVuY2Ugd291bGQgcmVwcm9kdWNlIHRoZSBleGFjdCBkZWZlY3QgdGhpcyB3b3JrIGV4aXN0cyB0b1xuICAgICAgLy8gcmVtb3ZlOiBhIGdyZWVuIHZlcmRpY3QgYmFja2VkIGJ5IGEgYm9vbGVhbiBub2JvZHkgY2hlY2tlZC5cbiAgICAgIGlmIChmYWlsZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBOYW1lIGVhY2ggYWdlbnQncyBSRUFTT04gQ09ERSwgbm90IGp1c3QgdGhlIGFnZW50LiBUaGVzZSBjb2RlcyBhcmUgdGhlIGNsb3NlZFxuICAgICAgICAvLyBgV29ya3NwYWNlSG9zdEFnZW50UHJvYmVGYWlsdXJlUmVhc29uYCB1bmlvbiDigJQgbmV2ZXIgQ0xJIG91dHB1dCDigJQgc28gdGhpcyBzdGF5cyBpbnNpZGVcbiAgICAgICAgLy8gdGhlIHNhbWUgc2VjcmV0LWlzb2xhdGlvbiBydWxlIHRoZSBldmlkZW5jZSBpdHNlbGYgb2JleXMsIHdoaWxlIHRlbGxpbmcgdGhlIHJlYWRlclxuICAgICAgICAvLyB3aGV0aGVyIHRvIGxvb2sgYXQgYSBjcmVkZW50aWFsIG9yIGF0IGEgcHJvdmlkZXIgYWNjb3VudC4gV0ktMjE0NDAzNDogdGhpcyBtZXNzYWdlXG4gICAgICAgIC8vIHByZXZpb3VzbHkgc2FpZCBvbmx5IGBjb2RleGAsIGFuZCB0aGUgcmVhbCBjYXVzZSAoYW4gZXhoYXVzdGVkIHByb3ZpZGVyIHF1b3RhKSBjb3N0IHR3b1xuICAgICAgICAvLyBHQ1AgY2FuYXJpZXMgdG8gcmVkaXNjb3Zlci4gVGhlIGNhcHBlZCBzdGRlcnIgYnl0ZSBjb3VudCBkaXN0aW5ndWlzaGVzIGEgc2lsZW50IHByb2JlXG4gICAgICAgIC8vIGZyb20gb25lIHdob3NlIHVuY2xhc3NpZmllZCBvdXRwdXQgd2FzIGRlbGliZXJhdGVseSB3aXRoaGVsZC5cbiAgICAgICAgY29uc3QgZGV0YWlsID0gZmFpbGVkXG4gICAgICAgICAgLm1hcCgoYWdlbnQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGV2aWRlbmNlID0gcmVwb3J0LmFnZW50c1thZ2VudF07XG4gICAgICAgICAgICBjb25zdCBmYWlsdXJlID0gZXZpZGVuY2U/LmZhaWx1cmUgPz8gXCJub3QtcmVwb3J0ZWRcIjtcbiAgICAgICAgICAgIGNvbnN0IHN0ZGVyckJ5dGVzID0gZXZpZGVuY2U/LnN0ZGVyckJ5dGVDb3VudDtcbiAgICAgICAgICAgIGNvbnN0IHN0ZGVyckRldGFpbCA9XG4gICAgICAgICAgICAgIHR5cGVvZiBzdGRlcnJCeXRlcyAhPT0gXCJudW1iZXJcIlxuICAgICAgICAgICAgICAgID8gXCJcIlxuICAgICAgICAgICAgICAgIDogZXZpZGVuY2U/LnN0ZGVyckJ5dGVDb3VudFRydW5jYXRlZFxuICAgICAgICAgICAgICAgICAgPyBgOyBzdGRlcnItYnl0ZXMtYXQtbGVhc3Q9JHtzdGRlcnJCeXRlc31gXG4gICAgICAgICAgICAgICAgICA6IGA7IHN0ZGVyci1ieXRlcz0ke3N0ZGVyckJ5dGVzfWA7XG4gICAgICAgICAgICByZXR1cm4gYCR7YWdlbnR9ICgke2ZhaWx1cmV9JHtzdGRlcnJEZXRhaWx9KWA7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuam9pbihcIiwgXCIpO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW50IHJlYWRpbmVzcyBkaWQgbm90IHBhc3MgZm9yOiAke2RldGFpbH1gKTtcbiAgICAgIH1cbiAgICAgIHB1YmxpY0V2aWRlbmNlID0ge1xuICAgICAgICBzb3VyY2VLaW5kLFxuICAgICAgICByZXF1aXJlZENoYW5uZWxzLFxuICAgICAgICByZXBvc2l0b3J5LFxuICAgICAgICBhZ2VudHM6IHJlcG9ydC5hZ2VudHMsXG4gICAgICAgIC4uLihpbnB1dC5yZXF1ZXN0ZWRBZ2VudHMgIT09IHVuZGVmaW5lZCA/IHsgcmVxdWVzdGVkQWdlbnRzIH0gOiB7fSksXG4gICAgICAgIGFsbFJlYWR5OiBXT1JLU1BBQ0VfSE9TVF9DQU5BUllfQUdFTlRTLmV2ZXJ5KChhZ2VudCkgPT4gcmVwb3J0LmFnZW50c1thZ2VudF0/LnJlYWR5ID09PSB0cnVlKSxcbiAgICAgICAgYWdlbnRDb250cmFjdFZlcnNpb246IHJlcG9ydC5jb250cmFjdFZlcnNpb24sXG4gICAgICB9O1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGRlZmF1bHQ6IHtcbiAgICAgIHRocm93IG5ldyBVbnN1cHBvcnRlZFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvblN0ZXBLaW5kRXJyb3Ioc3RlcC5raW5kKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBvYnNlcnZlZEF0ID0gbm93KCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgcmVzcG9uc2U6IFdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclJlc3BvbnNlID0ge1xuICAgIHByb3RvY29sVmVyc2lvbjogV09SS1NQQUNFX0hPU1RfUkVNT1RFX0lOSVRJQUxJWkVSX1BST1RPQ09MX1ZFUlNJT04sXG4gICAgc3RlcElkOiBzdGVwLmlkLFxuICAgIHN0YXR1czogXCJzdWNjZWVkZWRcIixcbiAgICBvYnNlcnZlZEF0LFxuICAgIC4uLihwdWJsaWNFdmlkZW5jZSAmJiBPYmplY3Qua2V5cyhwdWJsaWNFdmlkZW5jZSkubGVuZ3RoID4gMFxuICAgICAgPyB7IHB1YmxpY0V2aWRlbmNlIH1cbiAgICAgIDoge30pLFxuICB9O1xuICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgIHJlc3BvbnNlLFxuICAgIGB3b3Jrc3BhY2VIb3N0LnJlbW90ZUluaXRpYWxpemVyLnJlc3BvbnNlLiR7c3RlcC5pZH1gLFxuICApO1xuICByZXR1cm4gcmVzcG9uc2U7XG59XG5cbi8qKlxuICogSGFuZGxlIG9uZSByYXcgc3RkaW4gcGF5bG9hZCBhbmQgcmV0dXJuIHRoZSBleGFjdCBieXRlcyB0byB3cml0ZSB0byBzdGRvdXQuXG4gKlxuICogS2VwdCBzZXBhcmF0ZSBmcm9tIHRoZSBDTEkgc28gdGhlIHdob2xlIHJlcXVlc3QvcmVzcG9uc2UgY3ljbGUg4oCUIGluY2x1ZGluZyBtYWxmb3JtZWQgSlNPTiDigJQgaXNcbiAqIHRlc3RhYmxlIHdpdGhvdXQgc3Bhd25pbmcgYSBwcm9jZXNzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUGF5bG9hZChcbiAgcGF5bG9hZDogc3RyaW5nLFxuICBkZXBzOiBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJEZXBzLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHBheWxvYWQpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyUHJvdG9jb2xFcnJvcihcbiAgICAgIFwicmVxdWVzdCBib2R5IGlzIG5vdCB2YWxpZCBKU09OXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByZXF1ZXN0ID0gcGFyc2VXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJSZXF1ZXN0KHBhcnNlZCk7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZXhlY3V0ZVdvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplclN0ZXAoXG4gICAgcmVxdWVzdCxcbiAgICBkZXBzLFxuICApO1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkocmVzcG9uc2UpfVxcbmA7XG59XG5cbi8qKiBSZWplY3QgYXJndiB0aGF0IGlzIG5vdCBleGFjdGx5IHdoYXQgdGhlIGNvbnRyb2xsZXIncyBjb21tYW5kIGJ1aWxkZXIgZW1pdHMuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0V29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVyQXJndihcbiAgYXJndjogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiB2b2lkIHtcbiAgY29uc3QgZXhwZWN0ZWQgPSBXT1JLU1BBQ0VfSE9TVF9SRU1PVEVfSU5JVElBTElaRVJfQVJHVjtcbiAgY29uc3QgbWF0Y2hlcyA9XG4gICAgYXJndi5sZW5ndGggPT09IGV4cGVjdGVkLmxlbmd0aCAmJlxuICAgIGV4cGVjdGVkLmV2ZXJ5KCh2YWx1ZSwgaW5kZXgpID0+IGFyZ3ZbaW5kZXhdID09PSB2YWx1ZSk7XG4gIGlmICghbWF0Y2hlcykge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQcm90b2NvbEVycm9yKFxuICAgICAgYHJlbW90ZSBpbml0aWFsaXplciBleHBlY3RzIGFyZ3YgJHtleHBlY3RlZC5qb2luKFwiIFwiKX0sIGdvdCAke2FyZ3Yuam9pbihcIiBcIikgfHwgXCIobm9uZSlcIn1gLFxuICAgICk7XG4gIH1cbn1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG4vKiBDYW5hcnkgZXZpZGVuY2UgcHJvZHVjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbmV4cG9ydCBpbnRlcmZhY2UgQnVpbGRXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZUlucHV0IHtcbiAgcmVhZG9ubHkgcnVuSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgd29ya3NwYWNlSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgaG9zdElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG9ic2VydmVkQXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVwb3NpdG9yeToge1xuICAgIHJlYWRvbmx5IHZpc2liaWxpdHk6IFwicHVibGljXCIgfCBcInByaXZhdGVcIjtcbiAgICByZWFkb25seSBjbG9uZWQ6IGJvb2xlYW47XG4gIH07XG4gIHJlYWRvbmx5IGFnZW50czogV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uUmVwb3J0O1xuICAvKipcbiAgICogUGVyLWNoYW5uZWwgbGlmZWN5Y2xlIGV2aWRlbmNlIGdhdGhlcmVkIGZyb20gYSByZWFsIHJvdGF0ZS9yZXZva2UvcmVjb25uZWN0IHJ1biwga2V5ZWQgYnlcbiAgICogY2hhbm5lbC4gRWFjaCBjaGFubmVsIG11c3Qgc2hvdyBhbGwgZm91ciB0cmFuc2l0aW9ucy5cbiAgICovXG4gIHJlYWRvbmx5IGNoYW5uZWxMaWZlY3ljbGU6IFJlYWRvbmx5PFxuICAgIFJlY29yZDxcbiAgICAgIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbCxcbiAgICAgIHtcbiAgICAgICAgcmVhZG9ubHkgYm91bmQ6IGJvb2xlYW47XG4gICAgICAgIHJlYWRvbmx5IHJvdGF0ZWQ6IGJvb2xlYW47XG4gICAgICAgIHJlYWRvbmx5IHByZXZpb3VzQmluZGluZ1Jldm9rZWQ6IGJvb2xlYW47XG4gICAgICAgIHJlYWRvbmx5IHJlY29ubmVjdGVkOiBib29sZWFuO1xuICAgICAgfVxuICAgID5cbiAgPjtcbiAgcmVhZG9ubHkgYmFja3VwUmVzdG9yZToge1xuICAgIHJlYWRvbmx5IGF1dGhvcml6YXRpb25NYXRlcmlhbEV4Y2x1ZGVkOiBib29sZWFuO1xuICAgIHJlYWRvbmx5IGNyZWRlbnRpYWxSZWZlcmVuY2VzRXhjbHVkZWQ6IGJvb2xlYW47XG4gICAgcmVhZG9ubHkgcmVib3VuZENoYW5uZWxzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWxbXTtcbiAgfTtcbn1cblxuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IHByb2JsZW1zOiByZWFkb25seSBzdHJpbmdbXTtcblxuICBjb25zdHJ1Y3Rvcihwcm9ibGVtczogcmVhZG9ubHkgc3RyaW5nW10pIHtcbiAgICBzdXBlcihgQ2FuYXJ5IGV2aWRlbmNlIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZDogJHtwcm9ibGVtcy5qb2luKFwiOyBcIil9YCk7XG4gICAgdGhpcy5uYW1lID0gXCJXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZUVycm9yXCI7XG4gICAgdGhpcy5wcm9ibGVtcyA9IHByb2JsZW1zO1xuICB9XG59XG5cbi8qKlxuICogQ29uc3RydWN0IGBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZWAgZnJvbSBvYnNlcnZhdGlvbnMuXG4gKlxuICogV0hZIEEgQlVJTERFUiBBTkQgTk9UIEFOIE9CSkVDVCBMSVRFUkFMLiBUaGUgZXZpZGVuY2UgdHlwZSBkZWNsYXJlcyBldmVyeSBmaWVsZCBhcyBhIGxpdGVyYWxcbiAqIChgY2xvbmVkOiB0cnVlYCwgYHJlYWR5OiB0cnVlYCwgYGJvdW5kOiB0cnVlYCwg4oCmKSwgc28gVHlwZVNjcmlwdCBtYWtlcyBhIEZBSUxJTkcgY2FuYXJ5XG4gKiBsaXRlcmFsbHkgdW5yZXByZXNlbnRhYmxlLiBUaGF0IGlzIGEgZ29vZCBwcm9wZXJ0eSBmb3IgdGhlIHZhbGlkYXRvcidzIGNvbnRyYWN0IGFuZCBhIHRlcnJpYmxlXG4gKiBvbmUgZm9yIGhvbmVzdHk6IHRoZSBvbmx5IHdheSB0byBvYnRhaW4gYSB2YWx1ZSBvZiB0aGF0IHR5cGUgaXMgdG8gYXNzZXJ0IHRoZSBzdWNjZXNzIHlvdSB3ZXJlXG4gKiBzdXBwb3NlZCB0byBiZSBwcm92aW5nLiBUaGlzIGJ1aWxkZXIgaXMgdGhlIHNlYW0gd2hlcmUgb2JzZXJ2ZWQgYm9vbGVhbnMgbWVldCB0aGF0IHR5cGUg4oCUIGl0XG4gKiBSRUZVU0VTIHRvIHdpZGVuIGEgZmFsc2Ugb2JzZXJ2YXRpb24gaW50byB0aGUgbGl0ZXJhbCBgdHJ1ZWAsIHRocm93aW5nIHdpdGggdGhlIHNwZWNpZmljXG4gKiBzaG9ydGZhbGwgaW5zdGVhZC4gU28gYW4gdW5hdXRoZW50aWNhdGVkIGFnZW50IG9yIGFuIHVucm90YXRlZCBjaGFubmVsIGNhbm5vdCBiZWNvbWUgY2FuYXJ5XG4gKiBldmlkZW5jZSBhdCBhbGwsIHJhdGhlciB0aGFuIGJlY29taW5nIGV2aWRlbmNlIHRoYXQgdGhlbiBmYWlscyB2YWxpZGF0aW9uIHNvbWV3aGVyZSBsYXRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkV29ya3NwYWNlSG9zdEluaXRpYWxpemF0aW9uQ2FuYXJ5RXZpZGVuY2UoXG4gIGlucHV0OiBCdWlsZFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlSW5wdXQsXG4pOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZSB7XG4gIGNvbnN0IHByb2JsZW1zOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGlmIChpbnB1dC5yZXBvc2l0b3J5LnZpc2liaWxpdHkgIT09IFwicHJpdmF0ZVwiKSB7XG4gICAgcHJvYmxlbXMucHVzaChcImNhbmFyeSByZXBvc2l0b3J5IG11c3QgYmUgcHJpdmF0ZVwiKTtcbiAgfVxuICBpZiAoIWlucHV0LnJlcG9zaXRvcnkuY2xvbmVkKVxuICAgIHByb2JsZW1zLnB1c2goXCJwcml2YXRlLXJlcG9zaXRvcnkgY2xvbmUgd2FzIG5vdCBvYnNlcnZlZFwiKTtcblxuICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9DSEFOTkVMUykge1xuICAgIGNvbnN0IG9ic2VydmVkID0gaW5wdXQuY2hhbm5lbExpZmVjeWNsZT8uW2NoYW5uZWxdO1xuICAgIGlmICghb2JzZXJ2ZWQpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYG5vIGxpZmVjeWNsZSBldmlkZW5jZSBmb3IgdGhlICcke2NoYW5uZWx9JyBjaGFubmVsYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBbZmxhZywgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKG9ic2VydmVkKSkge1xuICAgICAgaWYgKHZhbHVlICE9PSB0cnVlKVxuICAgICAgICBwcm9ibGVtcy5wdXNoKGAke2NoYW5uZWx9IGNoYW5uZWwgZGlkIG5vdCBvYnNlcnZlICcke2ZsYWd9J2ApO1xuICAgIH1cbiAgfVxuXG4gIC8vIERlcml2ZSBjb3ZlcmFnZSBmcm9tIHRoZSByZXBvcnQgaXRzZWxmIHJhdGhlciB0aGFuIHJlLWRlY2lkaW5nIGl0IGhlcmU6IGByZXF1ZXN0ZWRBZ2VudHNgIGlzXG4gIC8vIHRoZSByZXBvcnQncyBvd24gZGVjbGFyZWQgc2NvcGUgYW5kIHJlc29sdmVzIHRvIGFsbCB0aHJlZSB3aGVuIGFic2VudCwgc28gYSBsZWdhY3kvZGVmYXVsdFxuICAvLyByZXBvcnQgaXMgdW5jaGFuZ2VkIHdoaWxlIGEgZGVsaWJlcmF0ZWx5IHNjb3BlZCBvbmUgKEQtMzM4J3MgQ29kZXggc2tpcCkgaXMgbm90IGZhaWxlZCBmb3IgdGhlXG4gIC8vIGFnZW50IGl0IHdhcyBuZXZlciBhc2tlZCB0byBwcm9iZS4gUmVhZGluZyBgYWdlbnRzYCBhbG9uZSBjYW5ub3QgdGVsbCBcInNraXBwZWRcIiBmcm9tIFwibWlzc2luZ1wiLlxuICBjb25zdCBjb3ZlcmVkQWdlbnRzID0gcmVzb2x2ZVdvcmtzcGFjZUhvc3RSZXF1ZXN0ZWRBZ2VudHMoaW5wdXQuYWdlbnRzPy5yZXF1ZXN0ZWRBZ2VudHMpO1xuICBmb3IgKGNvbnN0IGFnZW50IG9mIGNvdmVyZWRBZ2VudHMpIHtcbiAgICBjb25zdCBldmlkZW5jZSA9IGlucHV0LmFnZW50cz8uYWdlbnRzPy5bYWdlbnRdO1xuICAgIGlmICghZXZpZGVuY2UpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYG5vIHJlYWRpbmVzcyBwcm9iZSB3YXMgcnVuIGZvciAnJHthZ2VudH0nYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFldmlkZW5jZS5yZWFkeSkge1xuICAgICAgcHJvYmxlbXMucHVzaChcbiAgICAgICAgYCR7YWdlbnR9IGxpdmUgcmVhZGluZXNzIGRpZCBub3QgcGFzcyAoJHtldmlkZW5jZS5mYWlsdXJlID8/IFwidW5rbm93blwifSwgZXhpdCAke2V2aWRlbmNlLmV4aXRTdGF0dXN9KWAsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyBXSS0xMDAwMjQwMjogREVSSVZFRCBmcm9tIHRoZSBhZ2VudCdzIHByb2JlIHRhYmxlIOKAlCBzZWVcbiAgICAvLyB3b3Jrc3BhY2VIb3N0QWdlbnRBbGxvd2VkVmVyaWZpY2F0aW9uS2luZHMgZm9yIHdoeSB0aGUgbGl0ZXJhbCB0aGlzIHJlcGxhY2VkIGNvdWxkIG5ldmVyXG4gICAgLy8gYWRtaXQgYSByZWFsIGNsYXVkZSBjcmVkZW50aWFsLlxuICAgIGlmIChcbiAgICAgICF3b3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25LaW5kSXNBbGxvd2VkKFxuICAgICAgICBhZ2VudCxcbiAgICAgICAgZXZpZGVuY2UudmVyaWZpY2F0aW9uS2luZCxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIHByb2JsZW1zLnB1c2goXG4gICAgICAgIGAke2FnZW50fSB2ZXJpZmljYXRpb24ga2luZCAnJHtldmlkZW5jZS52ZXJpZmljYXRpb25LaW5kfScgaXMgbm90IGFsbG93ZWQgKGFsbG93ZWQ6ICR7W1xuICAgICAgICAgIC4uLndvcmtzcGFjZUhvc3RBZ2VudEFsbG93ZWRWZXJpZmljYXRpb25LaW5kcyhhZ2VudCksXG4gICAgICAgIF0uam9pbihcIiwgXCIpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIWlucHV0LmJhY2t1cFJlc3RvcmUuYXV0aG9yaXphdGlvbk1hdGVyaWFsRXhjbHVkZWQpIHtcbiAgICBwcm9ibGVtcy5wdXNoKFwiYmFja3VwIHJldGFpbmVkIGF1dGhvcml6YXRpb24gbWF0ZXJpYWxcIik7XG4gIH1cbiAgaWYgKCFpbnB1dC5iYWNrdXBSZXN0b3JlLmNyZWRlbnRpYWxSZWZlcmVuY2VzRXhjbHVkZWQpIHtcbiAgICBwcm9ibGVtcy5wdXNoKFwiYmFja3VwIHJldGFpbmVkIGNyZWRlbnRpYWwgcmVmZXJlbmNlc1wiKTtcbiAgfVxuICBjb25zdCByZWJvdW5kID0gbmV3IFNldChpbnB1dC5iYWNrdXBSZXN0b3JlLnJlYm91bmRDaGFubmVscyk7XG4gIGZvciAoY29uc3QgY2hhbm5lbCBvZiBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0NIQU5ORUxTKSB7XG4gICAgaWYgKCFyZWJvdW5kLmhhcyhjaGFubmVsKSlcbiAgICAgIHByb2JsZW1zLnB1c2goYHJlc3RvcmUgZGlkIG5vdCByZWJpbmQgdGhlICcke2NoYW5uZWx9JyBjaGFubmVsYCk7XG4gIH1cbiAgZm9yIChjb25zdCBjaGFubmVsIG9mIHJlYm91bmQpIHtcbiAgICBpZiAoIVdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMuaW5jbHVkZXMoY2hhbm5lbCkpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYHJlc3RvcmUgcmVib3VuZCBhbiB1bmtub3duIGNoYW5uZWwgJyR7Y2hhbm5lbH0nYCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZShpbnB1dC5vYnNlcnZlZEF0KSkpIHtcbiAgICBwcm9ibGVtcy5wdXNoKFwiY2FuYXJ5IG9ic2VydmVkQXQgbXVzdCBiZSBhbiBJU08gdGltZXN0YW1wXCIpO1xuICB9XG5cbiAgaWYgKHByb2JsZW1zLmxlbmd0aCA+IDApXG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlRXJyb3IocHJvYmxlbXMpO1xuXG4gIGNvbnN0IGNoYW5uZWxzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMubWFwKChjaGFubmVsKSA9PiBbXG4gICAgICBjaGFubmVsLFxuICAgICAge1xuICAgICAgICBib3VuZDogdHJ1ZSxcbiAgICAgICAgcm90YXRlZDogdHJ1ZSxcbiAgICAgICAgcHJldmlvdXNCaW5kaW5nUmV2b2tlZDogdHJ1ZSxcbiAgICAgICAgcmVjb25uZWN0ZWQ6IHRydWUsXG4gICAgICB9IGFzIGNvbnN0LFxuICAgIF0pLFxuICApIGFzIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlW1wiY2hhbm5lbHNcIl07XG5cbiAgLy8gU2FtZSByZXNvbHZlZCBjb3ZlcmFnZSB0aGUgdmFsaWRhdGlvbiBsb29wIGFib3ZlIHVzZWQg4oCUIHNoYXJpbmcgdGhlIG9uZSBiaW5kaW5nIGlzIHdoYXQgc3RvcHNcbiAgLy8gdGhlIHByb3ZlbiBzZXQgYW5kIHRoZSBlbWl0dGVkIHNldCBmcm9tIHNpbGVudGx5IGRpdmVyZ2luZyAocmVhZGluZyB0aGUgY29uc3RhbnQgaGVyZSBjcmFzaGVkXG4gIC8vIG9uIHRoZSBza2lwcGVkIGFnZW50J3MgYWJzZW50IGV2aWRlbmNlLCBhZnRlciB2YWxpZGF0aW9uIGhhZCBjb3JyZWN0bHkgYWxsb3dlZCBpdCkuXG4gIGNvbnN0IGFnZW50cyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBjb3ZlcmVkQWdlbnRzLm1hcCgoYWdlbnQpID0+IFtcbiAgICAgIGFnZW50LFxuICAgICAge1xuICAgICAgICByZWFkeTogdHJ1ZSxcbiAgICAgICAgdmVyaWZpY2F0aW9uS2luZDogaW5wdXQuYWdlbnRzLmFnZW50c1thZ2VudF0hLnZlcmlmaWNhdGlvbktpbmQsXG4gICAgICB9IGFzIGNvbnN0LFxuICAgIF0pLFxuICApIGFzIFdvcmtzcGFjZUhvc3RJbml0aWFsaXphdGlvbkNhbmFyeUV2aWRlbmNlW1wiYWdlbnRzXCJdO1xuXG4gIGNvbnN0IGV2aWRlbmNlOiBXb3Jrc3BhY2VIb3N0SW5pdGlhbGl6YXRpb25DYW5hcnlFdmlkZW5jZSA9IHtcbiAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0lOSVRJQUxJWkFUSU9OX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAga2luZDogXCJsaXZlXCIsXG4gICAgcnVuSWQ6IGlucHV0LnJ1bklkLFxuICAgIHdvcmtzcGFjZUlkOiBpbnB1dC53b3Jrc3BhY2VJZCxcbiAgICBob3N0SWQ6IGlucHV0Lmhvc3RJZCxcbiAgICBvYnNlcnZlZEF0OiBpbnB1dC5vYnNlcnZlZEF0LFxuICAgIHJlcG9zaXRvcnk6IHsgdmlzaWJpbGl0eTogXCJwcml2YXRlXCIsIGNsb25lZDogdHJ1ZSB9LFxuICAgIGNoYW5uZWxzLFxuICAgIC8vIFByb3BhZ2F0ZSB0aGUgcmVwb3J0J3MgZGVjbGFyZWQgY292ZXJhZ2Ugb250byB0aGUgYXNzZW1ibGVkIGFydGlmYWN0IHNvIHRoZSB2YWxpZGF0b3IgKGFuZFxuICAgIC8vIGFueSBsYXRlciByZWFkZXIgb2YgcmF0aWZpZWQgZXZpZGVuY2UpIGNhbiB0ZWxsIGEgZGVsaWJlcmF0ZWx5IHNjb3BlZCBydW4gZnJvbSBhIHRydW5jYXRlZFxuICAgIC8vIG9uZS4gT21pdHRlZCB3aGVuIHRoZSByZXBvcnQgd2FzIHVuc2NvcGVkLCBwcmVzZXJ2aW5nIHRoZSBkZWZhdWx0IGFydGlmYWN0IHNoYXBlIGJ5dGUgZm9yIGJ5dGUuXG4gICAgLi4uKGlucHV0LmFnZW50cz8ucmVxdWVzdGVkQWdlbnRzICE9PSB1bmRlZmluZWQgPyB7IHJlcXVlc3RlZEFnZW50czogY292ZXJlZEFnZW50cyB9IDoge30pLFxuICAgIGFnZW50cyxcbiAgICBiYWNrdXBSZXN0b3JlOiB7XG4gICAgICBhdXRob3JpemF0aW9uTWF0ZXJpYWw6IFwiZXhjbHVkZWRcIixcbiAgICAgIGNyZWRlbnRpYWxSZWZlcmVuY2VzOiBcImV4Y2x1ZGVkXCIsXG4gICAgICByZWJvdW5kQ2hhbm5lbHM6IFsuLi5XT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0NIQU5ORUxTXSxcbiAgICB9LFxuICB9O1xuICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgIGV2aWRlbmNlLFxuICAgIFwid29ya3NwYWNlSG9zdC5pbml0aWFsaXphdGlvbi5jYW5hcnlcIixcbiAgKTtcbiAgcmV0dXJuIGV2aWRlbmNlO1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LXJlbW90ZS1pbml0aWFsaXplci50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1yZW1vdGUtaW5pdGlhbGl6ZXIudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LXJlbW90ZS1pbml0aWFsaXplci50cyIsW11d
}}