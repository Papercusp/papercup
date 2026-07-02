/**
 * Per-CLIENT circuit breaker for the gateway's LOCAL-backend proxy path
 * (local-concurrent-inference-2026-07-02 P-015, D-010).
 *
 * `local-backend-pool.ts`'s health tracking protects each BACKEND from being over-run
 * (maxConcurrent per backend, demote after HEALTH_FAIL_THRESHOLD). It does NOT protect the
 * shared backend POOL from being MONOPOLIZED by one storming/wedged CLIENT — the local path
 * (gateway.ts `proxyLocal`) is called DIRECTLY, bypassing the account-pool path's admission
 * queue (maxQueued load-shed + AIMD) entirely, so nothing today stops one agent's retry loop
 * or parallel fan-out from claiming every slot of a small (e.g. 2-slot) llama-server batch
 * and starving every other client. This module is that missing per-owner gate.
 *
 * Two independent defenses, both keyed by the `x-papercusp-owner` header (an UNIDENTIFIED
 * caller — no header — is not gated here; it still meets the backend-level maxConcurrent
 * ceiling, same as today):
 *
 *   1. IN-FLIGHT CAP — a hard ceiling on how many local requests one owner may have
 *      concurrently in flight. Stops a parallel fan-out storm outright, for ~free (checked
 *      before any backend I/O).
 *   2. FAILURE-STREAK CIRCUIT — after `failureThreshold` consecutive REQUEST-level failures
 *      (every backend attempt exhausted with none reachable — see `nextClientCircuitState`),
 *      the owner's circuit opens for `cooldownMs`: further requests shed immediately instead
 *      of re-attempting the pool. A single miss doesn't trip it (mirrors
 *      `HEALTH_FAIL_THRESHOLD`'s "not a single blip" precedent in local-backend-pool.ts).
 *
 * Pure decision functions (this file) + a thin mutable Map wrapper (inlined in gateway.ts,
 * mirroring the ownerLedger/lastRouteByOwner bounded-Map discipline) — the same
 * pure-decision/IO-wrapper split as `nextHealthState` / the pool, and as
 * `evaluateUnreachableTerminalGuard` / `checkUnreachableTerminalGuard` (WI-1399).
 */

export interface ClientCircuitState {
  /** Requests from this owner currently in flight on the local-backend path. */
  inFlight: number;
  /** Consecutive REQUEST-level failures — resets to 0 the instant a request forwards ANY
   *  upstream response (a 200 or an upstream 4xx/5xx both count as "the pool served this
   *  owner"; only exhausting every backend attempt with none reachable is a failure here). */
  consecutiveFailures: number;
  /** Epoch ms the circuit re-closes at, or null when closed. */
  openUntil: number | null;
}

/** The state of an owner never seen before. */
export const CLIENT_CIRCUIT_ZERO: ClientCircuitState = { inFlight: 0, consecutiveFailures: 0, openUntil: null };

/** Consecutive request-level failures before a per-owner circuit opens. */
export const DEFAULT_CLIENT_FAILURE_THRESHOLD = 3;
/** How long an opened circuit stays open. Short — the goal is to stop a storm RIGHT NOW,
 *  not durably ban the owner; the very next clean request re-closes it immediately. */
export const DEFAULT_CLIENT_CIRCUIT_COOLDOWN_MS = 15_000;
/** Max concurrent in-flight local requests allowed from ONE owner. Deliberately small — a
 *  shared few-slot local backend must serve MULTIPLE distinct agents, not be claimable
 *  entirely by a single caller's fan-out. */
export const DEFAULT_CLIENT_MAX_IN_FLIGHT = 2;

export type ClientShedReason = 'circuit_open' | 'in_flight_cap';

export interface ClientShedVerdict {
  shed: boolean;
  reason?: ClientShedReason;
  /** Present when `reason === 'circuit_open'` — seconds until the circuit re-closes. */
  retryAfterSec?: number;
}

/**
 * Pure admission decision: would a NEW request from this owner be shed right now? Call
 * BEFORE the request does any backend I/O — the whole point is to reject a storming/wedged
 * client for ~free, not after it has already tied up a backend attempt.
 */
export function shouldShedClient(
  state: ClientCircuitState,
  now: number,
  maxInFlight: number = DEFAULT_CLIENT_MAX_IN_FLIGHT,
): ClientShedVerdict {
  if (state.openUntil !== null && now < state.openUntil) {
    return { shed: true, reason: 'circuit_open', retryAfterSec: Math.max(1, Math.ceil((state.openUntil - now) / 1000)) };
  }
  if (state.inFlight >= maxInFlight) {
    return { shed: true, reason: 'in_flight_cap' };
  }
  return { shed: false };
}

/** Call once admission is granted, immediately before starting the request's backend I/O. */
export function admitClient(state: ClientCircuitState): ClientCircuitState {
  return { ...state, inFlight: state.inFlight + 1 };
}

/**
 * Pure state transition on a request's terminal outcome. `ok` = the request forwarded ANY
 * upstream response (success or a client-side error FROM the backend); false = every
 * backend attempt was exhausted with none reachable (the 502 "no reachable local backend"
 * case) — the actual "this owner is wedging the pool" signal.
 */
export function nextClientCircuitState(
  prev: ClientCircuitState,
  ok: boolean,
  now: number,
  failureThreshold: number = DEFAULT_CLIENT_FAILURE_THRESHOLD,
  cooldownMs: number = DEFAULT_CLIENT_CIRCUIT_COOLDOWN_MS,
): ClientCircuitState {
  const inFlight = Math.max(0, prev.inFlight - 1);
  if (ok) {
    return { inFlight, consecutiveFailures: 0, openUntil: null };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const openUntil = consecutiveFailures >= failureThreshold ? now + cooldownMs : prev.openUntil;
  return { inFlight, consecutiveFailures, openUntil };
}
