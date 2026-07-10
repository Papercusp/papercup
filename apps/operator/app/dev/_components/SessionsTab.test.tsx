// @vitest-environment jsdom
//
// SessionsTab — the spawn-drilldown grid. The bulk of the tab is an
// effect-only fetch + expand-on-click shell over RichGrid; its pure display
// logic is the two formatters fmtRelTime (now-anchored "Ns/m/h/d ago", pinned
// with a fixed system clock) and fmtDuration (ms → "Ns" → "Nm Ss"), shared by
// the session/invocation/child grids. Both extracted + exported and pinned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));

import { fmtRelTime, fmtDuration } from './SessionsTab';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

describe('fmtRelTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders s / m / h / d ago at each boundary', () => {
    expect(fmtRelTime(new Date(NOW - 15_000).toISOString())).toBe('15s ago');
    expect(fmtRelTime(new Date(NOW - 2 * 60_000).toISOString())).toBe('2m ago');
    expect(fmtRelTime(new Date(NOW - 5 * 3_600_000).toISOString())).toBe('5h ago');
    expect(fmtRelTime(new Date(NOW - 3 * 86_400_000).toISOString())).toBe('3d ago');
  });
});

describe('fmtDuration', () => {
  it('renders sub-second spans in milliseconds', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(750)).toBe('750ms');
  });
  it('renders seconds with one decimal under a minute', () => {
    expect(fmtDuration(2500)).toBe('2.5s');
  });
  it('renders "Nm Ss" past a minute', () => {
    expect(fmtDuration(90_000)).toBe('1m 30s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
  });
});
