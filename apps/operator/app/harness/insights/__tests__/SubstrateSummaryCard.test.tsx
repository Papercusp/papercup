/**
 * @vitest-environment jsdom
 *
 * SubstrateSummaryCard tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  SubstrateSummaryCard,
  type SubstrateSummaryData,
} from '../SubstrateSummaryCard';

afterEach(() => {
  cleanup();
});

function summary(
  overrides: Partial<SubstrateSummaryData> = {},
): SubstrateSummaryData {
  return {
    enabled: true,
    totalHarnesses: 4,
    healthy: 2,
    booting: 1,
    degraded: 1,
    unhealthy: 0,
    disabled: 0,
    worstVerdict: 'degraded',
    ...overrides,
  };
}

describe('SubstrateSummaryCard', () => {
  it('renders verdict label for degraded', () => {
    render(<SubstrateSummaryCard summary={summary()} />);
    const el = screen.getByTestId('substrate-summary-card');
    expect(el.getAttribute('data-verdict')).toBe('degraded');
    expect(el.textContent).toContain('Degraded');
  });

  it('renders all four count tiles', () => {
    render(<SubstrateSummaryCard summary={summary()} />);
    expect(screen.getByTestId('substrate-summary-healthy').textContent).toContain('2');
    expect(screen.getByTestId('substrate-summary-booting').textContent).toContain('1');
    expect(screen.getByTestId('substrate-summary-degraded').textContent).toContain('1');
    expect(screen.getByTestId('substrate-summary-unhealthy').textContent).toContain('0');
  });

  it('renders harness count with plural', () => {
    render(<SubstrateSummaryCard summary={summary({ totalHarnesses: 4 })} />);
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).toContain('4 harnesses');
  });

  it('singular for 1 harness', () => {
    render(<SubstrateSummaryCard summary={summary({ totalHarnesses: 1 })} />);
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).toContain('1 harness');
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).not.toContain('1 harnesses');
  });

  it('renders CTA when diagnosticHref provided', () => {
    render(
      <SubstrateSummaryCard
        summary={summary()}
        diagnosticHref="/admin/dogfood-substrate"
      />,
    );
    const cta = screen.getByTestId('substrate-summary-cta') as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/admin/dogfood-substrate');
  });

  it('omits CTA when diagnosticHref absent', () => {
    render(<SubstrateSummaryCard summary={summary()} />);
    expect(screen.queryByTestId('substrate-summary-cta')).toBeNull();
  });

  it('verdict label for healthy', () => {
    render(
      <SubstrateSummaryCard
        summary={summary({
          worstVerdict: 'healthy',
          healthy: 4,
          booting: 0,
          degraded: 0,
          unhealthy: 0,
        })}
      />,
    );
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).toContain('All harnesses healthy');
  });

  it('verdict label for unhealthy', () => {
    render(
      <SubstrateSummaryCard
        summary={summary({ worstVerdict: 'unhealthy', unhealthy: 2 })}
      />,
    );
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).toContain('Unhealthy');
  });

  it('verdict label for disabled', () => {
    render(
      <SubstrateSummaryCard
        summary={summary({
          enabled: false,
          worstVerdict: 'disabled',
          totalHarnesses: 0,
        })}
      />,
    );
    expect(
      screen.getByTestId('substrate-summary-card').textContent,
    ).toContain('Substrate off');
  });
});
