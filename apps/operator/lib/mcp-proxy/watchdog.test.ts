import { describe, it, expect, beforeAll } from 'vitest';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so
// we can unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

let shouldRestart: (unreachableSinceMs: number, nowMs: number, thresholdMs?: number) => boolean;
beforeAll(async () => {
  ({ shouldRestart } = await import('./watchdog.mjs'));
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
