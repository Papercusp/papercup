'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS", () => { try { return WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS", () => { try { return WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS } catch {} });
__vite_ssr_exportName__("WorkspaceHostContractAssertionError", () => { try { return WorkspaceHostContractAssertionError } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostSecretIsolation", () => { try { return assertWorkspaceHostSecretIsolation } catch {} });
__vite_ssr_exportName__("runFakeWorkspaceHostProviderContractSuite", () => { try { return runFakeWorkspaceHostProviderContractSuite } catch {} });
__vite_ssr_exportName__("WorkspaceHostInjectedFault", () => { try { return WorkspaceHostInjectedFault } catch {} });
__vite_ssr_exportName__("DeterministicWorkspaceHostFaultInjector", () => { try { return DeterministicWorkspaceHostFaultInjector } catch {} });
__vite_ssr_exportName__("createWorkspaceHostSpendObservation", () => { try { return createWorkspaceHostSpendObservation } catch {} });
__vite_ssr_exportName__("appendWorkspaceHostSpendObservation", () => { try { return appendWorkspaceHostSpendObservation } catch {} });
__vite_ssr_exportName__("evaluateWorkspaceHostSpendFinality", () => { try { return evaluateWorkspaceHostSpendFinality } catch {} });
__vite_ssr_exportName__("createWorkspaceHostManualDestroyReceipt", () => { try { return createWorkspaceHostManualDestroyReceipt } catch {} });
__vite_ssr_exportName__("WorkspaceHostLiveCanaryHarness", () => { try { return WorkspaceHostLiveCanaryHarness } catch {} });
__vite_ssr_exportName__("fakeWorkspaceHostCapabilities", () => { try { return fakeWorkspaceHostCapabilities } catch {} });
__vite_ssr_exportName__("makeFakeWorkspaceHostProvider", () => { try { return makeFakeWorkspaceHostProvider } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-canary-identity.ts", {"importedNames":["WORKSPACE_HOST_CANARY_TAG_KEYS","workspaceHostCanaryIdentityLabels"]});

const WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION = "workspace-host-provider-contract-v1";
const WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS = 2500;
const WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS = [
  "target-and-secret-isolation",
  "connection-validation",
  "catalog-discovery",
  "price-estimate",
  "deterministic-plan",
  "idempotent-apply-reconcile",
  "observation-health-transport",
  "confirmed-destroy"
];
class WorkspaceHostContractAssertionError extends Error {
  constructor(check, message) {
    super(`Workspace-host provider contract '${check}' failed: ${message}`);
    this.check = check;
    this.name = "WorkspaceHostContractAssertionError";
  }
};
const SECRET_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?key|secret|token|password|passphrase|private[_-]?key)(?:$|[_-])/i;
const SECRET_VALUE = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
const SECRET_POLICY_SEGMENT = /(^|[_-])secret(?=[_-](?:scan|scanning|finding|findings|policy)(?:$|[_-]))/gi;
function isSecretShapedKey(key) {
  const normalized = key.replace(/([a-z\d])([A-Z])/g, "$1_$2");
  return SECRET_KEY.test(normalized.replace(SECRET_POLICY_SEGMENT, "$1policy_subject"));
}
function assertWorkspaceHostSecretIsolation(value, path = "metadata") {
  const visit = (candidate, currentPath) => {
    if (typeof candidate === "string") {
      if (SECRET_VALUE.test(candidate)) {
        throw new Error(
          `Secret material is forbidden in workspace-host public metadata at ${currentPath}`
        );
      };
      return;
    };
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach(
        (entry, index) => visit(entry, `${currentPath}[${index}]`)
      );
      return;
    };
    for (const [key, entry] of Object.entries(
      candidate
    )) {
      if (isSecretShapedKey(key)) {
        throw new Error(
          `Secret-shaped field '${currentPath}.${key}' is forbidden in workspace-host public metadata`
        );
      };
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
};
function requireContract(checks, check, condition, message) {
  if (!condition) throw new WorkspaceHostContractAssertionError(check, message);
  if (!checks.includes(check)) checks.push(check);
}
function requireNonEmpty(value, label) {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}
function requireTimestamp(value, label) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis))
    throw new Error(`${label} must be an ISO timestamp`);
  return millis;
}
function requireCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative safe integer number of cents`
    );
  }
}
function requireFailedRunTeardown(teardown) {
  requireNonEmpty(teardown.actorId, "failedRunTeardown.actorId");
  requireNonEmpty(teardown.reason, "failedRunTeardown.reason");
  requireNonEmpty(teardown.procedureRef, "failedRunTeardown.procedureRef");
  if (teardown.failedOperationIds.length === 0) {
    throw new Error(
      "Failed-run teardown must name at least one failed operation it cleans up after"
    );
  };
  for (const [index, operationId] of teardown.failedOperationIds.entries()) {
    requireNonEmpty(
      operationId,
      `failedRunTeardown.failedOperationIds[${index}]`
    );
  }
}
function requireSpendSettlement(settlement) {
  requireNonEmpty(settlement.actorId, "spendSettlement.actorId");
  requireNonEmpty(settlement.reason, "spendSettlement.reason");
  requireNonEmpty(settlement.procedureRef, "spendSettlement.procedureRef");
  requireTimestamp(settlement.reconcileAfter, "spendSettlement.reconcileAfter");
}
function validatePlanShape(checks, plan, request, target) {
  requireContract(
    checks,
    "deterministic-plan",
    plan.target === target,
    "plan target does not match provider target"
  );
  requireContract(
    checks,
    "deterministic-plan",
    plan.operationId === request.operationId,
    "plan changed operationId"
  );
  requireContract(
    checks,
    "deterministic-plan",
    plan.steps.length > 0,
    "plan must contain at least one resource step"
  );
  const seen = /* @__PURE__ */ new Set();
  const idempotencyKeys = /* @__PURE__ */ new Set();
  for (const step of plan.steps) {
    requireContract(
      checks,
      "deterministic-plan",
      !!step.id.trim(),
      "step id must not be empty"
    );
    requireContract(
      checks,
      "deterministic-plan",
      !seen.has(step.id),
      `duplicate step id '${step.id}'`
    );
    requireContract(
      checks,
      "deterministic-plan",
      !!step.idempotencyKey.trim() && !idempotencyKeys.has(step.idempotencyKey),
      `step '${step.id}' needs a unique provider idempotency key`
    );
    for (const dependency of step.dependsOn) {
      requireContract(
        checks,
        "deterministic-plan",
        seen.has(dependency),
        `step '${step.id}' dependency '${dependency}' must be declared earlier`
      );
    };
    seen.add(step.id);
    idempotencyKeys.add(step.idempotencyKey);
  }
}
async function runFakeWorkspaceHostProviderContractSuite(provider, fixture) {
  if (fixture.adapterKind !== "fake")
    throw new Error(
      "The fake provider contract suite refuses non-fake adapters"
    );
  requireNonEmpty(fixture.reportRef, "reportRef");
  requireNonEmpty(fixture.operationId, "operationId");
  requireNonEmpty(fixture.idempotencyKey, "idempotencyKey");
  const now = fixture.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const checks = [];
  assertWorkspaceHostSecretIsolation(
    fixture.context.connection.provider,
    "context.connection.provider"
  );
  assertWorkspaceHostSecretIsolation(
    fixture.desired.provider,
    "desired.provider"
  );
  assertWorkspaceHostSecretIsolation(fixture.desired.labels, "desired.labels");
  requireContract(
    checks,
    "target-and-secret-isolation",
    provider.target === fixture.desired.target,
    "desired target mismatch"
  );
  requireContract(
    checks,
    "target-and-secret-isolation",
    fixture.context.connection.target === provider.target,
    "connection target mismatch"
  );
  requireContract(
    checks,
    "target-and-secret-isolation",
    fixture.context.connection.cloudCredentialRef.kind === "cloud" && !!fixture.context.connection.cloudCredentialRef.ref.trim(),
    "cloud authorization must be a non-empty typed reference"
  );
  const validation = await provider.validateConnection(fixture.context);
  requireContract(
    checks,
    "connection-validation",
    validation.ok,
    validation.errors.join("; ") || "connection rejected"
  );
  requireContract(
    checks,
    "connection-validation",
    validation.errors.length === 0,
    "successful validation returned errors"
  );
  const query = {
    scope: fixture.desired.scope,
    region: fixture.desired.region
  };
  const [scopes, regions, sizes, images, price] = await Promise.all([
    provider.listScopes(fixture.context),
    provider.listRegions(query, fixture.context),
    provider.listSizes(query, fixture.context),
    provider.listImages(query, fixture.context),
    provider.estimatePrice(fixture.desired, fixture.context)
  ]);
  requireContract(
    checks,
    "catalog-discovery",
    scopes.some(
      (scope) => scope.kind === fixture.desired.scope.kind && scope.id === fixture.desired.scope.id
    ),
    "desired scope is absent from discovery"
  );
  requireContract(
    checks,
    "catalog-discovery",
    regions.some((region) => region.id === fixture.desired.region),
    "desired region is absent"
  );
  requireContract(
    checks,
    "catalog-discovery",
    sizes.some((size) => size.id === fixture.desired.size),
    "desired size is absent"
  );
  requireContract(
    checks,
    "catalog-discovery",
    images.some((image) => image.id === fixture.desired.image.id),
    "desired image is absent"
  );
  requireContract(
    checks,
    "price-estimate",
    Number.isFinite(price.hourlyAmount) && price.hourlyAmount >= 0 && !!price.currency.trim(),
    "price estimate must use a currency and a non-negative finite hourly amount"
  );
  const provisionRequest = {
    action: "provision",
    operationId: fixture.operationId,
    idempotencyKey: fixture.idempotencyKey,
    desired: fixture.desired
  };
  const [firstPlan, replayedPlan] = await Promise.all([
    provider.plan(provisionRequest, fixture.context),
    provider.plan(provisionRequest, fixture.context)
  ]);
  validatePlanShape(checks, firstPlan, provisionRequest, provider.target);
  validatePlanShape(checks, replayedPlan, provisionRequest, provider.target);
  requireContract(
    checks,
    "deterministic-plan",
    JSON.stringify(firstPlan.steps) === JSON.stringify(replayedPlan.steps),
    "replaying the same operation produced different resource steps"
  );
  const knownResources = [];
  const applyResults = [];
  for (const step of firstPlan.steps) {
    const result = await provider.apply(
      {
        planId: firstPlan.planId,
        operationId: firstPlan.operationId,
        step,
        knownResources: [...knownResources]
      },
      fixture.context
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.operationId === firstPlan.operationId,
      "apply changed operationId"
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.stepId === step.id,
      "apply changed stepId"
    );
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      result.state !== "in-progress",
      "fake apply did not settle deterministically"
    );
    if ("resource" in result && result.resource) {
      if (!knownResources.some(
        (resource) => resource.providerId === result.resource.providerId
      )) {
        knownResources.push(result.resource);
      }
    };
    applyResults.push(result);
  };
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    knownResources.length > 0,
    "provisioning produced no resource identities"
  );
  const firstApplied = applyResults.find(
    (result) => "resource" in result && result.resource
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    firstApplied && "resource" in firstApplied,
    "no applied resource to reconcile"
  );
  const firstStep = firstPlan.steps.find(
    (step) => step.id === firstApplied.stepId
  );
  const reconciled = await provider.reconcile(
    {
      planId: firstPlan.planId,
      operationId: firstPlan.operationId,
      step: firstStep,
      knownResources,
      reason: "resume",
      previousProviderRequestId: firstApplied.providerRequestId
    },
    fixture.context
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    reconciled.operationId === firstApplied.operationId,
    "reconcile changed operationId"
  );
  requireContract(
    checks,
    "idempotent-apply-reconcile",
    reconciled.stepId === firstApplied.stepId,
    "reconcile changed stepId"
  );
  if ("resource" in firstApplied && firstApplied.resource && "resource" in reconciled && reconciled.resource) {
    requireContract(
      checks,
      "idempotent-apply-reconcile",
      reconciled.resource.providerId === firstApplied.resource.providerId,
      "reconcile returned a different provider resource identity"
    );
  };
  const host = {
    hostId: fixture.desired.hostId,
    target: provider.target,
    resources: knownResources
  };
  const [observation, transport, health] = await Promise.all([
    provider.observe(host, fixture.context),
    provider.getTransportProfile(host, fixture.context),
    provider.attestHealth(host, fixture.context)
  ]);
  requireContract(
    checks,
    "observation-health-transport",
    observation.host.hostId === host.hostId,
    "observation changed host identity"
  );
  requireContract(
    checks,
    "observation-health-transport",
    health.hostId === host.hostId,
    "health attestation changed host identity"
  );
  requireContract(
    checks,
    "observation-health-transport",
    !!transport.kind.trim(),
    "transport profile needs a kind"
  );
  requireContract(
    checks,
    "observation-health-transport",
    Object.values(transport.features).some(Boolean),
    "transport profile declares no supported feature"
  );
  const destroyRequest = {
    action: "destroy",
    operationId: `${fixture.operationId}:destroy`,
    idempotencyKey: `${fixture.idempotencyKey}:destroy`,
    host,
    disposition: "discard",
    confirmation: {
      expectedHostId: host.hostId,
      confirmedBy: fixture.confirmedBy,
      confirmedAt: now()
    }
  };
  const destroyPlan = await provider.plan(destroyRequest, fixture.context);
  validatePlanShape(checks, destroyPlan, destroyRequest, provider.target);
  requireContract(
    checks,
    "confirmed-destroy",
    destroyPlan.steps.some((step) => step.destructive),
    "destroy plan has no destructive step"
  );
  const destroyConfirmations = [];
  for (const step of destroyPlan.steps) {
    const result = await provider.apply(
      {
        planId: destroyPlan.planId,
        operationId: destroyPlan.operationId,
        step,
        knownResources
      },
      fixture.context
    );
    if (!step.destructive) continue;
    requireContract(
      checks,
      "confirmed-destroy",
      result.state === "destroyed",
      `destructive step '${step.id}' lacks absence proof`
    );
    if (result.state === "destroyed") {
      requireContract(
        checks,
        "confirmed-destroy",
        result.confirmation.source === "provider-read",
        "destroy proof is not a fresh provider read"
      );
      requireContract(
        checks,
        "confirmed-destroy",
        knownResources.some(
          (resource) => resource.providerId === result.confirmation.providerResourceId
        ),
        `destroy proof references unknown resource '${result.confirmation.providerResourceId}'`
      );
      destroyConfirmations.push(result.confirmation);
    }
  };
  requireContract(
    checks,
    "confirmed-destroy",
    destroyConfirmations.length > 0,
    "destroy returned no absence confirmations"
  );
  return {
    suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
    reportRef: fixture.reportRef,
    target: provider.target,
    completedAt: now(),
    passed: true,
    checks: WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS.filter(
      (check) => checks.includes(check)
    ),
    provisionedResources: knownResources,
    destroyConfirmations
  };
};
class WorkspaceHostInjectedFault extends Error {
  constructor(fault) {
    super(fault.message);
    this.fault = fault;
    this.name = "WorkspaceHostInjectedFault";
  }
};
class DeterministicWorkspaceHostFaultInjector {
  constructor(script) {
    this.script = script;
    script.forEach((fault, index) => {
      requireNonEmpty(fault.point, `fault[${index}].point`);
      if (!Number.isSafeInteger(fault.occurrence) || fault.occurrence < 1) {
        throw new Error(
          `fault[${index}].occurrence must be a positive safe integer`
        );
      }
    });
  }
  counts = /* @__PURE__ */ new Map();
  triggered = /* @__PURE__ */ new Set();
  entries = [];
  async invoke(point, operation) {
    const occurrence = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, occurrence);
    const index = this.script.findIndex(
      (fault, candidate) => !this.triggered.has(candidate) && fault.point === point && fault.occurrence === occurrence
    );
    const configured = index >= 0 ? this.script[index] : void 0;
    const timing = configured?.timing ?? "before";
    if (configured && timing === "before") {
      this.triggered.add(index);
      this.entries.push({ point, occurrence, timing, triggered: true });
      throw new WorkspaceHostInjectedFault({ ...configured, timing });
    };
    const result = await operation();
    if (configured) {
      this.triggered.add(index);
      this.entries.push({ point, occurrence, timing, triggered: true });
      throw new WorkspaceHostInjectedFault({ ...configured, timing });
    };
    this.entries.push({ point, occurrence, timing, triggered: false });
    return result;
  }
  history() {
    return this.entries.map((entry) => ({ ...entry }));
  }
  untriggeredFaults() {
    return this.script.filter((_, index) => !this.triggered.has(index));
  }
};
const MICROS_PER_CENT = 10000n;
const CANONICAL_INTEGER_MICROS = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;
function requireCanonicalMicros(value, label) {
  if (!CANONICAL_INTEGER_MICROS.test(value)) {
    throw new Error(
      `${label} must be a canonical integer-micros decimal string`
    );
  };
  return BigInt(value);
}
function createWorkspaceHostSpendObservation(input) {
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("spend observation currency must be an ISO-4217 code");
  };
  const grossMicros = requireCanonicalMicros(
    input.grossMicros,
    "spend observation grossMicros"
  );
  const creditMicros = requireCanonicalMicros(
    input.creditMicros,
    "spend observation creditMicros"
  );
  const netMicros = requireCanonicalMicros(
    input.netMicros,
    "spend observation netMicros"
  );
  if (grossMicros < 0n) {
    throw new Error("spend observation grossMicros must not be negative");
  };
  if (creditMicros > 0n) {
    throw new Error("spend observation creditMicros must not be positive");
  };
  if (grossMicros + creditMicros !== netMicros) {
    throw new Error(
      "spend observation netMicros must equal grossMicros + creditMicros"
    );
  };
  requireTimestamp(input.observedAt, "spend observation observedAt");
  requireNonEmpty(
    input.providerEvidenceRef,
    "spend observation providerEvidenceRef"
  );
  const budgetCents = (grossMicros + MICROS_PER_CENT - 1n) / MICROS_PER_CENT;
  if (budgetCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "spend observation grossMicros exceeds the safe integer-cents budget range"
    );
  };
  return {
    ...input,
    budgetCents: Number(budgetCents)
  };
};
function sameWorkspaceHostSpend(left, right) {
  return left.currency === right.currency && left.grossMicros === right.grossMicros && left.creditMicros === right.creditMicros && left.netMicros === right.netMicros && left.budgetCents === right.budgetCents;
}
function validateWorkspaceHostSpendHistory(history) {
  const validated = [];
  const evidenceRefs = /* @__PURE__ */ new Set();
  for (const entry of history) {
    const rebuilt = createWorkspaceHostSpendObservation(entry);
    if (rebuilt.budgetCents !== entry.budgetCents) {
      throw new Error(
        "spend observation budgetCents must equal upward-rounded grossMicros"
      );
    };
    const previous = validated.at(-1);
    if (previous) {
      if (entry.currency !== previous.currency) {
        throw new Error("spend observation history cannot mix currencies");
      };
      if (Date.parse(entry.observedAt) <= Date.parse(previous.observedAt)) {
        throw new Error(
          "spend observation history timestamps must increase strictly"
        );
      }
    };
    if (evidenceRefs.has(entry.providerEvidenceRef)) {
      throw new Error(
        "spend observation history contains a duplicate providerEvidenceRef"
      );
    };
    evidenceRefs.add(entry.providerEvidenceRef);
    validated.push({ ...entry });
  };
  return validated;
}
function appendWorkspaceHostSpendObservation(history, input) {
  const validated = validateWorkspaceHostSpendHistory(history);
  const observation = createWorkspaceHostSpendObservation(input);
  const existing = validated.find(
    (entry) => entry.providerEvidenceRef === observation.providerEvidenceRef
  );
  if (existing) {
    if (existing.observedAt === observation.observedAt && sameWorkspaceHostSpend(existing, observation)) {
      return validated;
    };
    throw new Error(
      "spend observation providerEvidenceRef conflicts with prior history"
    );
  };
  const previous = validated.at(-1);
  if (previous) {
    if (observation.currency !== previous.currency) {
      throw new Error("spend observation history cannot mix currencies");
    };
    if (Date.parse(observation.observedAt) <= Date.parse(previous.observedAt)) {
      throw new Error(
        "spend observation history timestamps must increase strictly"
      );
    }
  };
  return [...validated, observation];
};
function evaluateWorkspaceHostSpendFinality(history, requiredStableWindowMs) {
  if (!Number.isSafeInteger(requiredStableWindowMs) || requiredStableWindowMs <= 0) {
    throw new Error("requiredStableWindowMs must be a positive safe integer");
  };
  const validated = validateWorkspaceHostSpendHistory(history);
  if (validated.length === 0) {
    return {
      status: "pending",
      retryable: true,
      reason: "no-observations",
      observationCount: 0,
      stableObservationCount: 0,
      stableForMs: 0,
      requiredStableWindowMs
    };
  };
  const latest = validated[validated.length - 1];
  let stableStartIndex = validated.length - 1;
  while (stableStartIndex > 0 && sameWorkspaceHostSpend(validated[stableStartIndex - 1], latest)) {
    stableStartIndex -= 1;
  };
  const stableObservationCount = validated.length - stableStartIndex;
  const stableSince = validated[stableStartIndex].observedAt;
  const stableForMs = Date.parse(latest.observedAt) - Date.parse(stableSince);
  if (stableObservationCount < 2) {
    return {
      status: "pending",
      retryable: true,
      reason: validated.length === 1 ? "insufficient-observations" : "unstable",
      observationCount: validated.length,
      stableObservationCount,
      stableForMs,
      requiredStableWindowMs
    };
  };
  if (stableForMs < requiredStableWindowMs) {
    return {
      status: "pending",
      retryable: true,
      reason: "stability-window-open",
      observationCount: validated.length,
      stableObservationCount,
      stableForMs,
      requiredStableWindowMs
    };
  };
  return {
    status: "settled",
    retryable: false,
    observationCount: validated.length,
    stableObservationCount,
    stableSince,
    stableForMs,
    requiredStableWindowMs,
    observation: { ...latest }
  };
};
function sameResource(a, b) {
  return a.target === b.target && a.kind === b.kind && a.providerId === b.providerId;
}
function createWorkspaceHostManualDestroyReceipt(input) {
  requireNonEmpty(input.runId, "manual destroy runId");
  requireNonEmpty(input.actorId, "manual destroy actorId");
  requireNonEmpty(input.reason, "manual destroy reason");
  requireNonEmpty(input.procedureRef, "manual destroy procedureRef");
  requireTimestamp(input.issuedAt, "manual destroy issuedAt");
  if (input.confirmation.source !== "provider-read") {
    throw new Error(
      "Emergency manual destroy requires a fresh provider-read absence confirmation"
    );
  };
  if (input.confirmation.providerResourceId !== input.resource.providerId) {
    throw new Error(
      "Emergency manual destroy confirmation does not match the resource"
    );
  };
  assertWorkspaceHostSecretIsolation(
    input.providerEvidence,
    "manualDestroy.providerEvidence"
  );
  return { kind: "workspace-host-emergency-manual-destroy", ...input };
};
class WorkspaceHostLiveCanaryHarness {
  constructor(spec, clock = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.spec = spec;
    this.clock = clock;
    requireNonEmpty(spec.runId, "canary runId");
    requireNonEmpty(spec.workspaceId, "canary workspaceId");
    requireNonEmpty(spec.target, "canary target");
    requireNonEmpty(spec.scope.kind, "canary scope.kind");
    requireNonEmpty(spec.scope.id, "canary scope.id");
    if (spec.cloudCredentialRef.kind !== "cloud" || !spec.cloudCredentialRef.ref.trim()) {
      throw new Error(
        "Live canary requires a non-empty typed cloudCredentialRef"
      );
    };
    if (spec.spendSettlement) requireSpendSettlement(spec.spendSettlement);
    if (spec.failedRunTeardown) {
      requireFailedRunTeardown(spec.failedRunTeardown);
    } else {
      const approval = spec.contractApproval;
      if (!approval || approval.status !== "approved" || approval.suiteVersion !== WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION || !approval.reportRef?.trim() || !approval.approvedBy?.trim()) {
        throw new Error(
          "Live provider work is blocked until the current fake-provider contract report is approved"
        );
      };
      requireTimestamp(approval.approvedAt, "contractApproval.approvedAt");
    };
    requireTimestamp(spec.teardownDeadlineAt, "teardownDeadlineAt");
    this.maxSpendCents = spec.maxSpendCents ?? WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS;
    requireCents(this.maxSpendCents, "maxSpendCents");
    if (this.maxSpendCents === 0 || this.maxSpendCents > WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS) {
      throw new Error(
        `Live canary maxSpendCents must be between 1 and ${WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS}`
      );
    };
    assertWorkspaceHostSecretIsolation(spec.scope, "canary.scope");
  }
  maxSpendCents;
  reservations = /* @__PURE__ */ new Map();
  costs = [];
  resources = [];
  tags(extra = {}) {
    assertWorkspaceHostSecretIsolation(extra, "canary.tags");
    const required = (0,__vite_ssr_import_0__.workspaceHostCanaryIdentityLabels)({
      runId: this.spec.runId,
      workspaceId: this.spec.workspaceId
    });
    for (const key of Object.keys(required)) {
      if (key in extra && extra[key] !== required[key])
        throw new Error(`Canary tag '${key}' cannot be overridden`);
    };
    return { ...extra, ...required };
  }
  nowMillis() {
    return requireTimestamp(this.clock(), "canary clock");
  }
  spentCents() {
    return this.costs.reduce((total, entry) => total + entry.cents, 0);
  }
  reservedCents() {
    return [...this.reservations.values()].reduce(
      (total, entry) => total + entry.cents,
      0
    );
  }
  assertCanStartProviderWork() {
    if (this.nowMillis() >= requireTimestamp(this.spec.teardownDeadlineAt, "teardownDeadlineAt")) {
      throw new Error(
        "Live canary teardown deadline has passed; provider mutations are blocked"
      );
    };
    if (this.spentCents() > this.maxSpendCents) {
      throw new Error(
        "Live canary spend ceiling has been exceeded; provider mutations are blocked"
      );
    }
  }
  reserveSpend(input) {
    this.assertCanStartProviderWork();
    requireNonEmpty(input.id, "spend reservation id");
    requireNonEmpty(input.purpose, "spend reservation purpose");
    requireCents(input.cents, "spend reservation cents");
    requireTimestamp(input.reservedAt, "spend reservation reservedAt");
    if (input.cents === 0)
      throw new Error("Spend reservations must be positive");
    if (this.reservations.has(input.id) || this.costs.some((entry) => entry.reservationId === input.id)) {
      throw new Error(`Duplicate spend reservation '${input.id}'`);
    };
    if (this.spentCents() + this.reservedCents() + input.cents > this.maxSpendCents) {
      throw new Error(
        `Live canary spend reservation '${input.id}' would exceed the ${this.maxSpendCents}-cent ceiling`
      );
    };
    const stored = { ...input };
    this.reservations.set(stored.id, stored);
    return { ...stored };
  }
  settleSpend(input) {
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation)
      throw new Error(`Unknown spend reservation '${input.reservationId}'`);
    requireCents(input.cents, "settled spend cents");
    requireTimestamp(input.observedAt, "settled spend observedAt");
    requireNonEmpty(
      input.providerEvidenceRef,
      "settled spend providerEvidenceRef"
    );
    this.reservations.delete(input.reservationId);
    const stored = { ...input };
    this.costs.push(stored);
    return { ...stored };
  }
  /** Record passive/provider-delayed billing evidence even if it reveals an overrun. */
  recordObservedSpend(input) {
    if (input.reservationId)
      throw new Error("Use settleSpend for reserved provider work");
    requireCents(input.cents, "observed spend cents");
    requireTimestamp(input.observedAt, "observed spend observedAt");
    requireNonEmpty(
      input.providerEvidenceRef,
      "observed spend providerEvidenceRef"
    );
    const stored = { ...input };
    this.costs.push(stored);
    return { ...stored };
  }
  storeResource(input, options) {
    if (options.admitProviderWork) this.assertCanStartProviderWork();
    requireTimestamp(input.createdAt, "canary resource createdAt");
    if (input.resource.target !== this.spec.target)
      throw new Error("Canary resource target does not match the run target");
    const requiredTags = this.tags();
    for (const [key, value] of Object.entries(requiredTags)) {
      if (input.tags[key] !== value)
        throw new Error(
          `Canary resource is missing required tag '${key}=${value}'`
        );
    };
    assertWorkspaceHostSecretIsolation(input.tags, "canary.resource.tags");
    if (this.resources.some(
      (entry) => sameResource(entry.resource, input.resource)
    )) {
      throw new Error(
        `Canary resource '${input.resource.providerId}' is already registered`
      );
    };
    const stored = { ...input, tags: { ...input.tags } };
    this.resources.push(stored);
    return { ...stored, tags: { ...stored.tags } };
  }
  registerResource(input) {
    return this.storeResource(input, { admitProviderWork: true });
  }
  /**
   * Rehydrate a resource that was registered before a controller restart.
   *
   * This validates the same identity/tag contract as registerResource but deliberately does not
   * admit new provider work or re-apply the teardown deadline. Destroy must remain recoverable
   * after its deadline; treating durable-ledger replay as a new create would strand the very
   * resources the deadline exists to remove.
   */
  restoreRegisteredResource(input) {
    return this.storeResource(input, { admitProviderWork: false });
  }
  confirmResourceAbsent(confirmation) {
    if (confirmation.source !== "provider-read")
      throw new Error("Resource deletion requires provider-read absence proof");
    requireTimestamp(confirmation.confirmedAbsentAt, "confirmedAbsentAt");
    const record = this.resources.find(
      (entry) => entry.resource.providerId === confirmation.providerResourceId
    );
    if (!record)
      throw new Error(
        `Destroy confirmation references unregistered resource '${confirmation.providerResourceId}'`
      );
    record.deletionConfirmation = { ...confirmation };
  }
  recordManualDestroyReceipt(receipt) {
    if (receipt.kind !== "workspace-host-emergency-manual-destroy" || receipt.runId !== this.spec.runId) {
      throw new Error(
        "Manual destroy receipt does not belong to this canary run"
      );
    };
    const checked = createWorkspaceHostManualDestroyReceipt(receipt);
    const record = this.resources.find(
      (entry) => sameResource(entry.resource, checked.resource)
    );
    if (!record)
      throw new Error(
        `Manual destroy receipt references unregistered resource '${checked.resource.providerId}'`
      );
    record.deletionConfirmation = { ...checked.confirmation };
  }
  teardownWatchdog(at = this.clock()) {
    const now = requireTimestamp(at, "teardown watchdog time");
    const pending = this.resources.filter(
      (entry) => !entry.deletionConfirmation
    );
    return {
      deadlineAt: this.spec.teardownDeadlineAt,
      overdue: pending.length > 0 && now >= requireTimestamp(this.spec.teardownDeadlineAt, "teardownDeadlineAt"),
      pending: pending.map((entry) => ({ ...entry, tags: { ...entry.tags } }))
    };
  }
  orphanCensus(observed) {
    const tagged = observed.filter(
      (entry) => entry.tags[__vite_ssr_import_0__.WORKSPACE_HOST_CANARY_TAG_KEYS.runId] === this.spec.runId
    );
    const untracked = tagged.filter(
      (entry) => !this.resources.some(
        (known) => sameResource(known.resource, entry.resource)
      )
    );
    const stillLive = this.resources.filter(
      (known) => !known.deletionConfirmation && tagged.some((entry) => sameResource(known.resource, entry.resource))
    );
    const missingWithoutReceipt = this.resources.filter(
      (known) => !known.deletionConfirmation && !tagged.some((entry) => sameResource(known.resource, entry.resource))
    );
    return {
      clean: tagged.length === 0 && this.resources.every((entry) => !!entry.deletionConfirmation),
      observedTagged: tagged.map((entry) => ({
        ...entry,
        tags: { ...entry.tags }
      })),
      untracked: untracked.map((entry) => ({
        ...entry,
        tags: { ...entry.tags }
      })),
      stillLive: stillLive.map((entry) => ({
        ...entry,
        tags: { ...entry.tags }
      })),
      missingWithoutReceipt: missingWithoutReceipt.map((entry) => ({
        ...entry,
        tags: { ...entry.tags }
      }))
    };
  }
  finalize(observed, completedAt = this.clock()) {
    requireTimestamp(completedAt, "canary completedAt");
    if (this.reservations.size > 0)
      throw new Error(
        "Cannot finalize a canary with unsettled spend reservations"
      );
    if (this.costs.length === 0)
      throw new Error(
        "Cannot finalize a canary without provider cost evidence"
      );
    if (this.spentCents() > this.maxSpendCents)
      throw new Error(
        "Cannot finalize a canary that exceeded its hard spend ceiling"
      );
    const census = this.orphanCensus(observed);
    if (!census.clean)
      throw new Error(
        "Cannot finalize a canary until the orphan census is clean"
      );
    const spec = this.spec;
    const authorization = spec.failedRunTeardown ? {
      failedRunTeardown: {
        ...spec.failedRunTeardown,
        failedOperationIds: [...spec.failedRunTeardown.failedOperationIds]
      }
    } : { contractReportRef: spec.contractApproval.reportRef };
    return {
      runId: spec.runId,
      target: spec.target,
      ...authorization,
      ...spec.spendSettlement ? { spendSettlement: { ...spec.spendSettlement } } : {},
      completedAt,
      spentCents: this.spentCents(),
      maxSpendCents: this.maxSpendCents,
      resourceCount: this.resources.length,
      costEvidence: this.costs.map((entry) => ({ ...entry }))
    };
  }
};
function notStubbed(member) {
  throw new Error(
    `Fake workspace-host provider: '${String(member)}' was called but this test did not stub it. Pass it to makeFakeWorkspaceHostProvider({ ${String(member)}: ... }).`
  );
}
function fakeWorkspaceHostCapabilities(overrides = {}) {
  return {
    discovery: {
      scopes: false,
      regions: false,
      sizes: false,
      images: false,
      priceEstimates: false,
      ...overrides.discovery
    },
    lifecycle: {
      start: false,
      stop: false,
      restart: false,
      snapshot: false,
      restore: false,
      upgrade: false,
      repair: false,
      confirmedDestroy: false,
      hostBootstrap: false,
      ...overrides.lifecycle
    },
    transportKinds: overrides.transportKinds ?? [],
    ...overrides.constraints ? { constraints: overrides.constraints } : {}
  };
};
function makeFakeWorkspaceHostProvider(parts) {
  const base = {
    target: "gcp",
    capabilities: fakeWorkspaceHostCapabilities(),
    validateConnection: () => notStubbed("validateConnection"),
    listScopes: () => notStubbed("listScopes"),
    listRegions: () => notStubbed("listRegions"),
    listSizes: () => notStubbed("listSizes"),
    listImages: () => notStubbed("listImages"),
    estimatePrice: () => notStubbed("estimatePrice"),
    plan: () => notStubbed("plan"),
    apply: () => notStubbed("apply"),
    observe: () => notStubbed("observe"),
    reconcile: () => notStubbed("reconcile"),
    getTransportProfile: () => notStubbed("getTransportProfile"),
    attestHealth: () => notStubbed("attestHealth")
  };
  return { ...base, ...parts };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QkFHZCxPQUMrQjtBQUMvQixRQUFNLE9BQThCO0FBQUEsSUFDbEMsUUFBUTtBQUFBLElBQ1IsY0FBYyw4QkFBOEI7QUFBQSxJQUM1QyxvQkFBb0IsTUFBTSxXQUFXLG9CQUFvQjtBQUFBLElBQ3pELFlBQVksTUFBTSxXQUFXLFlBQVk7QUFBQSxJQUN6QyxhQUFhLE1BQU0sV0FBVyxhQUFhO0FBQUEsSUFDM0MsV0FBVyxNQUFNLFdBQVcsV0FBVztBQUFBLElBQ3ZDLFlBQVksTUFBTSxXQUFXLFlBQVk7QUFBQSxJQUN6QyxlQUFlLE1BQU0sV0FBVyxlQUFlO0FBQUEsSUFDL0MsTUFBTSxNQUFNLFdBQVcsTUFBTTtBQUFBLElBQzdCLE9BQU8sTUFBTSxXQUFXLE9BQU87QUFBQSxJQUMvQixTQUFTLE1BQU0sV0FBVyxTQUFTO0FBQUEsSUFDbkMsV0FBVyxNQUFNLFdBQVcsV0FBVztBQUFBLElBQ3ZDLHFCQUFxQixNQUFNLFdBQVcscUJBQXFCO0FBQUEsSUFDM0QsY0FBYyxNQUFNLFdBQVcsY0FBYztBQUFBLEVBQy9DO0FBQ0EsU0FBTyxFQUFFLEdBQUcsTUFBTSxHQUFHLE1BQU07QUFDN0IiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIndvcmtzcGFjZS1ob3N0LXRlc3QtaGFybmVzcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7XG4gIENsb3VkQ3JlZGVudGlhbFJlZixcbiAgV29ya3NwYWNlSG9zdEFwcGx5UmVzdWx0LFxuICBXb3Jrc3BhY2VIb3N0RGVzaXJlZFNwZWMsXG4gIFdvcmtzcGFjZUhvc3REZXN0cm95Q29uZmlybWF0aW9uLFxuICBXb3Jrc3BhY2VIb3N0RGlzY292ZXJ5Q2FwYWJpbGl0aWVzLFxuICBXb3Jrc3BhY2VIb3N0TGlmZWN5Y2xlQ2FwYWJpbGl0aWVzLFxuICBXb3Jrc3BhY2VIb3N0UGxhbixcbiAgV29ya3NwYWNlSG9zdFBsYW5SZXF1ZXN0LFxuICBXb3Jrc3BhY2VIb3N0UHJvdmlkZXIsXG4gIFdvcmtzcGFjZUhvc3RQcm92aWRlckNhcGFiaWxpdGllcyxcbiAgV29ya3NwYWNlSG9zdFByb3ZpZGVyQ29udGV4dCxcbiAgV29ya3NwYWNlSG9zdFByb3ZpZGVyVGFyZ2V0LFxuICBXb3Jrc3BhY2VIb3N0UmVzb3VyY2VSZWYsXG4gIFdvcmtzcGFjZUhvc3RTY29wZVJlZixcbn0gZnJvbSBcIi4vd29ya3NwYWNlLWhvc3QtdHlwZXNcIjtcbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0NBTkFSWV9UQUdfS0VZUyxcbiAgd29ya3NwYWNlSG9zdENhbmFyeUlkZW50aXR5TGFiZWxzLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1jYW5hcnktaWRlbnRpdHlcIjtcblxuLyoqIFZlcnNpb25lZCBnYXRlIHNoYXJlZCBieSBmYWtlLWFkYXB0ZXIgY29uZm9ybWFuY2UgYW5kIGxpdmUgY2FuYXJ5IGFwcHJvdmFsLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX1BST1ZJREVSX0NPTlRSQUNUX1ZFUlNJT04gPVxuICBcIndvcmtzcGFjZS1ob3N0LXByb3ZpZGVyLWNvbnRyYWN0LXYxXCI7XG4vKiogT3duZXItYXBwcm92ZWQgY3VtdWxhdGl2ZSBjZWlsaW5nIGZvciB0aGUgZmlyc3QgcmVhbC1hY2NvdW50IGNhbmFyeSAoRC0wMjApLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0xJVkVfQ0FOQVJZX01BWF9TUEVORF9DRU5UUyA9IDJfNTAwO1xuXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfUFJPVklERVJfQ09OVFJBQ1RfQ0hFQ0tTID0gW1xuICBcInRhcmdldC1hbmQtc2VjcmV0LWlzb2xhdGlvblwiLFxuICBcImNvbm5lY3Rpb24tdmFsaWRhdGlvblwiLFxuICBcImNhdGFsb2ctZGlzY292ZXJ5XCIsXG4gIFwicHJpY2UtZXN0aW1hdGVcIixcbiAgXCJkZXRlcm1pbmlzdGljLXBsYW5cIixcbiAgXCJpZGVtcG90ZW50LWFwcGx5LXJlY29uY2lsZVwiLFxuICBcIm9ic2VydmF0aW9uLWhlYWx0aC10cmFuc3BvcnRcIixcbiAgXCJjb25maXJtZWQtZGVzdHJveVwiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RQcm92aWRlckNvbnRyYWN0Q2hlY2sgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX1BST1ZJREVSX0NPTlRSQUNUX0NIRUNLUylbbnVtYmVyXTtcblxuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RDb250cmFjdEFzc2VydGlvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBjaGVjazogV29ya3NwYWNlSG9zdFByb3ZpZGVyQ29udHJhY3RDaGVjayxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKGBXb3Jrc3BhY2UtaG9zdCBwcm92aWRlciBjb250cmFjdCAnJHtjaGVja30nIGZhaWxlZDogJHttZXNzYWdlfWApO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdENvbnRyYWN0QXNzZXJ0aW9uRXJyb3JcIjtcbiAgfVxufVxuXG5jb25zdCBTRUNSRVRfS0VZID1cbiAgLyg/Ol58W18tXSkoYXBpW18tXT9rZXl8YWNjZXNzW18tXT9rZXl8c2VjcmV0fHRva2VufHBhc3N3b3JkfHBhc3NwaHJhc2V8cHJpdmF0ZVtfLV0/a2V5KSg/OiR8W18tXSkvaTtcbmNvbnN0IFNFQ1JFVF9WQUxVRSA9IC8tLS0tLUJFR0lOICg/OltBLVogXSsgKT9QUklWQVRFIEtFWS0tLS0tLztcbmNvbnN0IFNFQ1JFVF9QT0xJQ1lfU0VHTUVOVCA9IC8oXnxbXy1dKXNlY3JldCg/PVtfLV0oPzpzY2FufHNjYW5uaW5nfGZpbmRpbmd8ZmluZGluZ3N8cG9saWN5KSg/OiR8W18tXSkpL2dpO1xuXG5mdW5jdGlvbiBpc1NlY3JldFNoYXBlZEtleShrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpemVkID0ga2V5LnJlcGxhY2UoLyhbYS16XFxkXSkoW0EtWl0pL2csIFwiJDFfJDJcIik7XG4gIC8vIGBzZWNyZXRgIGFsc28gbmFtZXMgdGhlIHRoaW5nIGEgcHVibGljIHNjYW5uaW5nIHBvbGljeSBkZXRlY3RzLiBNYXNrIG9ubHlcbiAgLy8gdGhhdCBwb2xpY3kgbm91biBiZWZvcmUgYXBwbHlpbmcgdGhlIGNyZWRlbnRpYWwta2V5IGhldXJpc3RpYzsgYW55IHJlYWxcbiAgLy8gY3JlZGVudGlhbCBzZWdtZW50IGVsc2V3aGVyZSBpbiB0aGUga2V5IChmb3IgZXhhbXBsZSBzZWNyZXRTY2FuVG9rZW4pXG4gIC8vIHJlbWFpbnMgdmlzaWJsZSBhbmQgaXMgc3RpbGwgcmVqZWN0ZWQuXG4gIHJldHVybiBTRUNSRVRfS0VZLnRlc3Qobm9ybWFsaXplZC5yZXBsYWNlKFNFQ1JFVF9QT0xJQ1lfU0VHTUVOVCwgXCIkMXBvbGljeV9zdWJqZWN0XCIpKTtcbn1cblxuLyoqXG4gKiBSZWplY3Qgc2VjcmV0LXNoYXBlZCB2YWx1ZXMgZnJvbSBhcnRpZmFjdHMgdGhhdCBhcmUgc2FmZSB0byBwZXJzaXN0IGluIGFcbiAqIHBsYW4sIGNvbnRyYWN0IHJlcG9ydCwgY2FuYXJ5IGxlZGdlciwgdGFnIHNldCwgb3IgZGVzdHJveSByZWNlaXB0LiBUeXBlZFxuICogY3JlZGVudGlhbCByZWZlcmVuY2VzIGFyZSBhbGxvd2VkIGJlY2F1c2UgdGhleSBjYXJyeSBvbmx5IHJlc29sdmVyIGlkcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gIHZhbHVlOiB1bmtub3duLFxuICBwYXRoID0gXCJtZXRhZGF0YVwiLFxuKTogdm9pZCB7XG4gIGNvbnN0IHZpc2l0ID0gKGNhbmRpZGF0ZTogdW5rbm93biwgY3VycmVudFBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGlmICh0eXBlb2YgY2FuZGlkYXRlID09PSBcInN0cmluZ1wiKSB7XG4gICAgICBpZiAoU0VDUkVUX1ZBTFVFLnRlc3QoY2FuZGlkYXRlKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFNlY3JldCBtYXRlcmlhbCBpcyBmb3JiaWRkZW4gaW4gd29ya3NwYWNlLWhvc3QgcHVibGljIG1ldGFkYXRhIGF0ICR7Y3VycmVudFBhdGh9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGNhbmRpZGF0ZSA9PT0gbnVsbCB8fCB0eXBlb2YgY2FuZGlkYXRlICE9PSBcIm9iamVjdFwiKSByZXR1cm47XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoY2FuZGlkYXRlKSkge1xuICAgICAgY2FuZGlkYXRlLmZvckVhY2goKGVudHJ5LCBpbmRleCkgPT5cbiAgICAgICAgdmlzaXQoZW50cnksIGAke2N1cnJlbnRQYXRofVske2luZGV4fV1gKSxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKFxuICAgICAgY2FuZGlkYXRlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICkpIHtcbiAgICAgIGlmIChpc1NlY3JldFNoYXBlZEtleShrZXkpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgU2VjcmV0LXNoYXBlZCBmaWVsZCAnJHtjdXJyZW50UGF0aH0uJHtrZXl9JyBpcyBmb3JiaWRkZW4gaW4gd29ya3NwYWNlLWhvc3QgcHVibGljIG1ldGFkYXRhYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHZpc2l0KGVudHJ5LCBgJHtjdXJyZW50UGF0aH0uJHtrZXl9YCk7XG4gICAgfVxuICB9O1xuICB2aXNpdCh2YWx1ZSwgcGF0aCk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVDb250cmFjdChcbiAgY2hlY2tzOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdENoZWNrW10sXG4gIGNoZWNrOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdENoZWNrLFxuICBjb25kaXRpb246IHVua25vd24sXG4gIG1lc3NhZ2U6IHN0cmluZyxcbik6IGFzc2VydHMgY29uZGl0aW9uIHtcbiAgaWYgKCFjb25kaXRpb24pIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q29udHJhY3RBc3NlcnRpb25FcnJvcihjaGVjaywgbWVzc2FnZSk7XG4gIGlmICghY2hlY2tzLmluY2x1ZGVzKGNoZWNrKSkgY2hlY2tzLnB1c2goY2hlY2spO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlTm9uRW1wdHkodmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIXZhbHVlLnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSBtdXN0IG5vdCBiZSBlbXB0eWApO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlVGltZXN0YW1wKHZhbHVlOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBtaWxsaXMgPSBEYXRlLnBhcnNlKHZhbHVlKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobWlsbGlzKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7bGFiZWx9IG11c3QgYmUgYW4gSVNPIHRpbWVzdGFtcGApO1xuICByZXR1cm4gbWlsbGlzO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlQ2VudHModmFsdWU6IG51bWJlciwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtsYWJlbH0gbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBzYWZlIGludGVnZXIgbnVtYmVyIG9mIGNlbnRzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVGYWlsZWRSdW5UZWFyZG93bihcbiAgdGVhcmRvd246IFdvcmtzcGFjZUhvc3RGYWlsZWRSdW5UZWFyZG93bixcbik6IHZvaWQge1xuICByZXF1aXJlTm9uRW1wdHkodGVhcmRvd24uYWN0b3JJZCwgXCJmYWlsZWRSdW5UZWFyZG93bi5hY3RvcklkXCIpO1xuICByZXF1aXJlTm9uRW1wdHkodGVhcmRvd24ucmVhc29uLCBcImZhaWxlZFJ1blRlYXJkb3duLnJlYXNvblwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KHRlYXJkb3duLnByb2NlZHVyZVJlZiwgXCJmYWlsZWRSdW5UZWFyZG93bi5wcm9jZWR1cmVSZWZcIik7XG4gIC8vIEEgdGVhcmRvd24gdGhhdCBuYW1lcyBubyBmYWlsZWQgb3BlcmF0aW9uIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gb25lIGFzc2VydGluZyB0aGUgcnVuXG4gIC8vIGZhaWxlZCBiZWNhdXNlIHNheWluZyBzbyBpcyBjb252ZW5pZW50LiBUaGUgb3BlcmF0aW9uIGlkcyBhcmUgd2hhdCBhbiBhdWRpdG9yIHJlYWRzIGJhY2suXG4gIGlmICh0ZWFyZG93bi5mYWlsZWRPcGVyYXRpb25JZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJGYWlsZWQtcnVuIHRlYXJkb3duIG11c3QgbmFtZSBhdCBsZWFzdCBvbmUgZmFpbGVkIG9wZXJhdGlvbiBpdCBjbGVhbnMgdXAgYWZ0ZXJcIixcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3QgW2luZGV4LCBvcGVyYXRpb25JZF0gb2YgdGVhcmRvd24uZmFpbGVkT3BlcmF0aW9uSWRzLmVudHJpZXMoKSkge1xuICAgIHJlcXVpcmVOb25FbXB0eShcbiAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgYGZhaWxlZFJ1blRlYXJkb3duLmZhaWxlZE9wZXJhdGlvbklkc1ske2luZGV4fV1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNwZW5kU2V0dGxlbWVudChcbiAgc2V0dGxlbWVudDogV29ya3NwYWNlSG9zdFNwZW5kU2V0dGxlbWVudCxcbik6IHZvaWQge1xuICByZXF1aXJlTm9uRW1wdHkoc2V0dGxlbWVudC5hY3RvcklkLCBcInNwZW5kU2V0dGxlbWVudC5hY3RvcklkXCIpO1xuICByZXF1aXJlTm9uRW1wdHkoc2V0dGxlbWVudC5yZWFzb24sIFwic3BlbmRTZXR0bGVtZW50LnJlYXNvblwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KHNldHRsZW1lbnQucHJvY2VkdXJlUmVmLCBcInNwZW5kU2V0dGxlbWVudC5wcm9jZWR1cmVSZWZcIik7XG4gIC8vIEEgZGVmZXJyYWwgd2l0aCBubyBkYXRlIGlzIGFuIG9ibGlnYXRpb24gbm9ib2R5IGNhbiBldmVyIGJlIHNob3duIHRvIGhhdmUgbWlzc2VkLlxuICByZXF1aXJlVGltZXN0YW1wKHNldHRsZW1lbnQucmVjb25jaWxlQWZ0ZXIsIFwic3BlbmRTZXR0bGVtZW50LnJlY29uY2lsZUFmdGVyXCIpO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBsYW5TaGFwZShcbiAgY2hlY2tzOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdENoZWNrW10sXG4gIHBsYW46IFdvcmtzcGFjZUhvc3RQbGFuLFxuICByZXF1ZXN0OiBXb3Jrc3BhY2VIb3N0UGxhblJlcXVlc3QsXG4gIHRhcmdldDogV29ya3NwYWNlSG9zdFByb3ZpZGVyVGFyZ2V0LFxuKTogdm9pZCB7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJkZXRlcm1pbmlzdGljLXBsYW5cIixcbiAgICBwbGFuLnRhcmdldCA9PT0gdGFyZ2V0LFxuICAgIFwicGxhbiB0YXJnZXQgZG9lcyBub3QgbWF0Y2ggcHJvdmlkZXIgdGFyZ2V0XCIsXG4gICk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJkZXRlcm1pbmlzdGljLXBsYW5cIixcbiAgICBwbGFuLm9wZXJhdGlvbklkID09PSByZXF1ZXN0Lm9wZXJhdGlvbklkLFxuICAgIFwicGxhbiBjaGFuZ2VkIG9wZXJhdGlvbklkXCIsXG4gICk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJkZXRlcm1pbmlzdGljLXBsYW5cIixcbiAgICBwbGFuLnN0ZXBzLmxlbmd0aCA+IDAsXG4gICAgXCJwbGFuIG11c3QgY29udGFpbiBhdCBsZWFzdCBvbmUgcmVzb3VyY2Ugc3RlcFwiLFxuICApO1xuXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgaWRlbXBvdGVuY3lLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3Qgc3RlcCBvZiBwbGFuLnN0ZXBzKSB7XG4gICAgcmVxdWlyZUNvbnRyYWN0KFxuICAgICAgY2hlY2tzLFxuICAgICAgXCJkZXRlcm1pbmlzdGljLXBsYW5cIixcbiAgICAgICEhc3RlcC5pZC50cmltKCksXG4gICAgICBcInN0ZXAgaWQgbXVzdCBub3QgYmUgZW1wdHlcIixcbiAgICApO1xuICAgIHJlcXVpcmVDb250cmFjdChcbiAgICAgIGNoZWNrcyxcbiAgICAgIFwiZGV0ZXJtaW5pc3RpYy1wbGFuXCIsXG4gICAgICAhc2Vlbi5oYXMoc3RlcC5pZCksXG4gICAgICBgZHVwbGljYXRlIHN0ZXAgaWQgJyR7c3RlcC5pZH0nYCxcbiAgICApO1xuICAgIHJlcXVpcmVDb250cmFjdChcbiAgICAgIGNoZWNrcyxcbiAgICAgIFwiZGV0ZXJtaW5pc3RpYy1wbGFuXCIsXG4gICAgICAhIXN0ZXAuaWRlbXBvdGVuY3lLZXkudHJpbSgpICYmICFpZGVtcG90ZW5jeUtleXMuaGFzKHN0ZXAuaWRlbXBvdGVuY3lLZXkpLFxuICAgICAgYHN0ZXAgJyR7c3RlcC5pZH0nIG5lZWRzIGEgdW5pcXVlIHByb3ZpZGVyIGlkZW1wb3RlbmN5IGtleWAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGRlcGVuZGVuY3kgb2Ygc3RlcC5kZXBlbmRzT24pIHtcbiAgICAgIHJlcXVpcmVDb250cmFjdChcbiAgICAgICAgY2hlY2tzLFxuICAgICAgICBcImRldGVybWluaXN0aWMtcGxhblwiLFxuICAgICAgICBzZWVuLmhhcyhkZXBlbmRlbmN5KSxcbiAgICAgICAgYHN0ZXAgJyR7c3RlcC5pZH0nIGRlcGVuZGVuY3kgJyR7ZGVwZW5kZW5jeX0nIG11c3QgYmUgZGVjbGFyZWQgZWFybGllcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBzZWVuLmFkZChzdGVwLmlkKTtcbiAgICBpZGVtcG90ZW5jeUtleXMuYWRkKHN0ZXAuaWRlbXBvdGVuY3lLZXkpO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmFrZVdvcmtzcGFjZUhvc3RQcm92aWRlckNvbnRyYWN0Rml4dHVyZSB7XG4gIC8qKiBSdW50aW1lIGd1YXJkIGFnYWluc3QgYWNjaWRlbnRhbGx5IGRyaXZpbmcgYSByZWFsIHByb3ZpZGVyIHdpdGggdGhlIGZha2Ugc3VpdGUuICovXG4gIGFkYXB0ZXJLaW5kOiBcImZha2VcIjtcbiAgcmVwb3J0UmVmOiBzdHJpbmc7XG4gIGNvbnRleHQ6IFdvcmtzcGFjZUhvc3RQcm92aWRlckNvbnRleHQ7XG4gIGRlc2lyZWQ6IFdvcmtzcGFjZUhvc3REZXNpcmVkU3BlYztcbiAgb3BlcmF0aW9uSWQ6IHN0cmluZztcbiAgaWRlbXBvdGVuY3lLZXk6IHN0cmluZztcbiAgY29uZmlybWVkQnk6IHN0cmluZztcbiAgbm93PzogKCkgPT4gc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RQcm92aWRlckNvbnRyYWN0UmVwb3J0IHtcbiAgc3VpdGVWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfUFJPVklERVJfQ09OVFJBQ1RfVkVSU0lPTjtcbiAgcmVwb3J0UmVmOiBzdHJpbmc7XG4gIHRhcmdldDogV29ya3NwYWNlSG9zdFByb3ZpZGVyVGFyZ2V0O1xuICBjb21wbGV0ZWRBdDogc3RyaW5nO1xuICBwYXNzZWQ6IHRydWU7XG4gIGNoZWNrczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdFByb3ZpZGVyQ29udHJhY3RDaGVja1tdO1xuICBwcm92aXNpb25lZFJlc291cmNlczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdFJlc291cmNlUmVmW107XG4gIGRlc3Ryb3lDb25maXJtYXRpb25zOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0RGVzdHJveUNvbmZpcm1hdGlvbltdO1xufVxuXG4vKipcbiAqIEV4ZXJjaXNlIGEgZGV0ZXJtaW5pc3RpYyBmYWtlIGFkYXB0ZXIgdGhyb3VnaCB0aGUgY29tcGxldGUgc2hhcmVkIGNvbnRyYWN0LlxuICogQ29uY3JldGUgcHJvdmlkZXIgdGVzdHMgc3VwcGx5IHRoZWlyIG93biBpbi1tZW1vcnkgZmFrZSBpbXBsZW1lbnRhdGlvbi4gUmVhbFxuICogYWNjb3VudHMgaW5zdGVhZCBnbyB0aHJvdWdoIFdvcmtzcGFjZUhvc3RMaXZlQ2FuYXJ5SGFybmVzcyBiZWxvdy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkZha2VXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdFN1aXRlKFxuICBwcm92aWRlcjogV29ya3NwYWNlSG9zdFByb3ZpZGVyLFxuICBmaXh0dXJlOiBGYWtlV29ya3NwYWNlSG9zdFByb3ZpZGVyQ29udHJhY3RGaXh0dXJlLFxuKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdFJlcG9ydD4ge1xuICBpZiAoZml4dHVyZS5hZGFwdGVyS2luZCAhPT0gXCJmYWtlXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJUaGUgZmFrZSBwcm92aWRlciBjb250cmFjdCBzdWl0ZSByZWZ1c2VzIG5vbi1mYWtlIGFkYXB0ZXJzXCIsXG4gICAgKTtcbiAgcmVxdWlyZU5vbkVtcHR5KGZpeHR1cmUucmVwb3J0UmVmLCBcInJlcG9ydFJlZlwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KGZpeHR1cmUub3BlcmF0aW9uSWQsIFwib3BlcmF0aW9uSWRcIik7XG4gIHJlcXVpcmVOb25FbXB0eShmaXh0dXJlLmlkZW1wb3RlbmN5S2V5LCBcImlkZW1wb3RlbmN5S2V5XCIpO1xuICBjb25zdCBub3cgPSBmaXh0dXJlLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcbiAgY29uc3QgY2hlY2tzOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJDb250cmFjdENoZWNrW10gPSBbXTtcblxuICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKFxuICAgIGZpeHR1cmUuY29udGV4dC5jb25uZWN0aW9uLnByb3ZpZGVyLFxuICAgIFwiY29udGV4dC5jb25uZWN0aW9uLnByb3ZpZGVyXCIsXG4gICk7XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24oXG4gICAgZml4dHVyZS5kZXNpcmVkLnByb3ZpZGVyLFxuICAgIFwiZGVzaXJlZC5wcm92aWRlclwiLFxuICApO1xuICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKGZpeHR1cmUuZGVzaXJlZC5sYWJlbHMsIFwiZGVzaXJlZC5sYWJlbHNcIik7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJ0YXJnZXQtYW5kLXNlY3JldC1pc29sYXRpb25cIixcbiAgICBwcm92aWRlci50YXJnZXQgPT09IGZpeHR1cmUuZGVzaXJlZC50YXJnZXQsXG4gICAgXCJkZXNpcmVkIHRhcmdldCBtaXNtYXRjaFwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwidGFyZ2V0LWFuZC1zZWNyZXQtaXNvbGF0aW9uXCIsXG4gICAgZml4dHVyZS5jb250ZXh0LmNvbm5lY3Rpb24udGFyZ2V0ID09PSBwcm92aWRlci50YXJnZXQsXG4gICAgXCJjb25uZWN0aW9uIHRhcmdldCBtaXNtYXRjaFwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwidGFyZ2V0LWFuZC1zZWNyZXQtaXNvbGF0aW9uXCIsXG4gICAgZml4dHVyZS5jb250ZXh0LmNvbm5lY3Rpb24uY2xvdWRDcmVkZW50aWFsUmVmLmtpbmQgPT09IFwiY2xvdWRcIiAmJlxuICAgICAgISFmaXh0dXJlLmNvbnRleHQuY29ubmVjdGlvbi5jbG91ZENyZWRlbnRpYWxSZWYucmVmLnRyaW0oKSxcbiAgICBcImNsb3VkIGF1dGhvcml6YXRpb24gbXVzdCBiZSBhIG5vbi1lbXB0eSB0eXBlZCByZWZlcmVuY2VcIixcbiAgKTtcblxuICBjb25zdCB2YWxpZGF0aW9uID0gYXdhaXQgcHJvdmlkZXIudmFsaWRhdGVDb25uZWN0aW9uKGZpeHR1cmUuY29udGV4dCk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJjb25uZWN0aW9uLXZhbGlkYXRpb25cIixcbiAgICB2YWxpZGF0aW9uLm9rLFxuICAgIHZhbGlkYXRpb24uZXJyb3JzLmpvaW4oXCI7IFwiKSB8fCBcImNvbm5lY3Rpb24gcmVqZWN0ZWRcIixcbiAgKTtcbiAgcmVxdWlyZUNvbnRyYWN0KFxuICAgIGNoZWNrcyxcbiAgICBcImNvbm5lY3Rpb24tdmFsaWRhdGlvblwiLFxuICAgIHZhbGlkYXRpb24uZXJyb3JzLmxlbmd0aCA9PT0gMCxcbiAgICBcInN1Y2Nlc3NmdWwgdmFsaWRhdGlvbiByZXR1cm5lZCBlcnJvcnNcIixcbiAgKTtcblxuICBjb25zdCBxdWVyeSA9IHtcbiAgICBzY29wZTogZml4dHVyZS5kZXNpcmVkLnNjb3BlLFxuICAgIHJlZ2lvbjogZml4dHVyZS5kZXNpcmVkLnJlZ2lvbixcbiAgfTtcbiAgY29uc3QgW3Njb3BlcywgcmVnaW9ucywgc2l6ZXMsIGltYWdlcywgcHJpY2VdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIHByb3ZpZGVyLmxpc3RTY29wZXMoZml4dHVyZS5jb250ZXh0KSxcbiAgICBwcm92aWRlci5saXN0UmVnaW9ucyhxdWVyeSwgZml4dHVyZS5jb250ZXh0KSxcbiAgICBwcm92aWRlci5saXN0U2l6ZXMocXVlcnksIGZpeHR1cmUuY29udGV4dCksXG4gICAgcHJvdmlkZXIubGlzdEltYWdlcyhxdWVyeSwgZml4dHVyZS5jb250ZXh0KSxcbiAgICBwcm92aWRlci5lc3RpbWF0ZVByaWNlKGZpeHR1cmUuZGVzaXJlZCwgZml4dHVyZS5jb250ZXh0KSxcbiAgXSk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJjYXRhbG9nLWRpc2NvdmVyeVwiLFxuICAgIHNjb3Blcy5zb21lKFxuICAgICAgKHNjb3BlKSA9PlxuICAgICAgICBzY29wZS5raW5kID09PSBmaXh0dXJlLmRlc2lyZWQuc2NvcGUua2luZCAmJlxuICAgICAgICBzY29wZS5pZCA9PT0gZml4dHVyZS5kZXNpcmVkLnNjb3BlLmlkLFxuICAgICksXG4gICAgXCJkZXNpcmVkIHNjb3BlIGlzIGFic2VudCBmcm9tIGRpc2NvdmVyeVwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiY2F0YWxvZy1kaXNjb3ZlcnlcIixcbiAgICByZWdpb25zLnNvbWUoKHJlZ2lvbikgPT4gcmVnaW9uLmlkID09PSBmaXh0dXJlLmRlc2lyZWQucmVnaW9uKSxcbiAgICBcImRlc2lyZWQgcmVnaW9uIGlzIGFic2VudFwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiY2F0YWxvZy1kaXNjb3ZlcnlcIixcbiAgICBzaXplcy5zb21lKChzaXplKSA9PiBzaXplLmlkID09PSBmaXh0dXJlLmRlc2lyZWQuc2l6ZSksXG4gICAgXCJkZXNpcmVkIHNpemUgaXMgYWJzZW50XCIsXG4gICk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJjYXRhbG9nLWRpc2NvdmVyeVwiLFxuICAgIGltYWdlcy5zb21lKChpbWFnZSkgPT4gaW1hZ2UuaWQgPT09IGZpeHR1cmUuZGVzaXJlZC5pbWFnZS5pZCksXG4gICAgXCJkZXNpcmVkIGltYWdlIGlzIGFic2VudFwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwicHJpY2UtZXN0aW1hdGVcIixcbiAgICBOdW1iZXIuaXNGaW5pdGUocHJpY2UuaG91cmx5QW1vdW50KSAmJlxuICAgICAgcHJpY2UuaG91cmx5QW1vdW50ID49IDAgJiZcbiAgICAgICEhcHJpY2UuY3VycmVuY3kudHJpbSgpLFxuICAgIFwicHJpY2UgZXN0aW1hdGUgbXVzdCB1c2UgYSBjdXJyZW5jeSBhbmQgYSBub24tbmVnYXRpdmUgZmluaXRlIGhvdXJseSBhbW91bnRcIixcbiAgKTtcblxuICBjb25zdCBwcm92aXNpb25SZXF1ZXN0OiBXb3Jrc3BhY2VIb3N0UGxhblJlcXVlc3QgPSB7XG4gICAgYWN0aW9uOiBcInByb3Zpc2lvblwiLFxuICAgIG9wZXJhdGlvbklkOiBmaXh0dXJlLm9wZXJhdGlvbklkLFxuICAgIGlkZW1wb3RlbmN5S2V5OiBmaXh0dXJlLmlkZW1wb3RlbmN5S2V5LFxuICAgIGRlc2lyZWQ6IGZpeHR1cmUuZGVzaXJlZCxcbiAgfTtcbiAgY29uc3QgW2ZpcnN0UGxhbiwgcmVwbGF5ZWRQbGFuXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBwcm92aWRlci5wbGFuKHByb3Zpc2lvblJlcXVlc3QsIGZpeHR1cmUuY29udGV4dCksXG4gICAgcHJvdmlkZXIucGxhbihwcm92aXNpb25SZXF1ZXN0LCBmaXh0dXJlLmNvbnRleHQpLFxuICBdKTtcbiAgdmFsaWRhdGVQbGFuU2hhcGUoY2hlY2tzLCBmaXJzdFBsYW4sIHByb3Zpc2lvblJlcXVlc3QsIHByb3ZpZGVyLnRhcmdldCk7XG4gIHZhbGlkYXRlUGxhblNoYXBlKGNoZWNrcywgcmVwbGF5ZWRQbGFuLCBwcm92aXNpb25SZXF1ZXN0LCBwcm92aWRlci50YXJnZXQpO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiZGV0ZXJtaW5pc3RpYy1wbGFuXCIsXG4gICAgSlNPTi5zdHJpbmdpZnkoZmlyc3RQbGFuLnN0ZXBzKSA9PT0gSlNPTi5zdHJpbmdpZnkocmVwbGF5ZWRQbGFuLnN0ZXBzKSxcbiAgICBcInJlcGxheWluZyB0aGUgc2FtZSBvcGVyYXRpb24gcHJvZHVjZWQgZGlmZmVyZW50IHJlc291cmNlIHN0ZXBzXCIsXG4gICk7XG5cbiAgY29uc3Qga25vd25SZXNvdXJjZXM6IFdvcmtzcGFjZUhvc3RSZXNvdXJjZVJlZltdID0gW107XG4gIGNvbnN0IGFwcGx5UmVzdWx0czogV29ya3NwYWNlSG9zdEFwcGx5UmVzdWx0W10gPSBbXTtcbiAgZm9yIChjb25zdCBzdGVwIG9mIGZpcnN0UGxhbi5zdGVwcykge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb3ZpZGVyLmFwcGx5KFxuICAgICAge1xuICAgICAgICBwbGFuSWQ6IGZpcnN0UGxhbi5wbGFuSWQsXG4gICAgICAgIG9wZXJhdGlvbklkOiBmaXJzdFBsYW4ub3BlcmF0aW9uSWQsXG4gICAgICAgIHN0ZXAsXG4gICAgICAgIGtub3duUmVzb3VyY2VzOiBbLi4ua25vd25SZXNvdXJjZXNdLFxuICAgICAgfSxcbiAgICAgIGZpeHR1cmUuY29udGV4dCxcbiAgICApO1xuICAgIHJlcXVpcmVDb250cmFjdChcbiAgICAgIGNoZWNrcyxcbiAgICAgIFwiaWRlbXBvdGVudC1hcHBseS1yZWNvbmNpbGVcIixcbiAgICAgIHJlc3VsdC5vcGVyYXRpb25JZCA9PT0gZmlyc3RQbGFuLm9wZXJhdGlvbklkLFxuICAgICAgXCJhcHBseSBjaGFuZ2VkIG9wZXJhdGlvbklkXCIsXG4gICAgKTtcbiAgICByZXF1aXJlQ29udHJhY3QoXG4gICAgICBjaGVja3MsXG4gICAgICBcImlkZW1wb3RlbnQtYXBwbHktcmVjb25jaWxlXCIsXG4gICAgICByZXN1bHQuc3RlcElkID09PSBzdGVwLmlkLFxuICAgICAgXCJhcHBseSBjaGFuZ2VkIHN0ZXBJZFwiLFxuICAgICk7XG4gICAgcmVxdWlyZUNvbnRyYWN0KFxuICAgICAgY2hlY2tzLFxuICAgICAgXCJpZGVtcG90ZW50LWFwcGx5LXJlY29uY2lsZVwiLFxuICAgICAgcmVzdWx0LnN0YXRlICE9PSBcImluLXByb2dyZXNzXCIsXG4gICAgICBcImZha2UgYXBwbHkgZGlkIG5vdCBzZXR0bGUgZGV0ZXJtaW5pc3RpY2FsbHlcIixcbiAgICApO1xuICAgIGlmIChcInJlc291cmNlXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXNvdXJjZSkge1xuICAgICAgaWYgKFxuICAgICAgICAha25vd25SZXNvdXJjZXMuc29tZShcbiAgICAgICAgICAocmVzb3VyY2UpID0+IHJlc291cmNlLnByb3ZpZGVySWQgPT09IHJlc3VsdC5yZXNvdXJjZSEucHJvdmlkZXJJZCxcbiAgICAgICAgKVxuICAgICAgKSB7XG4gICAgICAgIGtub3duUmVzb3VyY2VzLnB1c2gocmVzdWx0LnJlc291cmNlKTtcbiAgICAgIH1cbiAgICB9XG4gICAgYXBwbHlSZXN1bHRzLnB1c2gocmVzdWx0KTtcbiAgfVxuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiaWRlbXBvdGVudC1hcHBseS1yZWNvbmNpbGVcIixcbiAgICBrbm93blJlc291cmNlcy5sZW5ndGggPiAwLFxuICAgIFwicHJvdmlzaW9uaW5nIHByb2R1Y2VkIG5vIHJlc291cmNlIGlkZW50aXRpZXNcIixcbiAgKTtcblxuICBjb25zdCBmaXJzdEFwcGxpZWQgPSBhcHBseVJlc3VsdHMuZmluZChcbiAgICAocmVzdWx0KSA9PiBcInJlc291cmNlXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXNvdXJjZSxcbiAgKTtcbiAgcmVxdWlyZUNvbnRyYWN0KFxuICAgIGNoZWNrcyxcbiAgICBcImlkZW1wb3RlbnQtYXBwbHktcmVjb25jaWxlXCIsXG4gICAgZmlyc3RBcHBsaWVkICYmIFwicmVzb3VyY2VcIiBpbiBmaXJzdEFwcGxpZWQsXG4gICAgXCJubyBhcHBsaWVkIHJlc291cmNlIHRvIHJlY29uY2lsZVwiLFxuICApO1xuICBjb25zdCBmaXJzdFN0ZXAgPSBmaXJzdFBsYW4uc3RlcHMuZmluZChcbiAgICAoc3RlcCkgPT4gc3RlcC5pZCA9PT0gZmlyc3RBcHBsaWVkLnN0ZXBJZCxcbiAgKSE7XG4gIGNvbnN0IHJlY29uY2lsZWQgPSBhd2FpdCBwcm92aWRlci5yZWNvbmNpbGUoXG4gICAge1xuICAgICAgcGxhbklkOiBmaXJzdFBsYW4ucGxhbklkLFxuICAgICAgb3BlcmF0aW9uSWQ6IGZpcnN0UGxhbi5vcGVyYXRpb25JZCxcbiAgICAgIHN0ZXA6IGZpcnN0U3RlcCxcbiAgICAgIGtub3duUmVzb3VyY2VzLFxuICAgICAgcmVhc29uOiBcInJlc3VtZVwiLFxuICAgICAgcHJldmlvdXNQcm92aWRlclJlcXVlc3RJZDogZmlyc3RBcHBsaWVkLnByb3ZpZGVyUmVxdWVzdElkLFxuICAgIH0sXG4gICAgZml4dHVyZS5jb250ZXh0LFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiaWRlbXBvdGVudC1hcHBseS1yZWNvbmNpbGVcIixcbiAgICByZWNvbmNpbGVkLm9wZXJhdGlvbklkID09PSBmaXJzdEFwcGxpZWQub3BlcmF0aW9uSWQsXG4gICAgXCJyZWNvbmNpbGUgY2hhbmdlZCBvcGVyYXRpb25JZFwiLFxuICApO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiaWRlbXBvdGVudC1hcHBseS1yZWNvbmNpbGVcIixcbiAgICByZWNvbmNpbGVkLnN0ZXBJZCA9PT0gZmlyc3RBcHBsaWVkLnN0ZXBJZCxcbiAgICBcInJlY29uY2lsZSBjaGFuZ2VkIHN0ZXBJZFwiLFxuICApO1xuICBpZiAoXG4gICAgXCJyZXNvdXJjZVwiIGluIGZpcnN0QXBwbGllZCAmJlxuICAgIGZpcnN0QXBwbGllZC5yZXNvdXJjZSAmJlxuICAgIFwicmVzb3VyY2VcIiBpbiByZWNvbmNpbGVkICYmXG4gICAgcmVjb25jaWxlZC5yZXNvdXJjZVxuICApIHtcbiAgICByZXF1aXJlQ29udHJhY3QoXG4gICAgICBjaGVja3MsXG4gICAgICBcImlkZW1wb3RlbnQtYXBwbHktcmVjb25jaWxlXCIsXG4gICAgICByZWNvbmNpbGVkLnJlc291cmNlLnByb3ZpZGVySWQgPT09IGZpcnN0QXBwbGllZC5yZXNvdXJjZS5wcm92aWRlcklkLFxuICAgICAgXCJyZWNvbmNpbGUgcmV0dXJuZWQgYSBkaWZmZXJlbnQgcHJvdmlkZXIgcmVzb3VyY2UgaWRlbnRpdHlcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgaG9zdCA9IHtcbiAgICBob3N0SWQ6IGZpeHR1cmUuZGVzaXJlZC5ob3N0SWQsXG4gICAgdGFyZ2V0OiBwcm92aWRlci50YXJnZXQsXG4gICAgcmVzb3VyY2VzOiBrbm93blJlc291cmNlcyxcbiAgfTtcbiAgY29uc3QgW29ic2VydmF0aW9uLCB0cmFuc3BvcnQsIGhlYWx0aF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgcHJvdmlkZXIub2JzZXJ2ZShob3N0LCBmaXh0dXJlLmNvbnRleHQpLFxuICAgIHByb3ZpZGVyLmdldFRyYW5zcG9ydFByb2ZpbGUoaG9zdCwgZml4dHVyZS5jb250ZXh0KSxcbiAgICBwcm92aWRlci5hdHRlc3RIZWFsdGgoaG9zdCwgZml4dHVyZS5jb250ZXh0KSxcbiAgXSk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJvYnNlcnZhdGlvbi1oZWFsdGgtdHJhbnNwb3J0XCIsXG4gICAgb2JzZXJ2YXRpb24uaG9zdC5ob3N0SWQgPT09IGhvc3QuaG9zdElkLFxuICAgIFwib2JzZXJ2YXRpb24gY2hhbmdlZCBob3N0IGlkZW50aXR5XCIsXG4gICk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJvYnNlcnZhdGlvbi1oZWFsdGgtdHJhbnNwb3J0XCIsXG4gICAgaGVhbHRoLmhvc3RJZCA9PT0gaG9zdC5ob3N0SWQsXG4gICAgXCJoZWFsdGggYXR0ZXN0YXRpb24gY2hhbmdlZCBob3N0IGlkZW50aXR5XCIsXG4gICk7XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJvYnNlcnZhdGlvbi1oZWFsdGgtdHJhbnNwb3J0XCIsXG4gICAgISF0cmFuc3BvcnQua2luZC50cmltKCksXG4gICAgXCJ0cmFuc3BvcnQgcHJvZmlsZSBuZWVkcyBhIGtpbmRcIixcbiAgKTtcbiAgcmVxdWlyZUNvbnRyYWN0KFxuICAgIGNoZWNrcyxcbiAgICBcIm9ic2VydmF0aW9uLWhlYWx0aC10cmFuc3BvcnRcIixcbiAgICBPYmplY3QudmFsdWVzKHRyYW5zcG9ydC5mZWF0dXJlcykuc29tZShCb29sZWFuKSxcbiAgICBcInRyYW5zcG9ydCBwcm9maWxlIGRlY2xhcmVzIG5vIHN1cHBvcnRlZCBmZWF0dXJlXCIsXG4gICk7XG5cbiAgY29uc3QgZGVzdHJveVJlcXVlc3Q6IFdvcmtzcGFjZUhvc3RQbGFuUmVxdWVzdCA9IHtcbiAgICBhY3Rpb246IFwiZGVzdHJveVwiLFxuICAgIG9wZXJhdGlvbklkOiBgJHtmaXh0dXJlLm9wZXJhdGlvbklkfTpkZXN0cm95YCxcbiAgICBpZGVtcG90ZW5jeUtleTogYCR7Zml4dHVyZS5pZGVtcG90ZW5jeUtleX06ZGVzdHJveWAsXG4gICAgaG9zdCxcbiAgICBkaXNwb3NpdGlvbjogXCJkaXNjYXJkXCIsXG4gICAgY29uZmlybWF0aW9uOiB7XG4gICAgICBleHBlY3RlZEhvc3RJZDogaG9zdC5ob3N0SWQsXG4gICAgICBjb25maXJtZWRCeTogZml4dHVyZS5jb25maXJtZWRCeSxcbiAgICAgIGNvbmZpcm1lZEF0OiBub3coKSxcbiAgICB9LFxuICB9O1xuICBjb25zdCBkZXN0cm95UGxhbiA9IGF3YWl0IHByb3ZpZGVyLnBsYW4oZGVzdHJveVJlcXVlc3QsIGZpeHR1cmUuY29udGV4dCk7XG4gIHZhbGlkYXRlUGxhblNoYXBlKGNoZWNrcywgZGVzdHJveVBsYW4sIGRlc3Ryb3lSZXF1ZXN0LCBwcm92aWRlci50YXJnZXQpO1xuICByZXF1aXJlQ29udHJhY3QoXG4gICAgY2hlY2tzLFxuICAgIFwiY29uZmlybWVkLWRlc3Ryb3lcIixcbiAgICBkZXN0cm95UGxhbi5zdGVwcy5zb21lKChzdGVwKSA9PiBzdGVwLmRlc3RydWN0aXZlKSxcbiAgICBcImRlc3Ryb3kgcGxhbiBoYXMgbm8gZGVzdHJ1Y3RpdmUgc3RlcFwiLFxuICApO1xuICBjb25zdCBkZXN0cm95Q29uZmlybWF0aW9uczogV29ya3NwYWNlSG9zdERlc3Ryb3lDb25maXJtYXRpb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHN0ZXAgb2YgZGVzdHJveVBsYW4uc3RlcHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwcm92aWRlci5hcHBseShcbiAgICAgIHtcbiAgICAgICAgcGxhbklkOiBkZXN0cm95UGxhbi5wbGFuSWQsXG4gICAgICAgIG9wZXJhdGlvbklkOiBkZXN0cm95UGxhbi5vcGVyYXRpb25JZCxcbiAgICAgICAgc3RlcCxcbiAgICAgICAga25vd25SZXNvdXJjZXMsXG4gICAgICB9LFxuICAgICAgZml4dHVyZS5jb250ZXh0LFxuICAgICk7XG4gICAgaWYgKCFzdGVwLmRlc3RydWN0aXZlKSBjb250aW51ZTtcbiAgICByZXF1aXJlQ29udHJhY3QoXG4gICAgICBjaGVja3MsXG4gICAgICBcImNvbmZpcm1lZC1kZXN0cm95XCIsXG4gICAgICByZXN1bHQuc3RhdGUgPT09IFwiZGVzdHJveWVkXCIsXG4gICAgICBgZGVzdHJ1Y3RpdmUgc3RlcCAnJHtzdGVwLmlkfScgbGFja3MgYWJzZW5jZSBwcm9vZmAsXG4gICAgKTtcbiAgICBpZiAocmVzdWx0LnN0YXRlID09PSBcImRlc3Ryb3llZFwiKSB7XG4gICAgICByZXF1aXJlQ29udHJhY3QoXG4gICAgICAgIGNoZWNrcyxcbiAgICAgICAgXCJjb25maXJtZWQtZGVzdHJveVwiLFxuICAgICAgICByZXN1bHQuY29uZmlybWF0aW9uLnNvdXJjZSA9PT0gXCJwcm92aWRlci1yZWFkXCIsXG4gICAgICAgIFwiZGVzdHJveSBwcm9vZiBpcyBub3QgYSBmcmVzaCBwcm92aWRlciByZWFkXCIsXG4gICAgICApO1xuICAgICAgcmVxdWlyZUNvbnRyYWN0KFxuICAgICAgICBjaGVja3MsXG4gICAgICAgIFwiY29uZmlybWVkLWRlc3Ryb3lcIixcbiAgICAgICAga25vd25SZXNvdXJjZXMuc29tZShcbiAgICAgICAgICAocmVzb3VyY2UpID0+XG4gICAgICAgICAgICByZXNvdXJjZS5wcm92aWRlcklkID09PSByZXN1bHQuY29uZmlybWF0aW9uLnByb3ZpZGVyUmVzb3VyY2VJZCxcbiAgICAgICAgKSxcbiAgICAgICAgYGRlc3Ryb3kgcHJvb2YgcmVmZXJlbmNlcyB1bmtub3duIHJlc291cmNlICcke3Jlc3VsdC5jb25maXJtYXRpb24ucHJvdmlkZXJSZXNvdXJjZUlkfSdgLFxuICAgICAgKTtcbiAgICAgIGRlc3Ryb3lDb25maXJtYXRpb25zLnB1c2gocmVzdWx0LmNvbmZpcm1hdGlvbik7XG4gICAgfVxuICB9XG4gIHJlcXVpcmVDb250cmFjdChcbiAgICBjaGVja3MsXG4gICAgXCJjb25maXJtZWQtZGVzdHJveVwiLFxuICAgIGRlc3Ryb3lDb25maXJtYXRpb25zLmxlbmd0aCA+IDAsXG4gICAgXCJkZXN0cm95IHJldHVybmVkIG5vIGFic2VuY2UgY29uZmlybWF0aW9uc1wiLFxuICApO1xuXG4gIHJldHVybiB7XG4gICAgc3VpdGVWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9QUk9WSURFUl9DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJlcG9ydFJlZjogZml4dHVyZS5yZXBvcnRSZWYsXG4gICAgdGFyZ2V0OiBwcm92aWRlci50YXJnZXQsXG4gICAgY29tcGxldGVkQXQ6IG5vdygpLFxuICAgIHBhc3NlZDogdHJ1ZSxcbiAgICBjaGVja3M6IFdPUktTUEFDRV9IT1NUX1BST1ZJREVSX0NPTlRSQUNUX0NIRUNLUy5maWx0ZXIoKGNoZWNrKSA9PlxuICAgICAgY2hlY2tzLmluY2x1ZGVzKGNoZWNrKSxcbiAgICApLFxuICAgIHByb3Zpc2lvbmVkUmVzb3VyY2VzOiBrbm93blJlc291cmNlcyxcbiAgICBkZXN0cm95Q29uZmlybWF0aW9ucyxcbiAgfTtcbn1cblxuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEluamVjdGVkRmF1bHRUaW1pbmcgPSBcImJlZm9yZVwiIHwgXCJhZnRlclwiO1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdEluamVjdGVkRmF1bHRDbGFzcyA9XG4gIHwgXCJ0cmFuc2llbnRcIlxuICB8IFwidGhyb3R0bGVkXCJcbiAgfCBcImFtYmlndW91c1wiXG4gIHwgXCJ0ZXJtaW5hbFwiO1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdFNwZWMge1xuICBwb2ludDogc3RyaW5nO1xuICBvY2N1cnJlbmNlOiBudW1iZXI7XG4gIHRpbWluZz86IFdvcmtzcGFjZUhvc3RJbmplY3RlZEZhdWx0VGltaW5nO1xuICByZXRyeUNsYXNzOiBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdENsYXNzO1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RGYXVsdEhpc3RvcnlFbnRyeSB7XG4gIHBvaW50OiBzdHJpbmc7XG4gIG9jY3VycmVuY2U6IG51bWJlcjtcbiAgdGltaW5nOiBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdFRpbWluZztcbiAgdHJpZ2dlcmVkOiBib29sZWFuO1xufVxuXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdEluamVjdGVkRmF1bHQgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKHJlYWRvbmx5IGZhdWx0OiBSZXF1aXJlZDxXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdFNwZWM+KSB7XG4gICAgc3VwZXIoZmF1bHQubWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdFwiO1xuICB9XG59XG5cbi8qKiBEZXRlcm1pbmlzdGljIGJlZm9yZS9hZnRlci1zdWNjZXNzIGZhdWx0cyBmb3IgYW1iaWd1b3VzLXRpbWVvdXQgYW5kIHJldHJ5IHRlc3RzLiAqL1xuZXhwb3J0IGNsYXNzIERldGVybWluaXN0aWNXb3Jrc3BhY2VIb3N0RmF1bHRJbmplY3RvciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgY291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSB0cmlnZ2VyZWQgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSBlbnRyaWVzOiBXb3Jrc3BhY2VIb3N0RmF1bHRIaXN0b3J5RW50cnlbXSA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NyaXB0OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdFNwZWNbXSxcbiAgKSB7XG4gICAgc2NyaXB0LmZvckVhY2goKGZhdWx0LCBpbmRleCkgPT4ge1xuICAgICAgcmVxdWlyZU5vbkVtcHR5KGZhdWx0LnBvaW50LCBgZmF1bHRbJHtpbmRleH1dLnBvaW50YCk7XG4gICAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGZhdWx0Lm9jY3VycmVuY2UpIHx8IGZhdWx0Lm9jY3VycmVuY2UgPCAxKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgZmF1bHRbJHtpbmRleH1dLm9jY3VycmVuY2UgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlcmAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBpbnZva2U8VD4ocG9pbnQ6IHN0cmluZywgb3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+IHwgVCk6IFByb21pc2U8VD4ge1xuICAgIGNvbnN0IG9jY3VycmVuY2UgPSAodGhpcy5jb3VudHMuZ2V0KHBvaW50KSA/PyAwKSArIDE7XG4gICAgdGhpcy5jb3VudHMuc2V0KHBvaW50LCBvY2N1cnJlbmNlKTtcbiAgICBjb25zdCBpbmRleCA9IHRoaXMuc2NyaXB0LmZpbmRJbmRleChcbiAgICAgIChmYXVsdCwgY2FuZGlkYXRlKSA9PlxuICAgICAgICAhdGhpcy50cmlnZ2VyZWQuaGFzKGNhbmRpZGF0ZSkgJiZcbiAgICAgICAgZmF1bHQucG9pbnQgPT09IHBvaW50ICYmXG4gICAgICAgIGZhdWx0Lm9jY3VycmVuY2UgPT09IG9jY3VycmVuY2UsXG4gICAgKTtcbiAgICBjb25zdCBjb25maWd1cmVkID0gaW5kZXggPj0gMCA/IHRoaXMuc2NyaXB0W2luZGV4XSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCB0aW1pbmcgPSBjb25maWd1cmVkPy50aW1pbmcgPz8gXCJiZWZvcmVcIjtcbiAgICBpZiAoY29uZmlndXJlZCAmJiB0aW1pbmcgPT09IFwiYmVmb3JlXCIpIHtcbiAgICAgIHRoaXMudHJpZ2dlcmVkLmFkZChpbmRleCk7XG4gICAgICB0aGlzLmVudHJpZXMucHVzaCh7IHBvaW50LCBvY2N1cnJlbmNlLCB0aW1pbmcsIHRyaWdnZXJlZDogdHJ1ZSB9KTtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdCh7IC4uLmNvbmZpZ3VyZWQsIHRpbWluZyB9KTtcbiAgICB9XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3BlcmF0aW9uKCk7XG4gICAgaWYgKGNvbmZpZ3VyZWQpIHtcbiAgICAgIHRoaXMudHJpZ2dlcmVkLmFkZChpbmRleCk7XG4gICAgICB0aGlzLmVudHJpZXMucHVzaCh7IHBvaW50LCBvY2N1cnJlbmNlLCB0aW1pbmcsIHRyaWdnZXJlZDogdHJ1ZSB9KTtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0SW5qZWN0ZWRGYXVsdCh7IC4uLmNvbmZpZ3VyZWQsIHRpbWluZyB9KTtcbiAgICB9XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goeyBwb2ludCwgb2NjdXJyZW5jZSwgdGltaW5nLCB0cmlnZ2VyZWQ6IGZhbHNlIH0pO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBoaXN0b3J5KCk6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RGYXVsdEhpc3RvcnlFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5lbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IC4uLmVudHJ5IH0pKTtcbiAgfVxuXG4gIHVudHJpZ2dlcmVkRmF1bHRzKCk6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RJbmplY3RlZEZhdWx0U3BlY1tdIHtcbiAgICByZXR1cm4gdGhpcy5zY3JpcHQuZmlsdGVyKChfLCBpbmRleCkgPT4gIXRoaXMudHJpZ2dlcmVkLmhhcyhpbmRleCkpO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENvbnRyYWN0QXBwcm92YWwge1xuICBzdGF0dXM6IFwiYXBwcm92ZWRcIjtcbiAgc3VpdGVWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfUFJPVklERVJfQ09OVFJBQ1RfVkVSU0lPTjtcbiAgcmVwb3J0UmVmOiBzdHJpbmc7XG4gIGFwcHJvdmVkQnk6IHN0cmluZztcbiAgYXBwcm92ZWRBdDogc3RyaW5nO1xufVxuXG4vKipcbiAqIEFVVEhPUklaQVRJT04gdG8gdGVhciBkb3duIGEgY2FuYXJ5IGhvc3Qgd2hvc2UgcnVuIEZBSUxFRCAoRC0yNzMsIHJldmlzZWQgYnkgRC0yNzQpLlxuICpcbiAqIEEgZmFpbGVkIHJ1biBjYW4gbmV2ZXIgcHJvZHVjZSB0aGUgYXBwcm92ZWQgY29udHJhY3QgcmVwb3J0IGEgY29tcGxldGVkIG9uZSBkb2VzLCBiZWNhdXNlIHRoYXRcbiAqIHJlcG9ydCBJUyB0aGUgY29tcGxldGlvbiBhcnRpZmFjdCBvZiBhIHBhc3NpbmcgY2FuYXJ5LiBEZW1hbmRpbmcgaXQgYW55d2F5IG1ha2VzIHRoZSBob3N0cyBtb3N0XG4gKiBsaWtlbHkgdG8gbmVlZCB0ZWFyZG93biBleGFjdGx5IHRoZSBvbmVzIHRoYXQgY2Fubm90IGJlIHRvcm4gZG93bi5cbiAqXG4gKiBJdCBhdXRob3JpemVzIHRoZSB0ZWFyZG93biBhbmQgTk9USElORyBlbHNlLiBJbiBwYXJ0aWN1bGFyIGl0IHNheXMgbm90aGluZyBhYm91dCBzcGVuZDogYSBmYWlsZWRcbiAqIHJ1biBzdGlsbCBwcm92aXNpb25lZCByZXNvdXJjZXMgYW5kIHN0aWxsIGNvc3QgbW9uZXksIGFuZCB0aGF0IG1vbmV5IHNldHRsZXMgd2l0aCB0aGUgcHJvdmlkZXIgb25cbiAqIGl0cyBvd24gY2xvY2ssIGV4YWN0bHkgbGlrZSBhIHN1Y2Nlc3NmdWwgcnVuJ3MuIFdoZXRoZXIgdGhlIHNwZW5kIGlzIGtub3duIHlldCBpcyB0aGUgc2VwYXJhdGVcbiAqIHF1ZXN0aW9uIGBXb3Jrc3BhY2VIb3N0U3BlbmRTZXR0bGVtZW50YCBhbnN3ZXJzIOKAlCBELTI3MyBsZXQgdGhpcyB0eXBlIHN0YW5kIGluIGZvciB0aGF0IG9uZSwgYW5kXG4gKiBELTI3NCBzZXBhcmF0ZWQgdGhlbS5cbiAqXG4gKiBJdCBpcyBhbHNvIGRlbGliZXJhdGVseSBOT1QgdGhlIHNhbWUgaGF0Y2ggYXMgYW4gZW1lcmdlbmN5IG1hbnVhbCBkZXN0cm95LCB3aGljaCB3YWl2ZXMgdGhlIExBQkVMXG4gKiByZXF1aXJlbWVudCBmb3IgYSBob3N0IHByb3Zpc2lvbmVkIGJlZm9yZSB0aGUgY2FuYXJ5IHRhZyBjb250cmFjdCBleGlzdGVkLiBJZGVudGl0eSDigJQgdGhlXG4gKiBpbW11dGFibGUgY2FuYXJ5IGxhYmVscyBhbmQgdGhlIGNvbnRyb2xsZXItaW5kZXBlbmRlbnQgY2Vuc3VzIOKAlCBpcyB3YWl2ZWQgYnkgbmVpdGhlciwgYmVjYXVzZSBpdFxuICogaXMgd2hhdCBwcm92ZXMgdGhlIHJlc291cmNlcyBiZWluZyBkZWxldGVkIGFyZSBvdXJzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RGYWlsZWRSdW5UZWFyZG93biB7XG4gIGFjdG9ySWQ6IHN0cmluZztcbiAgcmVhc29uOiBzdHJpbmc7XG4gIHByb2NlZHVyZVJlZjogc3RyaW5nO1xuICAvKiogVGhlIGZhaWxlZCBvcGVyYXRpb24ocykgdGhpcyB0ZWFyZG93biBjbGVhbnMgdXAgYWZ0ZXI7IGF0IGxlYXN0IG9uZS4gKi9cbiAgZmFpbGVkT3BlcmF0aW9uSWRzOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBTRVRUTEVNRU5UIOKAlCBoYXMgdGhlIHByb3ZpZGVyJ3MgYmlsbGluZyBmb3IgdGhpcyBydW4gc2V0dGxlZCBhdCB0aGUgbW9tZW50IG9mIHRlYXJkb3duPyAoRC0yNzQpXG4gKlxuICogT3J0aG9nb25hbCB0byBhdXRob3JpemF0aW9uOiBhbnkgb2YgdGhlIGZvdXIgY29tYmluYXRpb25zIGNhbiBvY2N1ciwgaW5jbHVkaW5nIGEgZmFpbGVkLXJ1blxuICogdGVhcmRvd24gd2hvc2Ugc3BlbmQgSEFTIHNpbmNlIHNldHRsZWQgYmVjYXVzZSB0aGUgaG9zdCB3YXMgcmV0aXJlZCBkYXlzIGxhdGVyLlxuICpcbiAqIFN1cHBseWluZyB0aGlzIG1lYW5zIHRoZSBzcGVuZCBpcyBnZW51aW5lbHkgbm90IGtub3dhYmxlIHlldC4gYGxhdGVPYnNlcnZlZFNwZW5kYCBpcyBCWVxuICogREVGSU5JVElPTiBcImxlYXJuZWQgYWZ0ZXIgdGhlIGluaXRpYWwgc2V0dGxlXCIsIHNvIGF0IHRoZSBtb21lbnQgdGVhcmRvd24gaXMgd2FudGVkIGl0IGNhbm5vdFxuICogZXhpc3Qg4oCUIGFuZCBwcm92aWRlciBiaWxsaW5nIGxhZ3MgaG91cnMsIHNvIGZvciBhIHNob3J0LWxpdmVkIGNhbmFyeSBuZWl0aGVyIGNhbiB0aGUgc2V0dGxlZFxuICogY3VtdWxhdGl2ZSBjb3N0LiBSZXF1aXJpbmcgdGhlbSByZWdhcmRsZXNzIGlzIG5vdCBhIGdhdGUgYnV0IGFuIG91dGFnZSBvZiB0aGUgZGVsZXRlIHBhdGguXG4gKlxuICogVGhpcyBkb2VzIG5vdCB3YWl2ZSB0aGUgc3BlbmQgY2VpbGluZyDigJQgZGVsZXRpbmcgc29vbmVyIHJlZHVjZXMgc3BlbmQsIG5vdCBpbmNyZWFzZXMgaXQg4oCUIGFuZCBpdFxuICogZG9lcyBub3QgZHJvcCB0aGUgYWNjb3VudGluZzogaXQgcmVjb3JkcyBhIGRhdGVkIG9ibGlnYXRpb24gdG8gcmVjb25jaWxlIGFnYWluc3QgdGhlIHBlcnNpc3RlZFxuICogY29zdCBzaWduYWwsIHdoaWNoIHN1cnZpdmVzIHRlYXJkb3duIG9uIHRoZSBkaXNjYXJkZWQgaG9zdCByb3cuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFNwZW5kU2V0dGxlbWVudCB7XG4gIHN0YXR1czogXCJkZWZlcnJlZFwiO1xuICBhY3RvcklkOiBzdHJpbmc7XG4gIHJlYXNvbjogc3RyaW5nO1xuICBwcm9jZWR1cmVSZWY6IHN0cmluZztcbiAgLyoqIFdoZW4gdGhlIHByb3ZpZGVyJ3MgYmlsbGluZyBpcyBleHBlY3RlZCB0byBoYXZlIHNldHRsZWQsIHNvIHRoZSBvYmxpZ2F0aW9uIGNhbiBiZSBjaGFzZWQuICovXG4gIHJlY29uY2lsZUFmdGVyOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBXb3Jrc3BhY2VIb3N0TGl2ZUNhbmFyeVNwZWNCYXNlIHtcbiAgcnVuSWQ6IHN0cmluZztcbiAgd29ya3NwYWNlSWQ6IHN0cmluZztcbiAgdGFyZ2V0OiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJUYXJnZXQ7XG4gIHNjb3BlOiBXb3Jrc3BhY2VIb3N0U2NvcGVSZWY7XG4gIGNsb3VkQ3JlZGVudGlhbFJlZjogQ2xvdWRDcmVkZW50aWFsUmVmO1xuICAvKiogTWF5IGJlIGxvd2VyIHRoYW4gRC0wMjAncyBjYXAsIG5ldmVyIGhpZ2hlci4gRGVmYXVsdHMgdG8gVVNEIDI1LiAqL1xuICBtYXhTcGVuZENlbnRzPzogbnVtYmVyO1xuICB0ZWFyZG93bkRlYWRsaW5lQXQ6IHN0cmluZztcbiAgLyoqXG4gICAqIFByZXNlbnQgd2hlbiBwcm92aWRlciBiaWxsaW5nIGhhcyBOT1Qgc2V0dGxlZCB5ZXQgKEQtMjc0KS4gT3J0aG9nb25hbCB0byB0aGUgYXV0aG9yaXphdGlvblxuICAgKiBiZWxvdyDigJQgZWl0aGVyIGF1dGhvcml6YXRpb24gbWF5IGNhcnJ5IGl0LiBJdHMgb25seSBlZmZlY3Qgb24gdGhlIGxlZGdlciBpcyB0byBtYXJrIHRoZVxuICAgKiBjb21wbGV0aW9uIHJlY2VpcHQncyBzcGVuZCBhcyBwcm92aXNpb25hbDsgaXQgbmV2ZXIgcmVsYXhlcyB0aGUgc3BlbmQgY2VpbGluZy5cbiAgICovXG4gIHNwZW5kU2V0dGxlbWVudD86IFdvcmtzcGFjZUhvc3RTcGVuZFNldHRsZW1lbnQ7XG59XG5cbi8qKlxuICogQSBjYW5hcnkgbGVkZ2VyIGlzIGF1dGhvcml6ZWQgZWl0aGVyIGJ5IGFuIGFwcHJvdmVkIHByb3ZpZGVyLWNvbnRyYWN0IHJlcG9ydCDigJQgdGhlIG5vcm1hbCBwYXRoLFxuICogYW5kIHRoZSBvbmUgdGhhdCBnYXRlcyBsaXZlIHByb3ZpZGVyIFdPUksg4oCUIG9yIGJ5IGFuIGF1ZGl0ZWQgZmFpbGVkLXJ1biB0ZWFyZG93biwgd2hpY2ggaXNcbiAqIHRlYXJkb3duLW9ubHkuIFRoZSB0d28gYXJlIG11dHVhbGx5IGV4Y2x1c2l2ZSBieSBjb25zdHJ1Y3Rpb24gc28gbmVpdGhlciBjYW4gYmUgc3VwcGxpZWQgYXMgYVxuICogc3RhbmQtaW4gZm9yIHRoZSBvdGhlci5cbiAqL1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdExpdmVDYW5hcnlTcGVjID1cbiAgfCAoV29ya3NwYWNlSG9zdExpdmVDYW5hcnlTcGVjQmFzZSAmIHtcbiAgICAgIGNvbnRyYWN0QXBwcm92YWw6IFdvcmtzcGFjZUhvc3RDb250cmFjdEFwcHJvdmFsO1xuICAgICAgZmFpbGVkUnVuVGVhcmRvd24/OiB1bmRlZmluZWQ7XG4gICAgfSlcbiAgfCAoV29ya3NwYWNlSG9zdExpdmVDYW5hcnlTcGVjQmFzZSAmIHtcbiAgICAgIGNvbnRyYWN0QXBwcm92YWw/OiB1bmRlZmluZWQ7XG4gICAgICBmYWlsZWRSdW5UZWFyZG93bjogV29ya3NwYWNlSG9zdEZhaWxlZFJ1blRlYXJkb3duO1xuICAgIH0pO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDYW5hcnlTcGVuZFJlc2VydmF0aW9uIHtcbiAgaWQ6IHN0cmluZztcbiAgcHVycG9zZTogc3RyaW5nO1xuICBjZW50czogbnVtYmVyO1xuICByZXNlcnZlZEF0OiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDYW5hcnlDb3N0RXZpZGVuY2Uge1xuICByZXNlcnZhdGlvbklkPzogc3RyaW5nO1xuICBjZW50czogbnVtYmVyO1xuICBvYnNlcnZlZEF0OiBzdHJpbmc7XG4gIHByb3ZpZGVyRXZpZGVuY2VSZWY6IHN0cmluZztcbn1cblxuLyoqXG4gKiBPbmUgY3VtdWxhdGl2ZSBwcm92aWRlciBiaWxsaW5nIHNuYXBzaG90LCBwcmVzZXJ2aW5nIHRoZSBwcm92aWRlcidzIGV4YWN0IGludGVnZXItbWljcm9zXG4gKiBhY2NvdW50aW5nIHNlcGFyYXRlbHkgZnJvbSB0aGUgY29uc2VydmF0aXZlIGludGVnZXItY2VudHMgdmFsdWUgdXNlZCBieSBzYWZldHkgZ2F0ZXMuXG4gKlxuICogTWljcm9zIGFyZSBjYW5vbmljYWwgZGVjaW1hbCBzdHJpbmdzIGJlY2F1c2UgdGhlc2Ugb2JzZXJ2YXRpb25zIGFyZSBwZXJzaXN0ZWQgaW4gSlNPTiBhbmQgY2FuXG4gKiBleGNlZWQgSmF2YVNjcmlwdCdzIHNhZmUtaW50ZWdlciByYW5nZS4gQ3JlZGl0cyByZXRhaW4gdGhlIHByb3ZpZGVyIGNvbnZlbnRpb24gb2YgYmVpbmcgemVybyBvclxuICogbmVnYXRpdmU7IHRoZXJlZm9yZSBgbmV0TWljcm9zYCBtdXN0IGVxdWFsIGBncm9zc01pY3JvcyArIGNyZWRpdE1pY3Jvc2AgZXhhY3RseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbklucHV0IHtcbiAgcmVhZG9ubHkgY3VycmVuY3k6IHN0cmluZztcbiAgcmVhZG9ubHkgZ3Jvc3NNaWNyb3M6IHN0cmluZztcbiAgcmVhZG9ubHkgY3JlZGl0TWljcm9zOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG5ldE1pY3Jvczogc3RyaW5nO1xuICByZWFkb25seSBvYnNlcnZlZEF0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByb3ZpZGVyRXZpZGVuY2VSZWY6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbiBleHRlbmRzIFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uSW5wdXQge1xuICAvKiogVXB3YXJkLXJvdW5kZWQgZ3Jvc3MgY2hhcmdlIGV4cG9zdXJlIGZvciB0aGUgZXhpc3RpbmcgaW50ZWdlci1jZW50cyBidWRnZXQgZ2F0ZXMuICovXG4gIHJlYWRvbmx5IGJ1ZGdldENlbnRzOiBudW1iZXI7XG59XG5cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RTcGVuZEZpbmFsaXR5ID1cbiAgfCB7XG4gICAgICByZWFkb25seSBzdGF0dXM6IFwicGVuZGluZ1wiO1xuICAgICAgcmVhZG9ubHkgcmV0cnlhYmxlOiB0cnVlO1xuICAgICAgcmVhZG9ubHkgcmVhc29uOlxuICAgICAgICB8IFwibm8tb2JzZXJ2YXRpb25zXCJcbiAgICAgICAgfCBcImluc3VmZmljaWVudC1vYnNlcnZhdGlvbnNcIlxuICAgICAgICB8IFwidW5zdGFibGVcIlxuICAgICAgICB8IFwic3RhYmlsaXR5LXdpbmRvdy1vcGVuXCI7XG4gICAgICByZWFkb25seSBvYnNlcnZhdGlvbkNvdW50OiBudW1iZXI7XG4gICAgICByZWFkb25seSBzdGFibGVPYnNlcnZhdGlvbkNvdW50OiBudW1iZXI7XG4gICAgICByZWFkb25seSBzdGFibGVGb3JNczogbnVtYmVyO1xuICAgICAgcmVhZG9ubHkgcmVxdWlyZWRTdGFibGVXaW5kb3dNczogbnVtYmVyO1xuICAgIH1cbiAgfCB7XG4gICAgICByZWFkb25seSBzdGF0dXM6IFwic2V0dGxlZFwiO1xuICAgICAgcmVhZG9ubHkgcmV0cnlhYmxlOiBmYWxzZTtcbiAgICAgIHJlYWRvbmx5IG9ic2VydmF0aW9uQ291bnQ6IG51bWJlcjtcbiAgICAgIHJlYWRvbmx5IHN0YWJsZU9ic2VydmF0aW9uQ291bnQ6IG51bWJlcjtcbiAgICAgIHJlYWRvbmx5IHN0YWJsZVNpbmNlOiBzdHJpbmc7XG4gICAgICByZWFkb25seSBzdGFibGVGb3JNczogbnVtYmVyO1xuICAgICAgcmVhZG9ubHkgcmVxdWlyZWRTdGFibGVXaW5kb3dNczogbnVtYmVyO1xuICAgICAgcmVhZG9ubHkgb2JzZXJ2YXRpb246IFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uO1xuICAgIH07XG5cbmNvbnN0IE1JQ1JPU19QRVJfQ0VOVCA9IDEwXzAwMG47XG5jb25zdCBDQU5PTklDQUxfSU5URUdFUl9NSUNST1MgPSAvXig/OjB8WzEtOV1cXGQqfC1bMS05XVxcZCopJC87XG5cbmZ1bmN0aW9uIHJlcXVpcmVDYW5vbmljYWxNaWNyb3ModmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IGJpZ2ludCB7XG4gIGlmICghQ0FOT05JQ0FMX0lOVEVHRVJfTUlDUk9TLnRlc3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYCR7bGFiZWx9IG11c3QgYmUgYSBjYW5vbmljYWwgaW50ZWdlci1taWNyb3MgZGVjaW1hbCBzdHJpbmdgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIEJpZ0ludCh2YWx1ZSk7XG59XG5cbi8qKiBWYWxpZGF0ZSBhbmQgbm9ybWFsaXplIG9uZSBleGFjdCBjdW11bGF0aXZlIHNwZW5kIHNuYXBzaG90LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uKFxuICBpbnB1dDogV29ya3NwYWNlSG9zdFNwZW5kT2JzZXJ2YXRpb25JbnB1dCxcbik6IFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uIHtcbiAgaWYgKCEvXltBLVpdezN9JC8udGVzdChpbnB1dC5jdXJyZW5jeSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzcGVuZCBvYnNlcnZhdGlvbiBjdXJyZW5jeSBtdXN0IGJlIGFuIElTTy00MjE3IGNvZGVcIik7XG4gIH1cbiAgY29uc3QgZ3Jvc3NNaWNyb3MgPSByZXF1aXJlQ2Fub25pY2FsTWljcm9zKFxuICAgIGlucHV0Lmdyb3NzTWljcm9zLFxuICAgIFwic3BlbmQgb2JzZXJ2YXRpb24gZ3Jvc3NNaWNyb3NcIixcbiAgKTtcbiAgY29uc3QgY3JlZGl0TWljcm9zID0gcmVxdWlyZUNhbm9uaWNhbE1pY3JvcyhcbiAgICBpbnB1dC5jcmVkaXRNaWNyb3MsXG4gICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBjcmVkaXRNaWNyb3NcIixcbiAgKTtcbiAgY29uc3QgbmV0TWljcm9zID0gcmVxdWlyZUNhbm9uaWNhbE1pY3JvcyhcbiAgICBpbnB1dC5uZXRNaWNyb3MsXG4gICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBuZXRNaWNyb3NcIixcbiAgKTtcbiAgaWYgKGdyb3NzTWljcm9zIDwgMG4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzcGVuZCBvYnNlcnZhdGlvbiBncm9zc01pY3JvcyBtdXN0IG5vdCBiZSBuZWdhdGl2ZVwiKTtcbiAgfVxuICBpZiAoY3JlZGl0TWljcm9zID4gMG4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzcGVuZCBvYnNlcnZhdGlvbiBjcmVkaXRNaWNyb3MgbXVzdCBub3QgYmUgcG9zaXRpdmVcIik7XG4gIH1cbiAgaWYgKGdyb3NzTWljcm9zICsgY3JlZGl0TWljcm9zICE9PSBuZXRNaWNyb3MpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInNwZW5kIG9ic2VydmF0aW9uIG5ldE1pY3JvcyBtdXN0IGVxdWFsIGdyb3NzTWljcm9zICsgY3JlZGl0TWljcm9zXCIsXG4gICAgKTtcbiAgfVxuICByZXF1aXJlVGltZXN0YW1wKGlucHV0Lm9ic2VydmVkQXQsIFwic3BlbmQgb2JzZXJ2YXRpb24gb2JzZXJ2ZWRBdFwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KFxuICAgIGlucHV0LnByb3ZpZGVyRXZpZGVuY2VSZWYsXG4gICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBwcm92aWRlckV2aWRlbmNlUmVmXCIsXG4gICk7XG4gIGNvbnN0IGJ1ZGdldENlbnRzID0gKGdyb3NzTWljcm9zICsgTUlDUk9TX1BFUl9DRU5UIC0gMW4pIC8gTUlDUk9TX1BFUl9DRU5UO1xuICBpZiAoYnVkZ2V0Q2VudHMgPiBCaWdJbnQoTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBncm9zc01pY3JvcyBleGNlZWRzIHRoZSBzYWZlIGludGVnZXItY2VudHMgYnVkZ2V0IHJhbmdlXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIC4uLmlucHV0LFxuICAgIGJ1ZGdldENlbnRzOiBOdW1iZXIoYnVkZ2V0Q2VudHMpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBzYW1lV29ya3NwYWNlSG9zdFNwZW5kKFxuICBsZWZ0OiBXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbixcbiAgcmlnaHQ6IFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgbGVmdC5jdXJyZW5jeSA9PT0gcmlnaHQuY3VycmVuY3kgJiZcbiAgICBsZWZ0Lmdyb3NzTWljcm9zID09PSByaWdodC5ncm9zc01pY3JvcyAmJlxuICAgIGxlZnQuY3JlZGl0TWljcm9zID09PSByaWdodC5jcmVkaXRNaWNyb3MgJiZcbiAgICBsZWZ0Lm5ldE1pY3JvcyA9PT0gcmlnaHQubmV0TWljcm9zICYmXG4gICAgbGVmdC5idWRnZXRDZW50cyA9PT0gcmlnaHQuYnVkZ2V0Q2VudHNcbiAgKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVXb3Jrc3BhY2VIb3N0U3BlbmRIaXN0b3J5KFxuICBoaXN0b3J5OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbltdLFxuKTogV29ya3NwYWNlSG9zdFNwZW5kT2JzZXJ2YXRpb25bXSB7XG4gIGNvbnN0IHZhbGlkYXRlZDogV29ya3NwYWNlSG9zdFNwZW5kT2JzZXJ2YXRpb25bXSA9IFtdO1xuICBjb25zdCBldmlkZW5jZVJlZnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBoaXN0b3J5KSB7XG4gICAgY29uc3QgcmVidWlsdCA9IGNyZWF0ZVdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uKGVudHJ5KTtcbiAgICBpZiAocmVidWlsdC5idWRnZXRDZW50cyAhPT0gZW50cnkuYnVkZ2V0Q2VudHMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBidWRnZXRDZW50cyBtdXN0IGVxdWFsIHVwd2FyZC1yb3VuZGVkIGdyb3NzTWljcm9zXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwcmV2aW91cyA9IHZhbGlkYXRlZC5hdCgtMSk7XG4gICAgaWYgKHByZXZpb3VzKSB7XG4gICAgICBpZiAoZW50cnkuY3VycmVuY3kgIT09IHByZXZpb3VzLmN1cnJlbmN5KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInNwZW5kIG9ic2VydmF0aW9uIGhpc3RvcnkgY2Fubm90IG1peCBjdXJyZW5jaWVzXCIpO1xuICAgICAgfVxuICAgICAgaWYgKERhdGUucGFyc2UoZW50cnkub2JzZXJ2ZWRBdCkgPD0gRGF0ZS5wYXJzZShwcmV2aW91cy5vYnNlcnZlZEF0KSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBoaXN0b3J5IHRpbWVzdGFtcHMgbXVzdCBpbmNyZWFzZSBzdHJpY3RseVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZXZpZGVuY2VSZWZzLmhhcyhlbnRyeS5wcm92aWRlckV2aWRlbmNlUmVmKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcInNwZW5kIG9ic2VydmF0aW9uIGhpc3RvcnkgY29udGFpbnMgYSBkdXBsaWNhdGUgcHJvdmlkZXJFdmlkZW5jZVJlZlwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgZXZpZGVuY2VSZWZzLmFkZChlbnRyeS5wcm92aWRlckV2aWRlbmNlUmVmKTtcbiAgICB2YWxpZGF0ZWQucHVzaCh7IC4uLmVudHJ5IH0pO1xuICB9XG4gIHJldHVybiB2YWxpZGF0ZWQ7XG59XG5cbi8qKlxuICogQXBwZW5kIGEgcHJvdmlkZXIgc25hcHNob3Qgd2l0aG91dCBldmVyIHJld3JpdGluZyBwcmlvciBoaXN0b3J5LiBBbiBleGFjdCByZXRyeSBjYXJyeWluZyB0aGVcbiAqIHNhbWUgZXZpZGVuY2UgcmVmIGlzIGlkZW1wb3RlbnQ7IGEgY29uZmxpY3RpbmcgcmV1c2Ugb2YgdGhhdCByZWYgaXMgcmVqZWN0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBlbmRXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbihcbiAgaGlzdG9yeTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdFNwZW5kT2JzZXJ2YXRpb25bXSxcbiAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uSW5wdXQsXG4pOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0U3BlbmRPYnNlcnZhdGlvbltdIHtcbiAgY29uc3QgdmFsaWRhdGVkID0gdmFsaWRhdGVXb3Jrc3BhY2VIb3N0U3BlbmRIaXN0b3J5KGhpc3RvcnkpO1xuICBjb25zdCBvYnNlcnZhdGlvbiA9IGNyZWF0ZVdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uKGlucHV0KTtcbiAgY29uc3QgZXhpc3RpbmcgPSB2YWxpZGF0ZWQuZmluZChcbiAgICAoZW50cnkpID0+IGVudHJ5LnByb3ZpZGVyRXZpZGVuY2VSZWYgPT09IG9ic2VydmF0aW9uLnByb3ZpZGVyRXZpZGVuY2VSZWYsXG4gICk7XG4gIGlmIChleGlzdGluZykge1xuICAgIGlmIChcbiAgICAgIGV4aXN0aW5nLm9ic2VydmVkQXQgPT09IG9ic2VydmF0aW9uLm9ic2VydmVkQXQgJiZcbiAgICAgIHNhbWVXb3Jrc3BhY2VIb3N0U3BlbmQoZXhpc3RpbmcsIG9ic2VydmF0aW9uKVxuICAgICkge1xuICAgICAgcmV0dXJuIHZhbGlkYXRlZDtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBwcm92aWRlckV2aWRlbmNlUmVmIGNvbmZsaWN0cyB3aXRoIHByaW9yIGhpc3RvcnlcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHByZXZpb3VzID0gdmFsaWRhdGVkLmF0KC0xKTtcbiAgaWYgKHByZXZpb3VzKSB7XG4gICAgaWYgKG9ic2VydmF0aW9uLmN1cnJlbmN5ICE9PSBwcmV2aW91cy5jdXJyZW5jeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwic3BlbmQgb2JzZXJ2YXRpb24gaGlzdG9yeSBjYW5ub3QgbWl4IGN1cnJlbmNpZXNcIik7XG4gICAgfVxuICAgIGlmIChEYXRlLnBhcnNlKG9ic2VydmF0aW9uLm9ic2VydmVkQXQpIDw9IERhdGUucGFyc2UocHJldmlvdXMub2JzZXJ2ZWRBdCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJzcGVuZCBvYnNlcnZhdGlvbiBoaXN0b3J5IHRpbWVzdGFtcHMgbXVzdCBpbmNyZWFzZSBzdHJpY3RseVwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi52YWxpZGF0ZWQsIG9ic2VydmF0aW9uXTtcbn1cblxuLyoqXG4gKiBBIGN1bXVsYXRpdmUgYmlsbCBpcyBmaW5hbCBvbmx5IGFmdGVyIGF0IGxlYXN0IHR3byBpZGVudGljYWwgdHJhaWxpbmcgc25hcHNob3RzIHNwYW4gdGhlXG4gKiBjYWxsZXIncyBwb3NpdGl2ZSBzdGFiaWxpdHkgd2luZG93LiBFbXB0eSwgY2hhbmdlZCwgb3IgbWVyZWx5IHJlY2VudCByZWFkaW5ncyByZW1haW4gZXhwbGljaXRcbiAqIHJldHJ5YWJsZSBzdGF0ZXM7IG5vbmUgb2YgdGhlbSBhcmUgaW50ZXJwcmV0ZWQgYXMgemVyby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV2YWx1YXRlV29ya3NwYWNlSG9zdFNwZW5kRmluYWxpdHkoXG4gIGhpc3Rvcnk6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RTcGVuZE9ic2VydmF0aW9uW10sXG4gIHJlcXVpcmVkU3RhYmxlV2luZG93TXM6IG51bWJlcixcbik6IFdvcmtzcGFjZUhvc3RTcGVuZEZpbmFsaXR5IHtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyZXF1aXJlZFN0YWJsZVdpbmRvd01zKSB8fFxuICAgIHJlcXVpcmVkU3RhYmxlV2luZG93TXMgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZXF1aXJlZFN0YWJsZVdpbmRvd01zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXJcIik7XG4gIH1cbiAgY29uc3QgdmFsaWRhdGVkID0gdmFsaWRhdGVXb3Jrc3BhY2VIb3N0U3BlbmRIaXN0b3J5KGhpc3RvcnkpO1xuICBpZiAodmFsaWRhdGVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgcmV0cnlhYmxlOiB0cnVlLFxuICAgICAgcmVhc29uOiBcIm5vLW9ic2VydmF0aW9uc1wiLFxuICAgICAgb2JzZXJ2YXRpb25Db3VudDogMCxcbiAgICAgIHN0YWJsZU9ic2VydmF0aW9uQ291bnQ6IDAsXG4gICAgICBzdGFibGVGb3JNczogMCxcbiAgICAgIHJlcXVpcmVkU3RhYmxlV2luZG93TXMsXG4gICAgfTtcbiAgfVxuICBjb25zdCBsYXRlc3QgPSB2YWxpZGF0ZWRbdmFsaWRhdGVkLmxlbmd0aCAtIDFdITtcbiAgbGV0IHN0YWJsZVN0YXJ0SW5kZXggPSB2YWxpZGF0ZWQubGVuZ3RoIC0gMTtcbiAgd2hpbGUgKFxuICAgIHN0YWJsZVN0YXJ0SW5kZXggPiAwICYmXG4gICAgc2FtZVdvcmtzcGFjZUhvc3RTcGVuZCh2YWxpZGF0ZWRbc3RhYmxlU3RhcnRJbmRleCAtIDFdISwgbGF0ZXN0KVxuICApIHtcbiAgICBzdGFibGVTdGFydEluZGV4IC09IDE7XG4gIH1cbiAgY29uc3Qgc3RhYmxlT2JzZXJ2YXRpb25Db3VudCA9IHZhbGlkYXRlZC5sZW5ndGggLSBzdGFibGVTdGFydEluZGV4O1xuICBjb25zdCBzdGFibGVTaW5jZSA9IHZhbGlkYXRlZFtzdGFibGVTdGFydEluZGV4XSEub2JzZXJ2ZWRBdDtcbiAgY29uc3Qgc3RhYmxlRm9yTXMgPSBEYXRlLnBhcnNlKGxhdGVzdC5vYnNlcnZlZEF0KSAtIERhdGUucGFyc2Uoc3RhYmxlU2luY2UpO1xuICBpZiAoc3RhYmxlT2JzZXJ2YXRpb25Db3VudCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgIHJldHJ5YWJsZTogdHJ1ZSxcbiAgICAgIHJlYXNvbjogdmFsaWRhdGVkLmxlbmd0aCA9PT0gMSA/IFwiaW5zdWZmaWNpZW50LW9ic2VydmF0aW9uc1wiIDogXCJ1bnN0YWJsZVwiLFxuICAgICAgb2JzZXJ2YXRpb25Db3VudDogdmFsaWRhdGVkLmxlbmd0aCxcbiAgICAgIHN0YWJsZU9ic2VydmF0aW9uQ291bnQsXG4gICAgICBzdGFibGVGb3JNcyxcbiAgICAgIHJlcXVpcmVkU3RhYmxlV2luZG93TXMsXG4gICAgfTtcbiAgfVxuICBpZiAoc3RhYmxlRm9yTXMgPCByZXF1aXJlZFN0YWJsZVdpbmRvd01zKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICByZXRyeWFibGU6IHRydWUsXG4gICAgICByZWFzb246IFwic3RhYmlsaXR5LXdpbmRvdy1vcGVuXCIsXG4gICAgICBvYnNlcnZhdGlvbkNvdW50OiB2YWxpZGF0ZWQubGVuZ3RoLFxuICAgICAgc3RhYmxlT2JzZXJ2YXRpb25Db3VudCxcbiAgICAgIHN0YWJsZUZvck1zLFxuICAgICAgcmVxdWlyZWRTdGFibGVXaW5kb3dNcyxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgc3RhdHVzOiBcInNldHRsZWRcIixcbiAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgIG9ic2VydmF0aW9uQ291bnQ6IHZhbGlkYXRlZC5sZW5ndGgsXG4gICAgc3RhYmxlT2JzZXJ2YXRpb25Db3VudCxcbiAgICBzdGFibGVTaW5jZSxcbiAgICBzdGFibGVGb3JNcyxcbiAgICByZXF1aXJlZFN0YWJsZVdpbmRvd01zLFxuICAgIG9ic2VydmF0aW9uOiB7IC4uLmxhdGVzdCB9LFxuICB9O1xufVxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2Uge1xuICByZXNvdXJjZTogV29ya3NwYWNlSG9zdFJlc291cmNlUmVmO1xuICB0YWdzOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PjtcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIGRlbGV0aW9uQ29uZmlybWF0aW9uPzogV29ya3NwYWNlSG9zdERlc3Ryb3lDb25maXJtYXRpb247XG59XG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RPYnNlcnZlZENhbmFyeVJlc291cmNlIHtcbiAgcmVzb3VyY2U6IFdvcmtzcGFjZUhvc3RSZXNvdXJjZVJlZjtcbiAgdGFnczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG59XG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDYW5hcnlPcnBoYW5DZW5zdXMge1xuICBjbGVhbjogYm9vbGVhbjtcbiAgb2JzZXJ2ZWRUYWdnZWQ6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RPYnNlcnZlZENhbmFyeVJlc291cmNlW107XG4gIHVudHJhY2tlZDogcmVhZG9ubHkgV29ya3NwYWNlSG9zdE9ic2VydmVkQ2FuYXJ5UmVzb3VyY2VbXTtcbiAgc3RpbGxMaXZlOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2VbXTtcbiAgbWlzc2luZ1dpdGhvdXRSZWNlaXB0OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2VbXTtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdFRlYXJkb3duV2F0Y2hkb2dTdGF0dXMge1xuICBkZWFkbGluZUF0OiBzdHJpbmc7XG4gIG92ZXJkdWU6IGJvb2xlYW47XG4gIHBlbmRpbmc6IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDYW5hcnlSZXNvdXJjZVtdO1xufVxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0TWFudWFsRGVzdHJveVJlY2VpcHQge1xuICBraW5kOiBcIndvcmtzcGFjZS1ob3N0LWVtZXJnZW5jeS1tYW51YWwtZGVzdHJveVwiO1xuICBydW5JZDogc3RyaW5nO1xuICByZXNvdXJjZTogV29ya3NwYWNlSG9zdFJlc291cmNlUmVmO1xuICBhY3RvcklkOiBzdHJpbmc7XG4gIHJlYXNvbjogc3RyaW5nO1xuICBwcm9jZWR1cmVSZWY6IHN0cmluZztcbiAgaXNzdWVkQXQ6IHN0cmluZztcbiAgY29uZmlybWF0aW9uOiBXb3Jrc3BhY2VIb3N0RGVzdHJveUNvbmZpcm1hdGlvbjtcbiAgcHJvdmlkZXJFdmlkZW5jZT86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cbmludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q2FuYXJ5Q29tcGxldGlvblJlY2VpcHRCYXNlIHtcbiAgcnVuSWQ6IHN0cmluZztcbiAgdGFyZ2V0OiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJUYXJnZXQ7XG4gIGNvbXBsZXRlZEF0OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGF0IHRoZSBsZWRnZXIgb2JzZXJ2ZWQuIOKaoCBXaGVuIGBzcGVuZFNldHRsZW1lbnRgIGlzIHByZXNlbnQgdGhpcyBpcyBQUk9WSVNJT05BTCDigJQgcHJvdmlkZXJcbiAgICogYmlsbGluZyBoYWQgbm90IHNldHRsZWQgd2hlbiB0aGUgaG9zdCB3YXMgdG9ybiBkb3duLCBzbyB0aGUgcmVhbCBjb3N0IGlzIGhpZ2hlciBhbmQgYXJyaXZlc1xuICAgKiBsYXRlci4gQSByZWFkZXIgbXVzdCBub3QgcmVwb3J0IGl0IGFzIHRoZSBmaW5hbCBjb3N0IHdpdGhvdXQgY2hlY2tpbmcgdGhhdCBmaWVsZC5cbiAgICovXG4gIHNwZW50Q2VudHM6IG51bWJlcjtcbiAgbWF4U3BlbmRDZW50czogbnVtYmVyO1xuICByZXNvdXJjZUNvdW50OiBudW1iZXI7XG4gIGNvc3RFdmlkZW5jZTogcmVhZG9ubHkgV29ya3NwYWNlSG9zdENhbmFyeUNvc3RFdmlkZW5jZVtdO1xuICAvKipcbiAgICogUHJlc2VudCB3aGVuIHRoZSBzcGVuZCB3YXMgdW5zZXR0bGVkIGF0IHRlYXJkb3duIChELTI3NCk6IGNhcnJpZXMgdGhlIGRhdGVkIG9ibGlnYXRpb24gdG9cbiAgICogcmVjb25jaWxlIHRoaXMgcmVjZWlwdCBhZ2FpbnN0IHRoZSBwcm92aWRlcidzIGxhdGVyIGJpbGxpbmcuXG4gICAqL1xuICBzcGVuZFNldHRsZW1lbnQ/OiBXb3Jrc3BhY2VIb3N0U3BlbmRTZXR0bGVtZW50O1xufVxuXG4vKipcbiAqIE1pcnJvcnMgdGhlIGxlZGdlcidzIGF1dGhvcml6YXRpb24uIEEgY29tcGxldGVkIHJ1biBjaXRlcyBpdHMgYXBwcm92ZWQgY29udHJhY3QgcmVwb3J0OyBhXG4gKiBmYWlsZWQtcnVuIHRlYXJkb3duIGNpdGVzIHRoZSBhdWRpdGVkIHByb2NlZHVyZSBpbnN0ZWFkIGFuZCBzYXlzIHNvLCBzbyBubyByZWFkZXIgb2YgYSBwZXJzaXN0ZWRcbiAqIHJlY2VpcHQgY2FuIG1pc3Rha2Ugb25lIGZvciB0aGUgb3RoZXIuXG4gKi9cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZUhvc3RDYW5hcnlDb21wbGV0aW9uUmVjZWlwdCA9XG4gIHwgKFdvcmtzcGFjZUhvc3RDYW5hcnlDb21wbGV0aW9uUmVjZWlwdEJhc2UgJiB7XG4gICAgICBjb250cmFjdFJlcG9ydFJlZjogc3RyaW5nO1xuICAgICAgZmFpbGVkUnVuVGVhcmRvd24/OiB1bmRlZmluZWQ7XG4gICAgfSlcbiAgfCAoV29ya3NwYWNlSG9zdENhbmFyeUNvbXBsZXRpb25SZWNlaXB0QmFzZSAmIHtcbiAgICAgIGNvbnRyYWN0UmVwb3J0UmVmPzogdW5kZWZpbmVkO1xuICAgICAgZmFpbGVkUnVuVGVhcmRvd246IFdvcmtzcGFjZUhvc3RGYWlsZWRSdW5UZWFyZG93bjtcbiAgICB9KTtcblxuZnVuY3Rpb24gc2FtZVJlc291cmNlKFxuICBhOiBXb3Jrc3BhY2VIb3N0UmVzb3VyY2VSZWYsXG4gIGI6IFdvcmtzcGFjZUhvc3RSZXNvdXJjZVJlZixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGEudGFyZ2V0ID09PSBiLnRhcmdldCAmJiBhLmtpbmQgPT09IGIua2luZCAmJiBhLnByb3ZpZGVySWQgPT09IGIucHJvdmlkZXJJZFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlV29ya3NwYWNlSG9zdE1hbnVhbERlc3Ryb3lSZWNlaXB0KFxuICBpbnB1dDogT21pdDxXb3Jrc3BhY2VIb3N0TWFudWFsRGVzdHJveVJlY2VpcHQsIFwia2luZFwiPixcbik6IFdvcmtzcGFjZUhvc3RNYW51YWxEZXN0cm95UmVjZWlwdCB7XG4gIHJlcXVpcmVOb25FbXB0eShpbnB1dC5ydW5JZCwgXCJtYW51YWwgZGVzdHJveSBydW5JZFwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KGlucHV0LmFjdG9ySWQsIFwibWFudWFsIGRlc3Ryb3kgYWN0b3JJZFwiKTtcbiAgcmVxdWlyZU5vbkVtcHR5KGlucHV0LnJlYXNvbiwgXCJtYW51YWwgZGVzdHJveSByZWFzb25cIik7XG4gIHJlcXVpcmVOb25FbXB0eShpbnB1dC5wcm9jZWR1cmVSZWYsIFwibWFudWFsIGRlc3Ryb3kgcHJvY2VkdXJlUmVmXCIpO1xuICByZXF1aXJlVGltZXN0YW1wKGlucHV0Lmlzc3VlZEF0LCBcIm1hbnVhbCBkZXN0cm95IGlzc3VlZEF0XCIpO1xuICBpZiAoaW5wdXQuY29uZmlybWF0aW9uLnNvdXJjZSAhPT0gXCJwcm92aWRlci1yZWFkXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkVtZXJnZW5jeSBtYW51YWwgZGVzdHJveSByZXF1aXJlcyBhIGZyZXNoIHByb3ZpZGVyLXJlYWQgYWJzZW5jZSBjb25maXJtYXRpb25cIixcbiAgICApO1xuICB9XG4gIGlmIChpbnB1dC5jb25maXJtYXRpb24ucHJvdmlkZXJSZXNvdXJjZUlkICE9PSBpbnB1dC5yZXNvdXJjZS5wcm92aWRlcklkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJFbWVyZ2VuY3kgbWFudWFsIGRlc3Ryb3kgY29uZmlybWF0aW9uIGRvZXMgbm90IG1hdGNoIHRoZSByZXNvdXJjZVwiLFxuICAgICk7XG4gIH1cbiAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICBpbnB1dC5wcm92aWRlckV2aWRlbmNlLFxuICAgIFwibWFudWFsRGVzdHJveS5wcm92aWRlckV2aWRlbmNlXCIsXG4gICk7XG4gIHJldHVybiB7IGtpbmQ6IFwid29ya3NwYWNlLWhvc3QtZW1lcmdlbmN5LW1hbnVhbC1kZXN0cm95XCIsIC4uLmlucHV0IH07XG59XG5cbi8qKlxuICogRmFpbC1jbG9zZWQgbGVkZ2VyIGFyb3VuZCByZWFsIHByb3ZpZGVyIGNhbGxzLiBJdCBvd25zIG5vIHByb3ZpZGVyIGNsaWVudCBhbmRcbiAqIG5vIHNlY3JldCBieXRlczogY2FsbGVycyBtdXN0IHJlc2VydmUgc3BlbmQgYmVmb3JlIGEgbXV0YXRpb24sIGF0dGFjaCB0aGVcbiAqIHJlcXVpcmVkIHJ1biB0YWdzIHRvIGV2ZXJ5IGNyZWF0ZWQgcmVzb3VyY2UsIGFuZCBjbG9zZSB3aXRoIHByb3ZpZGVyLXJlYWRcbiAqIGFic2VuY2UgcGx1cyBjb3N0IGV2aWRlbmNlLlxuICovXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdExpdmVDYW5hcnlIYXJuZXNzIHtcbiAgcmVhZG9ubHkgbWF4U3BlbmRDZW50czogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlc2VydmF0aW9ucyA9IG5ldyBNYXA8XG4gICAgc3RyaW5nLFxuICAgIFdvcmtzcGFjZUhvc3RDYW5hcnlTcGVuZFJlc2VydmF0aW9uXG4gID4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSBjb3N0czogV29ya3NwYWNlSG9zdENhbmFyeUNvc3RFdmlkZW5jZVtdID0gW107XG4gIHByaXZhdGUgcmVhZG9ubHkgcmVzb3VyY2VzOiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2VbXSA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHJlYWRvbmx5IHNwZWM6IFdvcmtzcGFjZUhvc3RMaXZlQ2FuYXJ5U3BlYyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNsb2NrOiAoKSA9PiBzdHJpbmcgPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICkge1xuICAgIHJlcXVpcmVOb25FbXB0eShzcGVjLnJ1bklkLCBcImNhbmFyeSBydW5JZFwiKTtcbiAgICByZXF1aXJlTm9uRW1wdHkoc3BlYy53b3Jrc3BhY2VJZCwgXCJjYW5hcnkgd29ya3NwYWNlSWRcIik7XG4gICAgcmVxdWlyZU5vbkVtcHR5KHNwZWMudGFyZ2V0LCBcImNhbmFyeSB0YXJnZXRcIik7XG4gICAgcmVxdWlyZU5vbkVtcHR5KHNwZWMuc2NvcGUua2luZCwgXCJjYW5hcnkgc2NvcGUua2luZFwiKTtcbiAgICByZXF1aXJlTm9uRW1wdHkoc3BlYy5zY29wZS5pZCwgXCJjYW5hcnkgc2NvcGUuaWRcIik7XG4gICAgaWYgKFxuICAgICAgc3BlYy5jbG91ZENyZWRlbnRpYWxSZWYua2luZCAhPT0gXCJjbG91ZFwiIHx8XG4gICAgICAhc3BlYy5jbG91ZENyZWRlbnRpYWxSZWYucmVmLnRyaW0oKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkxpdmUgY2FuYXJ5IHJlcXVpcmVzIGEgbm9uLWVtcHR5IHR5cGVkIGNsb3VkQ3JlZGVudGlhbFJlZlwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHNwZWMuc3BlbmRTZXR0bGVtZW50KSByZXF1aXJlU3BlbmRTZXR0bGVtZW50KHNwZWMuc3BlbmRTZXR0bGVtZW50KTtcbiAgICBpZiAoc3BlYy5mYWlsZWRSdW5UZWFyZG93bikge1xuICAgICAgLy8gVGVhcmRvd24tb25seSBhdXRob3JpemF0aW9uOiBpdCBzdGFuZHMgaW4gZm9yIHRoZSBhcHByb3ZlZCBjb250cmFjdCByZXBvcnQgYSBmYWlsZWQgcnVuIGNhblxuICAgICAgLy8gbmV2ZXIgcHJvZHVjZSwgbmV2ZXIgZm9yIHByb3ZpZGVyIHdvcmsuIE5vdGhpbmcgYmVsb3cgdGhpcyBicmFuY2ggY3JlYXRlcyBvciBtdXRhdGVzIGFcbiAgICAgIC8vIHJlc291cmNlLiBJdCBzYXlzIG5vdGhpbmcgYWJvdXQgc3BlbmQg4oCUIHRoYXQgaXMgc3BlbmRTZXR0bGVtZW50J3MgcXVlc3Rpb24gKEQtMjc0KS5cbiAgICAgIHJlcXVpcmVGYWlsZWRSdW5UZWFyZG93bihzcGVjLmZhaWxlZFJ1blRlYXJkb3duKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgYXBwcm92YWwgPSBzcGVjLmNvbnRyYWN0QXBwcm92YWw7XG4gICAgICBpZiAoXG4gICAgICAgICFhcHByb3ZhbCB8fFxuICAgICAgICBhcHByb3ZhbC5zdGF0dXMgIT09IFwiYXBwcm92ZWRcIiB8fFxuICAgICAgICBhcHByb3ZhbC5zdWl0ZVZlcnNpb24gIT09IFdPUktTUEFDRV9IT1NUX1BST1ZJREVSX0NPTlRSQUNUX1ZFUlNJT04gfHxcbiAgICAgICAgIWFwcHJvdmFsLnJlcG9ydFJlZj8udHJpbSgpIHx8XG4gICAgICAgICFhcHByb3ZhbC5hcHByb3ZlZEJ5Py50cmltKClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJMaXZlIHByb3ZpZGVyIHdvcmsgaXMgYmxvY2tlZCB1bnRpbCB0aGUgY3VycmVudCBmYWtlLXByb3ZpZGVyIGNvbnRyYWN0IHJlcG9ydCBpcyBhcHByb3ZlZFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmVxdWlyZVRpbWVzdGFtcChhcHByb3ZhbC5hcHByb3ZlZEF0LCBcImNvbnRyYWN0QXBwcm92YWwuYXBwcm92ZWRBdFwiKTtcbiAgICB9XG4gICAgcmVxdWlyZVRpbWVzdGFtcChzcGVjLnRlYXJkb3duRGVhZGxpbmVBdCwgXCJ0ZWFyZG93bkRlYWRsaW5lQXRcIik7XG4gICAgdGhpcy5tYXhTcGVuZENlbnRzID1cbiAgICAgIHNwZWMubWF4U3BlbmRDZW50cyA/PyBXT1JLU1BBQ0VfSE9TVF9MSVZFX0NBTkFSWV9NQVhfU1BFTkRfQ0VOVFM7XG4gICAgcmVxdWlyZUNlbnRzKHRoaXMubWF4U3BlbmRDZW50cywgXCJtYXhTcGVuZENlbnRzXCIpO1xuICAgIGlmIChcbiAgICAgIHRoaXMubWF4U3BlbmRDZW50cyA9PT0gMCB8fFxuICAgICAgdGhpcy5tYXhTcGVuZENlbnRzID4gV09SS1NQQUNFX0hPU1RfTElWRV9DQU5BUllfTUFYX1NQRU5EX0NFTlRTXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBMaXZlIGNhbmFyeSBtYXhTcGVuZENlbnRzIG11c3QgYmUgYmV0d2VlbiAxIGFuZCAke1dPUktTUEFDRV9IT1NUX0xJVkVfQ0FOQVJZX01BWF9TUEVORF9DRU5UU31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihzcGVjLnNjb3BlLCBcImNhbmFyeS5zY29wZVwiKTtcbiAgfVxuXG4gIHRhZ3MoXG4gICAgZXh0cmE6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0ge30sXG4gICk6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcbiAgICBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uKGV4dHJhLCBcImNhbmFyeS50YWdzXCIpO1xuICAgIC8vIFNhbWUgc3ludGhlc2l6ZXIgdGhlIHByb3Zpc2lvbiByb3V0ZSB1c2VzLCBzbyBhIGZha2UtcHJvdmlkZXIgaG9zdCBhbmQgYSByZWFsIG9uZSBjYXJyeVxuICAgIC8vIGJ5dGUtaWRlbnRpY2FsIGlkZW50aXR5IGxhYmVscyBhbmQgdGhlIGRlc3Ryb3kgZ2F0ZSBjYW5ub3QgYmUgc2F0aXNmaWVkIGhlcmUgaW4gYSB3YXkgdGhlXG4gICAgLy8gcHJvZHVjdCBwYXRoIGNvdWxkIG5vdCByZXByb2R1Y2UuXG4gICAgY29uc3QgcmVxdWlyZWQgPSB3b3Jrc3BhY2VIb3N0Q2FuYXJ5SWRlbnRpdHlMYWJlbHMoe1xuICAgICAgcnVuSWQ6IHRoaXMuc3BlYy5ydW5JZCxcbiAgICAgIHdvcmtzcGFjZUlkOiB0aGlzLnNwZWMud29ya3NwYWNlSWQsXG4gICAgfSk7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocmVxdWlyZWQpKSB7XG4gICAgICBpZiAoa2V5IGluIGV4dHJhICYmIGV4dHJhW2tleV0gIT09IHJlcXVpcmVkW2tleV0pXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2FuYXJ5IHRhZyAnJHtrZXl9JyBjYW5ub3QgYmUgb3ZlcnJpZGRlbmApO1xuICAgIH1cbiAgICByZXR1cm4geyAuLi5leHRyYSwgLi4ucmVxdWlyZWQgfTtcbiAgfVxuXG4gIHByaXZhdGUgbm93TWlsbGlzKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHJlcXVpcmVUaW1lc3RhbXAodGhpcy5jbG9jaygpLCBcImNhbmFyeSBjbG9ja1wiKTtcbiAgfVxuXG4gIHByaXZhdGUgc3BlbnRDZW50cygpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmNvc3RzLnJlZHVjZSgodG90YWwsIGVudHJ5KSA9PiB0b3RhbCArIGVudHJ5LmNlbnRzLCAwKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVzZXJ2ZWRDZW50cygpOiBudW1iZXIge1xuICAgIHJldHVybiBbLi4udGhpcy5yZXNlcnZhdGlvbnMudmFsdWVzKCldLnJlZHVjZShcbiAgICAgICh0b3RhbCwgZW50cnkpID0+IHRvdGFsICsgZW50cnkuY2VudHMsXG4gICAgICAwLFxuICAgICk7XG4gIH1cblxuICBhc3NlcnRDYW5TdGFydFByb3ZpZGVyV29yaygpOiB2b2lkIHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm5vd01pbGxpcygpID49XG4gICAgICByZXF1aXJlVGltZXN0YW1wKHRoaXMuc3BlYy50ZWFyZG93bkRlYWRsaW5lQXQsIFwidGVhcmRvd25EZWFkbGluZUF0XCIpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiTGl2ZSBjYW5hcnkgdGVhcmRvd24gZGVhZGxpbmUgaGFzIHBhc3NlZDsgcHJvdmlkZXIgbXV0YXRpb25zIGFyZSBibG9ja2VkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAodGhpcy5zcGVudENlbnRzKCkgPiB0aGlzLm1heFNwZW5kQ2VudHMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJMaXZlIGNhbmFyeSBzcGVuZCBjZWlsaW5nIGhhcyBiZWVuIGV4Y2VlZGVkOyBwcm92aWRlciBtdXRhdGlvbnMgYXJlIGJsb2NrZWRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmVzZXJ2ZVNwZW5kKFxuICAgIGlucHV0OiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5U3BlbmRSZXNlcnZhdGlvbixcbiAgKTogV29ya3NwYWNlSG9zdENhbmFyeVNwZW5kUmVzZXJ2YXRpb24ge1xuICAgIHRoaXMuYXNzZXJ0Q2FuU3RhcnRQcm92aWRlcldvcmsoKTtcbiAgICByZXF1aXJlTm9uRW1wdHkoaW5wdXQuaWQsIFwic3BlbmQgcmVzZXJ2YXRpb24gaWRcIik7XG4gICAgcmVxdWlyZU5vbkVtcHR5KGlucHV0LnB1cnBvc2UsIFwic3BlbmQgcmVzZXJ2YXRpb24gcHVycG9zZVwiKTtcbiAgICByZXF1aXJlQ2VudHMoaW5wdXQuY2VudHMsIFwic3BlbmQgcmVzZXJ2YXRpb24gY2VudHNcIik7XG4gICAgcmVxdWlyZVRpbWVzdGFtcChpbnB1dC5yZXNlcnZlZEF0LCBcInNwZW5kIHJlc2VydmF0aW9uIHJlc2VydmVkQXRcIik7XG4gICAgaWYgKGlucHV0LmNlbnRzID09PSAwKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU3BlbmQgcmVzZXJ2YXRpb25zIG11c3QgYmUgcG9zaXRpdmVcIik7XG4gICAgaWYgKFxuICAgICAgdGhpcy5yZXNlcnZhdGlvbnMuaGFzKGlucHV0LmlkKSB8fFxuICAgICAgdGhpcy5jb3N0cy5zb21lKChlbnRyeSkgPT4gZW50cnkucmVzZXJ2YXRpb25JZCA9PT0gaW5wdXQuaWQpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYER1cGxpY2F0ZSBzcGVuZCByZXNlcnZhdGlvbiAnJHtpbnB1dC5pZH0nYCk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHRoaXMuc3BlbnRDZW50cygpICsgdGhpcy5yZXNlcnZlZENlbnRzKCkgKyBpbnB1dC5jZW50cyA+XG4gICAgICB0aGlzLm1heFNwZW5kQ2VudHNcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYExpdmUgY2FuYXJ5IHNwZW5kIHJlc2VydmF0aW9uICcke2lucHV0LmlkfScgd291bGQgZXhjZWVkIHRoZSAke3RoaXMubWF4U3BlbmRDZW50c30tY2VudCBjZWlsaW5nYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHN0b3JlZCA9IHsgLi4uaW5wdXQgfTtcbiAgICB0aGlzLnJlc2VydmF0aW9ucy5zZXQoc3RvcmVkLmlkLCBzdG9yZWQpO1xuICAgIHJldHVybiB7IC4uLnN0b3JlZCB9O1xuICB9XG5cbiAgc2V0dGxlU3BlbmQoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDYW5hcnlDb3N0RXZpZGVuY2UgJiB7IHJlc2VydmF0aW9uSWQ6IHN0cmluZyB9LFxuICApOiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5Q29zdEV2aWRlbmNlIHtcbiAgICBjb25zdCByZXNlcnZhdGlvbiA9IHRoaXMucmVzZXJ2YXRpb25zLmdldChpbnB1dC5yZXNlcnZhdGlvbklkKTtcbiAgICBpZiAoIXJlc2VydmF0aW9uKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHNwZW5kIHJlc2VydmF0aW9uICcke2lucHV0LnJlc2VydmF0aW9uSWR9J2ApO1xuICAgIHJlcXVpcmVDZW50cyhpbnB1dC5jZW50cywgXCJzZXR0bGVkIHNwZW5kIGNlbnRzXCIpO1xuICAgIHJlcXVpcmVUaW1lc3RhbXAoaW5wdXQub2JzZXJ2ZWRBdCwgXCJzZXR0bGVkIHNwZW5kIG9ic2VydmVkQXRcIik7XG4gICAgcmVxdWlyZU5vbkVtcHR5KFxuICAgICAgaW5wdXQucHJvdmlkZXJFdmlkZW5jZVJlZixcbiAgICAgIFwic2V0dGxlZCBzcGVuZCBwcm92aWRlckV2aWRlbmNlUmVmXCIsXG4gICAgKTtcbiAgICB0aGlzLnJlc2VydmF0aW9ucy5kZWxldGUoaW5wdXQucmVzZXJ2YXRpb25JZCk7XG4gICAgY29uc3Qgc3RvcmVkID0geyAuLi5pbnB1dCB9O1xuICAgIHRoaXMuY29zdHMucHVzaChzdG9yZWQpO1xuICAgIHJldHVybiB7IC4uLnN0b3JlZCB9O1xuICB9XG5cbiAgLyoqIFJlY29yZCBwYXNzaXZlL3Byb3ZpZGVyLWRlbGF5ZWQgYmlsbGluZyBldmlkZW5jZSBldmVuIGlmIGl0IHJldmVhbHMgYW4gb3ZlcnJ1bi4gKi9cbiAgcmVjb3JkT2JzZXJ2ZWRTcGVuZChcbiAgICBpbnB1dDogV29ya3NwYWNlSG9zdENhbmFyeUNvc3RFdmlkZW5jZSxcbiAgKTogV29ya3NwYWNlSG9zdENhbmFyeUNvc3RFdmlkZW5jZSB7XG4gICAgaWYgKGlucHV0LnJlc2VydmF0aW9uSWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVc2Ugc2V0dGxlU3BlbmQgZm9yIHJlc2VydmVkIHByb3ZpZGVyIHdvcmtcIik7XG4gICAgcmVxdWlyZUNlbnRzKGlucHV0LmNlbnRzLCBcIm9ic2VydmVkIHNwZW5kIGNlbnRzXCIpO1xuICAgIHJlcXVpcmVUaW1lc3RhbXAoaW5wdXQub2JzZXJ2ZWRBdCwgXCJvYnNlcnZlZCBzcGVuZCBvYnNlcnZlZEF0XCIpO1xuICAgIHJlcXVpcmVOb25FbXB0eShcbiAgICAgIGlucHV0LnByb3ZpZGVyRXZpZGVuY2VSZWYsXG4gICAgICBcIm9ic2VydmVkIHNwZW5kIHByb3ZpZGVyRXZpZGVuY2VSZWZcIixcbiAgICApO1xuICAgIGNvbnN0IHN0b3JlZCA9IHsgLi4uaW5wdXQgfTtcbiAgICB0aGlzLmNvc3RzLnB1c2goc3RvcmVkKTtcbiAgICByZXR1cm4geyAuLi5zdG9yZWQgfTtcbiAgfVxuXG4gIHByaXZhdGUgc3RvcmVSZXNvdXJjZShcbiAgICBpbnB1dDogV29ya3NwYWNlSG9zdENhbmFyeVJlc291cmNlLFxuICAgIG9wdGlvbnM6IHsgYWRtaXRQcm92aWRlcldvcms6IGJvb2xlYW4gfSxcbiAgKTogV29ya3NwYWNlSG9zdENhbmFyeVJlc291cmNlIHtcbiAgICBpZiAob3B0aW9ucy5hZG1pdFByb3ZpZGVyV29yaykgdGhpcy5hc3NlcnRDYW5TdGFydFByb3ZpZGVyV29yaygpO1xuICAgIHJlcXVpcmVUaW1lc3RhbXAoaW5wdXQuY3JlYXRlZEF0LCBcImNhbmFyeSByZXNvdXJjZSBjcmVhdGVkQXRcIik7XG4gICAgaWYgKGlucHV0LnJlc291cmNlLnRhcmdldCAhPT0gdGhpcy5zcGVjLnRhcmdldClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbmFyeSByZXNvdXJjZSB0YXJnZXQgZG9lcyBub3QgbWF0Y2ggdGhlIHJ1biB0YXJnZXRcIik7XG4gICAgY29uc3QgcmVxdWlyZWRUYWdzID0gdGhpcy50YWdzKCk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVxdWlyZWRUYWdzKSkge1xuICAgICAgaWYgKGlucHV0LnRhZ3Nba2V5XSAhPT0gdmFsdWUpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQ2FuYXJ5IHJlc291cmNlIGlzIG1pc3NpbmcgcmVxdWlyZWQgdGFnICcke2tleX09JHt2YWx1ZX0nYCxcbiAgICAgICAgKTtcbiAgICB9XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihpbnB1dC50YWdzLCBcImNhbmFyeS5yZXNvdXJjZS50YWdzXCIpO1xuICAgIGlmIChcbiAgICAgIHRoaXMucmVzb3VyY2VzLnNvbWUoKGVudHJ5KSA9PlxuICAgICAgICBzYW1lUmVzb3VyY2UoZW50cnkucmVzb3VyY2UsIGlucHV0LnJlc291cmNlKSxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENhbmFyeSByZXNvdXJjZSAnJHtpbnB1dC5yZXNvdXJjZS5wcm92aWRlcklkfScgaXMgYWxyZWFkeSByZWdpc3RlcmVkYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHN0b3JlZCA9IHsgLi4uaW5wdXQsIHRhZ3M6IHsgLi4uaW5wdXQudGFncyB9IH07XG4gICAgdGhpcy5yZXNvdXJjZXMucHVzaChzdG9yZWQpO1xuICAgIHJldHVybiB7IC4uLnN0b3JlZCwgdGFnczogeyAuLi5zdG9yZWQudGFncyB9IH07XG4gIH1cblxuICByZWdpc3RlclJlc291cmNlKFxuICAgIGlucHV0OiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2UsXG4gICk6IFdvcmtzcGFjZUhvc3RDYW5hcnlSZXNvdXJjZSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmVSZXNvdXJjZShpbnB1dCwgeyBhZG1pdFByb3ZpZGVyV29yazogdHJ1ZSB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWh5ZHJhdGUgYSByZXNvdXJjZSB0aGF0IHdhcyByZWdpc3RlcmVkIGJlZm9yZSBhIGNvbnRyb2xsZXIgcmVzdGFydC5cbiAgICpcbiAgICogVGhpcyB2YWxpZGF0ZXMgdGhlIHNhbWUgaWRlbnRpdHkvdGFnIGNvbnRyYWN0IGFzIHJlZ2lzdGVyUmVzb3VyY2UgYnV0IGRlbGliZXJhdGVseSBkb2VzIG5vdFxuICAgKiBhZG1pdCBuZXcgcHJvdmlkZXIgd29yayBvciByZS1hcHBseSB0aGUgdGVhcmRvd24gZGVhZGxpbmUuIERlc3Ryb3kgbXVzdCByZW1haW4gcmVjb3ZlcmFibGVcbiAgICogYWZ0ZXIgaXRzIGRlYWRsaW5lOyB0cmVhdGluZyBkdXJhYmxlLWxlZGdlciByZXBsYXkgYXMgYSBuZXcgY3JlYXRlIHdvdWxkIHN0cmFuZCB0aGUgdmVyeVxuICAgKiByZXNvdXJjZXMgdGhlIGRlYWRsaW5lIGV4aXN0cyB0byByZW1vdmUuXG4gICAqL1xuICByZXN0b3JlUmVnaXN0ZXJlZFJlc291cmNlKFxuICAgIGlucHV0OiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5UmVzb3VyY2UsXG4gICk6IFdvcmtzcGFjZUhvc3RDYW5hcnlSZXNvdXJjZSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmVSZXNvdXJjZShpbnB1dCwgeyBhZG1pdFByb3ZpZGVyV29yazogZmFsc2UgfSk7XG4gIH1cblxuICBjb25maXJtUmVzb3VyY2VBYnNlbnQoY29uZmlybWF0aW9uOiBXb3Jrc3BhY2VIb3N0RGVzdHJveUNvbmZpcm1hdGlvbik6IHZvaWQge1xuICAgIGlmIChjb25maXJtYXRpb24uc291cmNlICE9PSBcInByb3ZpZGVyLXJlYWRcIilcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJlc291cmNlIGRlbGV0aW9uIHJlcXVpcmVzIHByb3ZpZGVyLXJlYWQgYWJzZW5jZSBwcm9vZlwiKTtcbiAgICByZXF1aXJlVGltZXN0YW1wKGNvbmZpcm1hdGlvbi5jb25maXJtZWRBYnNlbnRBdCwgXCJjb25maXJtZWRBYnNlbnRBdFwiKTtcbiAgICBjb25zdCByZWNvcmQgPSB0aGlzLnJlc291cmNlcy5maW5kKFxuICAgICAgKGVudHJ5KSA9PiBlbnRyeS5yZXNvdXJjZS5wcm92aWRlcklkID09PSBjb25maXJtYXRpb24ucHJvdmlkZXJSZXNvdXJjZUlkLFxuICAgICk7XG4gICAgaWYgKCFyZWNvcmQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBEZXN0cm95IGNvbmZpcm1hdGlvbiByZWZlcmVuY2VzIHVucmVnaXN0ZXJlZCByZXNvdXJjZSAnJHtjb25maXJtYXRpb24ucHJvdmlkZXJSZXNvdXJjZUlkfSdgLFxuICAgICAgKTtcbiAgICByZWNvcmQuZGVsZXRpb25Db25maXJtYXRpb24gPSB7IC4uLmNvbmZpcm1hdGlvbiB9O1xuICB9XG5cbiAgcmVjb3JkTWFudWFsRGVzdHJveVJlY2VpcHQocmVjZWlwdDogV29ya3NwYWNlSG9zdE1hbnVhbERlc3Ryb3lSZWNlaXB0KTogdm9pZCB7XG4gICAgaWYgKFxuICAgICAgcmVjZWlwdC5raW5kICE9PSBcIndvcmtzcGFjZS1ob3N0LWVtZXJnZW5jeS1tYW51YWwtZGVzdHJveVwiIHx8XG4gICAgICByZWNlaXB0LnJ1bklkICE9PSB0aGlzLnNwZWMucnVuSWRcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJNYW51YWwgZGVzdHJveSByZWNlaXB0IGRvZXMgbm90IGJlbG9uZyB0byB0aGlzIGNhbmFyeSBydW5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGNoZWNrZWQgPSBjcmVhdGVXb3Jrc3BhY2VIb3N0TWFudWFsRGVzdHJveVJlY2VpcHQocmVjZWlwdCk7XG4gICAgY29uc3QgcmVjb3JkID0gdGhpcy5yZXNvdXJjZXMuZmluZCgoZW50cnkpID0+XG4gICAgICBzYW1lUmVzb3VyY2UoZW50cnkucmVzb3VyY2UsIGNoZWNrZWQucmVzb3VyY2UpLFxuICAgICk7XG4gICAgaWYgKCFyZWNvcmQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBNYW51YWwgZGVzdHJveSByZWNlaXB0IHJlZmVyZW5jZXMgdW5yZWdpc3RlcmVkIHJlc291cmNlICcke2NoZWNrZWQucmVzb3VyY2UucHJvdmlkZXJJZH0nYCxcbiAgICAgICk7XG4gICAgcmVjb3JkLmRlbGV0aW9uQ29uZmlybWF0aW9uID0geyAuLi5jaGVja2VkLmNvbmZpcm1hdGlvbiB9O1xuICB9XG5cbiAgdGVhcmRvd25XYXRjaGRvZyhhdCA9IHRoaXMuY2xvY2soKSk6IFdvcmtzcGFjZUhvc3RUZWFyZG93bldhdGNoZG9nU3RhdHVzIHtcbiAgICBjb25zdCBub3cgPSByZXF1aXJlVGltZXN0YW1wKGF0LCBcInRlYXJkb3duIHdhdGNoZG9nIHRpbWVcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IHRoaXMucmVzb3VyY2VzLmZpbHRlcihcbiAgICAgIChlbnRyeSkgPT4gIWVudHJ5LmRlbGV0aW9uQ29uZmlybWF0aW9uLFxuICAgICk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRlYWRsaW5lQXQ6IHRoaXMuc3BlYy50ZWFyZG93bkRlYWRsaW5lQXQsXG4gICAgICBvdmVyZHVlOlxuICAgICAgICBwZW5kaW5nLmxlbmd0aCA+IDAgJiZcbiAgICAgICAgbm93ID49XG4gICAgICAgICAgcmVxdWlyZVRpbWVzdGFtcCh0aGlzLnNwZWMudGVhcmRvd25EZWFkbGluZUF0LCBcInRlYXJkb3duRGVhZGxpbmVBdFwiKSxcbiAgICAgIHBlbmRpbmc6IHBlbmRpbmcubWFwKChlbnRyeSkgPT4gKHsgLi4uZW50cnksIHRhZ3M6IHsgLi4uZW50cnkudGFncyB9IH0pKSxcbiAgICB9O1xuICB9XG5cbiAgb3JwaGFuQ2Vuc3VzKFxuICAgIG9ic2VydmVkOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0T2JzZXJ2ZWRDYW5hcnlSZXNvdXJjZVtdLFxuICApOiBXb3Jrc3BhY2VIb3N0Q2FuYXJ5T3JwaGFuQ2Vuc3VzIHtcbiAgICBjb25zdCB0YWdnZWQgPSBvYnNlcnZlZC5maWx0ZXIoXG4gICAgICAoZW50cnkpID0+XG4gICAgICAgIGVudHJ5LnRhZ3NbV09SS1NQQUNFX0hPU1RfQ0FOQVJZX1RBR19LRVlTLnJ1bklkXSA9PT0gdGhpcy5zcGVjLnJ1bklkLFxuICAgICk7XG4gICAgY29uc3QgdW50cmFja2VkID0gdGFnZ2VkLmZpbHRlcihcbiAgICAgIChlbnRyeSkgPT5cbiAgICAgICAgIXRoaXMucmVzb3VyY2VzLnNvbWUoKGtub3duKSA9PlxuICAgICAgICAgIHNhbWVSZXNvdXJjZShrbm93bi5yZXNvdXJjZSwgZW50cnkucmVzb3VyY2UpLFxuICAgICAgICApLFxuICAgICk7XG4gICAgY29uc3Qgc3RpbGxMaXZlID0gdGhpcy5yZXNvdXJjZXMuZmlsdGVyKFxuICAgICAgKGtub3duKSA9PlxuICAgICAgICAha25vd24uZGVsZXRpb25Db25maXJtYXRpb24gJiZcbiAgICAgICAgdGFnZ2VkLnNvbWUoKGVudHJ5KSA9PiBzYW1lUmVzb3VyY2Uoa25vd24ucmVzb3VyY2UsIGVudHJ5LnJlc291cmNlKSksXG4gICAgKTtcbiAgICBjb25zdCBtaXNzaW5nV2l0aG91dFJlY2VpcHQgPSB0aGlzLnJlc291cmNlcy5maWx0ZXIoXG4gICAgICAoa25vd24pID0+XG4gICAgICAgICFrbm93bi5kZWxldGlvbkNvbmZpcm1hdGlvbiAmJlxuICAgICAgICAhdGFnZ2VkLnNvbWUoKGVudHJ5KSA9PiBzYW1lUmVzb3VyY2Uoa25vd24ucmVzb3VyY2UsIGVudHJ5LnJlc291cmNlKSksXG4gICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgY2xlYW46XG4gICAgICAgIHRhZ2dlZC5sZW5ndGggPT09IDAgJiZcbiAgICAgICAgdGhpcy5yZXNvdXJjZXMuZXZlcnkoKGVudHJ5KSA9PiAhIWVudHJ5LmRlbGV0aW9uQ29uZmlybWF0aW9uKSxcbiAgICAgIG9ic2VydmVkVGFnZ2VkOiB0YWdnZWQubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uZW50cnksXG4gICAgICAgIHRhZ3M6IHsgLi4uZW50cnkudGFncyB9LFxuICAgICAgfSkpLFxuICAgICAgdW50cmFja2VkOiB1bnRyYWNrZWQubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uZW50cnksXG4gICAgICAgIHRhZ3M6IHsgLi4uZW50cnkudGFncyB9LFxuICAgICAgfSkpLFxuICAgICAgc3RpbGxMaXZlOiBzdGlsbExpdmUubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uZW50cnksXG4gICAgICAgIHRhZ3M6IHsgLi4uZW50cnkudGFncyB9LFxuICAgICAgfSkpLFxuICAgICAgbWlzc2luZ1dpdGhvdXRSZWNlaXB0OiBtaXNzaW5nV2l0aG91dFJlY2VpcHQubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgICAgLi4uZW50cnksXG4gICAgICAgIHRhZ3M6IHsgLi4uZW50cnkudGFncyB9LFxuICAgICAgfSkpLFxuICAgIH07XG4gIH1cblxuICBmaW5hbGl6ZShcbiAgICBvYnNlcnZlZDogcmVhZG9ubHkgV29ya3NwYWNlSG9zdE9ic2VydmVkQ2FuYXJ5UmVzb3VyY2VbXSxcbiAgICBjb21wbGV0ZWRBdCA9IHRoaXMuY2xvY2soKSxcbiAgKTogV29ya3NwYWNlSG9zdENhbmFyeUNvbXBsZXRpb25SZWNlaXB0IHtcbiAgICByZXF1aXJlVGltZXN0YW1wKGNvbXBsZXRlZEF0LCBcImNhbmFyeSBjb21wbGV0ZWRBdFwiKTtcbiAgICBpZiAodGhpcy5yZXNlcnZhdGlvbnMuc2l6ZSA+IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IGZpbmFsaXplIGEgY2FuYXJ5IHdpdGggdW5zZXR0bGVkIHNwZW5kIHJlc2VydmF0aW9uc1wiLFxuICAgICAgKTtcbiAgICBpZiAodGhpcy5jb3N0cy5sZW5ndGggPT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IGZpbmFsaXplIGEgY2FuYXJ5IHdpdGhvdXQgcHJvdmlkZXIgY29zdCBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICBpZiAodGhpcy5zcGVudENlbnRzKCkgPiB0aGlzLm1heFNwZW5kQ2VudHMpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IGZpbmFsaXplIGEgY2FuYXJ5IHRoYXQgZXhjZWVkZWQgaXRzIGhhcmQgc3BlbmQgY2VpbGluZ1wiLFxuICAgICAgKTtcbiAgICBjb25zdCBjZW5zdXMgPSB0aGlzLm9ycGhhbkNlbnN1cyhvYnNlcnZlZCk7XG4gICAgaWYgKCFjZW5zdXMuY2xlYW4pXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IGZpbmFsaXplIGEgY2FuYXJ5IHVudGlsIHRoZSBvcnBoYW4gY2Vuc3VzIGlzIGNsZWFuXCIsXG4gICAgICApO1xuICAgIC8vIEEgY29uc3QgYWxpYXMsIHNvIHRoZSBzcGVjJ3MgYXV0aG9yaXphdGlvbiB1bmlvbiBuYXJyb3dzIG9uIHRoZSBjaGVjayBiZWxvdy5cbiAgICBjb25zdCBzcGVjID0gdGhpcy5zcGVjO1xuICAgIGNvbnN0IGF1dGhvcml6YXRpb24gPSBzcGVjLmZhaWxlZFJ1blRlYXJkb3duXG4gICAgICA/IHtcbiAgICAgICAgICBmYWlsZWRSdW5UZWFyZG93bjoge1xuICAgICAgICAgICAgLi4uc3BlYy5mYWlsZWRSdW5UZWFyZG93bixcbiAgICAgICAgICAgIGZhaWxlZE9wZXJhdGlvbklkczogWy4uLnNwZWMuZmFpbGVkUnVuVGVhcmRvd24uZmFpbGVkT3BlcmF0aW9uSWRzXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICA6IHsgY29udHJhY3RSZXBvcnRSZWY6IHNwZWMuY29udHJhY3RBcHByb3ZhbC5yZXBvcnRSZWYgfTtcbiAgICByZXR1cm4ge1xuICAgICAgcnVuSWQ6IHNwZWMucnVuSWQsXG4gICAgICB0YXJnZXQ6IHNwZWMudGFyZ2V0LFxuICAgICAgLi4uYXV0aG9yaXphdGlvbixcbiAgICAgIC4uLihzcGVjLnNwZW5kU2V0dGxlbWVudFxuICAgICAgICA/IHsgc3BlbmRTZXR0bGVtZW50OiB7IC4uLnNwZWMuc3BlbmRTZXR0bGVtZW50IH0gfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGNvbXBsZXRlZEF0LFxuICAgICAgc3BlbnRDZW50czogdGhpcy5zcGVudENlbnRzKCksXG4gICAgICBtYXhTcGVuZENlbnRzOiB0aGlzLm1heFNwZW5kQ2VudHMsXG4gICAgICByZXNvdXJjZUNvdW50OiB0aGlzLnJlc291cmNlcy5sZW5ndGgsXG4gICAgICBjb3N0RXZpZGVuY2U6IHRoaXMuY29zdHMubWFwKChlbnRyeSkgPT4gKHsgLi4uZW50cnkgfSkpLFxuICAgIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gbm90U3R1YmJlZChtZW1iZXI6IGtleW9mIFdvcmtzcGFjZUhvc3RQcm92aWRlcik6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBGYWtlIHdvcmtzcGFjZS1ob3N0IHByb3ZpZGVyOiAnJHtTdHJpbmcobWVtYmVyKX0nIHdhcyBjYWxsZWQgYnV0IHRoaXMgdGVzdCBkaWQgbm90IHN0dWIgaXQuIGAgK1xuICAgICAgYFBhc3MgaXQgdG8gbWFrZUZha2VXb3Jrc3BhY2VIb3N0UHJvdmlkZXIoeyAke1N0cmluZyhtZW1iZXIpfTogLi4uIH0pLmAsXG4gICk7XG59XG5cbi8qKlxuICogQ29tcGxldGUgY2FwYWJpbGl0aWVzIGZvciBhIGZha2UgcHJvdmlkZXIsIGV2ZXJ5IGZsYWcgb2ZmLlxuICpcbiAqIEFubm90YXRlZCBgV29ya3NwYWNlSG9zdFByb3ZpZGVyQ2FwYWJpbGl0aWVzYCB3aXRoIE5PIGNhc3Qgb24gcHVycG9zZTogdGhpcyBpcyB0aGUgc2luZ2xlXG4gKiBwbGFjZSBhIG5ld2x5LXJlcXVpcmVkIGNhcGFiaWxpdHkgZmllbGQgbXVzdCBiZSBmaWxsZWQgaW4sIGFuZCB1bnRpbCBpdCBpcywgdGhlIGNvbXBpbGVyXG4gKiBzdG9wcyBldmVyeSBmYWtlIGJ1aWx0IGZyb20gaXQuIFRoZSBhbHRlcm5hdGl2ZSDigJQgYGNhcGFiaWxpdGllczoge31gIGJlaGluZFxuICogYGFzIHVua25vd24gYXMgV29ya3NwYWNlSG9zdFByb3ZpZGVyYCDigJQgaXMgd2hhdCBsZXQgcHJvdmlzaW9uaW5nLXJ1bm5lci5pbnRlZ3JhdGlvbi50ZXN0LnRzXG4gKiBzaXQgcmVkIGZvciB0d28gZGF5cyBhZnRlciBgbGlmZWN5Y2xlLmhvc3RCb290c3RyYXBgIGJlY2FtZSBsb2FkLWJlYXJpbmcgKFdJLTIxNDQwMzIpOiB0aGVcbiAqIGNhc3QgZXJhc2VkIHRoZSBvbmUgZXJyb3IgdGhhdCB3b3VsZCBoYXZlIG5hbWVkIHRoZSBtaXNzaW5nIGZpZWxkLlxuICpcbiAqIERlZmF1bHRzIGFyZSBhbGwgYGZhbHNlYC9lbXB0eSBzbyBhIGZha2UgZGVjbGFyZXMgb25seSB0aGUgY2FwYWJpbGl0eSBpdHMgdGVzdCBleGVyY2lzZXMsXG4gKiBhbmQgYSB0ZXN0IHRoYXQgbmVlZHMgYSBjYXBhYmlsaXR5IGhhcyB0byBzYXkgc28uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmYWtlV29ya3NwYWNlSG9zdENhcGFiaWxpdGllcyhcbiAgb3ZlcnJpZGVzOiB7XG4gICAgZGlzY292ZXJ5PzogUGFydGlhbDxXb3Jrc3BhY2VIb3N0RGlzY292ZXJ5Q2FwYWJpbGl0aWVzPjtcbiAgICBsaWZlY3ljbGU/OiBQYXJ0aWFsPFdvcmtzcGFjZUhvc3RMaWZlY3ljbGVDYXBhYmlsaXRpZXM+O1xuICAgIHRyYW5zcG9ydEtpbmRzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gICAgY29uc3RyYWludHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgfSA9IHt9LFxuKTogV29ya3NwYWNlSG9zdFByb3ZpZGVyQ2FwYWJpbGl0aWVzIHtcbiAgcmV0dXJuIHtcbiAgICBkaXNjb3Zlcnk6IHtcbiAgICAgIHNjb3BlczogZmFsc2UsXG4gICAgICByZWdpb25zOiBmYWxzZSxcbiAgICAgIHNpemVzOiBmYWxzZSxcbiAgICAgIGltYWdlczogZmFsc2UsXG4gICAgICBwcmljZUVzdGltYXRlczogZmFsc2UsXG4gICAgICAuLi5vdmVycmlkZXMuZGlzY292ZXJ5LFxuICAgIH0sXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBzdGFydDogZmFsc2UsXG4gICAgICBzdG9wOiBmYWxzZSxcbiAgICAgIHJlc3RhcnQ6IGZhbHNlLFxuICAgICAgc25hcHNob3Q6IGZhbHNlLFxuICAgICAgcmVzdG9yZTogZmFsc2UsXG4gICAgICB1cGdyYWRlOiBmYWxzZSxcbiAgICAgIHJlcGFpcjogZmFsc2UsXG4gICAgICBjb25maXJtZWREZXN0cm95OiBmYWxzZSxcbiAgICAgIGhvc3RCb290c3RyYXA6IGZhbHNlLFxuICAgICAgLi4ub3ZlcnJpZGVzLmxpZmVjeWNsZSxcbiAgICB9LFxuICAgIHRyYW5zcG9ydEtpbmRzOiBvdmVycmlkZXMudHJhbnNwb3J0S2luZHMgPz8gW10sXG4gICAgLi4uKG92ZXJyaWRlcy5jb25zdHJhaW50cyA/IHsgY29uc3RyYWludHM6IG92ZXJyaWRlcy5jb25zdHJhaW50cyB9IDoge30pLFxuICB9O1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgZmFrZSBwcm92aWRlciB0aGF0IGdlbnVpbmVseSBzYXRpc2ZpZXMgYFdvcmtzcGFjZUhvc3RQcm92aWRlcmAsIHNvIGEgdGVzdCBuZXZlciBoYXNcbiAqIHRvIHJlYWNoIGZvciBgYXMgdW5rbm93biBhcyBXb3Jrc3BhY2VIb3N0UHJvdmlkZXJgIHRvIGdldCBvbmUuXG4gKlxuICogRXZlcnkgaW50ZXJmYWNlIG1lbWJlciBpcyBwcmVzZW50LiBUaGUgb25lcyBhIHRlc3QgZG9lcyBub3Qgc3VwcGx5IHRocm93IHdoZW4gY2FsbGVkLCBuYW1pbmdcbiAqIHRoZW1zZWx2ZXMg4oCUIGEgZmFrZSB0aGF0IGlzIG1pc3NpbmcgYSBtZXRob2QgYSBjb2RlIHBhdGggcmVhY2hlcyBub3cgZmFpbHMgbG91ZGx5IGluc3RlYWQgb2ZcbiAqIGFuc3dlcmluZyBgdW5kZWZpbmVkYCBhbmQgc3VyZmFjaW5nIGFzIGFuIHVucmVsYXRlZCBUeXBlRXJyb3IgZGVlcCBpbnNpZGUgdGhlIHJ1bm5lci5cbiAqXG4gKiBgRXh0cmFgIGNhcnJpZXMgbWVtYmVycyB0aGF0IGFyZSBOT1Qgb24gdGhlIGludGVyZmFjZSAoYW4gb3B0aW9uYWwgY2FwYWJpbGl0eSB0aGUgcnVubmVyXG4gKiBwcm9iZXMgZm9yIHdpdGggYCd4JyBpbiBwcm92aWRlcmAsIGZvciBpbnN0YW5jZSkgdGhyb3VnaCB0byB0aGUgcmV0dXJuIHR5cGUsIHNvIHRob3NlIHN0YXlcbiAqIHR5cGVkIGF0IHRoZSBjYWxsIHNpdGUgcmF0aGVyIHRoYW4gZm9yY2luZyB0aGUgY2FzdCBiYWNrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFrZUZha2VXb3Jrc3BhY2VIb3N0UHJvdmlkZXI8XG4gIEV4dHJhIGV4dGVuZHMgb2JqZWN0ID0gUmVjb3JkPG5ldmVyLCBuZXZlcj4sXG4+KFxuICBwYXJ0czogUGFydGlhbDxXb3Jrc3BhY2VIb3N0UHJvdmlkZXI+ICYgRXh0cmEsXG4pOiBXb3Jrc3BhY2VIb3N0UHJvdmlkZXIgJiBFeHRyYSB7XG4gIGNvbnN0IGJhc2U6IFdvcmtzcGFjZUhvc3RQcm92aWRlciA9IHtcbiAgICB0YXJnZXQ6IFwiZ2NwXCIsXG4gICAgY2FwYWJpbGl0aWVzOiBmYWtlV29ya3NwYWNlSG9zdENhcGFiaWxpdGllcygpLFxuICAgIHZhbGlkYXRlQ29ubmVjdGlvbjogKCkgPT4gbm90U3R1YmJlZChcInZhbGlkYXRlQ29ubmVjdGlvblwiKSxcbiAgICBsaXN0U2NvcGVzOiAoKSA9PiBub3RTdHViYmVkKFwibGlzdFNjb3Blc1wiKSxcbiAgICBsaXN0UmVnaW9uczogKCkgPT4gbm90U3R1YmJlZChcImxpc3RSZWdpb25zXCIpLFxuICAgIGxpc3RTaXplczogKCkgPT4gbm90U3R1YmJlZChcImxpc3RTaXplc1wiKSxcbiAgICBsaXN0SW1hZ2VzOiAoKSA9PiBub3RTdHViYmVkKFwibGlzdEltYWdlc1wiKSxcbiAgICBlc3RpbWF0ZVByaWNlOiAoKSA9PiBub3RTdHViYmVkKFwiZXN0aW1hdGVQcmljZVwiKSxcbiAgICBwbGFuOiAoKSA9PiBub3RTdHViYmVkKFwicGxhblwiKSxcbiAgICBhcHBseTogKCkgPT4gbm90U3R1YmJlZChcImFwcGx5XCIpLFxuICAgIG9ic2VydmU6ICgpID0+IG5vdFN0dWJiZWQoXCJvYnNlcnZlXCIpLFxuICAgIHJlY29uY2lsZTogKCkgPT4gbm90U3R1YmJlZChcInJlY29uY2lsZVwiKSxcbiAgICBnZXRUcmFuc3BvcnRQcm9maWxlOiAoKSA9PiBub3RTdHViYmVkKFwiZ2V0VHJhbnNwb3J0UHJvZmlsZVwiKSxcbiAgICBhdHRlc3RIZWFsdGg6ICgpID0+IG5vdFN0dWJiZWQoXCJhdHRlc3RIZWFsdGhcIiksXG4gIH07XG4gIHJldHVybiB7IC4uLmJhc2UsIC4uLnBhcnRzIH07XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtdGVzdC1oYXJuZXNzLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC10ZXN0LWhhcm5lc3MudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LXRlc3QtaGFybmVzcy50cyIsW11d
}}