import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HOST_CHAOS_CLASSES,
  WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
  resolveWorkspaceHostChaosRecovery,
  workspaceHostProviderRetryClass,
  type WorkspaceHostChaosClass,
} from "./workspace-host-chaos-classes";
import { workspaceHostRecoveryAction } from "./workspace-host-workflow";

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
