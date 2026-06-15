// @vitest-environment jsdom
//
// InsightsPanel — the per-mission insights modal (status distribution, attempts
// histogram, cost-per-passed KPIs). The derivation (`computeInsightsStats`) is
// extracted + tested branch-by-branch; a render-smoke drives a small feature set
// through the panel to confirm the headline tally + KPIs surface. RichGrid (the
// stuck-features grid) and PromptBudgetView (telemetry fetch) are stubbed so the
// smoke stays transport-free.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// RichGrid pulls in heavy virtualization; the panel only uses it for the stuck
// list. Stub to a marker so the smoke renders without measuring layout.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: unknown[] }) => <div data-testid="stuck-grid">{rows.length} stuck rows</div>,
}));

// PromptBudgetView fires a fetch on mount — out of scope for the panel smoke.
vi.mock('./PromptBudgetView', () => ({
  PromptBudgetView: () => <div data-testid="prompt-budget" />,
}));

import InsightsPanel, { computeInsightsStats } from './InsightsPanel';

afterEach(cleanup);

type F = { id: string; status: import('./theme').HarnessStatus; attempts: number; title: string };
function mk(over: Partial<F> = {}): F {
  return { id: 'F-1', status: 'todo', attempts: 0, title: 't', ...over };
}

describe('computeInsightsStats', () => {
  it('returns an all-zero shape for an empty feature set', () => {
    const s = computeInsightsStats([], 0);
    expect(s.passed).toBe(0);
    expect(s.stuckCount).toBe(0);
    expect(s.totalAttempts).toBe(0);
    expect(s.failRate).toBe(0);
    expect(s.avgAttemptsPerPassed).toBe(0);
    expect(s.costPerPassed).toBe(0);
    expect(s.attemptsHist).toEqual([0, 0, 0, 0, 0]);
    // Every status bucket exists and is zero.
    expect(Object.values(s.byStatus).every((n) => n === 0)).toBe(true);
  });

  it('tallies status counts per feature', () => {
    const s = computeInsightsStats(
      [mk({ status: 'passed' }), mk({ status: 'passed' }), mk({ status: 'failing' }), mk({ status: 'todo' })],
      0,
    );
    expect(s.byStatus.passed).toBe(2);
    expect(s.byStatus.failing).toBe(1);
    expect(s.byStatus.todo).toBe(1);
    expect(s.passed).toBe(2);
  });

  it('buckets attempts into the [0,1,2,3-4,5+] histogram', () => {
    const s = computeInsightsStats(
      [
        mk({ attempts: 0 }),
        mk({ attempts: 1 }),
        mk({ attempts: 2 }),
        mk({ attempts: 3 }),
        mk({ attempts: 4 }),
        mk({ attempts: 5 }),
        mk({ attempts: 9 }),
      ],
      0,
    );
    // 0→[0], 1→[1], 2→[2], 3 & 4→[3], 5 & 9→[4]
    expect(s.attemptsHist).toEqual([1, 1, 1, 2, 2]);
    expect(s.totalAttempts).toBe(0 + 1 + 2 + 3 + 4 + 5 + 9);
  });

  it('counts features with >= 3 attempts as stuck and computes failRate', () => {
    const s = computeInsightsStats(
      [mk({ attempts: 0 }), mk({ attempts: 3 }), mk({ attempts: 7 }), mk({ attempts: 1 })],
      0,
    );
    expect(s.stuckCount).toBe(2);
    expect(s.failRate).toBeCloseTo(0.5, 6);
  });

  it('divides cost and attempts by the passed count (not feature count)', () => {
    const s = computeInsightsStats(
      [mk({ status: 'passed', attempts: 2 }), mk({ status: 'passed', attempts: 4 }), mk({ status: 'failing', attempts: 6 })],
      12,
    );
    expect(s.passed).toBe(2);
    // total attempts across ALL features = 12; per passed = 12/2 = 6.
    expect(s.avgAttemptsPerPassed).toBe(6);
    expect(s.costPerPassed).toBe(6); // $12 / 2 passed
  });

  it('leaves cost-per-passed at 0 when nothing has passed (no divide-by-zero)', () => {
    const s = computeInsightsStats([mk({ status: 'failing', attempts: 3 })], 5);
    expect(s.passed).toBe(0);
    expect(s.costPerPassed).toBe(0);
    expect(s.avgAttemptsPerPassed).toBe(0);
  });
});

describe('<InsightsPanel />', () => {
  const FEATURES: F[] = [
    mk({ id: 'F-1', status: 'passed', attempts: 1, title: 'Done one' }),
    mk({ id: 'F-2', status: 'failing', attempts: 4, title: 'Stuck feature' }),
    mk({ id: 'F-3', status: 'todo', attempts: 0, title: 'Queued' }),
  ];

  it('renders the headline pass-rate / stuck tally for the feature set', () => {
    render(
      <InsightsPanel
        features={FEATURES}
        totalCostUsd={1.5}
        totalInputTokens={1000}
        totalOutputTokens={2000}
        iteration={7}
        inline
        onClose={() => {}}
      />,
    );
    // 1 of 3 passed → 33% — appears in both the head metric and the KPI sub.
    expect(screen.getAllByText('33%').length).toBeGreaterThan(0);
    // The head metric shows the pass-rate KPI value "1/3".
    expect(screen.getByText('1/3')).toBeTruthy();
    expect(screen.getByText('iteration 7 · 3 features')).toBeTruthy();
    // The stuck list mounts the (stubbed) grid with exactly the stuck rows.
    expect(screen.getByTestId('stuck-grid').textContent).toBe('1 stuck rows');
  });

  it('omits the prompt-budget section when no slug is given', () => {
    render(
      <InsightsPanel
        features={FEATURES}
        totalCostUsd={0}
        totalInputTokens={0}
        totalOutputTokens={0}
        iteration={1}
        inline
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('prompt-budget')).toBeNull();
  });

  it('mounts the prompt-budget section when a slug is provided', () => {
    render(
      <InsightsPanel
        features={FEATURES}
        totalCostUsd={0}
        totalInputTokens={0}
        totalOutputTokens={0}
        iteration={1}
        slug="my-harness"
        inline
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('prompt-budget')).toBeTruthy();
  });
});
