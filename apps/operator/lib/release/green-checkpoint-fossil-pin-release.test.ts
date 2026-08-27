/**
 * WI-42207 — releasing a frozen candidate pin that has aged into a fossil.
 *
 * WHAT THIS GUARDS. `createFrozenCandidateQueue` deliberately pins ONE candidate so that "a
 * crash, red verdict, or newer staging tip therefore resumes this exact candidate".
 * Independently, gate-verdict-freshness rule 5 WITHHOLDS any red whose candidate is older than
 * `CANDIDATE_FOSSIL_AGE_MS`, telling the operator "the next run must re-judge a fresh tip".
 *
 * Both rules are correct alone. Together they livelock: the pin guarantees the next run resumes
 * the SAME sha, which is exactly what the fossil rule says must not happen. Measured 2026-08-26 —
 * `main` frozen 6 days at a2d69cef, 44 consecutive reds, `gate_health.failingTests: []` the whole
 * time because no signature was ever published, and runs ending `candidate-fossil` on a candidate
 * already 143m old AT SUITE START (doomed before a single test ran).
 *
 * The predicate under test is the release decision. It is deliberately conservative in the
 * unreadable case — see the NaN test, which is the one that actually bites.
 */
import { describe, expect, it } from "vitest";

import { CANDIDATE_FOSSIL_AGE_MS } from "@papercusp/operator-core/lib/release/gate-verdict-freshness";
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from "@papercusp/operator-core/lib/release/green-checkpoint-schedule";
import { DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

import {
  FROZEN_REPAIR_STALL_MS,
  frozenPinIsFossilized,
  isJudgingPinnedActiveRepair,
} from "./green-checkpoint";

/** A fixed "now" so no assertion here depends on wall-clock time. */
const NOW_MS = Date.UTC(2026, 7, 26, 19, 48, 0);
const minutesAgoSec = (min: number) => (NOW_MS - min * 60_000) / 1000;

describe("frozenPinIsFossilized (WI-42207)", () => {
  it("releases the pin at the age that actually froze main — 143m against a 120m threshold", () => {
    // The real incident's numbers, not a synthetic pair: candidate 10bf66f6 was 143 minutes old
    // when its suite STARTED, so every red it could still produce was guaranteed to be withheld.
    expect(
      frozenPinIsFossilized({
        committedAtSec: minutesAgoSec(143),
        nowMs: NOW_MS,
      }),
    ).toBe(true);
    // Pin the threshold this depends on, so a change to it fails HERE rather than silently
    // altering when the gate releases a pin.
    expect(CANDIDATE_FOSSIL_AGE_MS).toBe(120 * 60_000);
  });

  it("holds the pin for a fresh candidate — the normal case must be untouched", () => {
    // A healthy run selects a tip minutes old (measured Aug 20-22: 1-38m). Releasing those would
    // destroy the stabilise-and-repair behaviour the queue exists to provide.
    for (const ageMin of [0, 1, 38, 119]) {
      expect(
        frozenPinIsFossilized({
          committedAtSec: minutesAgoSec(ageMin),
          nowMs: NOW_MS,
        }),
      ).toBe(false);
    }
  });

  it("holds exactly AT the threshold and releases just past it", () => {
    const atThresholdSec = (NOW_MS - CANDIDATE_FOSSIL_AGE_MS) / 1000;
    // `>` not `>=`: a candidate exactly at the threshold is still publishable by rule 5, so
    // releasing it would discard a pin the fossil rule would have honoured.
    expect(
      frozenPinIsFossilized({
        committedAtSec: atThresholdSec,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    expect(
      frozenPinIsFossilized({
        committedAtSec: atThresholdSec - 1,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("HOLDS on a NaN commit time (documented, but NOT the discriminating case)", () => {
    // HONESTY NOTE, measured rather than assumed: this assertion does NOT distinguish the guard.
    // `commitUnixTime` is `Number(await git(...))` and returns NaN rather than throwing, but
    // `Math.max(0, NaN)` is NaN and `NaN > threshold` is already false — so removing
    // `!Number.isFinite(...)` leaves this case behaving identically. It is kept because the NaN
    // path is real and a future refactor could make it matter; it is labelled so nobody reads it
    // as proof the guard works. The `null` case below is what actually proves that.
    expect(
      frozenPinIsFossilized({ committedAtSec: NaN, nowMs: NOW_MS }),
    ).toBe(false);
    // ...and it must still hold even when the surrounding age would obviously be a fossil, which
    // is what distinguishes a real guard from an accidental one.
    expect(
      frozenPinIsFossilized({
        committedAtSec: NaN,
        nowMs: NOW_MS,
        fossilAgeMs: 1,
      }),
    ).toBe(false);
  });

  it("holds when the commit time is absent entirely — THE falsifying case", () => {
    // This is the assertion that makes the guard falsifiable, verified by mutation: drop the
    // `committedAtSec == null` check and `null * 1_000` coerces to 0, so the age reads as ~56
    // YEARS and the predicate returns true — releasing the pin of a candidate whose commit time
    // simply could not be read. Of the seven inputs covered here, this is the only one whose
    // result changes when the guard is removed, so if you are trimming this file, keep this one.
    expect(
      frozenPinIsFossilized({ committedAtSec: null, nowMs: NOW_MS }),
    ).toBe(false);
    expect(
      frozenPinIsFossilized({ committedAtSec: undefined, nowMs: NOW_MS }),
    ).toBe(false);
  });

  it("holds for a future-dated commit instead of releasing on negative age", () => {
    // Clock skew between the committer and this process must not read as "infinitely old".
    // The age is clamped at 0, so a future commit is the freshest thing possible, never a fossil.
    expect(
      frozenPinIsFossilized({
        committedAtSec: minutesAgoSec(-600),
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("honours an explicit fossilAgeMs override in both directions", () => {
    const tenMinOldSec = minutesAgoSec(10);
    expect(
      frozenPinIsFossilized({
        committedAtSec: tenMinOldSec,
        nowMs: NOW_MS,
        fossilAgeMs: 5 * 60_000,
      }),
    ).toBe(true);
    expect(
      frozenPinIsFossilized({
        committedAtSec: tenMinOldSec,
        nowMs: NOW_MS,
        fossilAgeMs: 30 * 60_000,
      }),
    ).toBe(false);
  });
});

/**
 * ── PLAN D-004: the fossil rules are a COUPLED PAIR ──────────────────────────────────────────
 *
 * The header above describes the livelock correctly but resolved it in ONE direction: release the
 * pin so a fresh tip can be judged. Measured 2026-08-27, that resolution has a cost the original
 * framing missed — by CALL-SITE ORDER, not by reading constants:
 *
 *   frozenPinIsFossilized ................ green-checkpoint.ts:~7700  (sets repairQueue = null)
 *   decideFrozenCandidateRepairQueue ..... green-checkpoint.ts:~7780  (applies the 4h/3 budget)
 *
 * The budget evaluation runs ~80 lines LATER, inside `if (repairQueue)`. So for any repair living
 * past CANDIDATE_FOSSIL_AGE_MS the queue's own budget was UNREACHABLE CODE: `maxAgeMs` could never
 * fire and `blockedReason: 'wall-clock-exhausted'` was dead in production. Every frozen candidate
 * died to the 2h wall clock, none to a verdict (96061f5e@122m, bd653329@147m, bd653329@366m).
 *
 * The fix is therefore TWO predicates that must agree, and fixing EITHER ALONE re-creates the
 * freeze:
 *   • hold a PROGRESSING pin  (frozenPinIsFossilized)   — without the exemption below, its red is
 *     withheld and the queue resumes the same sha forever: the 6-day freeze, exactly.
 *   • publish that pin's red  (isJudgingPinnedActiveRepair) — without the hold above, there is no
 *     pin left to publish about.
 * `holds a progressing pin AND publishes its red — the livelock, encoded` asserts the pair.
 */
describe("frozenPinIsFossilized — progress awareness (plan D-004)", () => {
  /** A repair that is alive and moving: phase live, nothing blocked, just updated. */
  const progressing = {
    repairPhase: "ready-to-test" as const,
    repairBlockedReason: null,
    repairUpdatedAtMs: NOW_MS - 60_000,
  };

  /**
   * PERMANENT WRONG CONTROL — the pre-fix production predicate, age-only.
   *
   * Kept verbatim (not a paraphrase) so a silent revert to age-only reds here instead of passing.
   * Every assertion below that distinguishes the fix is stated as a DISAGREEMENT with this
   * control; without it these tests would pass just as happily against the code that froze main.
   */
  const ageOnlyFossilCheck = (input: {
    committedAtSec: number | null | undefined;
    nowMs: number;
    fossilAgeMs?: number;
  }): boolean => {
    const { committedAtSec, nowMs } = input;
    if (committedAtSec == null || !Number.isFinite(committedAtSec)) return false;
    const ageMs = Math.max(0, nowMs - committedAtSec * 1_000);
    return ageMs > (input.fossilAgeMs ?? CANDIDATE_FOSSIL_AGE_MS);
  };

  it("HOLDS the pin of a progressing repair past the threshold — and the old code did not", () => {
    // 143m is the real incident age, the same number the first test in this file uses. Under the
    // pre-fix predicate this released the pin mid-repair; that is the defect.
    const args = { committedAtSec: minutesAgoSec(143), nowMs: NOW_MS };
    expect(frozenPinIsFossilized({ ...args, ...progressing })).toBe(false);
    // THE DISCRIMINATING ASSERTION: the control and the fix must DISAGREE here. If this stops
    // failing for the control, the progress guard has become vacuous.
    expect(ageOnlyFossilCheck(args)).toBe(true);
  });

  it("releases once the queue's OWN budget is spent — the 4h/3-attempt limits, now reachable", () => {
    const args = { committedAtSec: minutesAgoSec(143), nowMs: NOW_MS };
    // phase 'blocked' is how the queue reports its own exhaustion.
    expect(
      frozenPinIsFossilized({ ...args, ...progressing, repairPhase: "blocked" }),
    ).toBe(true);
    // ...and either blockedReason alone is sufficient, so a phase/reason skew cannot wedge a pin.
    for (const reason of ["attempts-exhausted", "wall-clock-exhausted"] as const) {
      expect(
        frozenPinIsFossilized({
          ...args,
          ...progressing,
          repairBlockedReason: reason,
        }),
      ).toBe(true);
    }
    // The whole point of deferring: the queue's budget must OUTLAST the fossil threshold, or
    // deferring to it would change nothing. This is the inequality the fix depends on.
    expect(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAgeMs).toBeGreaterThan(
      CANDIDATE_FOSSIL_AGE_MS,
    );
  });

  it("releases a WEDGED queue whose writer died without ever marking it blocked", () => {
    const args = { committedAtSec: minutesAgoSec(400), nowMs: NOW_MS };
    // No progress for longer than a full suite plus slack ⇒ nobody is coming back for this pin.
    expect(
      frozenPinIsFossilized({
        ...args,
        ...progressing,
        repairUpdatedAtMs: NOW_MS - (FROZEN_REPAIR_STALL_MS + 60_000),
      }),
    ).toBe(true);
    // Just INSIDE the stall window it must still hold — a slow suite is not a dead one, and this
    // is the boundary that decides whether a legitimate 115m suite survives.
    expect(
      frozenPinIsFossilized({
        ...args,
        ...progressing,
        repairUpdatedAtMs: NOW_MS - (FROZEN_REPAIR_STALL_MS - 60_000),
      }),
    ).toBe(false);
    // Missing/!finite progress data releases, restoring the historical behaviour rather than
    // inventing an indefinite hold out of absent input.
    for (const bad of [null, undefined, NaN]) {
      expect(
        frozenPinIsFossilized({
          ...args,
          ...progressing,
          repairUpdatedAtMs: bad,
        }),
      ).toBe(true);
    }
  });

  it("leaves the NO-QUEUE path bit-for-bit identical to the pre-fix predicate", () => {
    // The authorization for this change (D-001) required no-queue behaviour be preserved, so
    // assert it against the control across the whole interesting range rather than one point.
    for (const ageMin of [0, 38, 119, 120, 121, 143, 366]) {
      const args = { committedAtSec: minutesAgoSec(ageMin), nowMs: NOW_MS };
      expect(frozenPinIsFossilized(args)).toBe(ageOnlyFossilCheck(args));
      // An explicit null pin is the same "no queue" statement as omitting it.
      expect(
        frozenPinIsFossilized({ ...args, repairPhase: null }),
      ).toBe(ageOnlyFossilCheck(args));
    }
  });

  it("never resurrects a FRESH candidate — the age gate still runs first", () => {
    // A blocked queue on a 38m candidate must still HOLD: progress state may only ever make the
    // predicate more conservative, never release a pin the age rule would have kept.
    expect(
      frozenPinIsFossilized({
        committedAtSec: minutesAgoSec(38),
        nowMs: NOW_MS,
        repairPhase: "blocked",
        repairBlockedReason: "attempts-exhausted",
        repairUpdatedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("derives the stall window from one real suite, so a legitimate suite cannot trip it", () => {
    expect(FROZEN_REPAIR_STALL_MS).toBe(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS + 30 * 60_000,
    );
    // The bug being prevented: a stall window SHORTER than a suite would release the pin of a
    // repair that is merely running its tests.
    expect(FROZEN_REPAIR_STALL_MS).toBeGreaterThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });
});

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
    // red — the mirror of the same skew guard on the pin-release side.
    expect(
      isJudgingPinnedActiveRepair({
        candidate: CAND,
        repairCandidate: CAND,
        repairPhase: "ready-to-test",
        repairBlockedReason: "wall-clock-exhausted",
      }),
    ).toBe(false);
  });

  it("holds a progressing pin AND publishes its red — the livelock, encoded", () => {
    // This is D-004's entire argument as one executable assertion, and the reason these two
    // predicates may never be changed independently.
    const args = { committedAtSec: minutesAgoSec(143), nowMs: NOW_MS };
    const pinHeld = !frozenPinIsFossilized({
      ...args,
      repairPhase: "ready-to-test",
      repairBlockedReason: null,
      repairUpdatedAtMs: NOW_MS - 60_000,
    });
    const redPublished = isJudgingPinnedActiveRepair({
      candidate: CAND,
      repairCandidate: CAND,
      repairPhase: "ready-to-test",
      repairBlockedReason: null,
    });
    // BOTH must hold. Either one alone is a freeze:
    //   pin held + red withheld  → the queue resumes the same sha forever (the measured 6 days,
    //                              44 reds, failingTests: [] throughout, no fixer ever dispatched)
    //   pin released + red published → nothing left to repair; the fix is thrown away mid-flight
    expect({ pinHeld, redPublished }).toEqual({
      pinHeld: true,
      redPublished: true,
    });
  });
});
