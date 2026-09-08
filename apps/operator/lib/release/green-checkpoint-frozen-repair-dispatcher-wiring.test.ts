/**
 * WI-10000758 — the frozen-repair DISPATCHER must be wired whenever the reservation trio is.
 *
 * `dispatchFrozenRepair` (green-checkpoint.ts) optional-chains `deps.dispatchFrozenRepairFixer`,
 * so a production wiring that supplies reserve/renew/finalize but NOT the dispatcher does not
 * fail — it takes the reservation, gets `fired = null`, releases the reservation and logs
 * "fixer dispatch did not return a spawn … queue remains unassigned for retry", forever.
 * That is exactly what sweep c076b0dd95 (2026-09-04) did by deleting the dispatcher together
 * with the repair-worktree code: `attempts` stayed 0 across 14 consecutive reds, and because
 * `recordCheckpointVerdict`'s own dispatch is gated `!verdict.repairQueue`, no path at all
 * could spawn a fixer for a frozen candidate.
 *
 * The guard is at the WIRING, not the call site: a call-site guard cannot see what the
 * production deps object omits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATE_VERDICT_HARNESS_ENV,
  GATE_VERDICT_WORKSPACE_ENV,
} from "@papercusp/operator-core/lib/release/gate-verdict-target";
import type { FrozenCandidateRepairQueue } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

const dispatchReleaseFixer = vi.fn(
  async (): Promise<{ spawnId: string | null; runId: string | null } | null> => ({
    spawnId: "s-wiring-test",
    runId: "r-wiring-test",
  }),
);

vi.mock(
  "@papercusp/operator-core/lib/harness/routines/release-actions",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@papercusp/operator-core/lib/harness/routines/release-actions")
    >()),
    dispatchReleaseFixer,
  }),
);

const { realCheckpointDeps } = await import("./green-checkpoint");
const { releaseConfig } = await import("./release-config");

const RESERVATION_TRIO = [
  "reserveFrozenRepairFixer",
  "renewFrozenRepairFixerReservation",
  "finalizeFrozenRepairFixer",
] as const;

describe("WI-10000758: realCheckpointDeps wires the frozen-repair dispatcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    dispatchReleaseFixer.mockClear();
  });

  it("supplies dispatchFrozenRepairFixer whenever it supplies the reservation trio", () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));
    for (const key of RESERVATION_TRIO) {
      expect(typeof deps[key], key).toBe("function");
    }
    // The regression this file exists for: trio present, dispatcher absent.
    expect(typeof deps.dispatchFrozenRepairFixer).toBe("function");
  });

  it("forwards the frozen queue to dispatchReleaseFixer with the stamped target, repairHead, failingTests and the queue itself", async () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));
    const queue = {
      candidate: "c".repeat(40),
      repairHead: "d".repeat(40),
      failingTests: ["lib/broken.test.ts"],
      phase: "awaiting-fixer",
      attempts: 0,
      fixerSpawnId: null,
    } as unknown as FrozenCandidateRepairQueue;

    const fired = await deps.dispatchFrozenRepairFixer!(queue);

    expect(fired).toEqual({ spawnId: "s-wiring-test", runId: "r-wiring-test" });
    expect(dispatchReleaseFixer).toHaveBeenCalledTimes(1);
    expect(dispatchReleaseFixer).toHaveBeenCalledWith(
      { workspaceId: "papercusp-workspace", installSlug: "papercusp" },
      queue.repairHead,
      queue.failingTests,
      queue,
    );
  });

  it("supplies neither the dispatcher nor the reservation trio without a stamped gate-verdict target (no half-wiring)", () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "");
    const deps = realCheckpointDeps(releaseConfig({}));
    for (const key of RESERVATION_TRIO) {
      expect(deps[key], key).toBeUndefined();
    }
    expect(deps.dispatchFrozenRepairFixer).toBeUndefined();
  });
});
