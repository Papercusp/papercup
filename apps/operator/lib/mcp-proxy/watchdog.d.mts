/**
 * Types for the mcp-proxy watchdog's pure decision surface.
 *
 * `watchdog.mjs` is plain ESM (it is a bare `node watchdog.mjs` systemd entrypoint, so it
 * must stay runnable without a build step). Importing it from TypeScript therefore raised
 * TS7016 — "implicitly has an 'any' type" — which silently erased type checking for every
 * assertion in watchdog.test.ts: the tests would still have compiled if a verdict string
 * were misspelled or an argument dropped. Declaring the surface here restores that safety
 * without asking the entrypoint to become TypeScript.
 *
 * Only the PURE, exported decision functions appear here. The poll loop, the network probe
 * and the systemctl call are deliberately unexported and untyped — they are side-effecting
 * and are exercised end-to-end against a live endpoint, not unit-tested.
 */

/** Verdict for one session-plane probe. See classifyProbeResult in watchdog.mjs. */
export type ProbeKind = 'ok' | 'auth' | 'empty' | 'dead';

/** Remediation chosen from a proxy probe plus a same-moment upstream probe. */
export type HandshakeAction = 'none' | 'restart-proxy' | 'upstream-wedged';

export function shouldRestart(
  unreachableSinceMs: number,
  nowMs: number,
  thresholdMs?: number,
): boolean;

export function classifyProbeResult(result?: {
  networkError?: unknown;
  status?: number;
  json?: unknown;
}): ProbeKind;

export function decideHandshakeAction(
  proxyKind: ProbeKind | string,
  upstreamKind: ProbeKind | string,
): HandshakeAction;
