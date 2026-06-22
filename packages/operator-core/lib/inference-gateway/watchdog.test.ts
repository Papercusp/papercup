import { describe, it, expect, beforeAll } from 'vitest';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so we can
// unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

let externalStallReason: (s: unknown, selfHealAtFreezeStart: number) => string | null;
beforeAll(async () => {
  ({ externalStallReason } = await import('./watchdog.mjs'));
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
