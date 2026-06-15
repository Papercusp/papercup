// @vitest-environment jsdom
//
// Compare (per-task A/B score-delta) — summary core + render coverage
// (impartial-benchmark-suite P-021 / BRIEF 10). Δ = treatment − baseline;
// the comparable set is the rows where BOTH scores are present.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Compare, summarizeDeltas, type ComparePerTaskRow } from './Compare';

afterEach(cleanup);

const ROWS: ComparePerTaskRow[] = [
  { label: 'task-1', baseline: 0.5, treatment: 0.8 }, // win (+0.3)
  { label: 'task-2', baseline: 0.6, treatment: 0.6 }, // tie
  { label: 'task-3', baseline: 0.7, treatment: 0.4 }, // loss (−0.3)
  { label: 'task-4', baseline: null, treatment: 0.9 }, // not comparable — excluded
];

describe('summarizeDeltas', () => {
  it('counts win/tie/loss and means over the comparable rows only', () => {
    const s = summarizeDeltas(ROWS);
    expect(s.n).toBe(3); // task-4 excluded (baseline null)
    expect(s.wins).toBe(1);
    expect(s.ties).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.meanBaseline).toBeCloseTo((0.5 + 0.6 + 0.7) / 3, 6);
    expect(s.meanTreatment).toBeCloseTo((0.8 + 0.6 + 0.4) / 3, 6);
    expect(s.meanDelta).toBeCloseTo(0, 6); // +0.3, 0, −0.3 net 0
  });

  it('returns nulls (not NaN) when nothing is comparable', () => {
    const s = summarizeDeltas([{ label: 'x', baseline: null, treatment: 1 }]);
    expect(s.n).toBe(0);
    expect(s.meanBaseline).toBeNull();
    expect(s.meanDelta).toBeNull();
    expect(s.wins).toBe(0);
  });
});

describe('<Compare />', () => {
  it('renders a row per task, arm-labelled headers, and the summary footer', () => {
    const { container, getByTestId } = render(
      <Compare baseline="baseline-b-native" treatment="papercusp" perTask={ROWS} />,
    );
    expect(container.querySelectorAll('[data-testid="compare-row"]')).toHaveLength(4);
    // headers resolve the arm vocab to human labels
    const ths = [...container.querySelectorAll('th')].map((t) => t.textContent ?? '');
    expect(ths.some((t) => t.includes('Baseline B'))).toBe(true);
    expect(ths.some((t) => t.includes('Papercusp'))).toBe(true);
    // summary footer shows 1W·1T·1L
    const summary = getByTestId('compare-summary').textContent ?? '';
    expect(summary).toContain('1W');
    expect(summary).toContain('1T');
    expect(summary).toContain('1L');
  });

  it('marks up/down deltas with direction arrows', () => {
    const { container } = render(
      <Compare baseline="baseline-a-ablation" treatment="papercusp" perTask={ROWS} summary={false} />,
    );
    const up = container.querySelector('.pc-compare__delta--up');
    const down = container.querySelector('.pc-compare__delta--down');
    expect(up?.textContent).toContain('▲');
    expect(down?.textContent).toContain('▼');
  });

  it('shows the empty hint when there are no rows', () => {
    const { getByTestId } = render(
      <Compare baseline="baseline-b-native" treatment="papercusp" perTask={[]} emptyHint="run the pilot first" />,
    );
    expect(getByTestId('compare-empty').textContent).toBe('run the pilot first');
  });
});
