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
 * Both rules below are HARD EVIDENCE, not heuristics — deliberately so. The sibling lesson from
 * EI-10619 (`agent-insights/prove-it-discriminates-before-it-acts`) is that a detector built on a
 * statistic over the values you happen to have will fire on healthy states; so this one reasons
 * only from facts that PROVE the verdict was superseded:
 *
 *   1. PIN-ADVANCE — the release pin moved past the pin this red was recorded against. The pin
 *      only ever advances on a GREEN checkpoint, so a later green demonstrably happened.
 *   2. WRITER-STARVED — the routine has FIRED since the observation without producing a new one.
 *      Its runs are being skipped; the verdict is simply unverified.
 *
 * A verdict you cannot distinguish from a STALE verdict is not a verdict.
 */

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
}

export interface GateVerdictFreshness {
  /** True ⇒ the recorded RED is not trustworthy: do NOT report it as the gate's current colour,
   *  and do NOT dispatch anyone to fix the tests it names. */
  stale: boolean;
  reason: string | null;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * PURE. Judge whether a recorded RED verdict has been superseded or was never verified.
 *
 * Returns `stale: false` for a green (0-red) blob: there is nothing to mistrust, and marking a
 * green stale would only invent a second phantom pointing the other way.
 */
export function evaluateGateVerdictFreshness(input: GateVerdictFreshnessInput): GateVerdictFreshness {
  const { consecutiveReds, observedAtMs, observedFromPin, currentGreenPinSha, lastFiredAtMs } = input;
  const intervalMs = input.intervalMs ?? GATE_FIRE_INTERVAL_MS;

  // Only a RED verdict can misdirect. A stale green is inert.
  if (consecutiveReds <= 0) return { stale: false, reason: null };

  // Rule 1 — PIN-ADVANCE. The pin only advances on a green checkpoint, so if it has moved past
  // the pin this red was recorded against, a green provably happened AFTER this verdict.
  if (observedFromPin && currentGreenPinSha && short(currentGreenPinSha) !== short(observedFromPin)) {
    return {
      stale: true,
      reason:
        `the release pin has advanced ${short(observedFromPin)} → ${short(currentGreenPinSha)} since this red was recorded — ` +
        `the pin only moves on a GREEN checkpoint, so the gate has greened since`,
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
    };
  }

  // A blob predating `observedAt` cannot be judged by rule 2. Say so plainly instead of guessing:
  // absence of a timestamp is not evidence of freshness, but it is not evidence of staleness either.
  return { stale: false, reason: null };
}
