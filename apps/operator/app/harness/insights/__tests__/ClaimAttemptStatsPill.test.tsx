/**
 * @vitest-environment jsdom
 *
 * ClaimAttemptStatsPill tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ClaimAttemptStatsPill } from '../ClaimAttemptStatsPill';

afterEach(() => {
  cleanup();
});

describe('ClaimAttemptStatsPill', () => {
  it('renders nothing when total = 0', () => {
    render(<ClaimAttemptStatsPill total={0} won={0} lost={0} error={0} />);
    expect(screen.queryByTestId('claim-attempt-stats-pill')).toBeNull();
  });

  it('renders all three segments by default', () => {
    render(<ClaimAttemptStatsPill total={10} won={6} lost={3} error={1} />);
    expect(screen.getByTestId('claim-attempt-stats-pill')).toBeTruthy();
    expect(screen.getByTestId('claim-stats-won').textContent).toContain('6');
    expect(screen.getByTestId('claim-stats-lost').textContent).toContain('3');
    expect(screen.getByTestId('claim-stats-error').textContent).toContain('1');
  });

  it('compact mode hides zero counts', () => {
    render(
      <ClaimAttemptStatsPill total={6} won={6} lost={0} error={0} compact />,
    );
    expect(screen.getByTestId('claim-stats-won')).toBeTruthy();
    expect(screen.queryByTestId('claim-stats-lost')).toBeNull();
    expect(screen.queryByTestId('claim-stats-error')).toBeNull();
  });

  it('compact mode keeps non-zero counts', () => {
    render(
      <ClaimAttemptStatsPill total={2} won={0} lost={1} error={1} compact />,
    );
    expect(screen.queryByTestId('claim-stats-won')).toBeNull();
    expect(screen.getByTestId('claim-stats-lost').textContent).toContain('1');
    expect(screen.getByTestId('claim-stats-error').textContent).toContain('1');
  });

  it('tooltip describes the breakdown', () => {
    render(<ClaimAttemptStatsPill total={10} won={6} lost={3} error={1} />);
    const pill = screen.getByTestId('claim-attempt-stats-pill');
    expect(pill.getAttribute('title')).toContain('6 won');
    expect(pill.getAttribute('title')).toContain('3 lost');
    expect(pill.getAttribute('title')).toContain('1 error');
    expect(pill.getAttribute('title')).toContain('10 total');
  });

  it('non-compact with all zeros except total stays visible', () => {
    // edge case: total > 0 but counts add up correctly
    render(<ClaimAttemptStatsPill total={3} won={0} lost={2} error={1} />);
    expect(screen.getByTestId('claim-attempt-stats-pill')).toBeTruthy();
    expect(screen.getByTestId('claim-stats-won').textContent).toContain('0');
  });
});
