import { describe, it, expect, beforeAll } from 'vitest';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so
// we can unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

// Types come from watchdog.d.mts — without it this import is an implicit `any` (TS7016) and
// every assertion below silently stops type-checking (a misspelled verdict would compile).
type Watchdog = typeof import('./watchdog.mjs');
let shouldRestart: Watchdog['shouldRestart'];
let classifyProbeResult: Watchdog['classifyProbeResult'];
let classifyDataPlaneResult: Watchdog['classifyDataPlaneResult'];
let decideHandshakeAction: Watchdog['decideHandshakeAction'];
let LIVENESS_PROBE_PATH: Watchdog['LIVENESS_PROBE_PATH'];
let livenessProbeUrl: Watchdog['livenessProbeUrl'];
let evaluateStallRate: Watchdog['evaluateStallRate'];
beforeAll(async () => {
  ({
    shouldRestart,
    classifyProbeResult,
    classifyDataPlaneResult,
    decideHandshakeAction,
    LIVENESS_PROBE_PATH,
    livenessProbeUrl,
    evaluateStallRate,
  } = await import('./watchdog.mjs'));
});

/**
 * WI-6743 — the liveness probe must not traverse the upstream.
 *
 * Polling a FORWARDED path (`/api/health`) made this watchdog report the proxy as unreachable
 * every time :3070 restarted, because retry-on-refused deliberately withholds a response for up
 * to the retry window so a deploy is invisible to MCP clients. Result: 272 false `unreachable`
 * incidents, and a real wedge became indistinguishable from a routine deploy.
 *
 * The end-to-end proof (the proxy still answers this path with a dead upstream) lives in
 * proxy.test.ts. These pin the two ways the fix can silently rot: the path drifting away from
 * the route the proxy actually serves, and the probe quietly reacquiring an upstream dependency.
 */
describe('mcp-proxy watchdog — liveness probe target (WI-6743)', () => {
  it('is the SAME constant the proxy serves, not a copied literal', async () => {
    const { MCP_PROXY_LOCAL_HEALTH_PATH } = await import('./budgets.mjs');
    // Both sides import this from budgets.mjs, so they cannot drift. If someone re-inlines a
    // literal on either side, this fails.
    expect(LIVENESS_PROBE_PATH).toBe(MCP_PROXY_LOCAL_HEALTH_PATH);
  });

  it('is proxy-local — never an upstream-forwarded path', () => {
    // `/api/*` is exactly what the proxy forwards; polling any of it reintroduces the bug.
    expect(LIVENESS_PROBE_PATH.startsWith('/api/')).toBe(false);
    expect(LIVENESS_PROBE_PATH).not.toBe('/api/health');
  });

  it('builds a loopback URL against the watchdog port', () => {
    expect(livenessProbeUrl(9071)).toBe(`http://127.0.0.1:9071${LIVENESS_PROBE_PATH}`);
  });
});

/**
 * EI-9237: the proxy's wedge signature ("event loop dead, zero responses") shows up purely as
 * sustained unreachability — there's no /stats counter to distinguish an internal wedge from an
 * external stall (unlike the inference-gateway watchdog), so the threshold-crossing decision is
 * the whole detector. Pure logic; the poll loop debounces + circuit-breaks the actual restart.
 */
describe('mcp-proxy watchdog — shouldRestart (unreachability threshold)', () => {
  it('does not restart while never-yet-unreachable (unreachableSinceMs=0)', () => {
    expect(shouldRestart(0, Date.now(), 45_000)).toBe(false);
  });

  it('does not restart before the threshold elapses', () => {
    const now = Date.now();
    expect(shouldRestart(now - 10_000, now, 45_000)).toBe(false);
  });

  it('restarts once the threshold is reached exactly', () => {
    const now = Date.now();
    expect(shouldRestart(now - 45_000, now, 45_000)).toBe(true);
  });

  it('restarts once the threshold is exceeded', () => {
    const now = Date.now();
    expect(shouldRestart(now - 90_000, now, 45_000)).toBe(true);
  });

  it('honors a custom threshold', () => {
    const now = Date.now();
    expect(shouldRestart(now - 5_000, now, 10_000)).toBe(false);
    expect(shouldRestart(now - 15_000, now, 10_000)).toBe(true);
  });
});

/**
 * WI-6744 — escalate on stall FREQUENCY, not only on one long outage.
 *
 * shouldRestart only fires when a SINGLE outage exceeds the threshold, so a burst of short
 * outages that each self-recover produces a run of reassuring `recovered (was unreachable 10s)`
 * lines and no action at all. That is how WI-6740 survived three weeks: severity was invisible
 * at the layer that observed it.
 */
describe('mcp-proxy watchdog — evaluateStallRate (burst detection)', () => {
  const now = 1_700_000_000_000;
  const HOUR = 3_600_000;

  it('does not escalate below the threshold', () => {
    const r = evaluateStallRate([now - 60_000, now - 120_000], now, HOUR, 3);
    expect(r.count).toBe(2);
    expect(r.escalate).toBe(false);
  });

  it('THE POINT: escalates on a burst of SELF-RECOVERED stalls, which shouldRestart never sees', () => {
    const onsets = [now - 1_000, now - 600_000, now - 1_200_000];
    // Each of these recovered in ~10s, so the single-outage detector stays silent...
    for (const t of onsets) expect(shouldRestart(t, t + 10_000, 45_000)).toBe(false);
    // ...but the rate detector fires.
    expect(evaluateStallRate(onsets, now, HOUR, 3).escalate).toBe(true);
  });

  it('prunes events outside the window and returns the survivors', () => {
    const r = evaluateStallRate([now - 10_000, now - HOUR - 1, now - 2 * HOUR], now, HOUR, 3);
    expect(r.kept).toEqual([now - 10_000]);
    expect(r.count).toBe(1);
    expect(r.escalate).toBe(false);
  });

  it('an old burst that has aged out does not keep firing', () => {
    const stale = [now - HOUR - 1, now - HOUR - 2, now - HOUR - 3];
    expect(evaluateStallRate(stale, now, HOUR, 3)).toMatchObject({ count: 0, escalate: false });
  });

  it('escalates exactly AT the threshold, not one past it', () => {
    const three = [now - 1, now - 2, now - 3];
    expect(evaluateStallRate(three, now, HOUR, 3).escalate).toBe(true);
    expect(evaluateStallRate(three.slice(0, 2), now, HOUR, 3).escalate).toBe(false);
  });
});

/**
 * EI-19299524366372518 — the session-plane probe.
 *
 * On 2026-08-01 /api/health answered 200 in ~2ms for ~100 minutes while the MCP tool
 * plane was completely dead (fleet throughput 2759 -> 44 calls/30min; 29 sessions dark
 * a median of 80 minutes). The reachability probe above is structurally incapable of
 * seeing that, so these tests pin the verdict logic that can — including the two
 * false-positive traps measured against the live endpoint, either of which would have
 * made the new detector worse than no detector at all.
 */
describe('mcp-proxy watchdog — classifyProbeResult (session plane)', () => {
  const withTools = (n: number) => ({
    result: { tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}` })) },
  });

  it('THE MISS: a target that serves a non-empty catalog is healthy', () => {
    expect(classifyProbeResult({ status: 200, json: withTools(742) })).toBe('ok');
  });

  it('THE MISS: a 200 that carries no catalog at all is NOT healthy', () => {
    // This is the shape /api/health would produce — a fine HTTP response proving nothing
    // about the tool plane. The old probe accepted exactly this and stayed silent.
    expect(classifyProbeResult({ status: 200, json: { ok: true } })).toBe('dead');
  });

  it('treats a timeout / connection error as dead', () => {
    expect(classifyProbeResult({ networkError: new Error('The operation was aborted') })).toBe('dead');
  });

  it('treats a non-200 as dead', () => {
    expect(classifyProbeResult({ status: 503, json: withTools(742) })).toBe('dead');
  });

  it('treats an unparseable body as dead', () => {
    expect(classifyProbeResult({ status: 200, json: null })).toBe('dead');
  });

  it('TRAP 1: a rejected bearer is auth, not a dead service', () => {
    // Verbatim shape from the live endpoint. Its own message warns this is NOT
    // "a healthy server with zero tools" — and it must not be read as a dead one either.
    const json = {
      error: {
        code: -32603,
        message:
          'mcp_auth_failed: superuser_invalid_bearer — this MCP session is UNAUTHENTICATED, so it exposes NO tools (this is NOT "a healthy server with zero tools").',
      },
    };
    expect(classifyProbeResult({ status: 200, json })).toBe('auth');
  });

  it('TRAP 2: 200 + zero tools + no error is ambiguous, never a verdict', () => {
    // `?tools=does-not-exist` returns exactly this, indistinguishable from an empty
    // registry — so it must resolve to 'empty' (caller confirms), never to 'dead'.
    expect(classifyProbeResult({ status: 200, json: withTools(0) })).toBe('empty');
  });

  it('a non-auth JSON-RPC error is dead', () => {
    expect(classifyProbeResult({ status: 200, json: { error: { code: -32000, message: 'boom' } } })).toBe('dead');
  });
});

describe('mcp-proxy watchdog — decideHandshakeAction (proxy vs upstream)', () => {
  it('restarts the proxy only when the upstream is provably serving', () => {
    expect(decideHandshakeAction('dead', 'ok')).toBe('restart-proxy');
  });

  it('THE 2026-08-01 CASE: both dead => upstream, and the proxy is NOT restarted', () => {
    // Restarting the proxy here fixes nothing, burns a circuit-breaker slot, and makes
    // the log blame the wrong service. Only a :3070 restart cleared the real incident.
    expect(decideHandshakeAction('dead', 'dead')).toBe('upstream-wedged');
  });

  it('never acts on our own credential failure', () => {
    expect(decideHandshakeAction('auth', 'ok')).toBe('none');
    expect(decideHandshakeAction('auth', 'dead')).toBe('none');
  });

  it('does nothing while the proxy is healthy', () => {
    expect(decideHandshakeAction('ok', 'dead')).toBe('none');
  });
});
