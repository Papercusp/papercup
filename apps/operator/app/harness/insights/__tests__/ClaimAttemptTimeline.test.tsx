// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  ClaimAttemptTimeline,
  type ClaimAttemptDisplayRow,
} from '../ClaimAttemptTimeline';

afterEach(() => cleanup());

function row(overrides: Partial<ClaimAttemptDisplayRow> = {}): ClaimAttemptDisplayRow {
  return {
    id: 1,
    feature_id: 'F-1',
    claimer_pubkey: 'aaaa1111bbbb2222',
    claimer_github_user_id: 42,
    ts: 1700000000000,
    outcome: 'won',
    detail: null,
    ...overrides,
  };
}

describe('ClaimAttemptTimeline — empty', () => {
  it('renders the "no attempts" empty state when loaded=true', () => {
    render(<ClaimAttemptTimeline attempts={[]} loaded={true} />);
    expect(screen.getByTestId('claim-attempt-timeline-empty')).toBeTruthy();
    expect(screen.getByTestId('claim-attempt-timeline-empty').textContent).toMatch(/No claim/);
  });

  it('renders "Loading…" when loaded=false and no attempts yet', () => {
    render(<ClaimAttemptTimeline attempts={[]} loaded={false} />);
    expect(screen.getByTestId('claim-attempt-timeline-empty').textContent).toMatch(/Loading/);
  });

  it('shows recent-count pill = 0 when empty', () => {
    render(<ClaimAttemptTimeline attempts={[]} />);
    const wrap = screen.getByTestId('claim-attempt-timeline');
    expect(wrap.textContent).toMatch(/0 recent/);
  });
});

describe('ClaimAttemptTimeline — rendered rows', () => {
  it('renders one row per attempt with feature_id + outcome', () => {
    render(
      <ClaimAttemptTimeline
        attempts={[row({ id: 10, feature_id: 'F-1', outcome: 'won' }), row({ id: 11, feature_id: 'F-2', outcome: 'lost' })]}
      />,
    );
    expect(screen.getByTestId('claim-attempt-row-10')).toBeTruthy();
    expect(screen.getByTestId('claim-attempt-row-11')).toBeTruthy();
    expect(screen.getByTestId('claim-attempt-row-10').textContent).toContain('F-1');
    expect(screen.getByTestId('claim-attempt-row-11').textContent).toContain('F-2');
  });

  it('records the outcome on data-outcome for filtering', () => {
    render(<ClaimAttemptTimeline attempts={[row({ id: 1, outcome: 'won' })]} />);
    expect(screen.getByTestId('claim-attempt-row-1').getAttribute('data-outcome')).toBe('won');
  });

  it('formats the count pill as "<N> recent"', () => {
    render(
      <ClaimAttemptTimeline
        attempts={[row({ id: 1 }), row({ id: 2 }), row({ id: 3 })]}
      />,
    );
    expect(screen.getByTestId('claim-attempt-timeline').textContent).toContain('3 recent');
  });

  it('shows the claimer github user id with @ prefix', () => {
    render(<ClaimAttemptTimeline attempts={[row({ id: 1, claimer_github_user_id: 99 })]} />);
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('@99');
  });

  it('shows ? when claimer github user id is 0', () => {
    render(<ClaimAttemptTimeline attempts={[row({ id: 1, claimer_github_user_id: 0 })]} />);
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('@?');
  });

  it('shortens long pubkeys', () => {
    render(
      <ClaimAttemptTimeline
        attempts={[row({ id: 1, claimer_pubkey: 'aabbccddeeff11223344' })]}
      />,
    );
    const cell = screen.getByTestId('claim-attempt-row-1');
    expect(cell.textContent).toContain('aabbccdd…3344');
  });

  it('does not shorten short pubkeys', () => {
    render(<ClaimAttemptTimeline attempts={[row({ id: 1, claimer_pubkey: 'abc' })]} />);
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('abc');
  });

  it('renders detail when present', () => {
    render(
      <ClaimAttemptTimeline
        attempts={[row({ id: 1, outcome: 'lost', detail: 'winner=xyz789' })]}
      />,
    );
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('winner=xyz789');
  });

  it('highlights rows matching highlightOutcome', () => {
    render(
      <ClaimAttemptTimeline
        attempts={[row({ id: 1, outcome: 'won' }), row({ id: 2, outcome: 'lost' })]}
        highlightOutcome="lost"
      />,
    );
    const r1 = screen.getByTestId('claim-attempt-row-1');
    const r2 = screen.getByTestId('claim-attempt-row-2');
    // The highlighted row should carry a distinct background from the base grid row.
    expect(r2.getAttribute('style') ?? '').toContain('color-mix(in oklab, var(--accent), transparent 92%)');
    expect(r1.getAttribute('style') ?? '').not.toContain('color-mix(in oklab, var(--accent), transparent 92%)');
  });

  it('renders an em-dash for ts=0 (defensive)', () => {
    render(<ClaimAttemptTimeline attempts={[row({ id: 1, ts: 0 })]} />);
    expect(screen.getByTestId('claim-attempt-row-1').textContent).toContain('—');
  });
});
