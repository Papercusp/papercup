/**
 * @vitest-environment jsdom
 *
 * YourPlaceCard tests. The per-viewer spend section was removed
 * (cross-backend-cost-capture D-003 #2) — harness-total spend now lives on the
 * SpendCard, and agent runs have no per-person attribution.
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
};

describe('YourPlaceCard', () => {
  it('renders the queue, role, and trust sections (no spend section)', () => {
    render(<YourPlaceCard {...baseProps} />);
    expect(screen.getByTestId('your-place-queue')).toBeTruthy();
    expect(screen.getByTestId('your-place-role')).toBeTruthy();
    expect(screen.getByTestId('your-place-trust')).toBeTruthy();
    expect(screen.queryByTestId('your-place-spend')).toBeNull();
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

  it('does not render any spend/cost text', () => {
    render(<YourPlaceCard {...baseProps} />);
    expect(screen.getByTestId('insights-your-place-card').textContent).not.toContain('$');
  });
});
