/**
 * CoverageTab — deterministic-coverage-census-2026-08-17 P-005.
 *
 * The panel deliberately contains almost no logic: every number it shows is computed
 * server-side by `readCoverage`, because a percentage recomputed from the capped `rows`
 * array would be a ratio over one page. What IS panel logic is the rendering of a null
 * ratio, and that is the thing worth a test — "—" and "0%" occupy the same square inch of
 * a dashboard and mean opposite things.
 */

import { describe, it, expect } from 'vitest';
import { formatPct } from './CoverageTab';

describe('formatPct — the null ratio must not render as a number', () => {
  it('renders null as a dash, NEVER as 0%', () => {
    // The whole panel's honesty reduces to this line. `null` means the census had no
    // denominator; rendering it as "0%" would tell a reader we measured and found
    // nothing proven, when in fact nothing was measured at all.
    expect(formatPct(null)).toBe('—');
    expect(formatPct(null)).not.toBe('0%');
  });

  it('renders a genuine zero as 0%', () => {
    // The mirror case, and the reason this cannot be implemented as a falsy check:
    // `!0` is true, so `value ? … : '—'` would erase a real, hard-won 0% — the exact
    // reading the census exists to surface (1,105 surfaces, none proven, measured
    // 2026-08-18).
    expect(formatPct(0)).toBe('0%');
  });

  it('renders ordinary and boundary values', () => {
    expect(formatPct(42.5)).toBe('42.5%');
    expect(formatPct(100)).toBe('100%');
  });
});
