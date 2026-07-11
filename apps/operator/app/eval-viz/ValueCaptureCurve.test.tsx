// @vitest-environment jsdom
//
// ValueCaptureCurve (L3 value capture) — projection + render coverage
// (impartial-benchmark-suite P-030 / BRIEF 10). One cumulative $-captured-vs-
// budget curve per arm; the higher curve at the budget cap wins.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ValueCaptureCurve, projectValueCurves, type ValueSeries } from './ValueCaptureCurve';

afterEach(cleanup);

const SERIES: ValueSeries[] = [
  { arm: 'hive', points: [{ budget: 0, valueCaptured: 0 }, { budget: 50, valueCaptured: 400 }, { budget: 100, valueCaptured: 900 }] },
  { arm: 'queen-ablated', points: [{ budget: 0, valueCaptured: 0 }, { budget: 50, valueCaptured: 250 }, { budget: 100, valueCaptured: 500 }] },
];

describe('projectValueCurves', () => {
  it('builds one path per series, sorted by budget, inside the box', () => {
    const { series } = projectValueCurves(SERIES, { width: 520, height: 300 });
    expect(series).toHaveLength(2);
    expect(series[0].path.split(' ')).toHaveLength(3);
    expect(series[0].end).not.toBeNull();
    // higher captured value → smaller svg y (hive ends higher than queen-ablated)
    const hiveEnd = series.find((s) => s.arm === 'hive')!.end!;
    const qaEnd = series.find((s) => s.arm === 'queen-ablated')!.end!;
    expect(hiveEnd.y).toBeLessThan(qaEnd.y);
  });

  it('folds budgetCap into the x domain so its reference is in view', () => {
    const { capX, xMax } = projectValueCurves(SERIES, { budgetCap: 200 });
    expect(capX).not.toBeNull();
    expect(xMax).toBeGreaterThanOrEqual(200);
  });

  it('sorts unsorted points by budget before drawing', () => {
    const { series } = projectValueCurves([
      { arm: 'hive', points: [{ budget: 100, valueCaptured: 900 }, { budget: 0, valueCaptured: 0 }, { budget: 50, valueCaptured: 400 }] },
    ]);
    // end point is the largest budget (100) regardless of input order
    expect(series[0].end!.budget).toBe(100);
  });

  it('returns empty for no points', () => {
    expect(projectValueCurves([])).toEqual({ series: [], xMax: 0, yMax: 0, capX: null });
  });
});

describe('<ValueCaptureCurve />', () => {
  it('renders one line per arm, the budget-cap reference, and end tooltips', () => {
    const { container, getByTestId } = render(<ValueCaptureCurve series={SERIES} budgetCap={100} />);
    expect(container.querySelectorAll('[data-testid="value-series"]')).toHaveLength(2);
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(getByTestId('value-cap')).not.toBeNull();
    const titles = [...container.querySelectorAll('circle title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('Pot') && t.includes('$900'))).toBe(true);
  });

  it('renders an empty state when there are no series', () => {
    const { getByTestId } = render(<ValueCaptureCurve series={[]} emptyHint="no value yet" />);
    expect(getByTestId('value-empty').textContent).toBe('no value yet');
  });
});
