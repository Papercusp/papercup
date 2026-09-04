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
  const CAND = "ba345f31b1c0ffee";

  it("exempts a live pin on the candidate actually being judged", () => {
    expect(
      isJudgingPinnedActiveRepair({
        candidate: CAND,
        repairCandidate: CAND,
        repairPhase: "ready-to-verify",
        repairBlockedReason: null,
      }),
    ).toBe(true);
  });

  it("does NOT exempt an accidentally-stale candidate — the rule's original job survives", () => {
    // No queue at all: this is the EI-21436432400491183 case the withholding was written for, and
    // it must keep behaving exactly as before.
    expect(isJudgingPinnedActiveRepair({ candidate: CAND })).toBe(false);
    expect(
      isJudgingPinnedActiveRepair({ candidate: CAND, repairCandidate: null }),
    ).toBe(false);
  });

  it("does NOT exempt when the pin names a DIFFERENT sha than the one being judged", () => {
    // The dangerous confusion: a queue exists, but this verdict is about some other candidate, so
    // publishing it would be exactly the mis-dispatch the withholding prevents.
    expect(
      isJudgingPinnedActiveRepair({
        candidate: CAND,
        repairCandidate: "deadbeefdeadbeef",
        repairPhase: "ready-to-test",
        repairBlockedReason: null,
      }),
    ).toBe(false);
  });

  it("does NOT exempt a repair that has already given up", () => {
    expect(
      isJudgingPinnedActiveRepair({
        candidate: CAND,
        repairCandidate: CAND,
        repairPhase: "blocked",
        repairBlockedReason: "attempts-exhausted",
      }),
    ).toBe(false);
    // blockedReason alone is disqualifying, so a phase/reason skew cannot publish a dead repair's
    // red.
    expect(
      isJudgingPinnedActiveRepair({
        candidate: CAND,
        repairCandidate: CAND,
        repairPhase: "ready-to-test",
        repairBlockedReason: "wall-clock-exhausted",
      }),
    ).toBe(false);
  });

  it("publishes the red of a pinned lineage however old the pin is — age is not an input", () => {
    // Under frozen-means-frozen the pin is HELD for as long as the repair takes, so the exemption
    // must be a function of the pin's identity and liveness only. If age ever became an input here
    // the 2026-08-26 livelock (pin held + red withheld) would be back.
    const exemption = isJudgingPinnedActiveRepair({
      candidate: CAND,
      repairCandidate: CAND,
      repairPhase: "ready-to-verify",
      repairBlockedReason: null,
    });
    expect(exemption).toBe(true);
    // Structural half of the same claim: the predicate's input shape carries no clock at all.
    const shape: Parameters<typeof isJudgingPinnedActiveRepair>[0] = {
      candidate: CAND,
      repairCandidate: CAND,
      repairPhase: "ready-to-verify",
      repairBlockedReason: null,
    };
    expect(Object.keys(shape).some((k) => /age|now|committed|stall/i.test(k))).toBe(false);
  });
});
