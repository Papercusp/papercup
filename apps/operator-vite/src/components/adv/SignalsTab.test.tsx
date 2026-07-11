// @vitest-environment jsdom
/**
 * SignalsTab.test — the /adv "Signals" tab (owner ask 2026-07-10). Verifies the
 * three sub-tabs (Rubrics & Scorecards / Observations / Ideas), the `?sig=`
 * default + deep-link, the rubric list→detail→back drill-down, and that the
 * Ideas sub-tab mounts the (moved-from-Learning) Scout ideation surface. The
 * three heavy panels + ScoutView are stubbed to markers — their own behavior is
 * covered in RubricsPanel / ObservationsPanel / LearningTab (ScoutView) tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@/app/_components/RubricsPanel', () => ({
  default: ({ onSelect }: { onSelect?: (id: string) => void }) => (
    <button data-testid="rubrics-panel" onClick={() => onSelect?.('rubric-1')}>rubrics-panel</button>
  ),
}));
vi.mock('@/app/_components/RubricDetailPanel', () => ({
  default: ({ rubricId, onBack }: { rubricId: string; onBack?: () => void }) => (
    <div data-testid="rubric-detail">
      detail:{rubricId}
      <button onClick={onBack}>back</button>
    </div>
  ),
}));
vi.mock('@/app/adv/create/ObservationsPanel', () => ({ default: () => <div data-testid="observations-panel" /> }));
// Ideas renders the Scout ideation surface (moved from Learning) + its styles.
vi.mock('./LearningTab', () => ({
  ScoutView: () => <div data-testid="scout-view" />,
  LearningStyles: () => null,
}));

import SignalsTab from './SignalsTab';

function renderTab(searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <SignalsTab />
    </NuqsTestingAdapter>,
  );
}

afterEach(cleanup);

describe('SignalsTab', () => {
  it('renders the three sub-tabs and defaults to Rubrics & Scorecards', () => {
    renderTab('');
    expect(screen.getByRole('tab', { name: /Rubrics & Scorecards/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Observations/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Ideas/ })).toBeTruthy();
    expect(screen.getByTestId('rubrics-panel')).toBeTruthy();
  });

  it('drills from the rubric list into the rubric detail and back', () => {
    renderTab('');
    fireEvent.click(screen.getByTestId('rubrics-panel')); // onSelect('rubric-1')
    expect(screen.getByTestId('rubric-detail').textContent).toContain('rubric-1');
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('rubrics-panel')).toBeTruthy();
  });

  it('shows the Observations feed on the ?sig=observations sub-tab', () => {
    renderTab('?sig=observations');
    expect(screen.getByTestId('observations-panel')).toBeTruthy();
    expect(screen.queryByTestId('rubrics-panel')).toBeNull();
  });

  it('shows the Scout ideation surface on the ?sig=ideas sub-tab', () => {
    renderTab('?sig=ideas');
    expect(screen.getByTestId('scout-view')).toBeTruthy();
  });

  it('switches sub-tabs on click', () => {
    renderTab('');
    fireEvent.click(screen.getByRole('tab', { name: /Observations/ }));
    expect(screen.getByTestId('observations-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Ideas/ }));
    expect(screen.getByTestId('scout-view')).toBeTruthy();
  });

  it('falls back to Rubrics for an unknown ?sig value', () => {
    renderTab('?sig=bogus');
    expect(screen.getByTestId('rubrics-panel')).toBeTruthy();
  });
});
