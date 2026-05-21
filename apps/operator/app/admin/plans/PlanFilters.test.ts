/**
 * Unit coverage for `withinDateWindow` — the P-103 date-filter
 * predicate. Pure function over an ISO-ish date string + a window
 * token; PlanRail uses it to client-side-filter the plan list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withinDateWindow } from './PlanFilters';

// Pin "now" so the relative-window math is deterministic.
const NOW = new Date('2026-05-20T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const daysAgo = (n: number): string =>
  new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

describe('withinDateWindow', () => {
  it('null window → always true (no filter)', () => {
    expect(withinDateWindow(daysAgo(0), null)).toBe(true);
    expect(withinDateWindow(daysAgo(999), null)).toBe(true);
    expect(withinDateWindow(null, null)).toBe(true);
  });

  it('null `updated` → excluded from any active window', () => {
    expect(withinDateWindow(null, 'today')).toBe(false);
    expect(withinDateWindow(null, '7d')).toBe(false);
    expect(withinDateWindow(null, '30d')).toBe(false);
  });

  it('today → within the last 24h', () => {
    expect(withinDateWindow(daysAgo(0), 'today')).toBe(true);
    expect(withinDateWindow(daysAgo(2), 'today')).toBe(false);
  });

  it('7d → within the last 7 days', () => {
    expect(withinDateWindow(daysAgo(3), '7d')).toBe(true);
    expect(withinDateWindow(daysAgo(6), '7d')).toBe(true);
    expect(withinDateWindow(daysAgo(10), '7d')).toBe(false);
  });

  it('30d → within the last 30 days', () => {
    expect(withinDateWindow(daysAgo(20), '30d')).toBe(true);
    expect(withinDateWindow(daysAgo(29), '30d')).toBe(true);
    expect(withinDateWindow(daysAgo(45), '30d')).toBe(false);
  });

  it('unparseable date string → excluded', () => {
    expect(withinDateWindow('not-a-date', '30d')).toBe(false);
    expect(withinDateWindow('', '7d')).toBe(false);
  });

  it('a full ISO timestamp also parses', () => {
    expect(withinDateWindow('2026-05-20T06:00:00Z', 'today')).toBe(true);
    expect(withinDateWindow('2026-04-01T06:00:00Z', 'today')).toBe(false);
  });
});
