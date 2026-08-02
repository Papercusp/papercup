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
beforeAll(async () => {
  ({ shouldRestart, classifyProbeResult, classifyDataPlaneResult, decideHandshakeAction } =
    await import('./watchdog.mjs'));
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
