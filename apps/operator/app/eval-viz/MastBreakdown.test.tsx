// @vitest-environment jsdom
//
// MastBreakdown (L4 coordination quality) — total + render coverage
// (impartial-benchmark-suite P-030 / BRIEF 10). Grouped failure-mode rates per
// arm (lower better) with the published 41–86% MAS-failure band shaded.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MastBreakdown, mastTotal, MAST_MODES, type MastArmRates } from './MastBreakdown';

afterEach(cleanup);

const ARMS: MastArmRates[] = [
  { arm: 'hive', duplication: 0.08, coordinationBreakdown: 0.05, misalignment: 0.06, redundant: 0.04 },
  { arm: 'queen-ablated', duplication: 0.4, coordinationBreakdown: 0.3, misalignment: 0.25, redundant: 0.35 },
];

describe('mastTotal', () => {
  it('sums the four mode rates into one comparable load scalar', () => {
    expect(mastTotal(ARMS[0])).toBeCloseTo(0.23, 6);
    expect(mastTotal(ARMS[1])).toBeCloseTo(1.3, 6);
  });
});

describe('MAST_MODES', () => {
  it('declares the four MAST failure modes with stable colors', () => {
    expect(MAST_MODES.map((m) => m.key)).toEqual(['duplication', 'coordinationBreakdown', 'misalignment', 'redundant']);
    expect(MAST_MODES.every((m) => /^#/.test(m.color))).toBe(true);
  });
});

describe('<MastBreakdown />', () => {
  it('renders a group per arm with one bar per mode, plus the baseline band', () => {
    const { container, getByTestId } = render(<MastBreakdown arms={ARMS} />);
    expect(container.querySelectorAll('[data-testid="mast-group"]')).toHaveLength(2);
    // 2 arms × 4 modes = 8 bars
    expect(container.querySelectorAll('rect[fill]').length).toBeGreaterThanOrEqual(8);
    expect(getByTestId('mast-band')).not.toBeNull();
    const titles = [...container.querySelectorAll('rect title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('Hive') && t.includes('duplication') && t.includes('8%'))).toBe(true);
  });

  it('renders the default 41–86% band label', () => {
    const { container } = render(<MastBreakdown arms={ARMS} />);
    const band = container.querySelector('.pc-mast__bandlabel')?.textContent ?? '';
    expect(band).toContain('41%');
    expect(band).toContain('86%');
  });

  it('renders an empty state when there are no arms', () => {
    const { getByTestId } = render(<MastBreakdown arms={[]} emptyHint="none" />);
    expect(getByTestId('mast-empty').textContent).toBe('none');
  });
});
