import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HOST_CHAOS_CLASSES,
  WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
  resolveWorkspaceHostChaosRecovery,
  workspaceHostProviderRetryClass,
  type WorkspaceHostChaosClass,
} from "./workspace-host-chaos-classes";
import {
  nextWorkspaceHostControllerAction,
  workspaceHostRecoveryAction,
  type WorkspaceHostControllerAction,
  type WorkspaceHostDurableWorkflowSpec,
  type WorkspaceHostResourceCheckpoint,
} from "./workspace-host-workflow";

/**
 * The failure classes P-024 enumerates, verbatim and in its order.
 *
 * PINNED, not derived: the plan item lives in Postgres, which a unit test must not reach. Set
 * equality against this literal is what makes the registry auditable — a class quietly dropped
 * from the registry, or added without a plan mandate, fails here instead of passing silently.
 * Source: plan `byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`, item P-024.
 */
const P024_ENUMERATED_CLASSES = [
  "API 429",
  "API 5xx",
  "expired credential",
  "quota denial",
  "regional capacity miss",
  "operation timeout after success",
  "controller crash between create and record",
  "bootstrap failure",
  "unhealthy operator",
  "lost tunnel",
  "stale image",
  "partial destroy",
  "snapshot failure",
  "orphan reaper recovery",
] as const;

describe("P-024 chaos-class registry completeness", () => {
  it("covers exactly the failure classes P-024 enumerates", () => {
    expect([...WORKSPACE_HOST_CHAOS_CLASSES].map((entry) => entry.label).sort()).toEqual(
      [...P024_ENUMERATED_CLASSES].sort(),
    );
  });

  it("gives every class a unique id and a stated rationale", () => {
    const ids = WORKSPACE_HOST_CHAOS_CLASSES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of WORKSPACE_HOST_CHAOS_CLASSES) {
      expect(entry.rationale.length, `${entry.id} must state why its recovery is safe`).toBeGreaterThan(40);
    }
  });

  it("exercises both probe shapes, so the state classes cannot be quietly dropped", () => {
    const kinds = new Set(WORKSPACE_HOST_CHAOS_CLASSES.map((entry) => entry.probe.kind));
    expect(kinds).toEqual(new Set(["thrown-error", "checkpoint-state"]));
  });
});

describe("P-024 chaos classes reach their required recovery", () => {
  it.each(WORKSPACE_HOST_CHAOS_CLASSES.map((entry) => [entry.label, entry] as const))(
    "%s",
    (_label, chaosClass: WorkspaceHostChaosClass) => {
      const resolved = resolveWorkspaceHostChaosRecovery(chaosClass);
      if (chaosClass.probe.kind === "thrown-error") {
        expect(resolved.retryClass).toBe(chaosClass.probe.expectedRetryClass);
      }
      expect(resolved.recovery).toBe(chaosClass.expectedRecovery);
    },
  );

  it("fails closed on every deterministic refusal, and only on those", () => {
    const halting = WORKSPACE_HOST_CHAOS_CLASSES.filter(
      (entry) => resolveWorkspaceHostChaosRecovery(entry).recovery === "halt",
    ).map((entry) => entry.id);
    // A credential/quota/bootstrap/image refusal is deterministic: retrying is a hang, not a fix.
    expect(halting.sort()).toEqual(
      ["bootstrap-failure", "expired-credential", "quota-denial", "stale-image"].sort(),
    );
  });
});

describe("workspaceHostProviderRetryClass", () => {
  it.each([
    [408, "throttled"],
    [429, "throttled"],
    [409, "ambiguous"],
    [400, "terminal"],
    [401, "terminal"],
    [403, "terminal"],
    [404, "terminal"],
    [422, "terminal"],
    [499, "terminal"],
    [500, "ambiguous"],
    [503, "ambiguous"],
  ] as const)("classifies status %i as %s", (status, expected) => {
    expect(workspaceHostProviderRetryClass({ status })).toBe(expected);
  });

  // WI-1818869. Not every provider throttles with 429 — Google answers Compute rate limiting with
  // 403 — so the 4xx rule alone settles a transient throttle as `terminal`, which
  // workspaceHostRecoveryAction turns into `halt`: a durable workflow stopped forever by a fault a
  // bounded backoff clears. An adapter's explicit throttle statement has to outrank the status.
  it("lets an explicit provider throttle outrank the status code", () => {
    expect(workspaceHostProviderRetryClass({ status: 403, throttled: true })).toBe("throttled");
    expect(workspaceHostProviderRetryClass({ status: 400, throttled: true })).toBe("throttled");
    // No status at all: the statement still stands on its own.
    expect(workspaceHostProviderRetryClass({ throttled: true })).toBe("throttled");
  });

  // The guard that keeps the signal from becoming a way to retry anything forever: only a literal
  // `true` counts, so a truthy-but-unmeant value cannot silently un-terminate a real refusal.
  it("keeps a 403 terminal unless the provider actually said throttled", () => {
    expect(workspaceHostProviderRetryClass({ status: 403 })).toBe("terminal");
    expect(workspaceHostProviderRetryClass({ status: 403, throttled: false })).toBe("terminal");
    expect(workspaceHostProviderRetryClass({ status: 403, throttled: "yes" })).toBe("terminal");
    expect(workspaceHostProviderRetryClass({ status: 403, throttled: 1 })).toBe("terminal");
  });

  it("defaults to ambiguous when no numeric status is present", () => {
    // A lost response carries no verdict; assuming failure here would duplicate a live resource.
    expect(workspaceHostProviderRetryClass({ message: "socket hang up" })).toBe("ambiguous");
    expect(workspaceHostProviderRetryClass({ status: "429" })).toBe("ambiguous");
    expect(workspaceHostProviderRetryClass(null)).toBe("ambiguous");
    expect(workspaceHostProviderRetryClass(undefined)).toBe("ambiguous");
  });
});

describe("the ceiling that makes a terminal classification load-bearing", () => {
  it("halts a retryable class once its attempts are spent", () => {
    const spent = workspaceHostRecoveryAction(
      {
        logicalKey: "vm",
        state: "failed",
        attempts: WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
        retryClass: "throttled",
      },
      WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
    );
    expect(spent).toBe("halt");
  });

  it("reconciles an ambiguous row regardless of attempts — so misclassifying a refusal never halts", () => {
    // This is the calibration case for the whole registry: `ambiguous` is deliberately exempt
    // from the attempt ceiling, because reconcile reads provider truth instead of re-mutating.
    // The exemption is safe ONLY while genuine refusals classify `terminal` — which is exactly
    // what the halt-set assertion above holds in place.
    const exhausted = workspaceHostRecoveryAction(
      {
        logicalKey: "vm",
        state: "failed",
        attempts: WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS * 100,
        retryClass: "ambiguous",
      },
      WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
    );
    expect(exhausted).toBe("reconcile");
  });
});

/**
 * The two remaining `checkpoint-state` classes, driven through the REAL controller oracle.
 *
 * The registry suite above proves each class resolves to its recovery ACTION. That is a claim
 * about one function; it says nothing about whether a controller holding a real workflow spec
 * ever reaches that action, nor whether the operation converges once it does. These drills run
 * {@link nextWorkspaceHostControllerAction} to completion against a real multi-resource spec —
 * the half a pure-registry test cannot claim, and the standard `controller crash between create
 * and record` already meets against the shipped runner in `lifecycle-runner.chaos.test.ts`.
 *
 * The injected rows come from the registry itself, so a drill cannot drift from the class it
 * claims to exercise.
 */
function chaosCheckpoint(id: string): WorkspaceHostResourceCheckpoint {
  const entry = WORKSPACE_HOST_CHAOS_CLASSES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no chaos class '${id}'`);
  if (entry.probe.kind !== "checkpoint-state") {
    throw new Error(`chaos class '${id}' is not a checkpoint-state probe`);
  }
  return { ...entry.probe.checkpoint };
}

function put(
  checkpoints: WorkspaceHostResourceCheckpoint[],
  next: WorkspaceHostResourceCheckpoint,
): void {
  const index = checkpoints.findIndex((entry) => entry.logicalKey === next.logicalKey);
  if (index === -1) checkpoints.push(next);
  else checkpoints[index] = next;
}

/**
 * Run the oracle to convergence, letting `respond` persist the outcome of each action.
 *
 * Bounded deliberately: a controller that cannot make progress must surface here as a named
 * action cycle. An unbounded loop would hang the suite, and a single-call assertion would not
 * notice a controller that reaches the right action and then never leaves it.
 */
function drive(
  spec: WorkspaceHostDurableWorkflowSpec,
  checkpoints: WorkspaceHostResourceCheckpoint[],
  respond: (action: WorkspaceHostControllerAction) => void,
  options: { cancellationRequested?: boolean } = {},
): { actions: readonly WorkspaceHostControllerAction[]; final: WorkspaceHostControllerAction } {
  const actions: WorkspaceHostControllerAction[] = [];
  for (let pass = 0; pass < 12; pass += 1) {
    const action = nextWorkspaceHostControllerAction(spec, checkpoints, options);
    actions.push(action);
    if (action.kind === "complete" || action.kind === "blocked") return { actions, final: action };
    respond(action);
  }
  throw new Error(`controller did not converge: ${actions.map((entry) => entry.kind).join(" -> ")}`);
}

const CONFIRMED_AT = "2026-08-31T00:00:00Z";

function confirmedAbsent(logicalKey: string, providerId: string): WorkspaceHostResourceCheckpoint {
  return {
    logicalKey,
    state: "absent",
    attempts: 1,
    providerResource: { target: "gcp", kind: logicalKey, providerId },
    deletionConfirmation: {
      hostId: "host-1",
      providerResourceId: providerId,
      confirmedAbsentAt: CONFIRMED_AT,
      source: "provider-read",
    },
  };
}

function destroySpec(): WorkspaceHostDurableWorkflowSpec {
  return {
    identity: {
      workspaceId: "workspace-1",
      hostId: "host-1",
      operationId: "op-destroy-1",
      planId: "plan-destroy-1",
      target: "gcp",
      desiredRevision: 3,
    },
    action: "destroy",
    maxApplyAttempts: WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
    resources: [
      {
        logicalKey: "vm",
        step: {
          id: "delete-instance",
          action: "destroy",
          resourceKind: "vm",
          dependsOn: [],
          idempotencyKey: "delete-instance-key",
          destructive: true,
          input: { op: "delete-instance" },
        },
        createdByOperation: false,
        deleteOnDestroy: true,
      },
      {
        logicalKey: "network",
        step: {
          id: "delete-network",
          action: "destroy",
          resourceKind: "network",
          dependsOn: ["delete-instance"],
          idempotencyKey: "delete-network-key",
          destructive: true,
          input: { op: "delete-network" },
        },
        createdByOperation: false,
        deleteOnDestroy: true,
      },
    ],
  };
}

describe("P-024 partial destroy — driven through the controller", () => {
  /** The teardown that deleted the VM, issued the network delete, and lost the answer. */
  function partiallyDestroyed(): WorkspaceHostResourceCheckpoint[] {
    return [confirmedAbsent("vm", "pc-host-vm"), chaosCheckpoint("partial-destroy")];
  }

  it("reconciles the delete that lost its answer, and completes once the receipt is real", () => {
    const spec = destroySpec();
    const checkpoints = partiallyDestroyed();

    const { actions, final } = drive(spec, checkpoints, (action) => {
      // The reconcile reads provider truth and finds the network really is gone.
      expect(action).toMatchObject({ kind: "reconcile", resource: { logicalKey: "network" } });
      put(checkpoints, confirmedAbsent("network", "pc-host-net"));
    });

    expect(actions.map((entry) => entry.kind)).toEqual(["reconcile", "complete"]);
    expect(final).toEqual({ kind: "complete", status: "succeeded" });
  });

  it("never re-issues the delete it already sent — the lost answer is read, not replayed", () => {
    // The whole point of `ambiguous`: the delete may have landed. Re-applying a destructive step
    // is the mirror of the duplicate-create hazard, and would report a second, spurious failure
    // for a resource that was already gone.
    const action = nextWorkspaceHostControllerAction(destroySpec(), partiallyDestroyed());
    expect(action.kind).not.toBe("apply");
    expect(action.kind).not.toBe("retry");
    expect(action).toMatchObject({ kind: "reconcile", resource: { logicalKey: "network" } });
  });

  it("refuses to call the destroy done on an absence with no provider-read receipt", () => {
    // WI-1762411 ran the other way — a settled census read as failure. This is its inverse and
    // the more dangerous direction: an unwitnessed `absent` reported as a finished teardown
    // leaves a billed resource alive with nothing left watching it.
    const spec = destroySpec();
    const checkpoints = partiallyDestroyed();

    const { actions, final } = drive(spec, checkpoints, () => {
      put(checkpoints, { logicalKey: "network", state: "absent", attempts: 2 });
    });

    // Pin the SEQUENCE, not just the verdict: a controller that blocked immediately would never
    // run the callback, and an end-state-only assertion would pass without the reconcile ever
    // happening — the same shape as a mocked rejection that never fires.
    expect(actions.map((entry) => entry.kind)).toEqual(["reconcile", "blocked"]);
    expect(final).toEqual({ kind: "blocked", reason: "destroy-unconfirmed" });
  });

  it("refuses a receipt that names a different resource than the row it would close out", () => {
    // A confirmation is only evidence about the id it names. Accepting a mismatched one would
    // let one successful delete close out every outstanding row.
    const spec = destroySpec();
    const checkpoints = partiallyDestroyed();

    const { actions, final } = drive(spec, checkpoints, () => {
      put(checkpoints, {
        ...confirmedAbsent("network", "pc-host-net"),
        deletionConfirmation: {
          hostId: "host-1",
          providerResourceId: "pc-host-vm",
          confirmedAbsentAt: CONFIRMED_AT,
          source: "provider-read",
        },
      });
    });

    expect(actions.map((entry) => entry.kind)).toEqual(["reconcile", "blocked"]);
    expect(final).toEqual({ kind: "blocked", reason: "destroy-unconfirmed" });
  });
});

function provisionSpec(): WorkspaceHostDurableWorkflowSpec {
  return {
    identity: {
      workspaceId: "workspace-1",
      hostId: "host-1",
      operationId: "op-provision-1",
      planId: "plan-provision-1",
      target: "gcp",
      desiredRevision: 1,
    },
    action: "provision",
    maxApplyAttempts: WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
    resources: [
      {
        logicalKey: "disk",
        step: {
          id: "create-disk",
          action: "provision",
          resourceKind: "disk",
          dependsOn: [],
          idempotencyKey: "create-disk-key",
          destructive: false,
          input: { op: "create-disk" },
        },
        createdByOperation: true,
        compensation: { action: "destroy", idempotencyKey: "delete-disk-key" },
        deleteOnDestroy: false,
      },
      {
        logicalKey: "vm",
        step: {
          id: "create-instance",
          action: "provision",
          resourceKind: "vm",
          dependsOn: ["create-disk"],
          idempotencyKey: "create-instance-key",
          destructive: false,
          input: { op: "create-instance" },
        },
        createdByOperation: true,
        compensation: { action: "destroy", idempotencyKey: "delete-instance-key" },
        deleteOnDestroy: false,
      },
    ],
  };
}

describe("P-024 orphan reaper recovery — driven through the controller", () => {
  const refusedVm: WorkspaceHostResourceCheckpoint = {
    logicalKey: "vm",
    state: "failed",
    attempts: 1,
    retryClass: "terminal",
    error: "Quota 'CPUS' exceeded",
  };

  it("resumes the interrupted compensation and only then reaches a terminal verdict", () => {
    // A reachable state, not a contrived one: the disk was created, the VM was refused, rollback
    // began on the disk, and the controller died with that delete in flight.
    const spec = provisionSpec();
    const checkpoints = [chaosCheckpoint("orphan-reaper-recovery"), { ...refusedVm }];

    const { actions, final } = drive(spec, checkpoints, (action) => {
      expect(action).toMatchObject({ kind: "compensate", resource: { logicalKey: "disk" } });
      put(checkpoints, { logicalKey: "disk", state: "compensated", attempts: 2 });
    });

    // Collect the orphan FIRST, then fail. Completing first would strand a billed disk with
    // nothing left to delete it — the zero-orphan guarantee breaking silently.
    expect(actions.map((entry) => entry.kind)).toEqual(["compensate", "complete"]);
    expect(final).toEqual({ kind: "complete", status: "failed" });
  });

  it("never re-applies the resource it was in the middle of deleting", () => {
    const action = nextWorkspaceHostControllerAction(provisionSpec(), [
      chaosCheckpoint("orphan-reaper-recovery"),
      { ...refusedVm },
    ]);
    expect(action.kind).not.toBe("apply");
    expect(action).toMatchObject({ kind: "compensate", resource: { logicalKey: "disk" } });
  });

  it("carries the compensation obligation in the durable row, not in a caller's rollback flag", () => {
    // The reaper's guarantee has to survive a restart that lost every in-memory hint. Here the VM
    // row was never even written back as failed and no cancellation is requested — the
    // `compensating` row alone must still resume the delete.
    expect(
      nextWorkspaceHostControllerAction(provisionSpec(), [
        chaosCheckpoint("orphan-reaper-recovery"),
        { logicalKey: "vm", state: "planned", attempts: 0 },
      ]),
    ).toMatchObject({ kind: "compensate", resource: { logicalKey: "disk" } });
  });

  it("does not compensate a healthy row — the verdict comes from the checkpoint, not the spec shape", () => {
    // Calibration. Without it, every assertion above would still pass if `compensate` were
    // returned for any compensable resource in a workflow that happens to be rolling back.
    expect(
      nextWorkspaceHostControllerAction(provisionSpec(), [
        { logicalKey: "disk", state: "applied", attempts: 1 },
        { logicalKey: "vm", state: "planned", attempts: 0 },
      ]),
    ).toMatchObject({ kind: "apply", resource: { logicalKey: "vm" } });
  });
});
