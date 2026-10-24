'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION", () => { try { return WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_FAMILIES", () => { try { return WORKSPACE_HOST_CREDENTIAL_FAMILIES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS", () => { try { return WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY", () => { try { return WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialReferenceError", () => { try { return WorkspaceHostCredentialReferenceError } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostCredentialReference", () => { try { return parseWorkspaceHostCredentialReference } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostCredentialRevocationReference", () => { try { return parseWorkspaceHostCredentialRevocationReference } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostCredentialReference", () => { try { return buildWorkspaceHostCredentialReference } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostCredentialRevocationReference", () => { try { return buildWorkspaceHostCredentialRevocationReference } catch {} });
__vite_ssr_exportName__("describeWorkspaceHostCredentialBinding", () => { try { return describeWorkspaceHostCredentialBinding } catch {} });
__vite_ssr_exportName__("assertNoResolvedAuthorizationMaterial", () => { try { return assertNoResolvedAuthorizationMaterial } catch {} });
__vite_ssr_exportName__("UnknownWorkspaceHostCredentialFamilyError", () => { try { return UnknownWorkspaceHostCredentialFamilyError } catch {} });
__vite_ssr_exportName__("workspaceHostCredentialReferenceDigest", () => { try { return workspaceHostCredentialReferenceDigest } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialResolver", () => { try { return WorkspaceHostCredentialResolver } catch {} });
__vite_ssr_exportName__("executeWorkspaceHostCredentialLifecycle", () => { try { return executeWorkspaceHostCredentialLifecycle } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-initialization.ts", {"importedNames":["WORKSPACE_HOST_CREDENTIAL_CHANNELS"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});



const WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION = "papercusp-workspace-host-credential-namespace-v1";
const WORKSPACE_HOST_CREDENTIAL_FAMILIES = [
  "cloud-workload-identity",
  "git-short-lived-delegation",
  "agent-forwarded-reference",
  "agent-encrypted-reference"
];
const CONTROLLER_CONNECTION_SELECTOR_SCHEMES = [
  "gcloud",
  "gcp",
  "aws",
  "az",
  "azure"
];
const REFERENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEME = /^[a-z][a-z0-9-]*$/;
const MAX_REFERENCE_LENGTH = 1024;
const GENERATION_SEGMENT = /^g([1-9][0-9]{0,8})$/;
const WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS = {
  "cloud-workload-identity": {
    family: "cloud-workload-identity",
    channel: "cloud",
    refScheme: "pc-cloud-workload",
    revocationScheme: "pc-cloud-workload-revocation",
    // `forwarded-agent` is absent because the initialization contract already rejects it for
    // the cloud channel; repeating that here keeps the two tables from disagreeing.
    deliveryKinds: ["provider-identity", "encrypted-reference"],
    segments: ["provider", "scopeId", "workloadId"],
    requiresExpiry: false,
    // Ambient: the instance metadata server answers, and nothing is placed on disk. Inventing a
    // file for it would make bind() pass against a path we created ourselves.
    requiresDeliveredMaterial: false
  },
  "git-short-lived-delegation": {
    family: "git-short-lived-delegation",
    channel: "git",
    refScheme: "pc-git-delegation",
    revocationScheme: "pc-git-delegation-revocation",
    deliveryKinds: ["short-lived-delegation", "encrypted-reference"],
    segments: ["forge", "owner", "repository"],
    requiresExpiry: true,
    requiresDeliveredMaterial: true
  },
  "agent-forwarded-reference": {
    family: "agent-forwarded-reference",
    channel: "agent",
    refScheme: "pc-agent-forward",
    revocationScheme: "pc-agent-revocation",
    deliveryKinds: ["forwarded-agent"],
    segments: ["hostId", "agentSet"],
    requiresExpiry: false,
    requiresDeliveredMaterial: true
  },
  "agent-encrypted-reference": {
    family: "agent-encrypted-reference",
    channel: "agent",
    refScheme: "pc-agent-sealed",
    revocationScheme: "pc-agent-revocation",
    deliveryKinds: ["encrypted-reference"],
    segments: ["hostId", "agentSet"],
    requiresExpiry: false,
    requiresDeliveredMaterial: true
  }
};
const WORKSPACE_HOST_CHANNELS_REQUIRING_FILE_DELIVERY = Object.freeze(
  Array.from(
    new Set(
      Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).filter((spec) => spec.requiresDeliveredMaterial).map((spec) => spec.channel)
    )
  ).sort()
);
class WorkspaceHostCredentialReferenceError extends Error {
  reference;
  constructor(reference, message) {
    super(message);
    this.name = "WorkspaceHostCredentialReferenceError";
    this.reference = reference;
  }
};
function splitReference(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new WorkspaceHostCredentialReferenceError(
      String(reference),
      "credential reference must be a non-empty string"
    );
  };
  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference must be at most ${MAX_REFERENCE_LENGTH} characters`
    );
  };
  if (/[\r\n\0\s]/.test(reference)) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      "credential reference must not contain whitespace or control characters"
    );
  };
  const separator = reference.indexOf("://");
  if (separator <= 0) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      "credential reference must be '<scheme>://<segment>[/<segment>…]'"
    );
  };
  const scheme = reference.slice(0, separator);
  const rest = reference.slice(separator + 3);
  if (!SCHEME.test(scheme)) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference scheme '${scheme}' is not a lowercase scheme name`
    );
  };
  if (rest.includes("?") || rest.includes("#") || rest.includes("@")) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      "credential reference must not contain userinfo, a query string, or a fragment"
    );
  };
  const segments = rest.split("/");
  for (const segment of segments) {
    if (!REFERENCE_SEGMENT.test(segment)) {
      throw new WorkspaceHostCredentialReferenceError(
        reference,
        `credential reference segment '${segment}' is not a safe reference segment`
      );
    }
  };
  return { scheme, segments };
}
function refuseControllerSelector(reference, scheme) {
  if (!CONTROLLER_CONNECTION_SELECTOR_SCHEMES.includes(scheme)) return;
  throw new WorkspaceHostCredentialReferenceError(
    reference,
    `'${reference}' is a controller connection selector, not host authorization material. Scheme '${scheme}' selects the identity the CONTROLLER connects with and must never be used as a workspace-host credential reference (D-103). Use a ratified host family: ${WORKSPACE_HOST_CREDENTIAL_FAMILIES.join(", ")}.`
  );
}
function parseWorkspaceHostCredentialReference(reference, channel) {
  const { scheme, segments } = splitReference(reference);
  refuseControllerSelector(reference, scheme);
  const spec = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).find(
    (candidate) => candidate.refScheme === scheme
  );
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `credential reference scheme '${scheme}' is not in the ratified host namespace (${WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION}). Ratified ref schemes: ${Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).map((entry) => `${entry.refScheme}://`).join(", ")}.`
    );
  };
  if (segments.length !== spec.segments.length) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} reference must have exactly ${spec.segments.length} segments (${spec.segments.join("/")}), got ${segments.length}`
    );
  };
  if (channel && spec.channel !== channel) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} reference belongs to the '${spec.channel}' channel, not '${channel}'`
    );
  };
  const fields = {};
  spec.segments.forEach((label, index) => {
    fields[label] = segments[index];
  });
  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    family: spec.family,
    channel: spec.channel,
    scheme,
    segments,
    fields
  };
};
function parseWorkspaceHostCredentialRevocationReference(reference, family) {
  const { scheme, segments } = splitReference(reference);
  refuseControllerSelector(reference, scheme);
  const candidates = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).filter(
    (entry) => entry.revocationScheme === scheme
  );
  const spec = family ? candidates.find((entry) => entry.family === family) : candidates[0];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      family ? `revocation reference scheme '${scheme}' does not belong to family '${family}'` : `revocation reference scheme '${scheme}' is not in the ratified host namespace (${WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION})`
    );
  };
  const generationSegment = segments[segments.length - 1] ?? "";
  const match = GENERATION_SEGMENT.exec(generationSegment);
  if (!match) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `revocation reference must end with a generation segment 'g<n>', got '${generationSegment}'`
    );
  };
  const body = segments.slice(0, -1);
  if (body.length !== spec.segments.length) {
    throw new WorkspaceHostCredentialReferenceError(
      reference,
      `${spec.family} revocation reference must be '${spec.revocationScheme}://${spec.segments.join("/")}/g<n>'`
    );
  };
  return {
    family: spec.family,
    scheme,
    segments: body,
    generation: Number(match[1])
  };
};
function buildWorkspaceHostCredentialReference(family, fields) {
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(family, `unknown credential family '${family}'`);
  };
  const segments = spec.segments.map((label) => {
    const value = fields[label];
    if (typeof value !== "string" || !REFERENCE_SEGMENT.test(value)) {
      throw new WorkspaceHostCredentialReferenceError(
        String(value),
        `${family} reference field '${label}' must be a safe reference segment`
      );
    };
    return value;
  });
  const reference = `${spec.refScheme}://${segments.join("/")}`;
  parseWorkspaceHostCredentialReference(reference, spec.channel);
  return reference;
};
function buildWorkspaceHostCredentialRevocationReference(family, fields, generation) {
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family];
  if (!spec) {
    throw new WorkspaceHostCredentialReferenceError(family, `unknown credential family '${family}'`);
  };
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new WorkspaceHostCredentialReferenceError(
      String(generation),
      "credential generation must be a positive safe integer"
    );
  };
  const segments = spec.segments.map((label) => {
    const value = fields[label];
    if (typeof value !== "string" || !REFERENCE_SEGMENT.test(value)) {
      throw new WorkspaceHostCredentialReferenceError(
        String(value),
        `${family} revocation field '${label}' must be a safe reference segment`
      );
    };
    return value;
  });
  const reference = `${spec.revocationScheme}://${segments.join("/")}/g${generation}`;
  parseWorkspaceHostCredentialRevocationReference(reference, family);
  return reference;
};
function describeWorkspaceHostCredentialBinding(input) {
  const { channel, credentialRef, delivery, requestedAt } = input;
  if (!__vite_ssr_import_1__.WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel)) {
    throw new WorkspaceHostCredentialReferenceError(
      String(channel),
      `unknown credential channel '${channel}'`
    );
  };
  if (credentialRef?.kind !== channel) {
    throw new WorkspaceHostCredentialReferenceError(
      String(credentialRef?.ref),
      `credential reference kind '${credentialRef?.kind}' does not match channel '${channel}'`
    );
  };
  const reference = parseWorkspaceHostCredentialReference(credentialRef.ref, channel);
  const spec = WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[reference.family];
  if (!spec.deliveryKinds.includes(delivery?.kind)) {
    throw new WorkspaceHostCredentialReferenceError(
      credentialRef.ref,
      `${reference.family} may not be delivered as '${delivery?.kind}'; allowed: ${spec.deliveryKinds.join(", ")}`
    );
  };
  if (!Number.isSafeInteger(delivery.generation) || delivery.generation < 1) {
    throw new WorkspaceHostCredentialReferenceError(
      credentialRef.ref,
      "credentialDelivery.generation must be a positive safe integer"
    );
  };
  const revocation = parseWorkspaceHostCredentialRevocationReference(
    delivery.revocationRef,
    reference.family
  );
  if (revocation.generation !== delivery.generation) {
    throw new WorkspaceHostCredentialReferenceError(
      delivery.revocationRef,
      `revocation reference names generation ${revocation.generation} but the delivery is generation ${delivery.generation}; a rotation must revoke the generation it replaces`
    );
  };
  if (revocation.segments.join("/") !== reference.segments.join("/")) {
    throw new WorkspaceHostCredentialReferenceError(
      delivery.revocationRef,
      `revocation reference does not identify the same subject as '${credentialRef.ref}'`
    );
  };
  const requestedAtMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    throw new WorkspaceHostCredentialReferenceError(
      String(requestedAt),
      "requestedAt must be an ISO timestamp"
    );
  };
  const needsExpiry = spec.requiresExpiry || delivery.kind === "short-lived-delegation";
  if (needsExpiry) {
    const expiresAtMs = Date.parse(delivery.expiresAt ?? "");
    if (!Number.isFinite(expiresAtMs)) {
      throw new WorkspaceHostCredentialReferenceError(
        credentialRef.ref,
        `${reference.family} requires credentialDelivery.expiresAt`
      );
    };
    if (expiresAtMs <= requestedAtMs) {
      throw new WorkspaceHostCredentialReferenceError(
        credentialRef.ref,
        `${reference.family} expiresAt must be after requestedAt`
      );
    }
  };
  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    family: reference.family,
    channel,
    reference,
    revocation,
    deliveryKind: delivery.kind,
    generation: delivery.generation,
    audience: delivery.audience,
    ...delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}
  };
};
const FORBIDDEN_EVIDENCE_KEYS = [
  "material",
  "authorization",
  "credential",
  "credentials",
  "bearer",
  "assertion",
  "cookie",
  "jwt",
  "refresh"
];
function assertNoResolvedAuthorizationMaterial(value, path) {
  (0,__vite_ssr_import_2__.assertWorkspaceHostSecretIsolation)(value, path);
  const visit = (candidate, currentPath) => {
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    };
    for (const [key, entry] of Object.entries(candidate)) {
      const normalized = key.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
      if (FORBIDDEN_EVIDENCE_KEYS.some((forbidden) => normalized.split(/[_-]/).includes(forbidden))) {
        throw new Error(
          `Resolved authorization material is forbidden in credential evidence at ${currentPath}.${key}`
        );
      };
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
};
class UnknownWorkspaceHostCredentialFamilyError extends Error {
  family;
  constructor(family) {
    super(
      `No host materializer is registered for credential family '${family}'. A host that cannot resolve a family must refuse the binding, not proceed unbound.`
    );
    this.name = "UnknownWorkspaceHostCredentialFamilyError";
    this.family = family;
  }
};
function workspaceHostCredentialReferenceDigest(reference) {
  return (0,__vite_ssr_import_0__.createHash)("sha256").update(reference).digest("hex").slice(0, 32);
};
class WorkspaceHostCredentialResolver {
  materializers;
  constructor(materializers) {
    this.materializers = /* @__PURE__ */ new Map();
    for (const materializer of materializers) {
      if (this.materializers.has(materializer.family)) {
        throw new Error(
          `Duplicate host materializer registered for credential family '${materializer.family}'`
        );
      };
      this.materializers.set(materializer.family, materializer);
    }
  }
  get families() {
    return [...this.materializers.keys()];
  }
  describe(input) {
    return describeWorkspaceHostCredentialBinding(input);
  }
  async run(operation, input) {
    const binding = this.describe(input);
    const materializer = this.materializers.get(binding.family);
    if (!materializer) throw new UnknownWorkspaceHostCredentialFamilyError(binding.family);
    const detail = operation === "bind" ? await materializer.bind(binding) : operation === "verify-bound" ? await materializer.verifyBound(binding) : operation === "revoke" ? await materializer.revoke(binding) : await materializer.verifyRevoked(binding);
    assertNoResolvedAuthorizationMaterial(
      detail ?? {},
      `workspaceHost.credential.${binding.channel}.${operation}`
    );
    const evidence = {
      namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
      channel: binding.channel,
      family: binding.family,
      operation,
      deliveryKind: binding.deliveryKind,
      generation: binding.generation,
      audience: binding.audience,
      revocationRef: input.delivery.revocationRef,
      referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
      detail: detail ?? {}
    };
    assertNoResolvedAuthorizationMaterial(
      evidence,
      `workspaceHost.credential.${binding.channel}.evidence`
    );
    return evidence;
  }
  /** Execute one step of an already-planned credential lifecycle. */
  async executeLifecycleStep(step, requestedAt) {
    return this.run(step.kind, {
      channel: step.channel,
      credentialRef: step.credentialRef,
      delivery: step.delivery,
      requestedAt
    });
  }
};
async function executeWorkspaceHostCredentialLifecycle(plan, resolver) {
  const completed = /* @__PURE__ */ new Set();
  const receipts = [];
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!completed.has(dependency)) {
        throw new Error(
          `Credential lifecycle step '${step.id}' depends on '${dependency}', which has not completed`
        );
      }
    };
    const evidence = await resolver.executeLifecycleStep(step, plan.requestedAt);
    receipts.push({ stepId: step.id, evidence });
    completed.add(step.id);
  };
  return receipts;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTs7Ozs7Ozs7Ozs7Ozs7O0FBZ0NBO0FBRUE7QUFRQTs7OztBQUdPLE1BQU0sOENBQ1g7QUFFSyxNQUFNLHFDQUFxQztBQUFBLEVBQ2hEO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFTQSxNQUFNLHlDQUE0RDtBQUFBLEVBQ2hFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBUUEsTUFBTSxvQkFBb0I7QUFDMUIsTUFBTSxTQUFTO0FBRWYsTUFBTSx1QkFBdUI7QUFDN0IsTUFBTSxxQkFBcUI7QUFvQ3BCLE1BQU0seUNBRVQ7QUFBQSxFQUNGLDJCQUEyQjtBQUFBLElBQ3pCLFFBQVE7QUFBQSxJQUNSLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLGtCQUFrQjtBQUFBO0FBQUE7QUFBQSxJQUdsQixlQUFlLENBQUMscUJBQXFCLHFCQUFxQjtBQUFBLElBQzFELFVBQVUsQ0FBQyxZQUFZLFdBQVcsWUFBWTtBQUFBLElBQzlDLGdCQUFnQjtBQUFBO0FBQUE7QUFBQSxJQUdoQiwyQkFBMkI7QUFBQSxFQUM3QjtBQUFBLEVBQ0EsOEJBQThCO0FBQUEsSUFDNUIsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsSUFDbEIsZUFBZSxDQUFDLDBCQUEwQixxQkFBcUI7QUFBQSxJQUMvRCxVQUFVLENBQUMsU0FBUyxTQUFTLFlBQVk7QUFBQSxJQUN6QyxnQkFBZ0I7QUFBQSxJQUNoQiwyQkFBMkI7QUFBQSxFQUM3QjtBQUFBLEVBQ0EsNkJBQTZCO0FBQUEsSUFDM0IsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsSUFDbEIsZUFBZSxDQUFDLGlCQUFpQjtBQUFBLElBQ2pDLFVBQVUsQ0FBQyxVQUFVLFVBQVU7QUFBQSxJQUMvQixnQkFBZ0I7QUFBQSxJQUNoQiwyQkFBMkI7QUFBQSxFQUM3QjtBQUFBLEVBQ0EsNkJBQTZCO0FBQUEsSUFDM0IsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsSUFDbEIsZUFBZSxDQUFDLHFCQUFxQjtBQUFBLElBQ3JDLFVBQVUsQ0FBQyxVQUFVLFVBQVU7QUFBQSxJQUMvQixnQkFBZ0I7QUFBQSxJQUNoQiwyQkFBMkI7QUFBQSxFQUM3QjtBQUNGO0FBWU8sTUFBTSxrREFDWCxPQUFPO0FBQUEsRUFDTCxNQUFNO0FBQUEsSUFDSixJQUFJO0FBQUEsTUFDRixPQUFPLE9BQU8sc0NBQXNDLEVBQ2pELE9BQU8sQ0FBQyxTQUFTLEtBQUsseUJBQXlCLEVBQy9DLElBQUksQ0FBQyxTQUFTLEtBQUssT0FBTztBQUFBLElBQy9CO0FBQUEsRUFDRixFQUFFLEtBQUs7QUFDVDtBQUVLLE1BQU0sOENBQThDLE1BQU07QUFBQSxFQUN0RDtBQUFBLEVBRVQsWUFBWSxXQUFtQixTQUFpQjtBQUM5QyxVQUFNLE9BQU87QUFDYixTQUFLLE9BQU87QUFDWixTQUFLLFlBQVk7QUFBQSxFQUNuQjtBQUNGO0FBbUJBLFNBQVMsZUFBZSxXQUEyRDtBQUNqRixNQUFJLE9BQU8sY0FBYyxZQUFZLFVBQVUsV0FBVyxHQUFHO0FBQzNELFVBQU0sSUFBSTtBQUFBLE1BQ1IsT0FBTyxTQUFTO0FBQUEsTUFDaEI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLE1BQUksVUFBVSxTQUFTLHNCQUFzQjtBQUMzQyxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSx3Q0FBd0Msb0JBQW9CO0FBQUEsSUFDOUQ7QUFBQSxFQUNGO0FBR0EsTUFBSSxhQUFhLEtBQUssU0FBUyxHQUFHO0FBQ2hDLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFlBQVksVUFBVSxRQUFRLEtBQUs7QUFDekMsTUFBSSxhQUFhLEdBQUc7QUFDbEIsVUFBTSxJQUFJO0FBQUEsTUFDUjtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFFBQU0sU0FBUyxVQUFVLE1BQU0sR0FBRyxTQUFTO0FBQzNDLFFBQU0sT0FBTyxVQUFVLE1BQU0sWUFBWSxDQUFDO0FBQzFDLE1BQUksQ0FBQyxPQUFPLEtBQUssTUFBTSxHQUFHO0FBQ3hCLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxNQUNBLGdDQUFnQyxNQUFNO0FBQUEsSUFDeEM7QUFBQSxFQUNGO0FBQ0EsTUFBSSxLQUFLLFNBQVMsR0FBRyxLQUFLLEtBQUssU0FBUyxHQUFHLEtBQUssS0FBSyxTQUFTLEdBQUcsR0FBRztBQUNsRSxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0EsUUFBTSxXQUFXLEtBQUssTUFBTSxHQUFHO0FBQy9CLGFBQVcsV0FBVyxVQUFVO0FBQzlCLFFBQUksQ0FBQyxrQkFBa0IsS0FBSyxPQUFPLEdBQUc7QUFDcEMsWUFBTSxJQUFJO0FBQUEsUUFDUjtBQUFBLFFBQ0EsaUNBQWlDLE9BQU87QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0EsU0FBTyxFQUFFLFFBQVEsU0FBUztBQUM1QjtBQUVBLFNBQVMseUJBQXlCLFdBQW1CLFFBQXNCO0FBQ3pFLE1BQUksQ0FBQyx1Q0FBdUMsU0FBUyxNQUFNLEVBQUc7QUFDOUQsUUFBTSxJQUFJO0FBQUEsSUFDUjtBQUFBLElBQ0EsSUFBSSxTQUFTLG1GQUNBLE1BQU0sNEpBRWQsbUNBQW1DLEtBQUssSUFBSSxDQUFDO0FBQUEsRUFDcEQ7QUFDRjtBQVNPLFNBQVMsc0NBQ2QsV0FDQSxTQUN3QztBQUN4QyxRQUFNLEVBQUUsUUFBUSxTQUFTLElBQUksZUFBZSxTQUFTO0FBQ3JELDJCQUF5QixXQUFXLE1BQU07QUFFMUMsUUFBTSxPQUFPLE9BQU8sT0FBTyxzQ0FBc0MsRUFBRTtBQUFBLElBQ2pFLENBQUMsY0FBYyxVQUFVLGNBQWM7QUFBQSxFQUN6QztBQUNBLE1BQUksQ0FBQyxNQUFNO0FBQ1QsVUFBTSxJQUFJO0FBQUEsTUFDUjtBQUFBLE1BQ0EsZ0NBQWdDLE1BQU0sNENBQ2hDLDJDQUEyQyw0QkFDNUMsT0FBTyxPQUFPLHNDQUFzQyxFQUNwRCxJQUFJLENBQUMsVUFBVSxHQUFHLE1BQU0sU0FBUyxLQUFLLEVBQ3RDLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDakI7QUFBQSxFQUNGO0FBQ0EsTUFBSSxTQUFTLFdBQVcsS0FBSyxTQUFTLFFBQVE7QUFDNUMsVUFBTSxJQUFJO0FBQUEsTUFDUjtBQUFBLE1BQ0EsR0FBRyxLQUFLLE1BQU0sZ0NBQWdDLEtBQUssU0FBUyxNQUFNLGNBQzVELEtBQUssU0FBUyxLQUFLLEdBQUcsQ0FBQyxVQUFVLFNBQVMsTUFBTTtBQUFBLElBQ3hEO0FBQUEsRUFDRjtBQUNBLE1BQUksV0FBVyxLQUFLLFlBQVksU0FBUztBQUN2QyxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSxHQUFHLEtBQUssTUFBTSw4QkFBOEIsS0FBSyxPQUFPLG1CQUFtQixPQUFPO0FBQUEsSUFDcEY7QUFBQSxFQUNGO0FBRUEsUUFBTSxTQUFpQyxDQUFDO0FBQ3hDLE9BQUssU0FBUyxRQUFRLENBQUMsT0FBTyxVQUFVO0FBQ3RDLFdBQU8sS0FBSyxJQUFJLFNBQVMsS0FBSztBQUFBLEVBQ2hDLENBQUM7QUFFRCxTQUFPO0FBQUEsSUFDTCxrQkFBa0I7QUFBQSxJQUNsQixRQUFRLEtBQUs7QUFBQSxJQUNiLFNBQVMsS0FBSztBQUFBLElBQ2Q7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDRjtBQVVPLFNBQVMsZ0RBQ2QsV0FDQSxRQUNrRDtBQUNsRCxRQUFNLEVBQUUsUUFBUSxTQUFTLElBQUksZUFBZSxTQUFTO0FBQ3JELDJCQUF5QixXQUFXLE1BQU07QUFFMUMsUUFBTSxhQUFhLE9BQU8sT0FBTyxzQ0FBc0MsRUFBRTtBQUFBLElBQ3ZFLENBQUMsVUFBVSxNQUFNLHFCQUFxQjtBQUFBLEVBQ3hDO0FBQ0EsUUFBTSxPQUFPLFNBQ1QsV0FBVyxLQUFLLENBQUMsVUFBVSxNQUFNLFdBQVcsTUFBTSxJQUNsRCxXQUFXLENBQUM7QUFDaEIsTUFBSSxDQUFDLE1BQU07QUFDVCxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSxTQUNJLGdDQUFnQyxNQUFNLGdDQUFnQyxNQUFNLE1BQzVFLGdDQUFnQyxNQUFNLDRDQUNsQywyQ0FBMkM7QUFBQSxJQUNyRDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLG9CQUFvQixTQUFTLFNBQVMsU0FBUyxDQUFDLEtBQUs7QUFDM0QsUUFBTSxRQUFRLG1CQUFtQixLQUFLLGlCQUFpQjtBQUN2RCxNQUFJLENBQUMsT0FBTztBQUNWLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxNQUNBLHdFQUF3RSxpQkFBaUI7QUFBQSxJQUMzRjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLE9BQU8sU0FBUyxNQUFNLEdBQUcsRUFBRTtBQUNqQyxNQUFJLEtBQUssV0FBVyxLQUFLLFNBQVMsUUFBUTtBQUN4QyxVQUFNLElBQUk7QUFBQSxNQUNSO0FBQUEsTUFDQSxHQUFHLEtBQUssTUFBTSxrQ0FDUixLQUFLLGdCQUFnQixNQUFNLEtBQUssU0FBUyxLQUFLLEdBQUcsQ0FBQztBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMLFFBQVEsS0FBSztBQUFBLElBQ2I7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLFlBQVksT0FBTyxNQUFNLENBQUMsQ0FBQztBQUFBLEVBQzdCO0FBQ0Y7QUFHTyxTQUFTLHNDQUNkLFFBQ0EsUUFDUTtBQUNSLFFBQU0sT0FBTyx1Q0FBdUMsTUFBTTtBQUMxRCxNQUFJLENBQUMsTUFBTTtBQUNULFVBQU0sSUFBSSxzQ0FBc0MsUUFBUSw4QkFBOEIsTUFBTSxHQUFHO0FBQUEsRUFDakc7QUFDQSxRQUFNLFdBQVcsS0FBSyxTQUFTLElBQUksQ0FBQyxVQUFVO0FBQzVDLFVBQU0sUUFBUSxPQUFPLEtBQUs7QUFDMUIsUUFBSSxPQUFPLFVBQVUsWUFBWSxDQUFDLGtCQUFrQixLQUFLLEtBQUssR0FBRztBQUMvRCxZQUFNLElBQUk7QUFBQSxRQUNSLE9BQU8sS0FBSztBQUFBLFFBQ1osR0FBRyxNQUFNLHFCQUFxQixLQUFLO0FBQUEsTUFDckM7QUFBQSxJQUNGO0FBQ0EsV0FBTztBQUFBLEVBQ1QsQ0FBQztBQUNELFFBQU0sWUFBWSxHQUFHLEtBQUssU0FBUyxNQUFNLFNBQVMsS0FBSyxHQUFHLENBQUM7QUFHM0Qsd0NBQXNDLFdBQVcsS0FBSyxPQUFPO0FBQzdELFNBQU87QUFDVDtBQUdPLFNBQVMsZ0RBQ2QsUUFDQSxRQUNBLFlBQ1E7QUFDUixRQUFNLE9BQU8sdUNBQXVDLE1BQU07QUFDMUQsTUFBSSxDQUFDLE1BQU07QUFDVCxVQUFNLElBQUksc0NBQXNDLFFBQVEsOEJBQThCLE1BQU0sR0FBRztBQUFBLEVBQ2pHO0FBQ0EsTUFBSSxDQUFDLE9BQU8sY0FBYyxVQUFVLEtBQUssYUFBYSxHQUFHO0FBQ3ZELFVBQU0sSUFBSTtBQUFBLE1BQ1IsT0FBTyxVQUFVO0FBQUEsTUFDakI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFFBQU0sV0FBVyxLQUFLLFNBQVMsSUFBSSxDQUFDLFVBQVU7QUFDNUMsVUFBTSxRQUFRLE9BQU8sS0FBSztBQUMxQixRQUFJLE9BQU8sVUFBVSxZQUFZLENBQUMsa0JBQWtCLEtBQUssS0FBSyxHQUFHO0FBQy9ELFlBQU0sSUFBSTtBQUFBLFFBQ1IsT0FBTyxLQUFLO0FBQUEsUUFDWixHQUFHLE1BQU0sc0JBQXNCLEtBQUs7QUFBQSxNQUN0QztBQUFBLElBQ0Y7QUFDQSxXQUFPO0FBQUEsRUFDVCxDQUFDO0FBQ0QsUUFBTSxZQUFZLEdBQUcsS0FBSyxnQkFBZ0IsTUFBTSxTQUFTLEtBQUssR0FBRyxDQUFDLEtBQUssVUFBVTtBQUNqRixrREFBZ0QsV0FBVyxNQUFNO0FBQ2pFLFNBQU87QUFDVDtBQWtDTyxTQUFTLHVDQUNkLE9BQzBDO0FBQzFDLFFBQU0sRUFBRSxTQUFTLGVBQWUsVUFBVSxZQUFZLElBQUk7QUFDMUQsTUFBSSxDQUFDLHlEQUFtQyxTQUFTLE9BQU8sR0FBRztBQUN6RCxVQUFNLElBQUk7QUFBQSxNQUNSLE9BQU8sT0FBTztBQUFBLE1BQ2QsK0JBQStCLE9BQU87QUFBQSxJQUN4QztBQUFBLEVBQ0Y7QUFDQSxNQUFJLGVBQWUsU0FBUyxTQUFTO0FBQ25DLFVBQU0sSUFBSTtBQUFBLE1BQ1IsT0FBTyxlQUFlLEdBQUc7QUFBQSxNQUN6Qiw4QkFBOEIsZUFBZSxJQUFJLDZCQUE2QixPQUFPO0FBQUEsSUFDdkY7QUFBQSxFQUNGO0FBRUEsUUFBTSxZQUFZLHNDQUFzQyxjQUFjLEtBQUssT0FBTztBQUNsRixRQUFNLE9BQU8sdUNBQXVDLFVBQVUsTUFBTTtBQUVwRSxNQUFJLENBQUMsS0FBSyxjQUFjLFNBQVMsVUFBVSxJQUEyQyxHQUFHO0FBQ3ZGLFVBQU0sSUFBSTtBQUFBLE1BQ1IsY0FBYztBQUFBLE1BQ2QsR0FBRyxVQUFVLE1BQU0sNkJBQTZCLFVBQVUsSUFBSSxlQUN6RCxLQUFLLGNBQWMsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUNwQztBQUFBLEVBQ0Y7QUFDQSxNQUFJLENBQUMsT0FBTyxjQUFjLFNBQVMsVUFBVSxLQUFLLFNBQVMsYUFBYSxHQUFHO0FBQ3pFLFVBQU0sSUFBSTtBQUFBLE1BQ1IsY0FBYztBQUFBLE1BQ2Q7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sYUFBYTtBQUFBLElBQ2pCLFNBQVM7QUFBQSxJQUNULFVBQVU7QUFBQSxFQUNaO0FBQ0EsTUFBSSxXQUFXLGVBQWUsU0FBUyxZQUFZO0FBQ2pELFVBQU0sSUFBSTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QseUNBQXlDLFdBQVcsVUFBVSxtQ0FDOUMsU0FBUyxVQUFVO0FBQUEsSUFDckM7QUFBQSxFQUNGO0FBQ0EsTUFBSSxXQUFXLFNBQVMsS0FBSyxHQUFHLE1BQU0sVUFBVSxTQUFTLEtBQUssR0FBRyxHQUFHO0FBQ2xFLFVBQU0sSUFBSTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsK0RBQStELGNBQWMsR0FBRztBQUFBLElBQ2xGO0FBQUEsRUFDRjtBQUVBLFFBQU0sZ0JBQWdCLEtBQUssTUFBTSxXQUFXO0FBQzVDLE1BQUksQ0FBQyxPQUFPLFNBQVMsYUFBYSxHQUFHO0FBQ25DLFVBQU0sSUFBSTtBQUFBLE1BQ1IsT0FBTyxXQUFXO0FBQUEsTUFDbEI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sY0FBYyxLQUFLLGtCQUFrQixTQUFTLFNBQVM7QUFDN0QsTUFBSSxhQUFhO0FBQ2YsVUFBTSxjQUFjLEtBQUssTUFBTSxTQUFTLGFBQWEsRUFBRTtBQUN2RCxRQUFJLENBQUMsT0FBTyxTQUFTLFdBQVcsR0FBRztBQUNqQyxZQUFNLElBQUk7QUFBQSxRQUNSLGNBQWM7QUFBQSxRQUNkLEdBQUcsVUFBVSxNQUFNO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsUUFBSSxlQUFlLGVBQWU7QUFDaEMsWUFBTSxJQUFJO0FBQUEsUUFDUixjQUFjO0FBQUEsUUFDZCxHQUFHLFVBQVUsTUFBTTtBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTCxrQkFBa0I7QUFBQSxJQUNsQixRQUFRLFVBQVU7QUFBQSxJQUNsQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxjQUFjLFNBQVM7QUFBQSxJQUN2QixZQUFZLFNBQVM7QUFBQSxJQUNyQixVQUFVLFNBQVM7QUFBQSxJQUNuQixHQUFJLFNBQVMsWUFBWSxFQUFFLFdBQVcsU0FBUyxVQUFVLElBQUksQ0FBQztBQUFBLEVBQ2hFO0FBQ0Y7QUFPQSxNQUFNLDBCQUE2QztBQUFBLEVBQ2pEO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUVPLFNBQVMsc0NBQXNDLE9BQWdCLE1BQW9CO0FBQ3hGLCtEQUFtQyxPQUFPLElBQUk7QUFDOUMsUUFBTSxRQUFRLENBQUMsV0FBb0IsZ0JBQThCO0FBQy9ELFFBQUksY0FBYyxRQUFRLE9BQU8sY0FBYyxTQUFVO0FBQ3pELFFBQUksTUFBTSxRQUFRLFNBQVMsR0FBRztBQUM1QixnQkFBVSxRQUFRLENBQUMsT0FBTyxVQUFVLE1BQU0sT0FBTyxHQUFHLFdBQVcsSUFBSSxLQUFLLEdBQUcsQ0FBQztBQUM1RTtBQUFBLElBQ0Y7QUFDQSxlQUFXLENBQUMsS0FBSyxLQUFLLEtBQUssT0FBTyxRQUFRLFNBQW9DLEdBQUc7QUFDL0UsWUFBTSxhQUFhLElBQUksUUFBUSxxQkFBcUIsT0FBTyxFQUFFLFlBQVk7QUFDekUsVUFBSSx3QkFBd0IsS0FBSyxDQUFDLGNBQWMsV0FBVyxNQUFNLE1BQU0sRUFBRSxTQUFTLFNBQVMsQ0FBQyxHQUFHO0FBQzdGLGNBQU0sSUFBSTtBQUFBLFVBQ1IsMEVBQ0ssV0FBVyxJQUFJLEdBQUc7QUFBQSxRQUN6QjtBQUFBLE1BQ0Y7QUFDQSxZQUFNLE9BQU8sR0FBRyxXQUFXLElBQUksR0FBRyxFQUFFO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBQ0EsUUFBTSxPQUFPLElBQUk7QUFDbkI7QUFpRE8sTUFBTSxrREFBa0QsTUFBTTtBQUFBLEVBQzFEO0FBQUEsRUFFVCxZQUFZLFFBQXVDO0FBQ2pEO0FBQUEsTUFDRSw2REFBNkQsTUFBTTtBQUFBLElBRXJFO0FBQ0EsU0FBSyxPQUFPO0FBQ1osU0FBSyxTQUFTO0FBQUEsRUFDaEI7QUFDRjtBQUVPLFNBQVMsdUNBQXVDLFdBQTJCO0FBQ2hGLFlBQU8sa0NBQVcsUUFBUSxFQUFFLE9BQU8sU0FBUyxFQUFFLE9BQU8sS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQ3pFO0FBVU8sTUFBTSxnQ0FBZ0M7QUFBQSxFQUMxQjtBQUFBLEVBS2pCLFlBQVksZUFBK0Q7QUFDekUsU0FBSyxnQkFBZ0Isb0JBQUksSUFBSTtBQUM3QixlQUFXLGdCQUFnQixlQUFlO0FBQ3hDLFVBQUksS0FBSyxjQUFjLElBQUksYUFBYSxNQUFNLEdBQUc7QUFDL0MsY0FBTSxJQUFJO0FBQUEsVUFDUixpRUFBaUUsYUFBYSxNQUFNO0FBQUEsUUFDdEY7QUFBQSxNQUNGO0FBQ0EsV0FBSyxjQUFjLElBQUksYUFBYSxRQUFRLFlBQVk7QUFBQSxJQUMxRDtBQUFBLEVBQ0Y7QUFBQSxFQUVBLElBQUksV0FBcUQ7QUFDdkQsV0FBTyxDQUFDLEdBQUcsS0FBSyxjQUFjLEtBQUssQ0FBQztBQUFBLEVBQ3RDO0FBQUEsRUFFQSxTQUNFLE9BQzBDO0FBQzFDLFdBQU8sdUNBQXVDLEtBQUs7QUFBQSxFQUNyRDtBQUFBLEVBRUEsTUFBTSxJQUNKLFdBQ0EsT0FDMEM7QUFDMUMsVUFBTSxVQUFVLEtBQUssU0FBUyxLQUFLO0FBQ25DLFVBQU0sZUFBZSxLQUFLLGNBQWMsSUFBSSxRQUFRLE1BQU07QUFDMUQsUUFBSSxDQUFDLGFBQWMsT0FBTSxJQUFJLDBDQUEwQyxRQUFRLE1BQU07QUFFckYsVUFBTSxTQUNKLGNBQWMsU0FDVixNQUFNLGFBQWEsS0FBSyxPQUFPLElBQy9CLGNBQWMsaUJBQ1osTUFBTSxhQUFhLFlBQVksT0FBTyxJQUN0QyxjQUFjLFdBQ1osTUFBTSxhQUFhLE9BQU8sT0FBTyxJQUNqQyxNQUFNLGFBQWEsY0FBYyxPQUFPO0FBRWxEO0FBQUEsTUFDRSxVQUFVLENBQUM7QUFBQSxNQUNYLDRCQUE0QixRQUFRLE9BQU8sSUFBSSxTQUFTO0FBQUEsSUFDMUQ7QUFFQSxVQUFNLFdBQTRDO0FBQUEsTUFDaEQsa0JBQWtCO0FBQUEsTUFDbEIsU0FBUyxRQUFRO0FBQUEsTUFDakIsUUFBUSxRQUFRO0FBQUEsTUFDaEI7QUFBQSxNQUNBLGNBQWMsUUFBUTtBQUFBLE1BQ3RCLFlBQVksUUFBUTtBQUFBLE1BQ3BCLFVBQVUsUUFBUTtBQUFBLE1BQ2xCLGVBQWUsTUFBTSxTQUFTO0FBQUEsTUFDOUIsaUJBQWlCLHVDQUF1QyxNQUFNLGNBQWMsR0FBRztBQUFBLE1BQy9FLFFBQVEsVUFBVSxDQUFDO0FBQUEsSUFDckI7QUFDQTtBQUFBLE1BQ0U7QUFBQSxNQUNBLDRCQUE0QixRQUFRLE9BQU87QUFBQSxJQUM3QztBQUNBLFdBQU87QUFBQSxFQUNUO0FBQUE7QUFBQSxFQUdBLE1BQU0scUJBQ0osTUFDQSxhQUMwQztBQUMxQyxXQUFPLEtBQUssSUFBSSxLQUFLLE1BQU07QUFBQSxNQUN6QixTQUFTLEtBQUs7QUFBQSxNQUNkLGVBQWUsS0FBSztBQUFBLE1BQ3BCLFVBQVUsS0FBSztBQUFBLE1BQ2Y7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBQ0Y7QUFlQSxlQUFzQix3Q0FDcEIsTUFDQSxVQUM2RDtBQUM3RCxRQUFNLFlBQVksb0JBQUksSUFBWTtBQUNsQyxRQUFNLFdBQXNELENBQUM7QUFDN0QsYUFBVyxRQUFRLEtBQUssT0FBTztBQUM3QixlQUFXLGNBQWMsS0FBSyxXQUFXO0FBQ3ZDLFVBQUksQ0FBQyxVQUFVLElBQUksVUFBVSxHQUFHO0FBQzlCLGNBQU0sSUFBSTtBQUFBLFVBQ1IsOEJBQThCLEtBQUssRUFBRSxpQkFBaUIsVUFBVTtBQUFBLFFBQ2xFO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFDQSxVQUFNLFdBQVcsTUFBTSxTQUFTLHFCQUFxQixNQUFNLEtBQUssV0FBVztBQUMzRSxhQUFTLEtBQUssRUFBRSxRQUFRLEtBQUssSUFBSSxTQUFTLENBQUM7QUFDM0MsY0FBVSxJQUFJLEtBQUssRUFBRTtBQUFBLEVBQ3ZCO0FBQ0EsU0FBTztBQUNUIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJ3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSByYXRpZmllZCBob3N0LW93bmVkIGNyZWRlbnRpYWwtcmVmZXJlbmNlIG5hbWVzcGFjZSwgYW5kIHRoZSB0eXBlZCByZXNvbHZlciB0aGF0XG4gKiBjb25zdW1lcyBpdCAoUC0wNDYgLyBXSS00MTcxMSwgZ292ZXJuZWQgYnkgRC0xMDMpLlxuICpcbiAqIFdIWSBUSElTIEZJTEUgRVhJU1RTLiBgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VgIGRvY3VtZW50cyBgcmVmYCBhcyBcImEgdHlwZWRcbiAqIHJlZmVyZW5jZSBpbnRvIGEgaG9zdC1vd25lZCByZXNvbHZlclwiIHdob3NlIHZhbHVlIFwiaXMgbmV2ZXIgYSBzZWNyZXQgdmFsdWVcIiwgYnV0IHVudGlsIG5vd1xuICogbm90aGluZyBkZWZpbmVkIHdoYXQgYSB3ZWxsLWZvcm1lZCBgcmVmYCBhY3R1YWxseSBsb29rcyBsaWtlIGFuZCBub3RoaW5nIHJlc29sdmVkIG9uZS4gVGhlXG4gKiBzdHJpbmdzIGNpcmN1bGF0ZWQgaW4gdGhlIHBsYW5uaW5nIGxhbmUgd2VyZSBleGFtcGxlcywgbm90IGEgbmFtZXNwYWNlLCBhbmQgRC0xMDMgcnVsZWRcbiAqIGV4cGxpY2l0bHkgdGhhdCB0aGV5IGFyZSBOT1QgcmF0aWZpZWQgYnkgaGF2aW5nIGJlZW4gd3JpdHRlbiBkb3duOlxuICpcbiAqICAgXCJDcmVkZW50aWFsIG5hbWVzcGFjZSBpcyBOT1QgcmF0aWZpZWQgYnkgdGhlIGV4YW1wbGUgc3RyaW5ncyBpbiBXSS00MTY5NDpcbiAqICAgIGdjbG91ZDovL2FjdGl2ZS11c2VyIHJlbWFpbnMgYSBjb250cm9sbGVyIGNvbm5lY3Rpb24gc2VsZWN0b3IgYW5kIG1heSBub3QgYmUgdHJlYXRlZCBhc1xuICogICAgYSBob3N0IHNlY3JldC9iaW5kaW5nOyB0aGUgaW5pdGlhbGl6ZXIgd29yayBtdXN0IGRlZmluZSBleHBsaWNpdCBjbG91ZCB3b3JrbG9hZC1pZGVudGl0eSxcbiAqICAgIHNob3J0LWxpdmVkIEdpdCBkZWxlZ2F0aW9uLCBhbmQgYWdlbnQgZm9yd2FyZGVkL2VuY3J5cHRlZC1yZWZlcmVuY2Ugc2VtYW50aWNzIHdpdGhcbiAqICAgIGRpc3RpbmN0IHJlZnMvcmV2b2NhdGlvbiByZWZzIGFuZCByb3RhdGlvbiB0ZXN0cy5cIlxuICpcbiAqIFNvIHRoaXMgbW9kdWxlIGRlZmluZXMgZm91ciBmYW1pbGllcyBhY3Jvc3MgdGhlIHRocmVlIGNoYW5uZWxzLCBlYWNoIHdpdGggaXRzIG93biByZWZcbiAqIHNjaGVtZSwgaXRzIG93biByZXZvY2F0aW9uLXJlZiBzY2hlbWUsIGFuZCBhIGdlbmVyYXRpb24gdGhhdCB0aGUgcmV2b2NhdGlvbiByZWYgbXVzdCBjYXJyeS5cbiAqXG4gKiBUSEUgUFJPUEVSVFkgVEhBVCBNQVRURVJTIE1PU1QuIGBnY2xvdWQ6Ly9hY3RpdmUtdXNlcmAgaXMgdGhlIENPTlRST0xMRVIncyBjb25uZWN0aW9uXG4gKiBzZWxlY3RvciDigJQgaXQgbmFtZXMgd2hpY2ggbG9jYWwgZ2Nsb3VkIGlkZW50aXR5IHRoZSBvcGVyYXRvciBwcm9jZXNzIHVzZXMgdG8gb3BlbiBhbiBJQVBcbiAqIHR1bm5lbC4gSXQgaXMgbm90LCBhbmQgY2FuIG5ldmVyIGJlY29tZSwgYXV0aG9yaXphdGlvbiBtYXRlcmlhbCB0aGUgaG9zdCBob2xkcy4gQWNjZXB0aW5nIGl0XG4gKiBpbiBhIGhvc3QgY3JlZGVudGlhbCBwb3NpdGlvbiB3b3VsZCBzaWxlbnRseSBwcm9tb3RlIGEgY29udHJvbGxlci1zaWRlIHNlbGVjdG9yIGludG8gYSBob3N0XG4gKiBiaW5kaW5nLCB3aGljaCBpcyBleGFjdGx5IHRoZSBjb25mdXNpb24gRC0xMDMgZm9yYmlkcy4gYHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VgXG4gKiB0aGVyZWZvcmUgcmVmdXNlcyBldmVyeSBrbm93biBjb250cm9sbGVyLXNlbGVjdG9yIHNjaGVtZSBCWSBOQU1FLCB3aXRoIGFuIGVycm9yIHRoYXQgc2F5cyB3aHksXG4gKiByYXRoZXIgdGhhbiBmYWlsaW5nIGl0IGluY2lkZW50YWxseSBhcyBcInVucmVjb2duaXNlZFwiLlxuICpcbiAqIERJUkVDVElPTiBPRiBUUlVTVC4gUGFyc2luZyBpcyBkZWxpYmVyYXRlbHkgYW4gYWxsb3dsaXN0IG92ZXIgcmF0aWZpZWQgc2NoZW1lcywgbm90IGEgZGVueWxpc3RcbiAqIG92ZXIgYmFkIG9uZXM6IGFuIHVucmVjb2duaXNlZCBzY2hlbWUgaXMgcmVmdXNlZCBieSBkZWZhdWx0LCBzbyBhIGZ1dHVyZSBjb250cm9sbGVyIHNlbGVjdG9yXG4gKiB0aGF0IG5vYm9keSB0aG91Z2h0IHRvIGRlbnkgc3RpbGwgY2Fubm90IGJlIHVzZWQgYXMgYSBob3N0IHJlZmVyZW5jZS4gVGhlIG5hbWVkIGRlbmlhbHMgZXhpc3RcbiAqIG9ubHkgdG8gcHJvZHVjZSBhIGJldHRlciBkaWFnbm9zaXMgZm9yIHRoZSBtaXN0YWtlcyB3ZSBrbm93IHBlb3BsZSB3aWxsIG1ha2UuXG4gKi9cbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfQ0hBTk5FTFMsXG4gIHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnksXG4gIHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeUtpbmQsXG4gIHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVQbGFuLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcCxcbn0gZnJvbSAnLi93b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXphdGlvbic7XG5pbXBvcnQgeyBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uIH0gZnJvbSAnLi93b3Jrc3BhY2UtaG9zdC10ZXN0LWhhcm5lc3MnO1xuXG4vKiogVmVyc2lvbmVkIHNvIGEgaG9zdCBhbmQgYSBjb250cm9sbGVyIGNhbiBkaXNhZ3JlZSBsb3VkbHkgcmF0aGVyIHRoYW4gc2lsZW50bHkuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9OQU1FU1BBQ0VfVkVSU0lPTiA9XG4gICdwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtY3JlZGVudGlhbC1uYW1lc3BhY2UtdjEnO1xuXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTElFUyA9IFtcbiAgJ2Nsb3VkLXdvcmtsb2FkLWlkZW50aXR5JyxcbiAgJ2dpdC1zaG9ydC1saXZlZC1kZWxlZ2F0aW9uJyxcbiAgJ2FnZW50LWZvcndhcmRlZC1yZWZlcmVuY2UnLFxuICAnYWdlbnQtZW5jcnlwdGVkLXJlZmVyZW5jZScsXG5dIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHkgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxJRVMpW251bWJlcl07XG5cbi8qKlxuICogU2NoZW1lcyB0aGF0IG5hbWUgYSBDT05UUk9MTEVSIGNvbm5lY3Rpb24gc2VsZWN0b3IuIFRoZXNlIGFyZSByZWZ1c2VkIGJ5IG5hbWUgaW4gYW55IGhvc3RcbiAqIGNyZWRlbnRpYWwgcG9zaXRpb24uIGBnY2xvdWQ6Ly9hY3RpdmUtdXNlcmAgaXMgdGhlIGxpdmUgZXhhbXBsZTogaXQgaXMgdGhlIGBjcmVkZW50aWFsX3JlZmBcbiAqIG9uIGEgYHdvcmtzcGFjZV9ob3N0X2Nvbm5lY3Rpb25zYCByb3csIHdoaWNoIHNlbGVjdHMgdGhlIG9wZXJhdG9yJ3Mgb3duIGNsb3VkIGlkZW50aXR5LlxuICovXG5jb25zdCBDT05UUk9MTEVSX0NPTk5FQ1RJT05fU0VMRUNUT1JfU0NIRU1FUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gICdnY2xvdWQnLFxuICAnZ2NwJyxcbiAgJ2F3cycsXG4gICdheicsXG4gICdhenVyZScsXG5dO1xuXG4vKipcbiAqIE9uZSBwYXRoIHNlZ21lbnQgb2YgYSByZWZlcmVuY2UuIERlbGliZXJhdGVseSBuYXJyb3c6IG5vIGA6YCwgbm8gYCVgLCBubyB3aGl0ZXNwYWNlLCBhbmQgbm9cbiAqIGxlYWRpbmcgcHVuY3R1YXRpb24uIEEgZ3JhbW1hciB0aGlzIHRpZ2h0IGlzIHdoYXQgc3RydWN0dXJhbGx5IGtlZXBzIG9wYXF1ZSBiZWFyZXIgbWF0ZXJpYWxcbiAqIG91dCBvZiBhIHJlZmVyZW5jZSDigJQgbW9zdCB0b2tlbiBlbmNvZGluZ3MgY2Fubm90IHN1cnZpdmUgaXQg4oCUIHdoaWNoIGlzIGEgc3Ryb25nZXIgZ3VhcmFudGVlXG4gKiB0aGFuIHBhdHRlcm4tbWF0Y2hpbmcgZm9yIHRva2VuIHNoYXBlcyB3ZSBoYXBwZW4gdG8gaGF2ZSB0aG91Z2h0IG9mLlxuICovXG5jb25zdCBSRUZFUkVOQ0VfU0VHTUVOVCA9IC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll8tXSokLztcbmNvbnN0IFNDSEVNRSA9IC9eW2Etel1bYS16MC05LV0qJC87XG4vKiogTWlycm9ycyBgcmVxdWlyZVJlZmVyZW5jZWAgaW4gdGhlIGluaXRpYWxpemF0aW9uIGNvbnRyYWN0LiAqL1xuY29uc3QgTUFYX1JFRkVSRU5DRV9MRU5HVEggPSAxMDI0O1xuY29uc3QgR0VORVJBVElPTl9TRUdNRU5UID0gL15nKFsxLTldWzAtOV17MCw4fSkkLztcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseVNwZWMge1xuICByZWFkb25seSBmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5O1xuICByZWFkb25seSBjaGFubmVsOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWw7XG4gIHJlYWRvbmx5IHJlZlNjaGVtZTogc3RyaW5nO1xuICByZWFkb25seSByZXZvY2F0aW9uU2NoZW1lOiBzdHJpbmc7XG4gIC8qKiBEZWxpdmVyeSBraW5kcyB0aGlzIGZhbWlseSBtYXkgYmUgZGVsaXZlcmVkIGFzOyBhIHN1YnNldCBvZiB0aGUgY2hhbm5lbCdzIGFsbG93ZWQgc2V0LiAqL1xuICByZWFkb25seSBkZWxpdmVyeUtpbmRzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5S2luZFtdO1xuICAvKiogTmFtZXMgZm9yIGVhY2ggcmVxdWlyZWQgc2VnbWVudCwgaW4gb3JkZXIuIExlbmd0aCBmaXhlcyB0aGUgc2VnbWVudCBjb3VudCBleGFjdGx5LiAqL1xuICByZWFkb25seSBzZWdtZW50czogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBXaGV0aGVyIGEgYmluZGluZyBpbiB0aGlzIGZhbWlseSBtdXN0IGNhcnJ5IGFuIGV4cGlyeS4gKi9cbiAgcmVhZG9ubHkgcmVxdWlyZXNFeHBpcnk6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGV0aGVyIGJpbmRpbmcgdGhpcyBmYW1pbHkgcmVxdWlyZXMgYXV0aG9yaXphdGlvbiBtYXRlcmlhbCB0byBoYXZlIGJlZW4gV1JJVFRFTiB0byB0aGUgaG9zdFxuICAgKiBmaWxlc3lzdGVtIGZpcnN0LCBhcyBvcHBvc2VkIHRvIGJlaW5nIGFuc3dlcmVkIGFtYmllbnRseSBieSB0aGUgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIHNpbmdsZSBzb3VyY2UgZm9yIHRoYXQgZmFjdCAoRC0yMTUpLiBgbWF0ZXJpYWxQYXRoRm9yYCBpbiB0aGUgcmVtb3RlIGluaXRpYWxpemVyXG4gICAqIGhvc3QgcmVhZHMgaXQgdG8gZGVjaWRlIHdoZXRoZXIgYSBmYW1pbHkgaGFzIGFuIG9uLWhvc3QgYXJ0aWZhY3QgYXQgYWxsLCBhbmQgdGhlIHBsYW4tdGltZVxuICAgKiBjYXBhYmlsaXR5IGdhdGUgcmVhZHMgaXQgdG8gZGVjaWRlIHdoZXRoZXIgYSBwcm92aWRlciB0aGF0IGNhbm5vdCB0cmFuc2ZlciBmaWxlcyBtYXkgY2FycnkgdGhlXG4gICAqIGZhbWlseSdzIGNoYW5uZWwuIEJvdGggdXNlZCB0byBoYXJkLWNvZGUgYGZhbWlseSA9PT0gJ2Nsb3VkLXdvcmtsb2FkLWlkZW50aXR5J2AsIHdoaWNoIGlzIHRoZVxuICAgKiBraW5kIG9mIHJlc3RhdGVkIGZhY3QgdGhhdCBzaWxlbnRseSBzdG9wcyBtYXRjaGluZyB3aGVuIGEgZmlmdGggZmFtaWx5IGlzIGFkZGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVxdWlyZXNEZWxpdmVyZWRNYXRlcmlhbDogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXNwYWNlIGl0c2VsZi5cbiAqXG4gKiBFdmVyeSBgcmVmU2NoZW1lYCBhbmQgZXZlcnkgYHJldm9jYXRpb25TY2hlbWVgIGhlcmUgaXMgZGlzdGluY3QgZnJvbSBldmVyeSBvdGhlciBvbmUsIHdoaWNoIGlzXG4gKiB3aGF0IG1ha2VzIHRoZSBpbml0aWFsaXphdGlvbiBjb250cmFjdCdzIFwiYWxsIHRocmVlIHJlZnMgZGlzdGluY3QgLyBhbGwgdGhyZWUgcmV2b2NhdGlvbiByZWZzXG4gKiBkaXN0aW5jdFwiIHJ1bGVzIGltcG9zc2libGUgdG8gdHJpcCBhY2NpZGVudGFsbHk6IHR3byBkaWZmZXJlbnQgY2hhbm5lbHMgY2Fubm90IGV2ZW4gc3BlbGwgdGhlXG4gKiBzYW1lIHJlZmVyZW5jZS4gVGhlIHR3byBhZ2VudCBmYW1pbGllcyBkZWxpYmVyYXRlbHkgU0hBUkUgYHBjLWFnZW50LXJldm9jYXRpb25gIGJlY2F1c2UgYVxuICogcmVxdWVzdCBjYXJyaWVzIGF0IG1vc3Qgb25lIGFnZW50IGNoYW5uZWwsIHNvIHRoZXkgbmV2ZXIgY29leGlzdCwgYW5kIGEgc2luZ2xlIHJldm9jYXRpb25cbiAqIHN1cmZhY2UgZm9yIFwidGhlIGFnZW50IGJpbmRpbmcgb24gdGhpcyBob3N0XCIgaXMgdGhlIGhvbmVzdCBtb2RlbC5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTOiBSZWFkb25seTxcbiAgUmVjb3JkPFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LCBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseVNwZWM+XG4+ID0ge1xuICAnY2xvdWQtd29ya2xvYWQtaWRlbnRpdHknOiB7XG4gICAgZmFtaWx5OiAnY2xvdWQtd29ya2xvYWQtaWRlbnRpdHknLFxuICAgIGNoYW5uZWw6ICdjbG91ZCcsXG4gICAgcmVmU2NoZW1lOiAncGMtY2xvdWQtd29ya2xvYWQnLFxuICAgIHJldm9jYXRpb25TY2hlbWU6ICdwYy1jbG91ZC13b3JrbG9hZC1yZXZvY2F0aW9uJyxcbiAgICAvLyBgZm9yd2FyZGVkLWFnZW50YCBpcyBhYnNlbnQgYmVjYXVzZSB0aGUgaW5pdGlhbGl6YXRpb24gY29udHJhY3QgYWxyZWFkeSByZWplY3RzIGl0IGZvclxuICAgIC8vIHRoZSBjbG91ZCBjaGFubmVsOyByZXBlYXRpbmcgdGhhdCBoZXJlIGtlZXBzIHRoZSB0d28gdGFibGVzIGZyb20gZGlzYWdyZWVpbmcuXG4gICAgZGVsaXZlcnlLaW5kczogWydwcm92aWRlci1pZGVudGl0eScsICdlbmNyeXB0ZWQtcmVmZXJlbmNlJ10sXG4gICAgc2VnbWVudHM6IFsncHJvdmlkZXInLCAnc2NvcGVJZCcsICd3b3JrbG9hZElkJ10sXG4gICAgcmVxdWlyZXNFeHBpcnk6IGZhbHNlLFxuICAgIC8vIEFtYmllbnQ6IHRoZSBpbnN0YW5jZSBtZXRhZGF0YSBzZXJ2ZXIgYW5zd2VycywgYW5kIG5vdGhpbmcgaXMgcGxhY2VkIG9uIGRpc2suIEludmVudGluZyBhXG4gICAgLy8gZmlsZSBmb3IgaXQgd291bGQgbWFrZSBiaW5kKCkgcGFzcyBhZ2FpbnN0IGEgcGF0aCB3ZSBjcmVhdGVkIG91cnNlbHZlcy5cbiAgICByZXF1aXJlc0RlbGl2ZXJlZE1hdGVyaWFsOiBmYWxzZSxcbiAgfSxcbiAgJ2dpdC1zaG9ydC1saXZlZC1kZWxlZ2F0aW9uJzoge1xuICAgIGZhbWlseTogJ2dpdC1zaG9ydC1saXZlZC1kZWxlZ2F0aW9uJyxcbiAgICBjaGFubmVsOiAnZ2l0JyxcbiAgICByZWZTY2hlbWU6ICdwYy1naXQtZGVsZWdhdGlvbicsXG4gICAgcmV2b2NhdGlvblNjaGVtZTogJ3BjLWdpdC1kZWxlZ2F0aW9uLXJldm9jYXRpb24nLFxuICAgIGRlbGl2ZXJ5S2luZHM6IFsnc2hvcnQtbGl2ZWQtZGVsZWdhdGlvbicsICdlbmNyeXB0ZWQtcmVmZXJlbmNlJ10sXG4gICAgc2VnbWVudHM6IFsnZm9yZ2UnLCAnb3duZXInLCAncmVwb3NpdG9yeSddLFxuICAgIHJlcXVpcmVzRXhwaXJ5OiB0cnVlLFxuICAgIHJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWw6IHRydWUsXG4gIH0sXG4gICdhZ2VudC1mb3J3YXJkZWQtcmVmZXJlbmNlJzoge1xuICAgIGZhbWlseTogJ2FnZW50LWZvcndhcmRlZC1yZWZlcmVuY2UnLFxuICAgIGNoYW5uZWw6ICdhZ2VudCcsXG4gICAgcmVmU2NoZW1lOiAncGMtYWdlbnQtZm9yd2FyZCcsXG4gICAgcmV2b2NhdGlvblNjaGVtZTogJ3BjLWFnZW50LXJldm9jYXRpb24nLFxuICAgIGRlbGl2ZXJ5S2luZHM6IFsnZm9yd2FyZGVkLWFnZW50J10sXG4gICAgc2VnbWVudHM6IFsnaG9zdElkJywgJ2FnZW50U2V0J10sXG4gICAgcmVxdWlyZXNFeHBpcnk6IGZhbHNlLFxuICAgIHJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWw6IHRydWUsXG4gIH0sXG4gICdhZ2VudC1lbmNyeXB0ZWQtcmVmZXJlbmNlJzoge1xuICAgIGZhbWlseTogJ2FnZW50LWVuY3J5cHRlZC1yZWZlcmVuY2UnLFxuICAgIGNoYW5uZWw6ICdhZ2VudCcsXG4gICAgcmVmU2NoZW1lOiAncGMtYWdlbnQtc2VhbGVkJyxcbiAgICByZXZvY2F0aW9uU2NoZW1lOiAncGMtYWdlbnQtcmV2b2NhdGlvbicsXG4gICAgZGVsaXZlcnlLaW5kczogWydlbmNyeXB0ZWQtcmVmZXJlbmNlJ10sXG4gICAgc2VnbWVudHM6IFsnaG9zdElkJywgJ2FnZW50U2V0J10sXG4gICAgcmVxdWlyZXNFeHBpcnk6IGZhbHNlLFxuICAgIHJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWw6IHRydWUsXG4gIH0sXG59O1xuXG4vKipcbiAqIFRoZSBjcmVkZW50aWFsIENIQU5ORUxTIHRoYXQgY2Fubm90IGJlIGNhcnJpZWQgd2l0aG91dCBvbi1ob3N0IGZpbGUgZGVsaXZlcnksIGRlcml2ZWQgZnJvbSB0aGVcbiAqIGZhbWlseSBzcGVjcyBhYm92ZSByYXRoZXIgdGhhbiByZXN0YXRlZCAoRC0yMTUgcG9pbnQgNikuXG4gKlxuICogQSBjaGFubmVsIG5lZWRzIGRlbGl2ZXJ5IGlmIEFOWSBmYW1pbHkgb24gaXQgZG9lczogYSBwcm92aWRlciB0aGF0IGNhbm5vdCB0cmFuc2ZlciBmaWxlcyBjYW5ub3RcbiAqIGNhcnJ5IGEgY2hhbm5lbCB3aG9zZSBmYW1pbGllcyByZXF1aXJlIGEgd3JpdHRlbiBhcnRpZmFjdC4gVGhlIGluaXRpYWxpemF0aW9uIGNvbnRyYWN0IGhvbGRzIGFcbiAqIGxpdGVyYWwgY29weSBvZiB0aGlzIHNldCBiZWNhdXNlIGB3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZWAgaW1wb3J0cyB0aGUgY29udHJhY3QgYW5kXG4gKiBjYW5ub3QgYmUgaW1wb3J0ZWQgYmFjayB3aXRob3V0IGEgY3ljbGU7IGB3b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZS50ZXN0LnRzYCBwaW5zIHRoZVxuICogdHdvIHRvZ2V0aGVyIHNvIHRoZSBjb3B5IGNhbm5vdCBkcmlmdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0NIQU5ORUxTX1JFUVVJUklOR19GSUxFX0RFTElWRVJZOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWxbXSA9XG4gIE9iamVjdC5mcmVlemUoXG4gICAgQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIE9iamVjdC52YWx1ZXMoV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTFlfU1BFQ1MpXG4gICAgICAgICAgLmZpbHRlcigoc3BlYykgPT4gc3BlYy5yZXF1aXJlc0RlbGl2ZXJlZE1hdGVyaWFsKVxuICAgICAgICAgIC5tYXAoKHNwZWMpID0+IHNwZWMuY2hhbm5lbCksXG4gICAgICApLFxuICAgICkuc29ydCgpLFxuICApO1xuXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgcmVmZXJlbmNlOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IocmVmZXJlbmNlOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yJztcbiAgICB0aGlzLnJlZmVyZW5jZSA9IHJlZmVyZW5jZTtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFBhcnNlZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlIHtcbiAgcmVhZG9ubHkgbmFtZXNwYWNlVmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT047XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG4gIHJlYWRvbmx5IGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgcmVhZG9ubHkgc2NoZW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlZ21lbnRzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFNlZ21lbnRzIGtleWVkIGJ5IHRoZSBmYW1pbHkncyBkZWNsYXJlZCBzZWdtZW50IG5hbWVzLiAqL1xuICByZWFkb25seSBmaWVsZHM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFBhcnNlZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2NhdGlvblJlZmVyZW5jZSB7XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG4gIHJlYWRvbmx5IHNjaGVtZTogc3RyaW5nO1xuICByZWFkb25seSBzZWdtZW50czogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcbn1cblxuZnVuY3Rpb24gc3BsaXRSZWZlcmVuY2UocmVmZXJlbmNlOiBzdHJpbmcpOiB7IHNjaGVtZTogc3RyaW5nOyBzZWdtZW50czogc3RyaW5nW10gfSB7XG4gIGlmICh0eXBlb2YgcmVmZXJlbmNlICE9PSAnc3RyaW5nJyB8fCByZWZlcmVuY2UubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICBTdHJpbmcocmVmZXJlbmNlKSxcbiAgICAgICdjcmVkZW50aWFsIHJlZmVyZW5jZSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZycsXG4gICAgKTtcbiAgfVxuICBpZiAocmVmZXJlbmNlLmxlbmd0aCA+IE1BWF9SRUZFUkVOQ0VfTEVOR1RIKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICByZWZlcmVuY2UsXG4gICAgICBgY3JlZGVudGlhbCByZWZlcmVuY2UgbXVzdCBiZSBhdCBtb3N0ICR7TUFYX1JFRkVSRU5DRV9MRU5HVEh9IGNoYXJhY3RlcnNgLFxuICAgICk7XG4gIH1cbiAgLy8gQ2hlY2tlZCBiZWZvcmUgdGhlIHNoYXBlIHRlc3Qgc28gYSByZWZlcmVuY2UgY2FycnlpbmcgYSBuZXdsaW5lIGlzIGRpYWdub3NlZCBhcyBzdWNoIHJhdGhlclxuICAvLyB0aGFuIGFzIGEgbWFsZm9ybWVkIHNjaGVtZTsgdGhlIGluaXRpYWxpemF0aW9uIGNvbnRyYWN0IHJlamVjdHMgdGhlc2Ugc2VwYXJhdGVseSB0b28uXG4gIGlmICgvW1xcclxcblxcMFxcc10vLnRlc3QocmVmZXJlbmNlKSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgcmVmZXJlbmNlLFxuICAgICAgJ2NyZWRlbnRpYWwgcmVmZXJlbmNlIG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZSBvciBjb250cm9sIGNoYXJhY3RlcnMnLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc2VwYXJhdG9yID0gcmVmZXJlbmNlLmluZGV4T2YoJzovLycpO1xuICBpZiAoc2VwYXJhdG9yIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgIFwiY3JlZGVudGlhbCByZWZlcmVuY2UgbXVzdCBiZSAnPHNjaGVtZT46Ly88c2VnbWVudD5bLzxzZWdtZW50PuKApl0nXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBzY2hlbWUgPSByZWZlcmVuY2Uuc2xpY2UoMCwgc2VwYXJhdG9yKTtcbiAgY29uc3QgcmVzdCA9IHJlZmVyZW5jZS5zbGljZShzZXBhcmF0b3IgKyAzKTtcbiAgaWYgKCFTQ0hFTUUudGVzdChzY2hlbWUpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICByZWZlcmVuY2UsXG4gICAgICBgY3JlZGVudGlhbCByZWZlcmVuY2Ugc2NoZW1lICcke3NjaGVtZX0nIGlzIG5vdCBhIGxvd2VyY2FzZSBzY2hlbWUgbmFtZWAsXG4gICAgKTtcbiAgfVxuICBpZiAocmVzdC5pbmNsdWRlcygnPycpIHx8IHJlc3QuaW5jbHVkZXMoJyMnKSB8fCByZXN0LmluY2x1ZGVzKCdAJykpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgICdjcmVkZW50aWFsIHJlZmVyZW5jZSBtdXN0IG5vdCBjb250YWluIHVzZXJpbmZvLCBhIHF1ZXJ5IHN0cmluZywgb3IgYSBmcmFnbWVudCcsXG4gICAgKTtcbiAgfVxuICBjb25zdCBzZWdtZW50cyA9IHJlc3Quc3BsaXQoJy8nKTtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKCFSRUZFUkVOQ0VfU0VHTUVOVC50ZXN0KHNlZ21lbnQpKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgICAgcmVmZXJlbmNlLFxuICAgICAgICBgY3JlZGVudGlhbCByZWZlcmVuY2Ugc2VnbWVudCAnJHtzZWdtZW50fScgaXMgbm90IGEgc2FmZSByZWZlcmVuY2Ugc2VnbWVudGAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBzY2hlbWUsIHNlZ21lbnRzIH07XG59XG5cbmZ1bmN0aW9uIHJlZnVzZUNvbnRyb2xsZXJTZWxlY3RvcihyZWZlcmVuY2U6IHN0cmluZywgc2NoZW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFDT05UUk9MTEVSX0NPTk5FQ1RJT05fU0VMRUNUT1JfU0NIRU1FUy5pbmNsdWRlcyhzY2hlbWUpKSByZXR1cm47XG4gIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgIHJlZmVyZW5jZSxcbiAgICBgJyR7cmVmZXJlbmNlfScgaXMgYSBjb250cm9sbGVyIGNvbm5lY3Rpb24gc2VsZWN0b3IsIG5vdCBob3N0IGF1dGhvcml6YXRpb24gbWF0ZXJpYWwuIGAgK1xuICAgICAgYFNjaGVtZSAnJHtzY2hlbWV9JyBzZWxlY3RzIHRoZSBpZGVudGl0eSB0aGUgQ09OVFJPTExFUiBjb25uZWN0cyB3aXRoIGFuZCBtdXN0IG5ldmVyIGJlIGAgK1xuICAgICAgYHVzZWQgYXMgYSB3b3Jrc3BhY2UtaG9zdCBjcmVkZW50aWFsIHJlZmVyZW5jZSAoRC0xMDMpLiBVc2UgYSByYXRpZmllZCBob3N0IGZhbWlseTogYCArXG4gICAgICBgJHtXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0ZBTUlMSUVTLmpvaW4oJywgJyl9LmAsXG4gICk7XG59XG5cbi8qKlxuICogUGFyc2UgYSBob3N0IGNyZWRlbnRpYWwgcmVmZXJlbmNlLCBvcHRpb25hbGx5IHBpbm5pbmcgdGhlIGNoYW5uZWwgaXQgbXVzdCBiZWxvbmcgdG8uXG4gKlxuICogUGFzc2luZyBgY2hhbm5lbGAgaXMgd2hhdCB0dXJucyBcInRoaXMgaXMgYSB3ZWxsLWZvcm1lZCByZWZlcmVuY2VcIiBpbnRvIFwidGhpcyBpcyBhIHdlbGwtZm9ybWVkXG4gKiByZWZlcmVuY2UgRk9SIFRISVMgU0xPVFwiIOKAlCBhIGdpdCBkZWxlZ2F0aW9uIHJlZiBzaXR0aW5nIGluIHRoZSBjbG91ZCBzbG90IGlzIHdlbGwtZm9ybWVkIGFuZFxuICogY29tcGxldGVseSB3cm9uZywgYW5kIG9ubHkgdGhlIGNoYW5uZWwtcGlubmVkIGNhbGwgY2FuIHNheSBzby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2UoXG4gIHJlZmVyZW5jZTogc3RyaW5nLFxuICBjaGFubmVsPzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsLFxuKTogUGFyc2VkV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2Uge1xuICBjb25zdCB7IHNjaGVtZSwgc2VnbWVudHMgfSA9IHNwbGl0UmVmZXJlbmNlKHJlZmVyZW5jZSk7XG4gIHJlZnVzZUNvbnRyb2xsZXJTZWxlY3RvcihyZWZlcmVuY2UsIHNjaGVtZSk7XG5cbiAgY29uc3Qgc3BlYyA9IE9iamVjdC52YWx1ZXMoV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTFlfU1BFQ1MpLmZpbmQoXG4gICAgKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLnJlZlNjaGVtZSA9PT0gc2NoZW1lLFxuICApO1xuICBpZiAoIXNwZWMpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgIGBjcmVkZW50aWFsIHJlZmVyZW5jZSBzY2hlbWUgJyR7c2NoZW1lfScgaXMgbm90IGluIHRoZSByYXRpZmllZCBob3N0IG5hbWVzcGFjZSBgICtcbiAgICAgICAgYCgke1dPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT059KS4gUmF0aWZpZWQgcmVmIHNjaGVtZXM6IGAgK1xuICAgICAgICBgJHtPYmplY3QudmFsdWVzKFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTKVxuICAgICAgICAgIC5tYXAoKGVudHJ5KSA9PiBgJHtlbnRyeS5yZWZTY2hlbWV9Oi8vYClcbiAgICAgICAgICAuam9pbignLCAnKX0uYCxcbiAgICApO1xuICB9XG4gIGlmIChzZWdtZW50cy5sZW5ndGggIT09IHNwZWMuc2VnbWVudHMubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICByZWZlcmVuY2UsXG4gICAgICBgJHtzcGVjLmZhbWlseX0gcmVmZXJlbmNlIG11c3QgaGF2ZSBleGFjdGx5ICR7c3BlYy5zZWdtZW50cy5sZW5ndGh9IHNlZ21lbnRzIGAgK1xuICAgICAgICBgKCR7c3BlYy5zZWdtZW50cy5qb2luKCcvJyl9KSwgZ290ICR7c2VnbWVudHMubGVuZ3RofWAsXG4gICAgKTtcbiAgfVxuICBpZiAoY2hhbm5lbCAmJiBzcGVjLmNoYW5uZWwgIT09IGNoYW5uZWwpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgIGAke3NwZWMuZmFtaWx5fSByZWZlcmVuY2UgYmVsb25ncyB0byB0aGUgJyR7c3BlYy5jaGFubmVsfScgY2hhbm5lbCwgbm90ICcke2NoYW5uZWx9J2AsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBzcGVjLnNlZ21lbnRzLmZvckVhY2goKGxhYmVsLCBpbmRleCkgPT4ge1xuICAgIGZpZWxkc1tsYWJlbF0gPSBzZWdtZW50c1tpbmRleF0gYXMgc3RyaW5nO1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIG5hbWVzcGFjZVZlcnNpb246IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT04sXG4gICAgZmFtaWx5OiBzcGVjLmZhbWlseSxcbiAgICBjaGFubmVsOiBzcGVjLmNoYW5uZWwsXG4gICAgc2NoZW1lLFxuICAgIHNlZ21lbnRzLFxuICAgIGZpZWxkcyxcbiAgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSBhIHJldm9jYXRpb24gcmVmZXJlbmNlIGFuZCByZWNvdmVyIHRoZSBnZW5lcmF0aW9uIGl0IHJldm9rZXMuXG4gKlxuICogVGhlIGdlbmVyYXRpb24gaXMgSU4gdGhlIHJldm9jYXRpb24gcmVmZXJlbmNlIG9uIHB1cnBvc2UuIEEgcmV2b2NhdGlvbiByZWZlcmVuY2UgdGhhdCBuYW1lZFxuICogb25seSBcInRoZSBnaXQgYmluZGluZ1wiIHdvdWxkIGJlIHRoZSBzYW1lIHN0cmluZyBmb3IgZXZlcnkgcm90YXRpb24sIHNvIGEgcmVwbGF5ZWQgcmV2b2NhdGlvblxuICogY291bGQgbm90IGJlIGRpc3Rpbmd1aXNoZWQgZnJvbSB0aGUgY3VycmVudCBvbmUsIGFuZCBhIHJvdGF0aW9uIHRlc3QgY291bGQgbm90IHByb3ZlIHRoYXQgdGhlXG4gKiBQUkVWSU9VUyBiaW5kaW5nIOKAlCByYXRoZXIgdGhhbiB0aGUgbmV3IG9uZSDigJQgaXMgd2hhdCBnb3QgcmV2b2tlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZvY2F0aW9uUmVmZXJlbmNlKFxuICByZWZlcmVuY2U6IHN0cmluZyxcbiAgZmFtaWx5PzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4pOiBQYXJzZWRXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJldm9jYXRpb25SZWZlcmVuY2Uge1xuICBjb25zdCB7IHNjaGVtZSwgc2VnbWVudHMgfSA9IHNwbGl0UmVmZXJlbmNlKHJlZmVyZW5jZSk7XG4gIHJlZnVzZUNvbnRyb2xsZXJTZWxlY3RvcihyZWZlcmVuY2UsIHNjaGVtZSk7XG5cbiAgY29uc3QgY2FuZGlkYXRlcyA9IE9iamVjdC52YWx1ZXMoV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTFlfU1BFQ1MpLmZpbHRlcihcbiAgICAoZW50cnkpID0+IGVudHJ5LnJldm9jYXRpb25TY2hlbWUgPT09IHNjaGVtZSxcbiAgKTtcbiAgY29uc3Qgc3BlYyA9IGZhbWlseVxuICAgID8gY2FuZGlkYXRlcy5maW5kKChlbnRyeSkgPT4gZW50cnkuZmFtaWx5ID09PSBmYW1pbHkpXG4gICAgOiBjYW5kaWRhdGVzWzBdO1xuICBpZiAoIXNwZWMpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgIGZhbWlseVxuICAgICAgICA/IGByZXZvY2F0aW9uIHJlZmVyZW5jZSBzY2hlbWUgJyR7c2NoZW1lfScgZG9lcyBub3QgYmVsb25nIHRvIGZhbWlseSAnJHtmYW1pbHl9J2BcbiAgICAgICAgOiBgcmV2b2NhdGlvbiByZWZlcmVuY2Ugc2NoZW1lICcke3NjaGVtZX0nIGlzIG5vdCBpbiB0aGUgcmF0aWZpZWQgaG9zdCBuYW1lc3BhY2UgYCArXG4gICAgICAgICAgYCgke1dPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT059KWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGdlbmVyYXRpb25TZWdtZW50ID0gc2VnbWVudHNbc2VnbWVudHMubGVuZ3RoIC0gMV0gPz8gJyc7XG4gIGNvbnN0IG1hdGNoID0gR0VORVJBVElPTl9TRUdNRU5ULmV4ZWMoZ2VuZXJhdGlvblNlZ21lbnQpO1xuICBpZiAoIW1hdGNoKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICByZWZlcmVuY2UsXG4gICAgICBgcmV2b2NhdGlvbiByZWZlcmVuY2UgbXVzdCBlbmQgd2l0aCBhIGdlbmVyYXRpb24gc2VnbWVudCAnZzxuPicsIGdvdCAnJHtnZW5lcmF0aW9uU2VnbWVudH0nYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGJvZHkgPSBzZWdtZW50cy5zbGljZSgwLCAtMSk7XG4gIGlmIChib2R5Lmxlbmd0aCAhPT0gc3BlYy5zZWdtZW50cy5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIHJlZmVyZW5jZSxcbiAgICAgIGAke3NwZWMuZmFtaWx5fSByZXZvY2F0aW9uIHJlZmVyZW5jZSBtdXN0IGJlIGAgK1xuICAgICAgICBgJyR7c3BlYy5yZXZvY2F0aW9uU2NoZW1lfTovLyR7c3BlYy5zZWdtZW50cy5qb2luKCcvJyl9L2c8bj4nYCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBmYW1pbHk6IHNwZWMuZmFtaWx5LFxuICAgIHNjaGVtZSxcbiAgICBzZWdtZW50czogYm9keSxcbiAgICBnZW5lcmF0aW9uOiBOdW1iZXIobWF0Y2hbMV0pLFxuICB9O1xufVxuXG4vKiogQ29uc3RydWN0IGEgcmVmZXJlbmNlIGluc3RlYWQgb2YgaGFuZC1mb3JtYXR0aW5nIG9uZSBhdCBhIGNhbGwgc2l0ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlKFxuICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxuICBmaWVsZHM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+LFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc3BlYyA9IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTW2ZhbWlseV07XG4gIGlmICghc3BlYykge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKGZhbWlseSwgYHVua25vd24gY3JlZGVudGlhbCBmYW1pbHkgJyR7ZmFtaWx5fSdgKTtcbiAgfVxuICBjb25zdCBzZWdtZW50cyA9IHNwZWMuc2VnbWVudHMubWFwKChsYWJlbCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gZmllbGRzW2xhYmVsXTtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyB8fCAhUkVGRVJFTkNFX1NFR01FTlQudGVzdCh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgICBTdHJpbmcodmFsdWUpLFxuICAgICAgICBgJHtmYW1pbHl9IHJlZmVyZW5jZSBmaWVsZCAnJHtsYWJlbH0nIG11c3QgYmUgYSBzYWZlIHJlZmVyZW5jZSBzZWdtZW50YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbiAgfSk7XG4gIGNvbnN0IHJlZmVyZW5jZSA9IGAke3NwZWMucmVmU2NoZW1lfTovLyR7c2VnbWVudHMuam9pbignLycpfWA7XG4gIC8vIFJvdW5kLXRyaXAgcmF0aGVyIHRoYW4gdHJ1c3QgdGhlIGNvbnN0cnVjdGlvbjogYSBidWlsZGVyIHRoYXQgY2FuIGVtaXQgc29tZXRoaW5nIGl0cyBvd25cbiAgLy8gcGFyc2VyIHJlamVjdHMgaXMgYSB3b3JzZSBmYWlsdXJlIHRoYW4gYSByZWplY3RlZCBpbnB1dCwgYmVjYXVzZSBpdCBmYWlscyBhdCB0aGUgZmFyIGVuZC5cbiAgcGFyc2VXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZShyZWZlcmVuY2UsIHNwZWMuY2hhbm5lbCk7XG4gIHJldHVybiByZWZlcmVuY2U7XG59XG5cbi8qKiBDb25zdHJ1Y3QgdGhlIHJldm9jYXRpb24gcmVmZXJlbmNlIGZvciBhIHNwZWNpZmljIGdlbmVyYXRpb24gb2YgYSBiaW5kaW5nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZvY2F0aW9uUmVmZXJlbmNlKFxuICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxuICBmaWVsZHM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+LFxuICBnZW5lcmF0aW9uOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzcGVjID0gV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTFlfU1BFQ1NbZmFtaWx5XTtcbiAgaWYgKCFzcGVjKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoZmFtaWx5LCBgdW5rbm93biBjcmVkZW50aWFsIGZhbWlseSAnJHtmYW1pbHl9J2ApO1xuICB9XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoZ2VuZXJhdGlvbikgfHwgZ2VuZXJhdGlvbiA8IDEpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIFN0cmluZyhnZW5lcmF0aW9uKSxcbiAgICAgICdjcmVkZW50aWFsIGdlbmVyYXRpb24gbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlcicsXG4gICAgKTtcbiAgfVxuICBjb25zdCBzZWdtZW50cyA9IHNwZWMuc2VnbWVudHMubWFwKChsYWJlbCkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gZmllbGRzW2xhYmVsXTtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyB8fCAhUkVGRVJFTkNFX1NFR01FTlQudGVzdCh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgICBTdHJpbmcodmFsdWUpLFxuICAgICAgICBgJHtmYW1pbHl9IHJldm9jYXRpb24gZmllbGQgJyR7bGFiZWx9JyBtdXN0IGJlIGEgc2FmZSByZWZlcmVuY2Ugc2VnbWVudGAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG4gIH0pO1xuICBjb25zdCByZWZlcmVuY2UgPSBgJHtzcGVjLnJldm9jYXRpb25TY2hlbWV9Oi8vJHtzZWdtZW50cy5qb2luKCcvJyl9L2cke2dlbmVyYXRpb259YDtcbiAgcGFyc2VXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJldm9jYXRpb25SZWZlcmVuY2UocmVmZXJlbmNlLCBmYW1pbHkpO1xuICByZXR1cm4gcmVmZXJlbmNlO1xufVxuXG4vKipcbiAqIEEgYmluZGluZyB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgbmFtZXNwYWNlOiB0aGUgcmVmZXJlbmNlLCB0aGUgZGVsaXZlcnksIGFuZCB0aGUgY3Jvc3MtY2hlY2tzXG4gKiB0aGF0IG9ubHkgbWFrZSBzZW5zZSB3aXRoIGJvdGggaW4gaGFuZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yIHtcbiAgcmVhZG9ubHkgbmFtZXNwYWNlVmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT047XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG4gIHJlYWRvbmx5IGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgcmVhZG9ubHkgcmVmZXJlbmNlOiBQYXJzZWRXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZTtcbiAgcmVhZG9ubHkgcmV2b2NhdGlvbjogUGFyc2VkV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZvY2F0aW9uUmVmZXJlbmNlO1xuICByZWFkb25seSBkZWxpdmVyeUtpbmQ6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlLaW5kO1xuICByZWFkb25seSBnZW5lcmF0aW9uOiBudW1iZXI7XG4gIHJlYWRvbmx5IGF1ZGllbmNlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGV4cGlyZXNBdD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZXNjcmliZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0lucHV0IHtcbiAgY2hhbm5lbDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsO1xuICBjcmVkZW50aWFsUmVmOiB7IGtpbmQ6IHN0cmluZzsgcmVmOiBzdHJpbmcgfTtcbiAgZGVsaXZlcnk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnk7XG4gIC8qKiBUaGUgaW5zdGFudCB0aGUgcmVxdWVzdCB3YXMgYWNjZXB0ZWQ7IGV4cGlyeSBpcyBqdWRnZWQgYWdhaW5zdCBpdCwgbmV2ZXIgYWdhaW5zdCBgbm93YC4gKi9cbiAgcmVxdWVzdGVkQXQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBvbmUgY2hhbm5lbCdzIHJlZmVyZW5jZSArIGRlbGl2ZXJ5IHBhaXIgYWdhaW5zdCB0aGUgbmFtZXNwYWNlLlxuICpcbiAqIEV4cGlyeSBpcyBjb21wYXJlZCB0byBgcmVxdWVzdGVkQXRgLCBub3QgdG8gd2FsbC1jbG9jayBub3csIGJlY2F1c2UgdGhhdCBpcyB0aGUgaW5zdGFudCB0aGVcbiAqIGluaXRpYWxpemF0aW9uIGNvbnRyYWN0IGl0c2VsZiBjb21wYXJlcyBhZ2FpbnN0LiBBIHJlc29sdmVyIHRoYXQgdXNlZCBpdHMgb3duIGNsb2NrIHdvdWxkXG4gKiBhY2NlcHQgb3IgcmVqZWN0IGJpbmRpbmdzIHRoZSBwbGFubmVyIGhhZCBhbHJlYWR5IHJ1bGVkIG9uLCBhbmQgdGhlIHR3byB2ZXJkaWN0cyB3b3VsZCBkaXZlcmdlXG4gKiBleGFjdGx5IHdoZW4gYSByZXF1ZXN0IHNhdCBpbiBhIHF1ZXVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmcoXG4gIGlucHV0OiBEZXNjcmliZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0lucHV0LFxuKTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvciB7XG4gIGNvbnN0IHsgY2hhbm5lbCwgY3JlZGVudGlhbFJlZiwgZGVsaXZlcnksIHJlcXVlc3RlZEF0IH0gPSBpbnB1dDtcbiAgaWYgKCFXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0NIQU5ORUxTLmluY2x1ZGVzKGNoYW5uZWwpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICBTdHJpbmcoY2hhbm5lbCksXG4gICAgICBgdW5rbm93biBjcmVkZW50aWFsIGNoYW5uZWwgJyR7Y2hhbm5lbH0nYCxcbiAgICApO1xuICB9XG4gIGlmIChjcmVkZW50aWFsUmVmPy5raW5kICE9PSBjaGFubmVsKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICBTdHJpbmcoY3JlZGVudGlhbFJlZj8ucmVmKSxcbiAgICAgIGBjcmVkZW50aWFsIHJlZmVyZW5jZSBraW5kICcke2NyZWRlbnRpYWxSZWY/LmtpbmR9JyBkb2VzIG5vdCBtYXRjaCBjaGFubmVsICcke2NoYW5uZWx9J2AsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJlZmVyZW5jZSA9IHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2UoY3JlZGVudGlhbFJlZi5yZWYsIGNoYW5uZWwpO1xuICBjb25zdCBzcGVjID0gV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTFlfU1BFQ1NbcmVmZXJlbmNlLmZhbWlseV07XG5cbiAgaWYgKCFzcGVjLmRlbGl2ZXJ5S2luZHMuaW5jbHVkZXMoZGVsaXZlcnk/LmtpbmQgYXMgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeUtpbmQpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICBjcmVkZW50aWFsUmVmLnJlZixcbiAgICAgIGAke3JlZmVyZW5jZS5mYW1pbHl9IG1heSBub3QgYmUgZGVsaXZlcmVkIGFzICcke2RlbGl2ZXJ5Py5raW5kfSc7IGFsbG93ZWQ6IGAgK1xuICAgICAgICBgJHtzcGVjLmRlbGl2ZXJ5S2luZHMuam9pbignLCAnKX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihkZWxpdmVyeS5nZW5lcmF0aW9uKSB8fCBkZWxpdmVyeS5nZW5lcmF0aW9uIDwgMSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgY3JlZGVudGlhbFJlZi5yZWYsXG4gICAgICAnY3JlZGVudGlhbERlbGl2ZXJ5LmdlbmVyYXRpb24gbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlcicsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJldm9jYXRpb24gPSBwYXJzZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2NhdGlvblJlZmVyZW5jZShcbiAgICBkZWxpdmVyeS5yZXZvY2F0aW9uUmVmLFxuICAgIHJlZmVyZW5jZS5mYW1pbHksXG4gICk7XG4gIGlmIChyZXZvY2F0aW9uLmdlbmVyYXRpb24gIT09IGRlbGl2ZXJ5LmdlbmVyYXRpb24pIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIGRlbGl2ZXJ5LnJldm9jYXRpb25SZWYsXG4gICAgICBgcmV2b2NhdGlvbiByZWZlcmVuY2UgbmFtZXMgZ2VuZXJhdGlvbiAke3Jldm9jYXRpb24uZ2VuZXJhdGlvbn0gYnV0IHRoZSBkZWxpdmVyeSBpcyBgICtcbiAgICAgICAgYGdlbmVyYXRpb24gJHtkZWxpdmVyeS5nZW5lcmF0aW9ufTsgYSByb3RhdGlvbiBtdXN0IHJldm9rZSB0aGUgZ2VuZXJhdGlvbiBpdCByZXBsYWNlc2AsXG4gICAgKTtcbiAgfVxuICBpZiAocmV2b2NhdGlvbi5zZWdtZW50cy5qb2luKCcvJykgIT09IHJlZmVyZW5jZS5zZWdtZW50cy5qb2luKCcvJykpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VFcnJvcihcbiAgICAgIGRlbGl2ZXJ5LnJldm9jYXRpb25SZWYsXG4gICAgICBgcmV2b2NhdGlvbiByZWZlcmVuY2UgZG9lcyBub3QgaWRlbnRpZnkgdGhlIHNhbWUgc3ViamVjdCBhcyAnJHtjcmVkZW50aWFsUmVmLnJlZn0nYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWVzdGVkQXRNcyA9IERhdGUucGFyc2UocmVxdWVzdGVkQXQpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShyZXF1ZXN0ZWRBdE1zKSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgU3RyaW5nKHJlcXVlc3RlZEF0KSxcbiAgICAgICdyZXF1ZXN0ZWRBdCBtdXN0IGJlIGFuIElTTyB0aW1lc3RhbXAnLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBuZWVkc0V4cGlyeSA9IHNwZWMucmVxdWlyZXNFeHBpcnkgfHwgZGVsaXZlcnkua2luZCA9PT0gJ3Nob3J0LWxpdmVkLWRlbGVnYXRpb24nO1xuICBpZiAobmVlZHNFeHBpcnkpIHtcbiAgICBjb25zdCBleHBpcmVzQXRNcyA9IERhdGUucGFyc2UoZGVsaXZlcnkuZXhwaXJlc0F0ID8/ICcnKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShleHBpcmVzQXRNcykpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZUVycm9yKFxuICAgICAgICBjcmVkZW50aWFsUmVmLnJlZixcbiAgICAgICAgYCR7cmVmZXJlbmNlLmZhbWlseX0gcmVxdWlyZXMgY3JlZGVudGlhbERlbGl2ZXJ5LmV4cGlyZXNBdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoZXhwaXJlc0F0TXMgPD0gcmVxdWVzdGVkQXRNcykge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRXJyb3IoXG4gICAgICAgIGNyZWRlbnRpYWxSZWYucmVmLFxuICAgICAgICBgJHtyZWZlcmVuY2UuZmFtaWx5fSBleHBpcmVzQXQgbXVzdCBiZSBhZnRlciByZXF1ZXN0ZWRBdGAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbmFtZXNwYWNlVmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9OQU1FU1BBQ0VfVkVSU0lPTixcbiAgICBmYW1pbHk6IHJlZmVyZW5jZS5mYW1pbHksXG4gICAgY2hhbm5lbCxcbiAgICByZWZlcmVuY2UsXG4gICAgcmV2b2NhdGlvbixcbiAgICBkZWxpdmVyeUtpbmQ6IGRlbGl2ZXJ5LmtpbmQsXG4gICAgZ2VuZXJhdGlvbjogZGVsaXZlcnkuZ2VuZXJhdGlvbixcbiAgICBhdWRpZW5jZTogZGVsaXZlcnkuYXVkaWVuY2UsXG4gICAgLi4uKGRlbGl2ZXJ5LmV4cGlyZXNBdCA/IHsgZXhwaXJlc0F0OiBkZWxpdmVyeS5leHBpcmVzQXQgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBLZXlzIGEgbWF0ZXJpYWxpemVyIG11c3QgbmV2ZXIgcmV0dXJuLiBgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbmAgYWxyZWFkeSByZWplY3RzXG4gKiB0aGUgY2xhc3NpYyBzZWNyZXQtc2hhcGVkIG5hbWVzOyB0aGlzIGFkZHMgdGhlIHdvcmRzIGEgY3JlZGVudGlhbCBtYXRlcmlhbGl6ZXIgc3BlY2lmaWNhbGx5XG4gKiBpcyB0ZW1wdGVkIHRvIHVzZSBmb3IgdGhlIHRoaW5nIGl0IGp1c3QgcmVzb2x2ZWQsIHdoaWNoIHRoYXQgcmVnZXggZG9lcyBub3QgY292ZXIuXG4gKi9cbmNvbnN0IEZPUkJJRERFTl9FVklERU5DRV9LRVlTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgJ21hdGVyaWFsJyxcbiAgJ2F1dGhvcml6YXRpb24nLFxuICAnY3JlZGVudGlhbCcsXG4gICdjcmVkZW50aWFscycsXG4gICdiZWFyZXInLFxuICAnYXNzZXJ0aW9uJyxcbiAgJ2Nvb2tpZScsXG4gICdqd3QnLFxuICAncmVmcmVzaCcsXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Tm9SZXNvbHZlZEF1dGhvcml6YXRpb25NYXRlcmlhbCh2YWx1ZTogdW5rbm93biwgcGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24odmFsdWUsIHBhdGgpO1xuICBjb25zdCB2aXNpdCA9IChjYW5kaWRhdGU6IHVua25vd24sIGN1cnJlbnRQYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAoY2FuZGlkYXRlID09PSBudWxsIHx8IHR5cGVvZiBjYW5kaWRhdGUgIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoY2FuZGlkYXRlKSkge1xuICAgICAgY2FuZGlkYXRlLmZvckVhY2goKGVudHJ5LCBpbmRleCkgPT4gdmlzaXQoZW50cnksIGAke2N1cnJlbnRQYXRofVske2luZGV4fV1gKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKGNhbmRpZGF0ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBrZXkucmVwbGFjZSgvKFthLXpcXGRdKShbQS1aXSkvZywgJyQxXyQyJykudG9Mb3dlckNhc2UoKTtcbiAgICAgIGlmIChGT1JCSURERU5fRVZJREVOQ0VfS0VZUy5zb21lKChmb3JiaWRkZW4pID0+IG5vcm1hbGl6ZWQuc3BsaXQoL1tfLV0vKS5pbmNsdWRlcyhmb3JiaWRkZW4pKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFJlc29sdmVkIGF1dGhvcml6YXRpb24gbWF0ZXJpYWwgaXMgZm9yYmlkZGVuIGluIGNyZWRlbnRpYWwgZXZpZGVuY2UgYXQgYCArXG4gICAgICAgICAgICBgJHtjdXJyZW50UGF0aH0uJHtrZXl9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHZpc2l0KGVudHJ5LCBgJHtjdXJyZW50UGF0aH0uJHtrZXl9YCk7XG4gICAgfVxuICB9O1xuICB2aXNpdCh2YWx1ZSwgcGF0aCk7XG59XG5cbi8qKlxuICogVGhlIGhvc3Qtb3duZWQgc2lkZSBvZiBhIGNyZWRlbnRpYWwgZmFtaWx5LlxuICpcbiAqIFRoaXMgaXMgd2hlcmUgYXV0aG9yaXphdGlvbiBtYXRlcmlhbCBhY3R1YWxseSBleGlzdHMuIEV2ZXJ5IG1ldGhvZCByZXR1cm5zIG9ubHkgUFVCTElDXG4gKiBldmlkZW5jZTsgdGhlIHJlc29sdmVkIG1hdGVyaWFsIG5ldmVyIGNyb3NzZXMgdGhpcyBib3VuZGFyeSwgYW5kIHRoZSByZXNvbHZlciBhc3NlcnRzIHRoYXQgb25cbiAqIHRoZSB3YXkgb3V0IHJhdGhlciB0aGFuIHRydXN0aW5nIGVhY2ggaW1wbGVtZW50YXRpb24gdG8gaGF2ZSByZW1lbWJlcmVkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxpemVyIHtcbiAgcmVhZG9ubHkgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseTtcbiAgYmluZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pj47XG4gIHZlcmlmeUJvdW5kKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICk6IFByb21pc2U8UmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+PjtcbiAgcmV2b2tlKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICk6IFByb21pc2U8UmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+PjtcbiAgdmVyaWZ5UmV2b2tlZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pj47XG59XG5cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsT3BlcmF0aW9uID1cbiAgfCAnYmluZCdcbiAgfCAndmVyaWZ5LWJvdW5kJ1xuICB8ICdyZXZva2UnXG4gIHwgJ3ZlcmlmeS1yZXZva2VkJztcblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEV2aWRlbmNlIHtcbiAgcmVhZG9ubHkgbmFtZXNwYWNlVmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT047XG4gIHJlYWRvbmx5IGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgcmVhZG9ubHkgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseTtcbiAgcmVhZG9ubHkgb3BlcmF0aW9uOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE9wZXJhdGlvbjtcbiAgcmVhZG9ubHkgZGVsaXZlcnlLaW5kOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5S2luZDtcbiAgcmVhZG9ubHkgZ2VuZXJhdGlvbjogbnVtYmVyO1xuICByZWFkb25seSBhdWRpZW5jZTogc3RyaW5nO1xuICByZWFkb25seSByZXZvY2F0aW9uUmVmOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBTdGFibGUsIG5vbi1yZXZlcnNpYmxlIGRpc2NyaW1pbmF0b3IgZm9yIHRoZSByZWZlcmVuY2UuIFR3byBydW5zIG9mIHRoZSBzYW1lIGJpbmRpbmcgcHJvZHVjZVxuICAgKiB0aGUgc2FtZSBkaWdlc3QgYW5kIGEgcm90YXRpb24gcHJvZHVjZXMgYSBkaWZmZXJlbnQgb25lLCBzbyBldmlkZW5jZSBjYW4gcHJvdmUgXCJ0aGUgYmluZGluZ1xuICAgKiBjaGFuZ2VkXCIgd2l0aG91dCByZXB1Ymxpc2hpbmcgdGhlIHJlZmVyZW5jZSBpbnRvIGV2ZXJ5IHJlY2VpcHQuXG4gICAqL1xuICByZWFkb25seSByZWZlcmVuY2VEaWdlc3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgZGV0YWlsOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59XG5cbmV4cG9ydCBjbGFzcyBVbmtub3duV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseTtcblxuICBjb25zdHJ1Y3RvcihmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5KSB7XG4gICAgc3VwZXIoXG4gICAgICBgTm8gaG9zdCBtYXRlcmlhbGl6ZXIgaXMgcmVnaXN0ZXJlZCBmb3IgY3JlZGVudGlhbCBmYW1pbHkgJyR7ZmFtaWx5fScuIGAgK1xuICAgICAgICBgQSBob3N0IHRoYXQgY2Fubm90IHJlc29sdmUgYSBmYW1pbHkgbXVzdCByZWZ1c2UgdGhlIGJpbmRpbmcsIG5vdCBwcm9jZWVkIHVuYm91bmQuYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9ICdVbmtub3duV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlFcnJvcic7XG4gICAgdGhpcy5mYW1pbHkgPSBmYW1pbHk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlRGlnZXN0KHJlZmVyZW5jZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShyZWZlcmVuY2UpLmRpZ2VzdCgnaGV4Jykuc2xpY2UoMCwgMzIpO1xufVxuXG4vKipcbiAqIFRoZSB0eXBlZCBob3N0LW93bmVkIGNyZWRlbnRpYWwgcmVzb2x2ZXIuXG4gKlxuICogSXQgb3ducyB2YWxpZGF0aW9uIGFuZCBldmlkZW5jZSBkaXNjaXBsaW5lOyB0aGUgcGVyLWZhbWlseSBtYXRlcmlhbGl6ZXJzIG93biB0aGUgYWN0dWFsXG4gKiBiaW5kaW5nLiBTcGxpdHRpbmcgaXQgdGhpcyB3YXkgaXMgd2hhdCBsZXRzIHRoZSByb3RhdGlvbiwgcmV2b2NhdGlvbiBhbmQgcmVjb25uZWN0IHRlc3RzIHJ1blxuICogYWdhaW5zdCByZWFsIHJlc29sdmVyIGxvZ2ljIHdpdGggYSBmYWtlIG1hdGVyaWFsaXplciwgaW5zdGVhZCBvZiB0aGUgdGVzdHMgb25seSBldmVyIGV4ZXJjaXNpbmdcbiAqIGEgbW9jayBvZiB0aGUgd2hvbGUgcmVzb2x2ZXIg4oCUIHdoaWNoIHdvdWxkIHByb3ZlIG5vdGhpbmcgYWJvdXQgdGhlIHJ1bGVzIGFib3ZlLlxuICovXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXNvbHZlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF0ZXJpYWxpemVyczogTWFwPFxuICAgIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxuICAgIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxpemVyXG4gID47XG5cbiAgY29uc3RydWN0b3IobWF0ZXJpYWxpemVyczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbGl6ZXJbXSkge1xuICAgIHRoaXMubWF0ZXJpYWxpemVycyA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IG1hdGVyaWFsaXplciBvZiBtYXRlcmlhbGl6ZXJzKSB7XG4gICAgICBpZiAodGhpcy5tYXRlcmlhbGl6ZXJzLmhhcyhtYXRlcmlhbGl6ZXIuZmFtaWx5KSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYER1cGxpY2F0ZSBob3N0IG1hdGVyaWFsaXplciByZWdpc3RlcmVkIGZvciBjcmVkZW50aWFsIGZhbWlseSAnJHttYXRlcmlhbGl6ZXIuZmFtaWx5fSdgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5tYXRlcmlhbGl6ZXJzLnNldChtYXRlcmlhbGl6ZXIuZmFtaWx5LCBtYXRlcmlhbGl6ZXIpO1xuICAgIH1cbiAgfVxuXG4gIGdldCBmYW1pbGllcygpOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseVtdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMubWF0ZXJpYWxpemVycy5rZXlzKCldO1xuICB9XG5cbiAgZGVzY3JpYmUoXG4gICAgaW5wdXQ6IERlc2NyaWJlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nSW5wdXQsXG4gICk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3Ige1xuICAgIHJldHVybiBkZXNjcmliZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZyhpbnB1dCk7XG4gIH1cblxuICBhc3luYyBydW4oXG4gICAgb3BlcmF0aW9uOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE9wZXJhdGlvbixcbiAgICBpbnB1dDogRGVzY3JpYmVXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdJbnB1dCxcbiAgKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEV2aWRlbmNlPiB7XG4gICAgY29uc3QgYmluZGluZyA9IHRoaXMuZGVzY3JpYmUoaW5wdXQpO1xuICAgIGNvbnN0IG1hdGVyaWFsaXplciA9IHRoaXMubWF0ZXJpYWxpemVycy5nZXQoYmluZGluZy5mYW1pbHkpO1xuICAgIGlmICghbWF0ZXJpYWxpemVyKSB0aHJvdyBuZXcgVW5rbm93bldvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5RXJyb3IoYmluZGluZy5mYW1pbHkpO1xuXG4gICAgY29uc3QgZGV0YWlsID1cbiAgICAgIG9wZXJhdGlvbiA9PT0gJ2JpbmQnXG4gICAgICAgID8gYXdhaXQgbWF0ZXJpYWxpemVyLmJpbmQoYmluZGluZylcbiAgICAgICAgOiBvcGVyYXRpb24gPT09ICd2ZXJpZnktYm91bmQnXG4gICAgICAgICAgPyBhd2FpdCBtYXRlcmlhbGl6ZXIudmVyaWZ5Qm91bmQoYmluZGluZylcbiAgICAgICAgICA6IG9wZXJhdGlvbiA9PT0gJ3Jldm9rZSdcbiAgICAgICAgICAgID8gYXdhaXQgbWF0ZXJpYWxpemVyLnJldm9rZShiaW5kaW5nKVxuICAgICAgICAgICAgOiBhd2FpdCBtYXRlcmlhbGl6ZXIudmVyaWZ5UmV2b2tlZChiaW5kaW5nKTtcblxuICAgIGFzc2VydE5vUmVzb2x2ZWRBdXRob3JpemF0aW9uTWF0ZXJpYWwoXG4gICAgICBkZXRhaWwgPz8ge30sXG4gICAgICBgd29ya3NwYWNlSG9zdC5jcmVkZW50aWFsLiR7YmluZGluZy5jaGFubmVsfS4ke29wZXJhdGlvbn1gLFxuICAgICk7XG5cbiAgICBjb25zdCBldmlkZW5jZTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxFdmlkZW5jZSA9IHtcbiAgICAgIG5hbWVzcGFjZVZlcnNpb246IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTkFNRVNQQUNFX1ZFUlNJT04sXG4gICAgICBjaGFubmVsOiBiaW5kaW5nLmNoYW5uZWwsXG4gICAgICBmYW1pbHk6IGJpbmRpbmcuZmFtaWx5LFxuICAgICAgb3BlcmF0aW9uLFxuICAgICAgZGVsaXZlcnlLaW5kOiBiaW5kaW5nLmRlbGl2ZXJ5S2luZCxcbiAgICAgIGdlbmVyYXRpb246IGJpbmRpbmcuZ2VuZXJhdGlvbixcbiAgICAgIGF1ZGllbmNlOiBiaW5kaW5nLmF1ZGllbmNlLFxuICAgICAgcmV2b2NhdGlvblJlZjogaW5wdXQuZGVsaXZlcnkucmV2b2NhdGlvblJlZixcbiAgICAgIHJlZmVyZW5jZURpZ2VzdDogd29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2VEaWdlc3QoaW5wdXQuY3JlZGVudGlhbFJlZi5yZWYpLFxuICAgICAgZGV0YWlsOiBkZXRhaWwgPz8ge30sXG4gICAgfTtcbiAgICBhc3NlcnROb1Jlc29sdmVkQXV0aG9yaXphdGlvbk1hdGVyaWFsKFxuICAgICAgZXZpZGVuY2UsXG4gICAgICBgd29ya3NwYWNlSG9zdC5jcmVkZW50aWFsLiR7YmluZGluZy5jaGFubmVsfS5ldmlkZW5jZWAsXG4gICAgKTtcbiAgICByZXR1cm4gZXZpZGVuY2U7XG4gIH1cblxuICAvKiogRXhlY3V0ZSBvbmUgc3RlcCBvZiBhbiBhbHJlYWR5LXBsYW5uZWQgY3JlZGVudGlhbCBsaWZlY3ljbGUuICovXG4gIGFzeW5jIGV4ZWN1dGVMaWZlY3ljbGVTdGVwKFxuICAgIHN0ZXA6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlU3RlcCxcbiAgICByZXF1ZXN0ZWRBdDogc3RyaW5nLFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRXZpZGVuY2U+IHtcbiAgICByZXR1cm4gdGhpcy5ydW4oc3RlcC5raW5kLCB7XG4gICAgICBjaGFubmVsOiBzdGVwLmNoYW5uZWwsXG4gICAgICBjcmVkZW50aWFsUmVmOiBzdGVwLmNyZWRlbnRpYWxSZWYsXG4gICAgICBkZWxpdmVyeTogc3RlcC5kZWxpdmVyeSxcbiAgICAgIHJlcXVlc3RlZEF0LFxuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxMaWZlY3ljbGVSZWNlaXB0IHtcbiAgcmVhZG9ubHkgc3RlcElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGV2aWRlbmNlOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEV2aWRlbmNlO1xufVxuXG4vKipcbiAqIEV4ZWN1dGUgYSBsaWZlY3ljbGUgcGxhbiBwcm9kdWNlZCBieSBgcGxhbldvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlYC5cbiAqXG4gKiBEZXBlbmRlbmN5IGVkZ2VzIGFyZSBFTkZPUkNFRCByYXRoZXIgdGhhbiBhc3N1bWVkIGZyb20gYXJyYXkgb3JkZXI6IHRoZSB3aG9sZSBwb2ludCBvZiBhXG4gKiByb3RhdGUgcGxhbiBpcyB0aGF0IHRoZSBuZXcgYmluZGluZyBpcyBwcm92ZW4gYm91bmQgYmVmb3JlIHRoZSBvbGQgb25lIGlzIHJldm9rZWQsIGFuZCBhXG4gKiBydW5uZXIgdGhhdCBtZXJlbHkgaXRlcmF0ZWQgdGhlIGFycmF5IHdvdWxkIHN0aWxsIFwicGFzc1wiIGlmIHRoZSBwbGFubmVyIGV2ZXIgZW1pdHRlZCB0aGVtIHRoZVxuICogb3RoZXIgd2F5IHJvdW5kLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlKFxuICBwbGFuOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVBsYW4sXG4gIHJlc29sdmVyOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlc29sdmVyLFxuKTogUHJvbWlzZTxyZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVJlY2VpcHRbXT4ge1xuICBjb25zdCBjb21wbGV0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgcmVjZWlwdHM6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTGlmZWN5Y2xlUmVjZWlwdFtdID0gW107XG4gIGZvciAoY29uc3Qgc3RlcCBvZiBwbGFuLnN0ZXBzKSB7XG4gICAgZm9yIChjb25zdCBkZXBlbmRlbmN5IG9mIHN0ZXAuZGVwZW5kc09uKSB7XG4gICAgICBpZiAoIWNvbXBsZXRlZC5oYXMoZGVwZW5kZW5jeSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBDcmVkZW50aWFsIGxpZmVjeWNsZSBzdGVwICcke3N0ZXAuaWR9JyBkZXBlbmRzIG9uICcke2RlcGVuZGVuY3l9Jywgd2hpY2ggaGFzIG5vdCBjb21wbGV0ZWRgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBldmlkZW5jZSA9IGF3YWl0IHJlc29sdmVyLmV4ZWN1dGVMaWZlY3ljbGVTdGVwKHN0ZXAsIHBsYW4ucmVxdWVzdGVkQXQpO1xuICAgIHJlY2VpcHRzLnB1c2goeyBzdGVwSWQ6IHN0ZXAuaWQsIGV2aWRlbmNlIH0pO1xuICAgIGNvbXBsZXRlZC5hZGQoc3RlcC5pZCk7XG4gIH1cbiAgcmV0dXJuIHJlY2VpcHRzO1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LWNyZWRlbnRpYWwtbmFtZXNwYWNlLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZS50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtY3JlZGVudGlhbC1uYW1lc3BhY2UudHMiLFtdXQ==
}}