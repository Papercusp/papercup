// @vitest-environment jsdom
//
// Frontier (cost/accuracy Pareto scatter) — projection + Pareto core + render
// coverage (impartial-benchmark-suite P-021 / BRIEF 10). The Pareto set is the
// load-bearing claim: a point is optimal iff no other point beats it on BOTH
// lower cost and higher score.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Frontier, paretoOptimal, projectFrontier, type FrontierPoint } from './Frontier';

afterEach(cleanup);

// papercusp: mid cost, top score (optimal). B-native: high cost, high score —
// dominated by papercusp (more cost, less score). C-bestofn: low cost, mid
// score (optimal — cheapest). A-ablation: mid cost, low score (dominated).
const ARMS: FrontierPoint[] = [
  { label: 'Papercusp', arm: 'papercusp', cost: 5, score: 0.7 },
  { label: 'Baseline B', arm: 'baseline-b-native', cost: 8, score: 0.62 },
  { label: 'Baseline C', arm: 'baseline-c-bestofn', cost: 2, score: 0.5 },
  { label: 'Baseline A', arm: 'baseline-a-ablation', cost: 5, score: 0.45 },
];

describe('paretoOptimal', () => {
  it('keeps points no other beats on both lower cost and higher score', () => {
    const opt = paretoOptimal(ARMS);
    // papercusp (idx 0) and C-bestofn (idx 2) are on the frontier.
    expect(opt.has(0)).toBe(true);
    expect(opt.has(2)).toBe(true);
    // B-native (idx 1): papercusp is cheaper AND higher → dominated.
    expect(opt.has(1)).toBe(false);
    // A-ablation (idx 3): papercusp same cost, higher score → dominated.
    expect(opt.has(3)).toBe(false);
  });

  it('keeps genuine ties (identical points do not dominate each other)', () => {
    const tie: FrontierPoint[] = [
      { label: 'x', arm: 'papercusp', cost: 1, score: 1 },
      { label: 'y', arm: 'baseline-a-ablation', cost: 1, score: 1 },
    ];
    expect(paretoOptimal(tie)).toEqual(new Set([0, 1]));
  });

  it('a single point is trivially optimal', () => {
    expect(paretoOptimal([ARMS[0]])).toEqual(new Set([0]));
  });
});

describe('projectFrontier', () => {
  it('maps lower cost to the left and higher score higher on the plot (smaller y)', () => {
    const { points } = projectFrontier(ARMS, { width: 520, height: 320 });
    const c = points.find((p) => p.arm === 'baseline-c-bestofn')!; // cheapest
    const b = points.find((p) => p.arm === 'baseline-b-native')!; // priciest
    expect(c.x).toBeLessThan(b.x);
    const top = points.find((p) => p.arm === 'papercusp')!; // highest score
    const low = points.find((p) => p.arm === 'baseline-a-ablation')!; // lowest score
    expect(top.y).toBeLessThan(low.y);
    // every point lands inside the box
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(520);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(320);
    }
  });

  it('flags the frontier points and builds a left→right frontier path', () => {
    const { points, frontierPath } = projectFrontier(ARMS);
    expect(points.filter((p) => p.onFrontier).map((p) => p.arm).sort()).toEqual(['baseline-c-bestofn', 'papercusp']);
    // two optimal points → a path with two "x,y" pairs (one space-separated join).
    expect(frontierPath.split(' ')).toHaveLength(2);
  });

  it('handles a degenerate (all-equal) domain without NaN', () => {
    const flat: FrontierPoint[] = [
      { label: 'a', arm: 'papercusp', cost: 3, score: 3 },
      { label: 'b', arm: 'baseline-a-ablation', cost: 3, score: 3 },
    ];
    const { points } = projectFrontier(flat);
    for (const p of points) {
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
    }
  });

  it('returns nothing for empty input', () => {
    expect(projectFrontier([])).toEqual({ points: [], frontierPath: '' });
  });
});

describe('<Frontier />', () => {
  it('renders one dot per point, accents the frontier, rings the highlighted arm', () => {
    const { container } = render(<Frontier points={ARMS} />);
    expect(container.querySelectorAll('[data-testid="frontier-point"]')).toHaveLength(4);
    const optimal = container.querySelectorAll('[data-frontier="1"]');
    expect(optimal).toHaveLength(2);
    // default highlightArm = papercusp → exactly one ring
    expect(container.querySelectorAll('.pc-frontier__ring')).toHaveLength(1);
    // the frontier line is drawn
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    // per-point tooltip names the arm + axes
    const titles = [...container.querySelectorAll('circle title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('Papercusp') && t.includes('Pareto-optimal'))).toBe(true);
  });

  it('renders an empty state (not null) when there are no points', () => {
    const { getByTestId } = render(<Frontier points={[]} emptyHint="nothing yet" />);
    expect(getByTestId('frontier-empty').textContent).toBe('nothing yet');
  });
});
