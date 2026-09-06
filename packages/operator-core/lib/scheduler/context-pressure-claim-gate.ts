/**
 * context-pressure-claim-gate.ts — WI-5940: refuse to SERVE new self-selected work to a
 * caller whose context pressure is CRITICAL, with a compact-first verdict instead of an item.
 *
 * WHY (the filed reproduction): a leader told a critical-context member to pull now AND to
 * self-compact first in the same message. The ordering was ambiguous, the member pulled a hard
 * timing-sensitive item ~2 minutes later, and an ownership collision followed. An agent at
 * critical context cannot reliably drive a hard item to completion — it will compact mid-task,
 * and in-flight state is exactly what compaction carries worst. At the time of filing the same
 * fleet had critical_context 3-of-10 members with 4 unowned criticals: this is the steady state
 * of a long drain, not a rare corner.
 *
 * WHY THIS IS ONE SHARED MODULE rather than a check inlined at each tool. Both SELF-SELECT
 * surfaces (`scheduler:get_next` and its compatibility wrapper `work_items:claim_next`) must
 * answer identically. get_next.ts already carries the scar from letting exactly that drift:
 * `concurrencyBlockedRefusal`'s doc comment records how the cap-led refusal existed on the
 * non-fleet branch only, so the identical defect survived on `fleetScopedMiss` — the branch every
 * fleet member actually takes. Same anti-drift shape here: ONE verdict, two call sites.
 *
 * ⚠ THE CENTRAL HAZARD — a false 'critical' must never manufacture a false drain.
 * `contextPressure` is NOT a live reading. It is cached on `coord_presence` by the
 * compaction-compliance watchdog on a ~2-minute sweep, while a session's own ambient context
 * gauge is recomputed every turn. context-pressure.ts records the measured divergence: a fleet
 * member's `coord:orient` row read "critical" moments after its own live gauge read 12%. If that
 * stale reading silently refused work, this gate would recreate the very false-drain trap the
 * filing warns against (point 2: the refusal must be a VERDICT, not silence) — an agent idling
 * while believing its lane is drained, which is strictly worse than the collision it prevents.
 *
 * Three properties keep that from happening, and each is asserted by a test:
 *   1. FAIL-OPEN ON UNKNOWN. `deriveContextPressure` already degrades a reading older than
 *      CONTEXT_ESTIMATE_STALE_MS to `null`, and `fetchContextPressure` simply omits such owners.
 *      A `null`/absent bucket SERVES, and is never coerced to 'critical'. Unknown means unknown.
 *   2. ONLY 'critical' REFUSES. 'ok' and 'high' are served unchanged — 'high' means "wrap up
 *      soon", which is not a reason to withhold work (and the filing's acceptance says so).
 *   3. AN ESCAPE HATCH THE CALLER OWNS. A caller sees its live gauge every turn; the cache is a
 *      ≤2-minute-stale proxy for it. So on the one axis where they disagree, the CALLER is the
 *      better authority — `override` lets it proceed and is reported in the result rather than
 *      being silent. Without it, a falsely-cached 'critical' could withhold work for up to the
 *      full staleness ceiling with no recourse, which is the worse failure.
 *
 * The refusal itself leads with the CAUSE and states plainly that the lane was never consulted —
 * EI-19931420102632438's lesson, that a caller refused on its OWN state must never be handed a
 * sentence that reads as a claim about lane contents.
 *
 * PURE (no PG, no clock): the IO seam is the existing `fetchContextPressure` batch read, done by
 * the caller. That keeps this unit-testable and keeps the gate's semantics in one readable place.
 */

import type {
  ContextPressureBucket,
  ContextPressureRecoveryResolution,
} from '../agent-tools/coordination/context-pressure';

/** Typed verdict code, named by the filing so a reader can grep the item from the wire. */
export const CONTEXT_CRITICAL_REFUSAL_CODE = 'claim_refused_context_critical';

/** Why the gate let a pull through — reported so "served" is never an unexplained default. */
export type ContextPressureServeReason =
  /** Bucket resolved below the refusal threshold. */
  | 'pressure-ok'
  /** 'high' — wrap-up territory, deliberately still served (acceptance: ok/high unchanged). */
  | 'pressure-high'
  /** No bucket: untracked owner, or an estimate too stale to assert. Fail-open by contract. */
  | 'pressure-unknown'
  /** Caller asserted its live gauge disagrees with the cached bucket. */
  | 'caller-override'
  /** Kill-switch off. */
  | 'gate-disabled';

export type ContextPressureGateDecision =
  | { refuse: false; reason: ContextPressureServeReason; bucket: ContextPressureBucket | null }
  | {
      refuse: true;
      reason: 'pressure-critical';
      bucket: 'critical';
      code: typeof CONTEXT_CRITICAL_REFUSAL_CODE;
      error: string;
      diagnosis: {
        contextPressureBlocked: true;
        contextPressure: 'critical';
        /** The lane was never queried — say so, so this is not read as a drain verdict. */
        laneEvaluated: false;
        remedy: string;
        overrideArg: string;
        recoveryPath: ContextPressureRecoveryResolution['path'] | null;
      };
    };

function contextPressureRemedy(
  recovery: ContextPressureRecoveryResolution | null | undefined,
): { label: string; text: string } {
  switch (recovery?.path) {
    case 'cold-loop':
      return {
        label: recovery.carryNoteVerified
          ? 'cold-loop settle'
          : 'checkpoint, then cold-loop settle',
        text:
          'write/refresh loop:checkpoint { did, left, insight, next }, then end this turn; the armed COLD loop ' +
          'is the fresh-context boundary on its next wake' +
          (recovery.carryNoteVerified
            ? ' from its verified carry-note.'
            : ' and the checkpoint creates the carry-note it needs. Do not call session:request-compaction.'),
      };
    case 'warm-loop':
      return {
        label: 'checkpoint, then warm-loop retune',
        text:
          'write/refresh loop:checkpoint { did, left, insight, next }, then call session:request-compaction; ' +
          'its no-PTY fallback retunes the active WARM loop to COLD before the next wake.',
      };
    case 'no-path':
      return {
        label: 'checkpoint, arm a fresh-context wake',
        text:
          'write/refresh durable checkpoints, arm a COLD loop (or another real fresh-context wake), then end this turn and re-pull; ' +
          'self-compaction is unavailable to this session.',
      };
    case 'unknown':
      return {
        label: 'verify a fresh-context recovery path',
        text:
          'write/refresh durable checkpoints and establish a verified fresh-context wake before ending this turn; ' +
          'recovery-path availability could not be read, so do not assume session:request-compaction can succeed.',
      };
    case 'self-compaction':
    default:
      return {
        label: 'self-compact, then re-pull',
        text:
          'self-compact (session:request-compaction { autoContinue: true }), then re-pull; the work is still there.',
      };
  }
}

/**
 * The refusal text. Shaped like `concurrencyBlockedRefusal`: cause first, explicit
 * "the lane was NOT evaluated" disclaimer, then the remedy — and it names the override so a
 * caller holding a contradicting live gauge is never left without a move.
 */
function contextCriticalRefusalMessage(
  overrideArg: string,
  recovery: ContextPressureRecoveryResolution | null | undefined,
): string {
  const remedy = contextPressureRemedy(recovery);
  return (
    'context pressure CRITICAL: your cached context estimate is at/above the critical band, and an ' +
    'agent that compacts mid-task carries in-flight state worst — so no item was served. ' +
    `REMEDY: ${remedy.text} ` +
    'work is still there. (The claim lane itself was NOT evaluated — this is not a statement about ' +
    'lane contents, and NOT a drain verdict.) ' +
    `If your OWN live context gauge disagrees, it is the better authority — the cached bucket lags it ` +
    `by up to a ~2-minute watchdog sweep: re-call with ${overrideArg}: true to proceed.`
  );
}

/**
 * PURE decision. `bucket` is the caller's own cached context-pressure bucket (null ⇒ unknown).
 *
 * Ordering is deliberate: the kill-switch and the caller's override are consulted BEFORE the
 * bucket, so neither can be defeated by a stale reading.
 */
export function decideContextPressureGate(input: {
  bucket: ContextPressureBucket | null | undefined;
  /** Caller asserts its live gauge contradicts the cached bucket. */
  override?: boolean;
  /** Kill-switch (flag). Default true — finished work does not ship dark. */
  enabled?: boolean;
  /** Name of the override argument, for the remedy text. */
  overrideArg?: string;
  /** Optional async-derived remedy facts; omitted preserves the legacy wording. */
  recovery?: ContextPressureRecoveryResolution | null;
}): ContextPressureGateDecision {
  const bucket = input.bucket ?? null;
  const overrideArg = input.overrideArg ?? 'ignoreContextPressure';
  if (input.enabled === false) return { refuse: false, reason: 'gate-disabled', bucket };
  if (input.override === true) return { refuse: false, reason: 'caller-override', bucket };
  // Fail-open on unknown: an absent/stale bucket is never coerced into a refusal.
  if (bucket == null) return { refuse: false, reason: 'pressure-unknown', bucket: null };
  if (bucket === 'ok') return { refuse: false, reason: 'pressure-ok', bucket };
  if (bucket === 'high') return { refuse: false, reason: 'pressure-high', bucket };
  return {
    refuse: true,
    reason: 'pressure-critical',
    bucket: 'critical',
    code: CONTEXT_CRITICAL_REFUSAL_CODE,
    error: contextCriticalRefusalMessage(overrideArg, input.recovery),
    diagnosis: {
      contextPressureBlocked: true,
      contextPressure: 'critical',
      laneEvaluated: false,
      remedy: contextPressureRemedy(input.recovery).label,
      overrideArg,
      recoveryPath: input.recovery?.path ?? null,
    },
  };
}

/** The full wire body for a refusing tool result — shared so both surfaces emit one shape. */
export function contextCriticalRefusalResult(decision: Extract<ContextPressureGateDecision, { refuse: true }>): {
  ok: false;
  error: string;
  code: string;
  diagnosis: Record<string, unknown>;
} {
  return {
    ok: false,
    error: decision.error,
    code: decision.code,
    diagnosis: decision.diagnosis,
  };
}
