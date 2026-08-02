/**
 * gate-verdict-freshness.ts — is the green-gate's recorded verdict still TRUSTWORTHY? (WI-4489)
 *
 * ## The defect this closes
 *
 * `gate_health` (the green-checkpoint routine's metadata blob) is a mutable CACHE of the gate's
 * last verdict. It is written ONLY by ROUTINE-invoked checkpoint runs. But a routine fire that
 * loses the per-root run-lock records `skipped-locked`, which `classifyGateStallStatus` correctly
 * treats as a NO-OP (a lock collision proves nothing about gate health, EI-2615) — and the no-op
 * path returns WITHOUT touching `gate_health`.
 *
 * Meanwhile the fire itself still advances `routines.last_fired_at`. So:
 *
 *   - `fireStale` (WI-282) keys on `last_fired_at` ⇒ reads FRESH — the routine IS firing, hourly,
 *     on time.
 *   - `gate_health.consecutiveReds` keys on the last OBSERVATION ⇒ can be arbitrarily old.
 *
 * **A routine that fires and no-ops is indistinguishable from a routine that fires and works.**
 * WI-282's comment says `fireStale` exists to catch a checkpoint that *never ran* ("it can't go
 * red without running"). This is the uncovered inverse: one that RAN, SKIPPED, and WROTE NOTHING.
 *
 * Observed live 2026-07-12: the last real verdict was 18:29; the routine then fired at 19:15,
 * 20:15 and 21:15, each `skipped-locked`. For ~3.5h every consumer read `consecutiveReds: 4,
 * fireStale: false` — a confident RED — while the gate was in fact GREEN on every actual run
 * (`{"reason":"up-to-date","green":true}`) and all 8 named "failing" tests passed. The stale red
 * dispatched the release-fixer, whose MANUAL runs held the lock that kept the routine skipping,
 * which kept the blob stale: a self-sustaining phantom that could not clear itself.
 *
 * ## The principle
 *
 * > The `ready` pin advancing IS the gate's green verdict — durably recorded in git. `gate_health`
 * > is only a cache of it. **When the cache and the pin disagree, the PIN is the truth.**
 *
 * `release-actions.ts` already trusts exactly this inference — but only on the WRITE path
 * (`pinMoved` ⇒ reset the streak). It was never applied on the READ path, so any consumer reading
 * a starved cache was misled. This module applies it there.
 *
 * All three rules below are HARD EVIDENCE, not heuristics — deliberately so. The sibling lesson
 * from EI-10619 (`agent-insights/prove-it-discriminates-before-it-acts`) is that a detector built
 * on a statistic over the values you happen to have will fire on healthy states; so this one
 * reasons only from facts that PROVE the verdict was superseded:
 *
 *   1. PIN-ADVANCE — the release pin moved past the pin this red was recorded against. The pin
 *      only ever advances on a GREEN checkpoint, so a later green demonstrably happened.
 *   2. WRITER-STARVED — the routine has FIRED since the observation without producing a new one.
 *      Its runs are being skipped; the verdict is simply unverified.
 *   3. RETRIAGE-PROVEN (EI-13288) — the checkpoint run that PRODUCED this verdict already re-ran
 *      its own named failing files at a newer tip (green-checkpoint.ts's stale-candidate
 *      re-triage) and they PASSED, but the bounded auto-refire cap was reached before a full
 *      suite could confirm that tip green. Unlike rules 1-2 (both infer staleness from
 *      surrounding pipeline state), this is the run's own first-hand evidence about itself: it
 *      directly disproves its own failing-test names, at record time, without needing the pin to
 *      move or the routine to starve. See EI-13288 — a fresh, on-time, correctly-held gate can
 *      still name files its own retriage already knows don't reproduce.
 *   4. REFIRE-IN-FLIGHT (EI-18669342433807110) — a stale-candidate auto-refire for THIS EXACT red
 *      is running RIGHT NOW (green-checkpoint.ts already decided the red is stale and recursed
 *      onto a newer tip, but that recursion can take minutes and writes nothing to `gate_health`
 *      until it settles). Like rule 3 this is live first-hand evidence, not an inference — the run
 *      that produced the cached red is, this moment, re-verifying it. Checked FIRST: it is the
 *      most current of the four (rule 3 is about a run that already finished; this one hasn't).
 *
 * A verdict you cannot distinguish from a STALE verdict is not a verdict.
 */

import { describeRefireBudget, type StoredInFlightRetriage } from './in-flight-retriage';

/** One green-checkpoint fire interval. The routine is hourly; the 1.5× slack below keeps a fire
 *  that lands a little late from reading as a starved writer. */
export const GATE_FIRE_INTERVAL_MS = 60 * 60_000;

export interface GateVerdictFreshnessInput {
  /** The red streak the cache is reporting. A ZERO-red (green) verdict going stale is harmless —
   *  it never misdirects anyone — so freshness is only ever judged for a RED. */
  consecutiveReds: number;
  /** When the last REAL verdict was observed (`gate_health.observedAt`). Null on a blob written
   *  before this field existed — rule 2 is then unavailable and says so, rather than guessing. */
  observedAtMs: number | null;
  /** The release pin as observed AT verdict time (`gate_health.lastFrom`), 12-char short sha. */
  observedFromPin: string | null;
  /** The release ("ready") pin RIGHT NOW — full or short sha. */
  currentGreenPinSha: string | null;
  /** The routine's last fire (`routines.last_fired_at`) — fresh even when the fire no-opped. */
  lastFiredAtMs: number | null;
  /** Fire interval; defaults to {@link GATE_FIRE_INTERVAL_MS}. */
  intervalMs?: number;
  /** EI-13288 — Rule 3 input. Non-null ⇒ the checkpoint run that produced THIS verdict already
   *  re-ran its own named failing files at this (short) tip sha, via the stale-candidate
   *  re-triage, and they PASSED — the auto-refire cap was reached before a full suite could
   *  confirm that tip green (`gate_health.retriageStaleTip`). This is hard evidence from the
   *  SAME run, not a heuristic: the verdict's own failure signature does not reproduce at a sha
   *  it already checked. Null/absent when the run's retriage never found a stale-candidate (the
   *  common, genuinely-broken case) or ran on a blob predating this field. */
  retriageStaleTip?: string | null;
  /** EI-18669342433807110 — Rule 4 input. The parsed `gate_health.inFlightRetriage` marker (already
   *  freshness-checked by `parseInFlightRetriage`), when a stale-candidate auto-refire is currently
   *  running. Null/absent when no refire is in flight, or its marker is missing/abandoned. */
  inFlightRetriage?: StoredInFlightRetriage | null;
}

export interface GateVerdictFreshness {
  /** True ⇒ the recorded RED is not trustworthy: do NOT report it as the gate's current colour,
   *  and do NOT dispatch anyone to fix the tests it names. */
  stale: boolean;
  reason: string | null;
  /**
   * WHICH rule fired, when `stale` — callers that need to distinguish PROVEN-GREEN from
   * merely-UNVERIFIED must not just branch on `stale` (EI-13714):
   *   - 'pin-advance'      — HARD PROOF a green happened (the pin only moves on green). A
   *                          caller may safely treat the streak as reset to 0, not just "unknown".
   *   - 'writer-starved'   — no new evidence either way; the true colour is genuinely unknown.
   *   - 'retriage-proven'  — this verdict's own named failures are proven not to reproduce at a
   *                          newer tip, but that is not a full-suite green proof.
   *   - 'refire-in-flight' — a stale-candidate auto-refire for this exact red is running RIGHT
   *                          NOW; a fresh verdict is imminent, so this cached red must not be
   *                          acted on in the meantime.
   * `null` when `stale` is false.
   */
  reasonCode: 'pin-advance' | 'writer-starved' | 'retriage-proven' | 'refire-in-flight' | null;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * PURE. Judge whether a recorded RED verdict has been superseded or was never verified.
 *
 * Returns `stale: false` for a green (0-red) blob: there is nothing to mistrust, and marking a
 * green stale would only invent a second phantom pointing the other way.
 */
export function evaluateGateVerdictFreshness(input: GateVerdictFreshnessInput): GateVerdictFreshness {
  const {
    consecutiveReds,
    observedAtMs,
    observedFromPin,
    currentGreenPinSha,
    lastFiredAtMs,
    retriageStaleTip,
    inFlightRetriage,
  } = input;
  const intervalMs = input.intervalMs ?? GATE_FIRE_INTERVAL_MS;

  // Only a RED verdict can misdirect. A stale green is inert.
  if (consecutiveReds <= 0) return { stale: false, reason: null, reasonCode: null };

  // Rule 4 — REFIRE-IN-FLIGHT (EI-18669342433807110). Checked FIRST — this is live, RIGHT-NOW
  // evidence (a run is this moment re-verifying the exact red being read), more current than any
  // of the other three rules. Only trusted when the marker names the SAME candidate this cached
  // red was recorded against — a marker left over from an earlier, already-superseded red must
  // never silence a genuinely new, unrelated one.
  if (inFlightRetriage && observedFromPin && inFlightRetriage.fromCandidate === observedFromPin) {
    return {
      stale: true,
      reason:
        `a stale-candidate auto-refire for this exact red is IN FLIGHT right now ` +
        `(${describeRefireBudget(inFlightRetriage).label}, re-verifying tip ` +
        `${short(inFlightRetriage.refiringCandidate)}) — do NOT go fix the test(s) it names; a fresh ` +
        `verdict is imminent` +
        // EI-19343516395023183: at the cap the imminent verdict is the FINAL one, so "wait, it will
        // sort itself out" stops being true here. Saying so is the difference between waiting
        // correctly and waiting through the one red that was always going to stick.
        (describeRefireBudget(inFlightRetriage).atCap
          ? ` ⚠ this is the LAST refire — if it comes back red the verdict STICKS, so be ready to act on it`
          : ''),
      reasonCode: 'refire-in-flight',
    };
  }

  // Rule 3 — RETRIAGE-PROVEN (EI-13288). Checked first of the post-hoc rules: this is the run's OWN evidence about
  // ITSELF (a real re-test it performed, not an inference from surrounding state), so it is the
  // most direct of the three rules. The gate held (correctly — the auto-refire cap bounds how
  // long we chase a moving tip), but the specific failing-test NAMES this verdict carries are
  // proven, by the run's own hand, not to reproduce at `retriageStaleTip`.
  if (retriageStaleTip) {
    return {
      stale: true,
      reason:
        `this verdict's own stale-candidate re-triage already re-ran its named failing file(s) at tip ` +
        `${short(retriageStaleTip)} and they PASSED — the auto-refire cap was reached before a full ` +
        `suite could confirm ${short(retriageStaleTip)} green, so the recorded failing-test names are ` +
        `unconfirmed at record time (they may already be fixed)`,
      reasonCode: 'retriage-proven',
    };
  }

  // Rule 1 — PIN-ADVANCE. The pin only advances on a green checkpoint, so if it has moved past
  // the pin this red was recorded against, a green provably happened AFTER this verdict.
  if (observedFromPin && currentGreenPinSha && short(currentGreenPinSha) !== short(observedFromPin)) {
    return {
      stale: true,
      reason:
        `the release pin has advanced ${short(observedFromPin)} → ${short(currentGreenPinSha)} since this red was recorded — ` +
        `the pin only moves on a GREEN checkpoint, so the gate has greened since`,
      reasonCode: 'pin-advance',
    };
  }

  // Rule 2 — WRITER-STARVED. The routine fired again but produced no new verdict (its runs are
  // being skipped on the run-lock), so `consecutiveReds` is simply unverified. Note this reads
  // `last_fired_at`, which a `skipped-locked` no-op DOES refresh — that mismatch is the whole bug.
  if (observedAtMs != null && lastFiredAtMs != null && lastFiredAtMs > observedAtMs + intervalMs * 1.5) {
    const hrs = Math.round(((lastFiredAtMs - observedAtMs) / 3_600_000) * 10) / 10;
    return {
      stale: true,
      reason:
        `the green-checkpoint has fired since this verdict without producing a new one (last verdict ${hrs}h before the last fire) — ` +
        `its runs are being SKIPPED (run-lock contention), so this red is unverified`,
      reasonCode: 'writer-starved',
    };
  }

  // A blob predating `observedAt` cannot be judged by rule 2. Say so plainly instead of guessing:
  // absence of a timestamp is not evidence of freshness, but it is not evidence of staleness either.
  return { stale: false, reason: null, reasonCode: null };
}
