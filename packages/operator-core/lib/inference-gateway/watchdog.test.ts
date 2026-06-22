import { describe, it, expect, beforeAll } from 'vitest';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so we can
// unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

let externalStallReason: (s: unknown, selfHealAtFreezeStart: number) => string | null;
let deadProxyAlerts: (
  s: unknown,
  opts?: { minAttempts?: number; rateThreshold?: number },
) => Array<{ accountId: string; rate: number; attempts: number; fails: number }>;
beforeAll(async () => {
  ({ externalStallReason, deadProxyAlerts } = await import('./watchdog.mjs'));
});

/**
 * EI-2421: the watchdog's frozen-while-saturated restart signature ALSO fires when the whole account
 * pool is rate-limit exhausted (nothing trickles → totalRequests frozen) or while the gateway's own
 * self-heal valve is draining the wedge. Restarting then is pure harm (drops in-flight bee/queen
 * spawns and can't fix a rate-limit). externalStallReason() returns a reason → SUPPRESS, or null →
 * a real internal wedge → restart proceeds.
 */
describe('gateway watchdog — externalStallReason (false-restart suppression)', () => {
  const now = Date.now();

  it('returns null for a TRUE internal wedge (no external/self-heal signal) → restart proceeds', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 5, unified: { rejected: false } }, 5)).toBeNull();
  });

  it('suppresses when the active account is governor-paused (rate-limit, not a wedge)', () => {
    expect(externalStallReason({ pausedUntil: now + 30_000, selfHealReclaims: 0 }, 0)).toMatch(/governor-paused/);
  });

  it('does NOT treat a stale (past) pausedUntil as an external stall', () => {
    expect(externalStallReason({ pausedUntil: now - 30_000, selfHealReclaims: 3 }, 3)).toBeNull();
  });

  it('suppresses when the unified budget window is exhausted (rejected)', () => {
    expect(externalStallReason({ pausedUntil: 0, unified: { rejected: true } }, 0)).toMatch(/exhausted|rejected/);
  });

  it('suppresses while the in-process self-heal valve is advancing reclaims (let it drain)', () => {
    // 7 reclaims now vs 4 captured when the freeze started → valve is actively draining.
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 7 }, 4)).toMatch(/self-heal/);
  });

  it('does NOT suppress on self-heal when reclaims have NOT advanced since freeze start (valve stuck)', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 4 }, 4)).toBeNull();
  });

  it('ignores the self-heal signal when the freeze-start baseline is unknown (-1)', () => {
    expect(externalStallReason({ pausedUntil: 0, selfHealReclaims: 9 }, -1)).toBeNull();
  });

  it('is robust to a missing / partial / undefined /stats payload', () => {
    expect(externalStallReason({}, -1)).toBeNull();
    expect(externalStallReason(undefined, -1)).toBeNull();
    expect(externalStallReason({ unified: {} }, -1)).toBeNull();
  });
});

/**
 * EI-2537: proactive DEAD-PROXY detection. deadProxyAlerts() ranks egress proxies whose volume-fair
 * egressFailRateByAccount crosses the threshold over a minimum attempt count — the floor filters the
 * small-sample 100% blip, and the rate (not the raw count) is the signal so the BUSIEST proxy isn't
 * mistaken for the deadest. Pure logic; the poll loop logs + debounces the result.
 */
describe('gateway watchdog — deadProxyAlerts (proactive dead-proxy detection)', () => {
  const stats = (over = {}) => ({
    egressFailRateByAccount: {},
    egressAttemptsByAccount: {},
    egressFailsByAccount: {},
    ...over,
  });

  it('flags a chronically-failing proxy (high rate over enough attempts)', () => {
    const out = deadProxyAlerts(
      stats({
        egressFailRateByAccount: { definitelyahuman: 0.95, aviynw6: 0.03 },
        egressAttemptsByAccount: { definitelyahuman: 60, aviynw6: 100 },
        egressFailsByAccount: { definitelyahuman: 57, aviynw6: 3 },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: 'definitelyahuman', rate: 0.95, attempts: 60, fails: 57 });
  });

  it('does NOT flag a small-sample 100% blip (below the min-attempts floor)', () => {
    const out = deadProxyAlerts(
      stats({ egressFailRateByAccount: { x: 1 }, egressAttemptsByAccount: { x: 1 }, egressFailsByAccount: { x: 1 } }),
    );
    expect(out).toEqual([]);
  });

  it('does NOT flag a healthy proxy (rate below threshold even with high volume)', () => {
    const out = deadProxyAlerts(
      stats({ egressFailRateByAccount: { busy: 0.04 }, egressAttemptsByAccount: { busy: 5000 }, egressFailsByAccount: { busy: 200 } }),
    );
    expect(out).toEqual([]);
  });

  it('returns multiple offenders sorted worst-first (by rate)', () => {
    const out = deadProxyAlerts(
      stats({
        egressFailRateByAccount: { a: 0.6, b: 0.9, c: 0.1 },
        egressAttemptsByAccount: { a: 40, b: 40, c: 40 },
        egressFailsByAccount: { a: 24, b: 36, c: 4 },
      }),
    );
    expect(out.map((d) => d.accountId)).toEqual(['b', 'a']);
  });

  it('honors custom thresholds', () => {
    const s = stats({ egressFailRateByAccount: { p: 0.3 }, egressAttemptsByAccount: { p: 10 }, egressFailsByAccount: { p: 3 } });
    expect(deadProxyAlerts(s)).toEqual([]); // default 0.5/20 → not flagged
    expect(deadProxyAlerts(s, { minAttempts: 5, rateThreshold: 0.25 })).toHaveLength(1); // relaxed → flagged
  });

  it('is robust to a missing / partial / undefined /stats payload', () => {
    expect(deadProxyAlerts(undefined)).toEqual([]);
    expect(deadProxyAlerts({})).toEqual([]);
    expect(deadProxyAlerts({ egressFailRateByAccount: { x: 0.9 } })).toEqual([]); // no attempts map → 0 attempts → filtered
  });
});
