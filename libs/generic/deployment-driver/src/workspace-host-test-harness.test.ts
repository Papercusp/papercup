import { describe, expect, it } from "vitest";
import type {
  WorkspaceHostApplyRequest,
  WorkspaceHostApplyResult,
  WorkspaceHostDesiredSpec,
  WorkspaceHostPlan,
  WorkspaceHostPlanRequest,
  WorkspaceHostProvider,
  WorkspaceHostProviderContext,
  WorkspaceHostReconcileRequest,
  WorkspaceHostResourceRef,
} from "./workspace-host-types";
import {
  type WorkspaceHostLiveCanarySpec,
  DeterministicWorkspaceHostFaultInjector,
  WORKSPACE_HOST_CANARY_TAG_KEYS,
  WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS,
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  WorkspaceHostInjectedFault,
  WorkspaceHostLiveCanaryHarness,
  assertWorkspaceHostSecretIsolation,
  createWorkspaceHostManualDestroyReceipt,
  runFakeWorkspaceHostProviderContractSuite,
} from "./workspace-host-test-harness";

const NOW = "2026-08-22T05:00:00.000Z";
const LATER = "2026-08-22T06:00:00.000Z";

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: "host-1",
    target: "fake",
    scope: { kind: "project", id: "project-1" },
    region: "us-test1",
    size: "small",
    image: { id: "ubuntu-2404", version: "1" },
    data: { volumeGiB: 50, encrypted: true },
    credentials: {
      cloudCredentialRef: { kind: "cloud", ref: "resolver://cloud/test" },
    },
    labels: { purpose: "contract-test" },
    provider: { networkTier: "standard" },
  };
}

function context(): WorkspaceHostProviderContext {
  return {
    workspaceId: "workspace-1",
    requestId: "request-1",
    connection: {
      target: "fake",
      cloudCredentialRef: { kind: "cloud", ref: "resolver://cloud/test" },
      scope: { kind: "project", id: "project-1" },
      provider: { testMode: "fake" },
    },
  };
}

function fakeProvider(): WorkspaceHostProvider {
  const resources = new Map<string, WorkspaceHostResourceRef>();
  const resourceFor = (stepId: string): WorkspaceHostResourceRef => ({
    target: "fake",
    kind: stepId.includes("network") ? "network" : "vm",
    providerId: `provider-${stepId.replace(/^destroy-/, "")}`,
    region: "us-test1",
  });
  const plan = (request: WorkspaceHostPlanRequest): WorkspaceHostPlan => {
    const destroying = request.action === "destroy";
    const ids = destroying
      ? ["destroy-vm", "destroy-network"]
      : ["network", "vm"];
    return {
      planId: `plan:${request.operationId}`,
      operationId: request.operationId,
      target: "fake",
      hostId:
        request.action === "provision"
          ? request.desired.hostId
          : request.host.hostId,
      generatedAt: NOW,
      warnings: [],
      steps: ids.map((id, index) => ({
        id,
        action: request.action,
        resourceKind: id.includes("network") ? "network" : "vm",
        dependsOn: index === 0 ? [] : [ids[index - 1]],
        idempotencyKey: `${request.idempotencyKey}:${id}`,
        destructive: destroying,
        input: {},
      })),
    };
  };
  const apply = async (
    request: WorkspaceHostApplyRequest,
  ): Promise<WorkspaceHostApplyResult> => {
    const resource = resourceFor(request.step.id);
    if (request.step.destructive) {
      resources.delete(resource.providerId);
      return {
        operationId: request.operationId,
        stepId: request.step.id,
        state: "destroyed",
        observedAt: NOW,
        confirmation: {
          hostId: "host-1",
          providerResourceId: resource.providerId,
          confirmedAbsentAt: NOW,
          source: "provider-read",
        },
      };
    }
    resources.set(resource.providerId, resource);
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: resources.has(resource.providerId) ? "applied" : "unchanged",
      observedAt: NOW,
      providerRequestId: `request:${request.step.id}`,
      resource,
    };
  };
  return {
    target: "fake",
    capabilities: {
      discovery: {
        scopes: true,
        regions: true,
        sizes: true,
        images: true,
        priceEstimates: true,
      },
      lifecycle: {
        start: true,
        stop: true,
        restart: true,
        snapshot: true,
        restore: true,
        upgrade: true,
        repair: true,
        confirmedDestroy: true,
        hostBootstrap: false,
      },
      transportKinds: ["fake-ssh"],
    },
    async validateConnection() {
      return {
        ok: true,
        checkedAt: NOW,
        identity: "fake:test",
        warnings: [],
        errors: [],
      };
    },
    async listScopes() {
      return [{ kind: "project", id: "project-1", label: "Test project" }];
    },
    async listRegions() {
      return [{ id: "us-test1", label: "Test", available: true }];
    },
    async listSizes() {
      return [
        {
          id: "small",
          label: "Small",
          cpuCount: 2,
          memoryMiB: 4096,
          available: true,
        },
      ];
    },
    async listImages() {
      return [
        {
          id: "ubuntu-2404",
          version: "1",
          label: "Ubuntu 24.04",
          signed: true,
        },
      ];
    },
    async estimatePrice() {
      return {
        currency: "USD",
        hourlyAmount: 0.05,
        observedAt: NOW,
        confidence: "estimated",
      };
    },
    async plan(request) {
      return plan(request);
    },
    apply,
    async reconcile(request: WorkspaceHostReconcileRequest) {
      return apply(request);
    },
    async observe(host) {
      return {
        host,
        state: "running",
        resources: host.resources,
        observedAt: NOW,
        drift: [],
      };
    },
    async getTransportProfile() {
      return {
        kind: "fake-ssh",
        supportedClientPlatforms: ["linux"],
        features: {
          command: true,
          pty: true,
          tcpForward: true,
          fileTransfer: true,
        },
        prerequisites: [],
        constraints: [],
        reconnect: "resume",
        audited: true,
        compatibility: {
          requirements: [],
          traffic: { interactive: "recommended", "bulk-transfer": "supported" },
          limits: {
            unknown: [
              "session-duration",
              "idle-timeout",
              "concurrency",
              "throughput",
            ],
            notes: [],
          },
          proxy: { mode: "supported", notes: [] },
          cost: { model: "included", meters: [], notes: [] },
          audit: {
            controlPlaneEvents: true,
            sessionMetadata: true,
            sessionContent: false,
            fileTransferEvents: false,
            notes: [],
          },
          hostKey: {
            initialEnrollment: "verify-before-connect",
            replacement: "block-and-reverify",
            notes: [],
          },
          fallbacks: [],
        },
      };
    },
    async attestHealth(host) {
      return {
        hostId: host.hostId,
        observedAt: NOW,
        status: "healthy",
        checks: [{ name: "ready", ok: true }],
      };
    },
  };
}

function canarySpec(): WorkspaceHostLiveCanarySpec {
  return {
    runId: "canary-1",
    workspaceId: "workspace-1",
    target: "gcp",
    scope: { kind: "project", id: "active-alcove-504205-q3" },
    cloudCredentialRef: { kind: "cloud" as const, ref: "adc://default" },
    contractApproval: {
      status: "approved" as const,
      suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
      reportRef: "artifact://contract/fake-gcp-1",
      approvedBy: "security-review",
      approvedAt: NOW,
    },
    teardownDeadlineAt: LATER,
  };
}

describe("workspace-host provider contract suite", () => {
  it("drives a fake adapter through discovery, deterministic apply/reconcile, and confirmed destroy", async () => {
    const report = await runFakeWorkspaceHostProviderContractSuite(
      fakeProvider(),
      {
        adapterKind: "fake",
        reportRef: "artifact://contract/fake-1",
        context: context(),
        desired: desired(),
        operationId: "operation-1",
        idempotencyKey: "operation-1",
        confirmedBy: "test",
        now: () => NOW,
      },
    );

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(
      report.provisionedResources.map((resource) => resource.providerId),
    ).toEqual(["provider-network", "provider-vm"]);
    expect(
      report.destroyConfirmations.map(
        (confirmation) => confirmation.providerResourceId,
      ),
    ).toEqual(["provider-vm", "provider-network"]);
  });

  it("refuses secret-shaped public adapter metadata", async () => {
    const unsafe = desired();
    unsafe.provider = { api_token: "plain-text" };
    await expect(
      runFakeWorkspaceHostProviderContractSuite(fakeProvider(), {
        adapterKind: "fake",
        reportRef: "artifact://contract/unsafe",
        context: context(),
        desired: unsafe,
        operationId: "operation-unsafe",
        idempotencyKey: "operation-unsafe",
        confirmedBy: "test",
      }),
    ).rejects.toThrow("Secret-shaped field 'desired.provider.api_token'");
  });
});

describe("deterministic provider fault injection", () => {
  it("models before-call throttling and ambiguous timeout-after-success at exact occurrences", async () => {
    const injector = new DeterministicWorkspaceHostFaultInjector([
      {
        point: "apply:vm",
        occurrence: 1,
        retryClass: "throttled",
        message: "429",
      },
      {
        point: "apply:vm",
        occurrence: 2,
        timing: "after",
        retryClass: "ambiguous",
        message: "timeout",
      },
    ]);
    let sideEffects = 0;
    const operation = () => ++sideEffects;

    await expect(injector.invoke("apply:vm", operation)).rejects.toMatchObject({
      fault: { retryClass: "throttled", timing: "before" },
    });
    expect(sideEffects).toBe(0);
    await expect(injector.invoke("apply:vm", operation)).rejects.toBeInstanceOf(
      WorkspaceHostInjectedFault,
    );
    expect(sideEffects).toBe(1);
    await expect(injector.invoke("apply:vm", operation)).resolves.toBe(2);
    expect(injector.untriggeredFaults()).toEqual([]);
    expect(injector.history()).toEqual([
      { point: "apply:vm", occurrence: 1, timing: "before", triggered: true },
      { point: "apply:vm", occurrence: 2, timing: "after", triggered: true },
      { point: "apply:vm", occurrence: 3, timing: "before", triggered: false },
    ]);
  });
});

describe("real-account canary safety harness", () => {
  it("fails closed without a current approved fake-contract report", () => {
    expect(
      () =>
        new WorkspaceHostLiveCanaryHarness(
          {
            ...canarySpec(),
            contractApproval: undefined,
          } as unknown as ReturnType<typeof canarySpec>,
          () => NOW,
        ),
    ).toThrow(
      "blocked until the current fake-provider contract report is approved",
    );
    expect(
      () =>
        new WorkspaceHostLiveCanaryHarness(
          { ...canarySpec(), maxSpendCents: 2_501 },
          () => NOW,
        ),
    ).toThrow(`between 1 and ${WORKSPACE_HOST_LIVE_CANARY_MAX_SPEND_CENTS}`);
  });

  it("enforces reservations before spend and stops at the cumulative USD 25 ceiling", () => {
    const harness = new WorkspaceHostLiveCanaryHarness(canarySpec(), () => NOW);
    harness.reserveSpend({
      id: "vm-hour",
      purpose: "one VM hour",
      cents: 2_400,
      reservedAt: NOW,
    });
    expect(() =>
      harness.reserveSpend({
        id: "disk",
        purpose: "disk",
        cents: 101,
        reservedAt: NOW,
      }),
    ).toThrow("would exceed the 2500-cent ceiling");
    harness.settleSpend({
      reservationId: "vm-hour",
      cents: 2_400,
      observedAt: NOW,
      providerEvidenceRef: "billing://gcp/cost-1",
    });
    harness.recordObservedSpend({
      cents: 101,
      observedAt: NOW,
      providerEvidenceRef: "billing://gcp/delayed",
    });
    expect(() => harness.assertCanStartProviderWork()).toThrow(
      "spend ceiling has been exceeded",
    );
  });

  it("requires immutable run tags, watchdogs teardown, and distinguishes absence from proof", () => {
    const harness = new WorkspaceHostLiveCanaryHarness(canarySpec(), () => NOW);
    const resource: WorkspaceHostResourceRef = {
      target: "gcp",
      kind: "vm",
      providerId: "instance-1",
    };
    expect(() =>
      harness.registerResource({ resource, tags: {}, createdAt: NOW }),
    ).toThrow(
      `missing required tag '${WORKSPACE_HOST_CANARY_TAG_KEYS.canary}=true'`,
    );
    const tags = harness.tags({ purpose: "workspace-host-test" });
    harness.registerResource({ resource, tags, createdAt: NOW });

    expect(harness.teardownWatchdog(LATER)).toMatchObject({ overdue: true });
    expect(harness.orphanCensus([])).toMatchObject({
      clean: false,
      missingWithoutReceipt: [{ resource }],
    });
    const receipt = createWorkspaceHostManualDestroyReceipt({
      runId: "canary-1",
      resource,
      actorId: "operator:test",
      reason: "teardown watchdog fired",
      procedureRef: "runbook://gcp/manual-destroy",
      issuedAt: LATER,
      confirmation: {
        hostId: "host-1",
        providerResourceId: "instance-1",
        confirmedAbsentAt: LATER,
        source: "provider-read",
        providerRequestId: "gcp-operation-1",
      },
      providerEvidence: { operationRef: "gcp-operation-1" },
    });
    harness.recordManualDestroyReceipt(receipt);
    expect(harness.teardownWatchdog(LATER)).toMatchObject({
      overdue: false,
      pending: [],
    });
    expect(harness.orphanCensus([])).toMatchObject({ clean: true });
  });

  it("rehydrates an already-registered resource after the teardown deadline without admitting new work", () => {
    const harness = new WorkspaceHostLiveCanaryHarness(
      canarySpec(),
      () => LATER,
    );
    const resource: WorkspaceHostResourceRef = {
      target: "gcp",
      kind: "vm",
      providerId: "instance-1",
    };

    expect(() =>
      harness.registerResource({
        resource,
        tags: harness.tags(),
        createdAt: NOW,
      }),
    ).toThrow("teardown deadline has passed");
    expect(() =>
      harness.restoreRegisteredResource({
        resource,
        tags: harness.tags(),
        createdAt: NOW,
      }),
    ).not.toThrow();
    harness.confirmResourceAbsent({
      hostId: "host-1",
      providerResourceId: "instance-1",
      confirmedAbsentAt: LATER,
      source: "provider-read",
    });
    harness.recordObservedSpend({
      cents: 1,
      observedAt: LATER,
      providerEvidenceRef: "billing://gcp/delayed",
    });
    expect(harness.finalize([], LATER)).toMatchObject({
      resourceCount: 1,
      spentCents: 1,
    });
  });

  it("requires cost evidence and a clean orphan census before emitting a completion receipt", () => {
    const harness = new WorkspaceHostLiveCanaryHarness(canarySpec(), () => NOW);
    const resource: WorkspaceHostResourceRef = {
      target: "gcp",
      kind: "disk",
      providerId: "disk-1",
    };
    harness.registerResource({
      resource,
      tags: harness.tags(),
      createdAt: NOW,
    });
    harness.confirmResourceAbsent({
      hostId: "host-1",
      providerResourceId: "disk-1",
      confirmedAbsentAt: LATER,
      source: "provider-read",
    });
    expect(() => harness.finalize([], LATER)).toThrow(
      "without provider cost evidence",
    );
    harness.recordObservedSpend({
      cents: 75,
      observedAt: LATER,
      providerEvidenceRef: "billing://gcp/final",
    });
    expect(harness.finalize([], LATER)).toMatchObject({
      runId: "canary-1",
      spentCents: 75,
      maxSpendCents: 2_500,
      resourceCount: 1,
    });
  });

  it("rejects secret material in persisted metadata and manual receipts", () => {
    expect(() =>
      assertWorkspaceHostSecretIsolation({ private_key: "not-even-needed" }),
    ).toThrow("Secret-shaped field");
    expect(() =>
      assertWorkspaceHostSecretIsolation({
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "plaintext",
        sessionToken: "plaintext",
      }),
    ).toThrow("Secret-shaped field 'metadata.accessKeyId'");
    expect(() =>
      createWorkspaceHostManualDestroyReceipt({
        runId: "canary-1",
        resource: { target: "gcp", kind: "vm", providerId: "instance-1" },
        actorId: "operator:test",
        reason: "test",
        procedureRef: "runbook://manual",
        issuedAt: NOW,
        confirmation: {
          hostId: "host-1",
          providerResourceId: "instance-1",
          confirmedAbsentAt: NOW,
          source: "provider-read",
        },
        providerEvidence: { access_token: "plaintext" },
      }),
    ).toThrow("Secret-shaped field");
  });

  it("allows public secret-scanning policy keys without weakening credential detection", () => {
    expect(() =>
      assertWorkspaceHostSecretIsolation({
        maxSecretFindings: 0,
        allowSecretFindings: false,
        secretScanEnabled: true,
        secretScanPolicy: "deny",
      }),
    ).not.toThrow();

    expect(() =>
      assertWorkspaceHostSecretIsolation({ secretScanToken: "plaintext" }),
    ).toThrow("Secret-shaped field 'metadata.secretScanToken'");
    expect(() =>
      assertWorkspaceHostSecretIsolation({
        maxSecretFindings: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toThrow("Secret material is forbidden");
  });
});
