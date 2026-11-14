import { describe, it, expect, beforeAll } from 'vitest';

/**
 * WI-6738 — the client/proxy timing-budget invariant.
 *
 * The mcp-proxy retries a refused upstream for up to `retryWindowMs` so that a :3070
 * restart is invisible to MCP clients. psu independently picked a 45s request timeout, so
 * it abandoned requests the proxy was still actively retrying: every :3070 gap between 45s
 * and 90s became a hard user-visible failure the resilience layer would otherwise have
 * absorbed completely. Owner hit it on 2026-08-01 and reported the system down; it had
 * self-recovered ~90s later.
 *
 * Neither number was wrong on its own. The defect was that they were chosen independently,
 * in different files, with no expressed relationship. These tests express the relationship,
 * so the inversion cannot come back silently — which is the only durable fix, since the
 * next person to tune either number will not have read the incident.
 */
type Budgets = typeof import('./budgets.mjs');
let B: Budgets;
beforeAll(async () => {
  B = await import('./budgets.mjs');
});

describe('mcp-proxy budgets — the client/proxy invariant', () => {
  it('THE INVARIANT: psu waits at least as long as the proxy will retry', () => {
    // If this ever fails, the proxy's patience has become unreachable and the service is
    // pointless for the window in between — that is precisely the 2026-08-01 defect.
    expect(B.PSU_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(B.MCP_PROXY_RETRY_WINDOW_MS);
  });

  it('leaves headroom above the window rather than matching it exactly', () => {
    // The measured worst-case recovery (91981ms) already sits just under the 90s nominal
    // window, so an exact match would still lose the race to connection + response time.
    expect(B.PSU_REQUEST_TIMEOUT_MS).toBeGreaterThan(B.MCP_PROXY_RETRY_WINDOW_MS);
  });

  it('regression: the old hard-coded 45s would violate the invariant', () => {
    // Pins the actual historical bug so nobody "simplifies" back to it.
    expect(B.psuTimeoutInvertsProxyBudget(45_000, 90_000)).toBe(true);
    expect(B.psuTimeoutInvertsProxyBudget(B.PSU_REQUEST_TIMEOUT_MS)).toBe(false);
  });
});

describe('mcp-proxy budgets — derivePsuTimeoutMs', () => {
  it('keeps required Codex startup alive through the proxy recovery contract', () => {
    expect(B.CODEX_MCP_STARTUP_TIMEOUT_SEC * 1000)
      .toBeGreaterThanOrEqual(B.MCP_PROXY_RETRY_WINDOW_MS + B.PSU_CLIENT_HEADROOM_MS);
    // Nov 13: Codex exited after 30s while initialize recovered after 54s.
    expect(B.psuTimeoutInvertsProxyBudget(30_000)).toBe(true);
    expect(B.psuTimeoutInvertsProxyBudget(B.CODEX_MCP_STARTUP_TIMEOUT_SEC * 1000)).toBe(false);
  });

  it('derives window + headroom when there is no override', () => {
    expect(B.derivePsuTimeoutMs({ retryWindowMs: 90_000, headroomMs: 30_000 })).toBe(120_000);
  });

  it('tracks a raised retry window automatically (the anti-drift property)', () => {
    // The whole point: change the proxy window and the client follows, with no second edit.
    expect(B.derivePsuTimeoutMs({ retryWindowMs: 180_000, headroomMs: 30_000 })).toBe(210_000);
  });

  it('honors an explicit operator override, even one below the window', () => {
    // Deliberate: a human debugging a wedged box may want to fail fast, and silently
    // overriding them would be its own bug. Detection is exposed separately.
    expect(B.derivePsuTimeoutMs({ overrideMs: 5_000, retryWindowMs: 90_000 })).toBe(5_000);
    expect(B.psuTimeoutInvertsProxyBudget(5_000, 90_000)).toBe(true);
  });

  it('the watchdog threshold derives from the same window, so it cannot alarm during legitimate absorption', () => {
    // The mcp-proxy watchdog concludes "session plane dead" after window + headroom. If that
    // were a frozen literal, raising the proxy's retry window would make the watchdog start
    // firing WHILE the proxy is still legitimately absorbing an upstream restart — the same
    // independently-chosen-number bug, one layer up. Derived, it tracks automatically.
    const derived = B.derivePsuTimeoutMs({ retryWindowMs: 180_000, headroomMs: B.PSU_CLIENT_HEADROOM_MS });
    expect(derived).toBeGreaterThan(180_000);
    expect(B.psuTimeoutInvertsProxyBudget(derived, 180_000)).toBe(false);
  });

  it('ignores a non-positive or unparseable override rather than disabling the timeout', () => {
    // A `PAPERCUSP_PSU_TIMEOUT_MS=0` must not mean "wait forever" — that reintroduces the
    // original hang-with-no-output this timeout exists to prevent.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(B.derivePsuTimeoutMs({ overrideMs: bad, retryWindowMs: 90_000, headroomMs: 30_000 })).toBe(120_000);
    }
  });
});
