// @vitest-environment jsdom
/**
 * ScheduledRoutinesPane render coverage (scheduled-recurring-plans-2026-06-16
 * P-026) — the ops list of scheduled plans. Pins: the loading vs honest-empty
 * states, the summary, the active-first/soonest-fire sort + per-plan
 * collapse to one row (the byPlan reducer keeps the soonest fire), the
 * explicit active/paused + last-run labels, the relative-when label, and the onSelect
 * click handler. The `plans.scheduledOccurrences` sync query is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  result: { data: [] as unknown[], loading: false },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => H.result,
}));

import ScheduledRoutinesPane from './ScheduledRoutinesPane';

const HOUR = 60 * 60 * 1000;

function occ(over: Record<string, unknown> = {}) {
  return {
    templateSlug: 'plan-a',
    title: 'Plan A',
    harnessSlug: 'pot-x',
    occurrenceMs: Date.now() + 2 * HOUR,
    kind: 'recurring',
    scheduleActive: true,
    lastOutcome: null,
    ...over,
  };
}

beforeEach(() => {
  H.result = { data: [], loading: false };
});
afterEach(cleanup);

describe('<ScheduledRoutinesPane>', () => {
  it('shows the loading state while fetching with no data', () => {
    H.result = { data: [], loading: true };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText(/Loading routines…/)).toBeTruthy();
  });

  it('shows the honest empty state when there are no occurrences', () => {
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText(/No routines scheduled in the next 30 days/)).toBeTruthy();
  });

  it('renders the header count and one row per plan', () => {
    H.result = {
      data: [occ({ templateSlug: 'plan-a', title: 'Plan A' }), occ({ templateSlug: 'plan-b', title: 'Plan B' })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('2 scheduled')).toBeTruthy();
    expect(screen.getByText('2 active')).toBeTruthy();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText('Plan B')).toBeTruthy();
  });

  it('collapses multiple occurrences of one plan into a single row', () => {
    const now = Date.now();
    H.result = {
      data: [
        occ({ templateSlug: 'plan-a', occurrenceMs: now + 5 * HOUR }),
        occ({ templateSlug: 'plan-a', occurrenceMs: now + 1 * HOUR }),
      ],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    // single row → one title node
    expect(screen.getAllByText('Plan A').length).toBe(1);
    expect(screen.getByText('1 scheduled')).toBeTruthy();
  });

  it('sorts armed plans before paused ones', () => {
    H.result = {
      data: [
        occ({ templateSlug: 'paused', title: 'Paused Plan', scheduleActive: false, occurrenceMs: Date.now() + 1 * HOUR }),
        occ({ templateSlug: 'armed', title: 'Armed Plan', scheduleActive: true, occurrenceMs: Date.now() + 10 * HOUR }),
      ],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    const items = document.querySelectorAll('li');
    expect(items[0].textContent).toContain('Armed Plan');
    expect(items[1].textContent).toContain('Paused Plan');
  });

  it('renders a readable last-run outcome', () => {
    H.result = {
      data: [occ({ lastOutcome: 'success', occurrenceMs: Date.now() + 2 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Last: Success')).toBeTruthy();
  });

  it('renders the active state and overdue label for past fires', () => {
    H.result = {
      data: [occ({ scheduleActive: true, occurrenceMs: Date.now() - 1 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('overdue')).toBeTruthy();
  });

  it('calls onSelect with the templateSlug when a row is clicked', () => {
    const onSelect = vi.fn();
    H.result = { data: [occ({ templateSlug: 'plan-z', title: 'Plan Z' })], loading: false };
    render(<ScheduledRoutinesPane onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Plan Z'));
    expect(onSelect).toHaveBeenCalledWith('plan-z');
  });
});
