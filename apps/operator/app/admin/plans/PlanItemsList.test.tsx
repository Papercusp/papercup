// @vitest-environment jsdom
/**
 * PlanItemsList.test.tsx — render-tier coverage for the flat cross-plan items
 * aggregation. Purely presentational (items/loading/error are props), so this
 * drives its real branches directly: loading, error (+ Retry), empty (3 empty
 * messages — bare-single / selected-plans / no-filter), the grouped collapsible
 * render, the bare single-plan render, and row selection (clicking a row writes
 * the `?item=<plan>::<id>` nuqs param). AssignDialog + AuthorBadge are stubbed
 * (nuqs/toast/identity-heavy children not under test here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('./AssignDialog', () => ({ default: () => null }));
vi.mock('../../_components/AuthorBadge', () => ({ AuthorBadge: () => null }));

import PlanItemsList from './PlanItemsList';
import type { PlanItemRow } from './plans-api';

function renderList(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

function mkRow(over: Partial<PlanItemRow['item']> & { plan?: string } = {}): PlanItemRow {
  const { plan = 'plan-a', ...itemOver } = over;
  return {
    plan,
    archived: false,
    item: {
      id: 'P-001',
      storedStatus: 'todo',
      effectiveStatus: 'todo',
      text: 'Do the thing',
      ...itemOver,
    },
  };
}

const noop = () => {};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PlanItemsList (cross-plan items aggregation)', () => {
  it('renders the title and a loading placeholder', () => {
    renderList(
      <PlanItemsList items={[]} loading error={null} refresh={noop} title="All items" />,
    );
    expect(screen.getByText('All items')).toBeTruthy();
    expect(screen.getByText(/Loading…/)).toBeTruthy();
  });

  it('renders the error state with a Retry button that calls refresh', () => {
    const refresh = vi.fn();
    renderList(
      <PlanItemsList items={[]} loading={false} error="boom" refresh={refresh} title="All items" />,
    );
    expect(screen.getByText(/Failed to load items/)).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the no-filter empty message when there are no items', () => {
    renderList(
      <PlanItemsList items={[]} loading={false} error={null} refresh={noop} title="All items" />,
    );
    expect(screen.getByText('No items match the current filters.')).toBeTruthy();
  });

  it('shows the per-plan empty message when a single plan filter has no items', () => {
    renderList(
      <PlanItemsList
        items={[mkRow({ plan: 'other-plan' })]}
        loading={false}
        error={null}
        refresh={noop}
        planFilters={['plan-a']}
        title="All items"
      />,
    );
    expect(screen.getByText('No items in plan-a.')).toBeTruthy();
  });

  it('renders grouped rows (plan head + item text + effective-status pill)', () => {
    // Groups are collapsible (Radix), default-collapsed; seed ?expand=plan-a so
    // the row content (the effective-status pill) is mounted + visible.
    renderList(
      <PlanItemsList
        items={[mkRow({ text: 'First item', effectiveStatus: 'blocked' })]}
        loading={false}
        error={null}
        refresh={noop}
        planMeta={new Map([['plan-a', { title: 'Plan A', bucket: 'active' }]])}
        title="All items"
      />,
      '?expand=plan-a',
    );
    // Group header uses the human title…
    expect(screen.getByText('Plan A')).toBeTruthy();
    // …the row pill surfaces the EFFECTIVE status (blocked), not the stored one.
    expect(screen.getByText('blocked')).toBeTruthy();
    // The single-item count label.
    expect(screen.getByText('1 item')).toBeTruthy();
  });

  it('renders an importance badge only for non-normal importance', () => {
    renderList(
      <PlanItemsList
        items={[mkRow({ importance: 'urgent', text: 'Urgent one' })]}
        loading={false}
        error={null}
        refresh={noop}
        planFilters={['plan-a']}
        title="All items"
      />,
    );
    expect(screen.getByText('urgent')).toBeTruthy();
  });

  it('renders bare (no plan header) when exactly one plan is filter-selected', () => {
    renderList(
      <PlanItemsList
        items={[mkRow({ plan: 'plan-a', text: 'Bare row' })]}
        loading={false}
        error={null}
        refresh={noop}
        planMeta={new Map([['plan-a', { title: 'Plan A', bucket: 'active' }]])}
        planFilters={['plan-a']}
        title="All items"
      />,
    );
    // The row shows…
    expect(screen.getByText('Bare row')).toBeTruthy();
    // …but the group head title is NOT rendered (bare mode).
    expect(screen.queryByText('Plan A')).toBeNull();
  });

  it('selecting a row writes the ?item=<plan>::<id> nuqs param', async () => {
    const onUrlUpdate = vi.fn();
    render(
      <NuqsTestingAdapter searchParams="" onUrlUpdate={onUrlUpdate} hasMemory>
        <PlanItemsList
          items={[mkRow({ plan: 'plan-a', id: 'P-007', text: 'Pick me' })]}
          loading={false}
          error={null}
          refresh={noop}
          planFilters={['plan-a']}
          title="All items"
        />
      </NuqsTestingAdapter>,
    );
    fireEvent.click(screen.getByText('Pick me'));
    // nuqs flushes URL writes on a microtask — wait for the update to land.
    await vi.waitFor(() => {
      const itemUpdate = onUrlUpdate.mock.calls
        .map((c) => c[0].searchParams.get('item'))
        .find((v): v is string => v != null);
      // selectItem writes ?item=<plan>::<itemId> (and clears ?other=).
      expect(itemUpdate).toBe('plan-a::P-007');
    });
  });
});
