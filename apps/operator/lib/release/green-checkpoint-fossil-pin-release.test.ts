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

import { frozenPinIsFossilized } from "./green-checkpoint";

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
