/**
 * @vitest-environment jsdom
 *
 * SpendCard tests (cross-backend-cost-capture P-006) — real per-harness spend
 * from agent_usage_samples: total $, token throughput, run count, and an
 * estimated-vs-provider split note.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SpendCard } from '../SpendCard';

afterEach(() => {
  cleanup();
});

describe('SpendCard', () => {
  it('renders title and the this-week pill', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        estimatedUsdThisWeek={0}
        tokensThisWeek={1_500_000}
        runsThisWeek={5}
      />,
    );
    const card = screen.getByTestId('insights-spend-card');
    expect(card.textContent).toContain('Spend');
    expect(screen.getByTestId('spend-card-tier-pill').textContent).toContain(
      'this week',
    );
  });

  it('shows harness total, tokens, and run count', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={100}
        estimatedUsdThisWeek={0}
        tokensThisWeek={1_500_000}
        runsThisWeek={7}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$100');
    expect(screen.getByTestId('spend-card-tokens').textContent).toContain('1.5M');
    expect(screen.getByTestId('spend-card-runs').textContent).toContain('7');
  });

  it('formats sub-$1 spend with two decimals', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={0.5}
        estimatedUsdThisWeek={0}
        tokensThisWeek={4096}
        runsThisWeek={1}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$0.50');
  });

  it('formats $100+ spend as whole dollars', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={234.5}
        estimatedUsdThisWeek={0}
        tokensThisWeek={10_000_000}
        runsThisWeek={30}
      />,
    );
    expect(
      screen.getByTestId('spend-card-harness-total').textContent,
    ).toContain('$235');
  });

  it('formats token throughput with K/M suffixes', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={0}
        estimatedUsdThisWeek={0}
        tokensThisWeek={2048}
        runsThisWeek={0}
      />,
    );
    expect(screen.getByTestId('spend-card-tokens').textContent).toContain('2.0K');
  });

  it('shows the estimated-cost note when any spend was token-priced', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={9}
        estimatedUsdThisWeek={4.5}
        tokensThisWeek={2_000_000}
        runsThisWeek={4}
      />,
    );
    const note = screen.getByTestId('spend-card-estimate-note');
    expect(note.textContent).toContain('$4.5');
    expect(note.textContent).toContain('estimated');
    expect(screen.queryByTestId('spend-card-note')).toBeNull();
  });

  it('shows the provider-reported note when nothing was estimated', () => {
    render(
      <SpendCard
        harnessTotalUsdThisWeek={9}
        estimatedUsdThisWeek={0}
        tokensThisWeek={2_000_000}
        runsThisWeek={4}
      />,
    );
    expect(screen.getByTestId('spend-card-note').textContent).toContain(
      'Provider-reported',
    );
    expect(screen.queryByTestId('spend-card-estimate-note')).toBeNull();
  });
});
