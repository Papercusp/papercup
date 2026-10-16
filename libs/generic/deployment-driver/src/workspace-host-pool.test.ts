import { describe, expect, it } from "vitest";
import {
  selectWorkspaceHostPoolPlacement,
  type WorkspaceHostPoolCandidate,
  type WorkspaceHostPoolRequest,
  type WorkspaceHostPoolRefusal,
} from "./workspace-host-pool";

const request = (overrides: Partial<WorkspaceHostPoolRequest> = {}): WorkspaceHostPoolRequest => ({
  workspaceId: "control-plane", customerWorkspaceId: "customer-a", dataVolumeId: "disk-a",
  target: "gcp", scope: { kind: "project", id: "project-a" }, region: "us-central1", zone: "us-central1-a",
  architecture: "x86_64", runtimeBundleSha256: "a".repeat(64), minimum: { cpuCount: 2, memoryMiB: 4096 },
  nowMs: 100_000, maxObservationAgeMs: 30_000, mayProvision: true, ...overrides,
});
const host = (overrides: Partial<WorkspaceHostPoolCandidate> = {}): WorkspaceHostPoolCandidate => ({
  workspaceId: "control-plane", hostId: "host-a", generation: 2, controllerFence: 7,
  target: "gcp", scope: { kind: "project", id: "project-a" }, region: "us-central1", zone: "us-central1-a",
  architecture: "x86_64", runtimeBundleSha256: "a".repeat(64), size: { cpuCount: 4, memoryMiB: 8192 },
  state: "running", health: "healthy", observedAtMs: 99_000,
  customerWorkspaceId: null, dataVolumeId: null, reservationId: null,
  cleanAttestationRef: "reimage:host-a:generation-2", ...overrides,
});

describe("ordinary VM pool placement (capacity-cost P-534)", () => {
  it("prefers a customer's running data-bearing VM over a smaller clean VM", () => {
    const owned = host({ hostId: "owned", customerWorkspaceId: "customer-a", dataVolumeId: "disk-a", cleanAttestationRef: null });
    expect(selectWorkspaceHostPoolPlacement(request(), [host(), owned])).toMatchObject({
      kind: "reuse", hostId: "owned", generation: 2, controllerFence: 7, rejected: [],
    });
  });

  it("starts the same customer's stopped VM with the same volume instead of replacing it", () => {
    expect(selectWorkspaceHostPoolPlacement(request(), [host(), host({
      hostId: "stopped", state: "stopped", customerWorkspaceId: "customer-a", dataVolumeId: "disk-a",
    })])).toMatchObject({ kind: "start", hostId: "stopped" });
  });

  it("chooses a clean warm VM deterministically without mutating the inventory", () => {
    const a = host({ hostId: "a", size: { cpuCount: 2, memoryMiB: 4096 } });
    const b = host({ ...a, hostId: "b" });
    const large = host({ hostId: "large" });
    const inventory = Object.freeze([Object.freeze(large), Object.freeze(b), Object.freeze(a)]);
    expect(selectWorkspaceHostPoolPlacement(request(), inventory)).toMatchObject({ kind: "assign-warm", hostId: "a" });
    expect(selectWorkspaceHostPoolPlacement(request(), [...inventory].reverse())).toEqual(
      selectWorkspaceHostPoolPlacement(request(), inventory),
    );
    expect(inventory.map((h) => h.hostId)).toEqual(["large", "b", "a"]);
  });

  const refusals: [string, Partial<WorkspaceHostPoolCandidate>, WorkspaceHostPoolRefusal][] = [
    ["foreign control plane", { workspaceId: "foreign" }, "workspace-mismatch"],
    ["foreign customer", { customerWorkspaceId: "customer-b", dataVolumeId: "disk-b" }, "foreign-tenant"],
    ["foreign cloud", { target: "aws" }, "data-affinity-mismatch"],
    ["foreign account", { scope: { kind: "project", id: "other" } }, "data-affinity-mismatch"],
    ["foreign scope kind", { scope: { kind: "account", id: "project-a" } }, "data-affinity-mismatch"],
    ["foreign region", { region: "europe-west1" }, "data-affinity-mismatch"],
    ["foreign zone", { zone: "us-central1-b" }, "data-affinity-mismatch"],
    ["different architecture", { architecture: "arm64" }, "runtime-mismatch"],
    ["unqualified runtime", { runtimeBundleSha256: "b".repeat(64) }, "runtime-mismatch"],
    ["insufficient RAM", { size: { cpuCount: 4, memoryMiB: 4095 } }, "insufficient-capacity"],
    ["insufficient CPU", { size: { cpuCount: 1, memoryMiB: 8192 } }, "insufficient-capacity"],
    ["unknown capacity", { size: { cpuCount: NaN, memoryMiB: 8192 } }, "invalid-capacity"],
    ["zero generation", { generation: 0 }, "invalid-generation"],
    ["invalid fence", { controllerFence: NaN }, "invalid-generation"],
    ["stale observation", { observedAtMs: 69_999 }, "stale-observation"],
    ["future observation", { observedAtMs: 100_001 }, "stale-observation"],
    ["missing observation", { observedAtMs: NaN }, "stale-observation"],
    ["unknown health", { health: "unknown" }, "unhealthy"],
    ["failed health", { health: "unhealthy" }, "unhealthy"],
    ["draining VM", { state: "draining" }, "unavailable"],
    ["failed VM", { state: "failed" }, "unavailable"],
    ["pending reservation", { reservationId: "another-wake" }, "reserved"],
    ["unclean VM", { cleanAttestationRef: null }, "unclean"],
    ["blank clean proof", { cleanAttestationRef: "  " }, "unclean"],
    ["unexpected retained disk", { dataVolumeId: "disk-b" }, "unclean"],
    ["wrong existing disk", { customerWorkspaceId: "customer-a", dataVolumeId: "disk-b" }, "wrong-volume"],
    ["missing existing disk", { customerWorkspaceId: "customer-a", dataVolumeId: null }, "wrong-volume"],
    ["stopped unassigned host", { state: "stopped" }, "warm-host-not-running"],
  ];
  it.each(refusals)("refuses %s and exposes the refusal", (_name, overrides, reason) => {
    const decision = selectWorkspaceHostPoolPlacement(request({ mayProvision: false }), [host(overrides)]);
    expect(decision).toMatchObject({ kind: "queue", rejected: [{ hostId: "host-a", reasons: expect.arrayContaining([reason]) }] });
    expect(decision).not.toHaveProperty("hostId");
  });

  it("returns provision only with prior quota/budget admission, and queue otherwise", () => {
    expect(selectWorkspaceHostPoolPlacement(request(), [])).toEqual({ kind: "provision", reason: "no-eligible-host", rejected: [] });
    expect(selectWorkspaceHostPoolPlacement(request({ mayProvision: false }), [])).toEqual({ kind: "queue", reason: "no-eligible-host", rejected: [] });
  });

  it("does not reuse a VM reserved by an in-flight operation, even for the same customer", () => {
    const owned = host({ customerWorkspaceId: "customer-a", dataVolumeId: "disk-a", reservationId: "wake-in-progress" });
    expect(selectWorkspaceHostPoolPlacement(request({ mayProvision: false }), [owned])).toMatchObject({ kind: "queue" });
  });

  it("accepts the exact freshness and capacity boundary", () => {
    expect(selectWorkspaceHostPoolPlacement(request(), [host({ observedAtMs: 70_000, size: { cpuCount: 2, memoryMiB: 4096 } })]))
      .toMatchObject({ kind: "assign-warm" });
  });

  it("applies the same provider-neutral rules to AWS without treating GCP disks as portable", () => {
    const aws = { target: "aws", scope: { kind: "account", id: "123456789012" }, region: "us-east-1", zone: "us-east-1a" };
    expect(selectWorkspaceHostPoolPlacement(request(aws), [host(), host({ ...aws, hostId: "aws" })]))
      .toMatchObject({ kind: "assign-warm", hostId: "aws", rejected: [{ hostId: "host-a", reasons: ["data-affinity-mismatch"] }] });
  });

  it.each<Partial<WorkspaceHostPoolRequest>>([
    { workspaceId: "" }, { customerWorkspaceId: " " }, { dataVolumeId: "" }, { zone: "" },
    { runtimeBundleSha256: "unknown" }, { minimum: { cpuCount: Infinity, memoryMiB: 4096 } },
    { minimum: { cpuCount: 2, memoryMiB: 0 } }, { nowMs: NaN }, { maxObservationAgeMs: 0 },
  ])("rejects incomplete request preconditions %#", (overrides) => {
    expect(() => selectWorkspaceHostPoolPlacement(request(overrides), [host()])).toThrow(/requires/);
  });

  it("fails closed on duplicate or blank host identity instead of selecting an ambiguous generation", () => {
    expect(() => selectWorkspaceHostPoolPlacement(request(), [host(), host({ controllerFence: 99 })])).toThrow(/unique/);
    expect(() => selectWorkspaceHostPoolPlacement(request(), [host({ hostId: " " })])).toThrow(/non-empty/);
  });
});
