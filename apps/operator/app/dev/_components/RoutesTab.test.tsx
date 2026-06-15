// @vitest-environment jsdom
//
// RoutesTab — the recent route_invocations traffic panel. Two pure formatters
// carry its display logic: fmtRelTime (now-anchored "Ns/m/h/d ago", pinned with
// a fixed system clock) and fmtDuration (ms → "Ns" → "Nm Ss", null-safe). Both
// are extracted + exported; the rest of the tab is an effect-only fetch shell
// over RichGrid.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('nuqs', () => ({
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));

import { fmtRelTime, fmtDuration } from './RoutesTab';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

describe('fmtRelTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders seconds-ago under a minute', () => {
    expect(fmtRelTime(new Date(NOW - 30_000).toISOString())).toBe('30s ago');
  });
  it('renders minutes-ago under an hour', () => {
    expect(fmtRelTime(new Date(NOW - 5 * 60_000).toISOString())).toBe('5m ago');
  });
  it('renders hours-ago under a day', () => {
    expect(fmtRelTime(new Date(NOW - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });
  it('renders days-ago past a day', () => {
    expect(fmtRelTime(new Date(NOW - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });
});

describe('fmtDuration', () => {
  it('renders an em dash for null', () => {
    expect(fmtDuration(null)).toBe('—');
  });
  it('renders raw ms under a second', () => {
    expect(fmtDuration(250)).toBe('250ms');
  });
  it('renders seconds with two decimals under a minute', () => {
    expect(fmtDuration(1500)).toBe('1.50s');
  });
  it('renders "Nm Ss" past a minute', () => {
    expect(fmtDuration(65_000)).toBe('1m 5s');
  });
});
