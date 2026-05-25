/**
 * @vitest-environment jsdom
 *
 * YourPlaceCard — P-073d tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { YourPlaceCard, type YourPlaceCardProps } from '../YourPlaceCard';

afterEach(() => {
  cleanup();
});

const baseProps: YourPlaceCardProps = {
  queue: { queued: 3, working: 1, shipped_this_week: 4 },
  role: {
    pr_reviewer_enabled: true,
    is_provisional_owner: false,
    is_claimant: true,
  },
  trust: { trusted_authors_count: 2, trusted_by_count: 5 },
  spend: { spent_usd_this_week: 12.34, cap_usd: 50 },
};

describe('YourPlaceCard — P-073d', () => {
  it('renders all 4 sections', () => {
    render(<YourPlaceCard {...baseProps} />);
    expect(screen.getByTestId('your-place-queue')).toBeTruthy();
    expect(screen.getByTestId('your-place-role')).toBeTruthy();
    expect(screen.getByTestId('your-place-trust')).toBeTruthy();
    expect(screen.getByTestId('your-place-spend')).toBeTruthy();
  });

  it('shows queue stats', () => {
    render(<YourPlaceCard {...baseProps} />);
    const q = screen.getByTestId('your-place-queue');
    expect(q.textContent).toContain('3');
    expect(q.textContent).toContain('Queued');
    expect(q.textContent).toContain('1');
    expect(q.textContent).toContain('Working');
    expect(q.textContent).toContain('4');
    expect(q.textContent).toContain('Shipped this week');
  });

  it('renders role badges with on/off testid', () => {
    render(<YourPlaceCard {...baseProps} />);
    expect(screen.getByTestId('role-reviewer-on')).toBeTruthy();
    expect(screen.getByTestId('role-provisional-off')).toBeTruthy();
    expect(screen.getByTestId('role-claimant-on')).toBeTruthy();
  });

  it('shows trust counts', () => {
    render(<YourPlaceCard {...baseProps} />);
    const t = screen.getByTestId('your-place-trust');
    expect(t.textContent).toContain('2');
    expect(t.textContent).toContain('You trust');
    expect(t.textContent).toContain('5');
    expect(t.textContent).toContain('Trust you');
  });

  it('formats spend < $1 with two decimal places', () => {
    render(
      <YourPlaceCard
        {...baseProps}
        spend={{ spent_usd_this_week: 0.32 }}
      />,
    );
    expect(screen.getByTestId('your-place-spend').textContent).toContain(
      '$0.32',
    );
  });

  it('formats spend < $100 with one decimal place', () => {
    render(
      <YourPlaceCard
        {...baseProps}
        spend={{ spent_usd_this_week: 12.34 }}
      />,
    );
    expect(screen.getByTestId('your-place-spend').textContent).toContain(
      '$12.3',
    );
  });

  it('formats spend ≥ $100 as whole dollars', () => {
    render(
      <YourPlaceCard
        {...baseProps}
        spend={{ spent_usd_this_week: 234.5 }}
      />,
    );
    expect(screen.getByTestId('your-place-spend').textContent).toContain(
      '$235',
    );
  });

  it('includes cap when provided', () => {
    render(
      <YourPlaceCard
        {...baseProps}
        spend={{ spent_usd_this_week: 12.34, cap_usd: 100 }}
      />,
    );
    const s = screen.getByTestId('your-place-spend');
    expect(s.textContent).toContain('$12.3');
    expect(s.textContent).toContain('$100');
  });

  it('omits cap when not provided', () => {
    render(
      <YourPlaceCard
        {...baseProps}
        spend={{ spent_usd_this_week: 12.34 }}
      />,
    );
    const s = screen.getByTestId('your-place-spend');
    // no cap separator should appear; but make sure $12.3 is there
    expect(s.textContent).toContain('$12.3');
    expect(s.textContent).not.toContain('/ $');
  });

  it('explains tier-D privacy', () => {
    render(<YourPlaceCard {...baseProps} />);
    expect(screen.getByTestId('your-place-spend').textContent).toContain(
      'never shown to other people',
    );
  });
});
