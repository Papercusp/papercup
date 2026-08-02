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

/**
 * Verdict for one DATA-plane probe (WI-6739). 'config' is deliberately distinct from 'dead':
 * a probe we mis-configured must never alarm as a service fault.
 */
export type DataPlaneKind = 'ok' | 'config' | 'dead';

/** Remediation chosen from a proxy probe plus a same-moment upstream probe. */
export type HandshakeAction = 'none' | 'restart-proxy' | 'upstream-wedged';

/**
 * The liveness path (WI-6743) — re-exported from budgets.mjs, which proxy.ts also imports, so
 * the probe and the route it probes cannot drift apart. MUST be proxy-local: a forwarded path
 * cannot answer while retry-on-refused holds a request through a :3070 restart.
 */
export const LIVENESS_PROBE_PATH: string;

export function livenessProbeUrl(port?: number): string;

export function shouldRestart(
  unreachableSinceMs: number,
  nowMs: number,
  thresholdMs?: number,
): boolean;

/** Rolling-window verdict for stall RATE (WI-6744). Returns the pruned event list. */
export function evaluateStallRate(
  eventTimesMs: number[],
  nowMs: number,
  windowMs?: number,
  threshold?: number,
): { kept: number[]; count: number; escalate: boolean; windowMs: number; threshold: number };

export function classifyProbeResult(result?: {
  networkError?: unknown;
  status?: number;
  json?: unknown;
}): ProbeKind;

export function classifyDataPlaneResult(result?: {
  networkError?: unknown;
  status?: number;
  json?: unknown;
}): DataPlaneKind;

/**
 * Arguments for the data-plane probe call (WI-6739). `invalid` reports a malformed
 * PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_ARGS override, which is logged rather than silently
 * replaced with args belonging to a different tool.
 */
export function dataPlaneProbeArgs(
  tool: string,
  rawArgs?: string | null,
  defaultTool?: string,
): { args: Record<string, unknown>; invalid: boolean };

export function decideHandshakeAction(
  proxyKind: ProbeKind | string,
  upstreamKind: ProbeKind | string,
): HandshakeAction;
