// @vitest-environment jsdom
/**
 * QueuePanel — the /adv Create dock's Queue view.
 *
 * Regression guard for the queue-authorization-redesign parity bug: the
 * A1 authorizer-split + B1 tabs originally landed in PlansClient only, so the
 * Create-tab Queue (this panel) silently rendered the legacy grouping. These
 * tests lock in that the panel:
 *   - passes `groupByAuthorizer` to PlanOtherList tracking the flag (A1);
 *   - renders the QueueSummary + Pending|Queen's-log tabs when the flag is on (B1);
 *   - mounts the shared <DecisionLog/> on the Queen's-log tab.
 *
 * The data hooks, flag hook and heavy list children are mocked; nuqs runs under
 * the testing adapter (so `?queueTab=` is injectable).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

// Flag: flip per test.
let flagOn = true;
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => flagOn }));

// Capture the props PlanOtherList receives (esp. groupByAuthorizer).
const otherListProps: Array<Record<string, unknown>> = [];
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  default: (props: Record<string, unknown>) => {
    otherListProps.push(props);
    return <div data-testid="other-list" data-authz={String(props.groupByAuthorizer)} />;
  },
}));
vi.mock('@/app/admin/plans/PlanItemsList', () => ({
  default: () => <div data-testid="items-list" />,
}));
vi.mock('@/app/admin/plans/QueueSummary', () => ({
  default: ({ waitingOnYou }: { waitingOnYou: number }) => (
    <div data-testid="queue-summary">{waitingOnYou}</div>
  ),
}));
vi.mock('@/app/_components/DecisionLog', () => ({
  default: ({ layer }: { layer: string }) => <div data-testid="decision-log" data-layer={layer} />,
}));

// Stub the shared data hooks; keep the real ITEM_FILTERS constants.
const QUEUE_DATA = {
  loading: false,
  error: null,
  refresh: vi.fn(),
  filteredItems: [],
  otherItems: [],
  otherGroups: [],
  attentionRaw: { loading: false, error: null, refresh: vi.fn() },
  itemStatusCounts: {},
  tierCounts: { decision: 3, handled: 0, alert: 1, activity: 2 },
  queueTotal: 6,
  showOther: true,
  showPlanItems: true,
  otherFacets: [],
};
vi.mock('./use-create-data', async () => {
  const actual = await vi.importActual<typeof import('./use-create-data')>('./use-create-data');
  return {
    ...actual,
    useCreateScope: () => ({ scopeMode: 'all', harnessFilter: null, advActiveSlug: null }),
    usePlanListMaps: () => ({
      planBucketBySlug: new Map(),
      harnessByPlan: new Map(),
      planMetaBySlug: new Map(),
      harnessOptions: [],
      planList: { data: null, loading: false, error: null, refresh: vi.fn() },
      filteredPlanList: { data: null, loading: false, error: null, refresh: vi.fn() },
      visiblePlans: [],
    }),
    useQueueData: () => QUEUE_DATA,
  };
});

import QueuePanel from './QueuePanel';

function renderAt(search: string) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    withNuqsTestingAdapter({ searchParams: search })({ children });
  return render(<QueuePanel />, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  otherListProps.length = 0;
  flagOn = true;
});

describe('QueuePanel', () => {
  it('flag ON: passes groupByAuthorizer + renders the summary and Pending/Queen-log tabs', () => {
    renderAt('');
    expect(screen.getByTestId('other-list').getAttribute('data-authz')).toBe('true');
    expect(otherListProps.at(-1)?.groupByAuthorizer).toBe(true);
    // B1: summary (waiting-on-you = tierCounts.decision) + the two tabs.
    expect(screen.getByTestId('queue-summary').textContent).toContain('3');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "Queen's log" })).toBeTruthy();
  });

  it('flag OFF: legacy grouping (groupByAuthorizer falsy), no summary/tabs', () => {
    flagOn = false;
    renderAt('');
    expect(screen.getByTestId('other-list').getAttribute('data-authz')).toBe('false');
    expect(screen.queryByTestId('queue-summary')).toBeNull();
    expect(screen.queryByRole('button', { name: "Queen's log" })).toBeNull();
  });

  it('Queen-log tab: mounts the shared DecisionLog (disposition layer default)', () => {
    renderAt('queueTab=queen-log');
    const log = screen.getByTestId('decision-log');
    expect(log).toBeTruthy();
    expect(log.getAttribute('data-layer')).toBe('disposition');
    // the pending list is not rendered on the Queen-log tab
    expect(screen.queryByTestId('other-list')).toBeNull();
  });
});
