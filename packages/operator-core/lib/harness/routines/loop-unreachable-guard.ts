/**
 * Loop unreachable-owner terminal guard (WI-1399 — "auto-terminate loops whose owner
 * session is permanently gone").
 *
 * The gap: a loop:arm loop whose owner session dies PERMANENTLY is re-armed forever by the
 * stuck-park backstop in `reconcile-loop-routines.ts` — NOTHING existing auto-pauses it:
 *   - the fire-gate circuit (`autoloop.ts` evaluateFireGate) only THROTTLES, and its own
 *     recovery-debounce (F3) auto-CLOSES a stalled-open circuit and RESUMES cadence;
 *   - the cost-cap (`loop-cost-cap.ts`) only fires when `costCapCents` is configured;
 *   - the dead-man guard (`loop-dead-man.ts`) only fires when `maxFires`/`maxDurationSec`
 *     is configured.
 * A loop armed with none of those (the common case for an interactive su loop) re-fires
 * forever, wasting a resume spawn per cycle and re-emitting `loop-stalled` watchdog EIs.
 *
 * This adds the missing UNCONDITIONAL guard: using the SAME reachability signal
 * `loop:status` already surfaces to a human (`probeWakeReachability` —
 * events/await/wake-reachability.ts), a stuck-park cycle whose owner is genuinely
 * unreachable (no injectable channel, not resumable — `reachable === false`) — AND has
 * stayed that way across a generous terminal window and a minimum run of consecutive
 * stuck-backstop fires (so a merely slow/long-turn or transiently-uninjectable session is
 * never mistaken for permanently dead) — is auto-paused instead of re-armed.
 *
 * A healthy loop between fires still has a standing inbox-wake await and (once its process
 * exits or the psu-host reconnects) a live channel, so it stays reachable; only a truly-gone
 * session (relaunched terminal never reconnected, dead pid, no resumable handle) trips this.
 *
 * Fail-soft throughout: a probe error or read failure is treated as "still reachable" — an
 * uncertain read must never terminate a loop; the existing backoff/circuit guards remain the
 * fallback defense in that case.
 */
import type { Sql } from 'postgres';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import { autoPauseLoopRoutine } from './loop-cost-cap';

/** Terminal window floor: an unreachable owner must stay that way for at least this long
 *  (env-overridable) before termination is even considered. */
export const DEFAULT_TERMINAL_UNREACHABLE_MS = 2 * 3600_000; // 2h

/** Minimum consecutive stuck-backstop fires (autoloop_state.consecutive_errors, +1 for the
 *  fire under evaluation) before termination — so a single blip never terminates a loop. */
export const DEFAULT_MIN_STUCK_FIRES = 3;

/** The terminal window for a given loop interval: env override, floored at 8× the loop's own
 *  interval so a very short-interval loop still gets several real retry cycles first (mirrors
 *  `stuckParkMs`'s own 4×-interval floor in reconcile-loop-routines.ts, doubled since this is
 *  the STRICTLY LATER guard in the chain — it must never fire before the stuck-park backstop
 *  itself would have had multiple chances to recover). */
export function terminalUnreachableMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_TERMINAL_UNREACHABLE_MS;
  return Math.max(base, intervalMs * 8);
}

/** Minimum consecutive stuck-backstop fires required, env-overridable. */
export function minStuckFiresForTermination(): number {
  const env = Number(process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : DEFAULT_MIN_STUCK_FIRES;
}

/**
 * Pure decision: breach only when the owner is unreachable, has been parked past the
 * terminal window, AND this fire is at least the configured minimum consecutive
 * stuck-backstop count. Each condition independently guards against a false positive
 * (a reachable owner, a not-yet-stale park, or a single blip never breaches).
 */
export function evaluateUnreachableTerminalGuard(input: {
  /** `probeWakeReachability(...).reachable` for the loop's target owner. */
  reachable: boolean;
  /** How long the owner has been unreachable / the loop parked with no signal (ms). */
  parkedForMs: number;
  /** The loop's configured interval (ms) — used to floor the terminal window. */
  intervalMs: number;
  /** Consecutive stuck-backstop fires, INCLUDING the one under evaluation. */
  stuckFireCount: number;
}): { breach: boolean; reason?: string } {
  if (input.reachable) return { breach: false };
  const window = terminalUnreachableMs(input.intervalMs);
  if (input.parkedForMs < window) return { breach: false };
  const minFires = minStuckFiresForTermination();
  if (input.stuckFireCount < minFires) return { breach: false };
  return {
    breach: true,
    reason:
      `dead-owner: unreachable (no injectable/resumable wake channel), parked ${Math.round(input.parkedForMs / 1000)}s ` +
      `(≥${Math.round(window / 1000)}s terminal window) across ${input.stuckFireCount} consecutive stuck-backstop fires ` +
      `— auto-paused (WI-1399, dead-owner loop terminal guard)`,
  };
}

export interface UnreachableTerminalGuardDeps {
  /** Injected for tests; defaults to the real reachability probe. */
  probeReachability?: typeof probeWakeReachability;
  /** Injected for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
}

export interface UnreachableTerminalGuardResult {
  breach: boolean;
  reason?: string;
  /** The reachability verdict the decision was based on (diagnostics). Absent on a fail-soft probe error. */
  reachability?: WakeReachabilityVerdict;
}

/**
 * The IO wrapper the stuck-backstop branch consults: probe the owner's wake reachability,
 * evaluate the pure decision, and on breach auto-pause the routine. Fail-soft — a probe
 * error never throws and is treated as "still reachable" (no termination on an uncertain
 * read).
 */
export async function checkUnreachableTerminalGuard(
  input: {
    sql: Sql;
    routineId: string;
    targetOwnerId: string;
    parkedForMs: number;
    intervalMs: number;
    stuckFireCount: number;
  },
  deps: UnreachableTerminalGuardDeps = {},
): Promise<UnreachableTerminalGuardResult> {
  const probeReachability = deps.probeReachability ?? probeWakeReachability;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;

  let reachability: WakeReachabilityVerdict;
  try {
    reachability = await probeReachability(input.targetOwnerId);
  } catch {
    return { breach: false }; // fail-soft: an uncertain reachability read never terminates a loop
  }

  const verdict = evaluateUnreachableTerminalGuard({
    reachable: reachability.reachable,
    parkedForMs: input.parkedForMs,
    intervalMs: input.intervalMs,
    stuckFireCount: input.stuckFireCount,
  });
  if (verdict.breach) {
    await autoPause(input.sql, input.routineId, verdict.reason!);
  }
  return { ...verdict, reachability };
}
