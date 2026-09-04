/**
 * Plan D-004 — the fossil verdict EXEMPTION for a pinned repair.
 *
 * gate-verdict-freshness rule 5 WITHHOLDS any red whose candidate is older than
 * `CANDIDATE_FOSSIL_AGE_MS`, so a stale accidental candidate never dispatches agents against
 * code the gate did not judge as current. A PINNED repair inverts that reasoning: the queue chose
 * that exact immutable sha on purpose, so its red is not staleness — it is the failing-test
 * signature the repair needs. Withholding it is what froze `main` for 6 days with
 * `gate_health.failingTests: []` and no fixer ever dispatched (measured 2026-08-26).
 *
 * This file used to be `green-checkpoint-fossil-pin-release.test.ts` and also covered the
 * companion `frozenPinIsFossilized` predicate — the WI-42207 age/stall RELEASE of a pinned
 * candidate. That predicate no longer exists (frozen-candidate-stays-frozen-through-all-fixes-
 * 2026-09-03 P-009/P-010: nothing un-freezes a lineage but promotion or an operator retire), so
 * only the exemption half survives here. The guard that the release path is gone lives in
 * `frozen-lineage-never-reads-tip.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { isJudgingPinnedActiveRepair } from "./green-checkpoint";

describe("isJudgingPinnedActiveRepair — the fossil verdict exemption (plan D-004)", () => {
  const BASE = "ba345f31b1c0ffee";
  const HEAD = "ca456f42c2d1feed";
  const ACTIVE_QUEUE = {
    candidate: BASE,
    repairHead: HEAD,
    phase: "ready-to-verify" as const,
  };

  it("exempts the live repairHead after admissions move it past the frozen candidate", () => {
    expect(
      isJudgingPinnedActiveRepair({
        candidate: HEAD,
        repairQueue: ACTIVE_QUEUE,
      }),
    ).toBe(true);
  });

  it("does NOT exempt an accidentally-stale candidate — the rule's original job survives", () => {
    // No queue at all: this is the EI-21436432400491183 case the withholding was written for, and
    // it must keep behaving exactly as before.
    expect(isJudgingPinnedActiveRepair({ candidate: HEAD })).toBe(false);
    expect(
      isJudgingPinnedActiveRepair({ candidate: HEAD, repairQueue: null }),
    ).toBe(false);
  });

  it("does NOT exempt the frozen base after the repairHead has moved", () => {
    expect(
      isJudgingPinnedActiveRepair({
        candidate: BASE,
        repairQueue: ACTIVE_QUEUE,
      }),
    ).toBe(false);
  });

  it("does NOT exempt when repairHead names a DIFFERENT sha than the one being judged", () => {
    // The dangerous confusion: a queue exists, but this verdict is about some other candidate, so
    // publishing it would be exactly the mis-dispatch the withholding prevents.
    expect(
      isJudgingPinnedActiveRepair({
        candidate: "deadbeefdeadbeef",
        repairQueue: ACTIVE_QUEUE,
      }),
    ).toBe(false);
  });

  it("does NOT exempt a repair that has already given up", () => {
    expect(
      isJudgingPinnedActiveRepair({
        candidate: HEAD,
        repairQueue: {
          ...ACTIVE_QUEUE,
          phase: "blocked",
          blockedReason: "attempts-exhausted",
        },
      }),
    ).toBe(false);
    // blockedReason alone is disqualifying, so a phase/reason skew cannot publish a dead repair's
    // red.
    expect(
      isJudgingPinnedActiveRepair({
        candidate: HEAD,
        repairQueue: {
          ...ACTIVE_QUEUE,
          phase: "ready-to-test",
          blockedReason: "attempts-exhausted",
        },
      }),
    ).toBe(false);
  });

  it("publishes the red of a pinned lineage however old the pin is — age is not an input", () => {
    // Under frozen-means-frozen the pin is HELD for as long as the repair takes, so the exemption
    // must be a function of the pin's identity and liveness only. If age ever became an input here
    // the 2026-08-26 livelock (pin held + red withheld) would be back.
    const exemption = isJudgingPinnedActiveRepair({
      candidate: HEAD,
      repairQueue: ACTIVE_QUEUE,
    });
    expect(exemption).toBe(true);
    // Structural half of the same claim: the predicate's input shape carries no clock at all.
    const shape: Parameters<typeof isJudgingPinnedActiveRepair>[0] = {
      candidate: HEAD,
      repairQueue: ACTIVE_QUEUE,
    };
    expect(
      Object.keys(shape).some((k) => /age|now|committed|stall/i.test(k)),
    ).toBe(false);
  });
});
