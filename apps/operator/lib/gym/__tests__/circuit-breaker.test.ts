import { describe, it, expect } from 'vitest';
import { circuitBreakerTripped, overfittingAlarm, proxyAlarm } from '../circuit-breaker';

/**
 * Circuit-breaker + alarms (P-021) — the loop's real safety net (D-006/D-012/D-014).
 * The breaker tracks the dedicated harness's dev-anchor aggregate vs the
 * baseline-of-record; on drift below threshold it auto-reverts the harness override.
 * The monitor alarm catches overfitting-to-anchor; the proxy alarm catches gym score
 * rising while the real-anchor stays flat. Pure predicates.
 */
describe('circuitBreakerTripped', () => {
  it('trips when the dev-anchor aggregate drifts below baseline − threshold', () => {
    expect(circuitBreakerTripped(6.4, 7.0, 0.5)).toBe(true); // 6.4 < 7.0 - 0.5
  });
  it('does not trip within the threshold', () => {
    expect(circuitBreakerTripped(6.6, 7.0, 0.5)).toBe(false); // 6.6 > 6.5
  });
  it('does not trip when above baseline', () => {
    expect(circuitBreakerTripped(7.2, 7.0, 0.5)).toBe(false);
  });
});

describe('overfittingAlarm', () => {
  it('alarms when the dev-anchor climbs while the monitor stalls', () => {
    expect(overfittingAlarm(0.5, 0.0, 0.3)).toBe(true);
  });
  it('is quiet when both move together', () => {
    expect(overfittingAlarm(0.5, 0.45, 0.3)).toBe(false);
  });
  it('is quiet when the dev-anchor is not climbing', () => {
    expect(overfittingAlarm(0.0, -0.5, 0.3)).toBe(false);
  });
});

describe('proxyAlarm', () => {
  it('alarms when gym score rises but the real-anchor does not move (D-014)', () => {
    expect(proxyAlarm(0.6, 0.05, 0.3)).toBe(true);
  });
  it('is quiet when the real-anchor tracks the gym score', () => {
    expect(proxyAlarm(0.6, 0.5, 0.3)).toBe(false);
  });
});
