// @vitest-environment jsdom
/**
 * QueuePanel — the /adv Create dock's Queue view.
 *
 * Regression guard for the queue-authorization-redesign parity bug: the
 * A1 authorizer-split + B1 tabs originally landed in PlansClient only, so the
 * Create-tab Queue (this panel) silently rendered the legacy grouping. These
 * tests lock in that the panel:
 *   - passes `groupByAuthorizer` to PlanOtherList tracking the flag (A1);
 *   - renders the QueueSummary + Needs Decision|Queen's-log tabs when the flag is on (B1);
 *   - mounts the shared <DecisionLog/> on the Queen's-log tab.
 *
 * The data hooks, flag hook and heavy list children are mocked; nuqs runs under
 * the testing adapter (so `?queueTab=` is injectable).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
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
  itemStatusCounts: {
    'needs-human': 3,
    todo: 5,
    blocked: 2,
    'coord-escalation': 1,
    'coord-message': 0,
    'smoke-fail': 0,
    'operator-report': 0,
    improvement: 0,
    'standing-approval': 0,
    conversation: 0,
    'scout-grade': 0,
  },
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
  const onUrlUpdate = vi.fn();
  const Wrapper = ({ children }: { children: ReactNode }) =>
    withNuqsTestingAdapter({ searchParams: search, onUrlUpdate })({
      children: <TooltipProvider delayDuration={0}>{children}</TooltipProvider>,
    });
  const utils = render(<QueuePanel />, { wrapper: Wrapper });
  return { ...utils, onUrlUpdate };
}

afterEach(() => {
  cleanup();
  otherListProps.length = 0;
  flagOn = true;
});

describe('QueuePanel', () => {
  it('flag ON: passes groupByAuthorizer + renders the summary and Needs Decision/Queen-log tabs', () => {
    renderAt('');
    expect(screen.getByTestId('other-list').getAttribute('data-authz')).toBe('true');
    expect(otherListProps.at(-1)?.groupByAuthorizer).toBe(true);
    // B1: summary (waiting-on-you = tierCounts.decision) + the two tabs.
    expect(screen.getByTestId('queue-summary').textContent).toContain('3');
    expect(screen.getByRole('button', { name: 'Needs Decision' })).toBeTruthy();
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

  it('clicking the Queen-log tab writes ?queueTab=queen-log (nuqs param)', async () => {
    const { onUrlUpdate } = renderAt('');
    fireEvent.click(screen.getByRole('button', { name: "Queen's log" }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)![0];
    expect(last.searchParams.get('queueTab')).toBe('queen-log');
  });

  it('the qlLayer toggle writes ?qlLayer=action and swaps the DecisionLog layer', async () => {
    const { onUrlUpdate } = renderAt('queueTab=queen-log');
    // disposition is the default → flip to the "All actions" (action) layer
    fireEvent.click(screen.getByRole('button', { name: 'All actions' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)![0];
    expect(last.searchParams.get('qlLayer')).toBe('action');
  });

  it('flag ON: uses the compact shared filter and writes ?qKinds from the collapsed panel', async () => {
    const { onUrlUpdate } = renderAt('');
    expect(screen.queryByRole('button', { name: 'Needs Human' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByRole('button', { name: /Escalations, 1/i }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)![0];
    expect(last.searchParams.get('qKinds')).toBe('coord-escalation');
  });

  it('toggling an item-status filter writes ?istatus (flag OFF / pending list)', async () => {
    flagOn = false;
    const { onUrlUpdate } = renderAt('');
    // the pending list shows the ITEM_FILTERS pressable chips
    const filterBtns = screen.getAllByRole('button', { pressed: false });
    expect(filterBtns.length).toBeGreaterThan(0);
    fireEvent.click(filterBtns[0]);
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)![0];
    expect(last.searchParams.has('istatus')).toBe(true);
  });
});
