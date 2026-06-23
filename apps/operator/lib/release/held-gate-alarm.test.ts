import { describe, it, expect } from 'vitest';
import { heldGateAlert, formatHeldDuration } from './held-gate-alarm';

const HOUR = 60 * 60 * 1000;

describe('heldGateAlert — rising urgency the longer the gate is held (docs-audit #2)', () => {
  it('is quiet under 2h (single escalation + per-tick broadcast already cover it)', () => {
    expect(heldGateAlert(0)).toBeNull();
    expect(heldGateAlert(90 * 60 * 1000)).toBeNull(); // 1h30m
    expect(heldGateAlert(HOUR * 2 - 1)).toBeNull();
  });
  it('HELD at 2h', () => {
    const a = heldGateAlert(HOUR * 2);
    expect(a?.tier).toBe('held');
    expect(a?.urgency).toBe('HELD');
    expect(a?.ageLabel).toBe('2h');
  });
  it('URGENT at 4h (the duration the gate sat unnoticed on 2026-06-23)', () => {
    const a = heldGateAlert(HOUR * 4 + 12 * 60 * 1000);
    expect(a?.tier).toBe('urgent');
    expect(a?.urgency).toBe('URGENT');
    expect(a?.ageLabel).toBe('4h 12m');
  });
  it('CRITICAL at 8h+', () => {
    expect(heldGateAlert(HOUR * 8)?.tier).toBe('critical');
    expect(heldGateAlert(HOUR * 26)?.tier).toBe('critical');
  });
  it('tiers are monotonic in severity as the hold grows', () => {
    const tiers = [HOUR, HOUR * 3, HOUR * 5, HOUR * 9].map((m) => heldGateAlert(m)?.tier ?? 'none');
    expect(tiers).toEqual(['none', 'held', 'urgent', 'critical']);
  });
});

describe('formatHeldDuration', () => {
  it('formats minutes / hours / hours+minutes', () => {
    expect(formatHeldDuration(0)).toBe('0m');
    expect(formatHeldDuration(45 * 60 * 1000)).toBe('45m');
    expect(formatHeldDuration(HOUR * 3)).toBe('3h');
    expect(formatHeldDuration(HOUR * 3 + 7 * 60 * 1000)).toBe('3h 7m');
  });
});
