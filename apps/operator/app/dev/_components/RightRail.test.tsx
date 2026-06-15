// @vitest-environment jsdom
//
// RightRail — the live status rail (plugin host / pg / build / activity). The
// rail body is an effect-only polling shell; its pure display logic is two
// relative-age formatters: fmtRel (ISO string → bare "Ns/m/h/d", for the
// activity feed) and fmtRelMs (epoch-ms-or-null → "N…ago", for the build
// mtime). Both extracted + exported, pinned with a fixed system clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fmtRel, fmtRelMs } from './RightRail';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('fmtRel', () => {
  it('renders a bare s / m / h / d age (no "ago" suffix)', () => {
    expect(fmtRel(new Date(NOW - 20_000).toISOString())).toBe('20s');
    expect(fmtRel(new Date(NOW - 3 * 60_000).toISOString())).toBe('3m');
    expect(fmtRel(new Date(NOW - 4 * 3_600_000).toISOString())).toBe('4h');
    expect(fmtRel(new Date(NOW - 5 * 86_400_000).toISOString())).toBe('5d');
  });
});

describe('fmtRelMs', () => {
  it('renders an em dash for null', () => {
    expect(fmtRelMs(null)).toBe('—');
  });
  it('renders "N… ago" from an epoch-ms timestamp', () => {
    expect(fmtRelMs(NOW - 45_000)).toBe('45s ago');
    expect(fmtRelMs(NOW - 6 * 60_000)).toBe('6m ago');
    expect(fmtRelMs(NOW - 2 * 3_600_000)).toBe('2h ago');
    expect(fmtRelMs(NOW - 7 * 86_400_000)).toBe('7d ago');
  });
});
