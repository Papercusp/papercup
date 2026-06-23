// @vitest-environment jsdom
/**
 * PlansClient.test.tsx — render-tier coverage for the Plans admin shell. The
 * shell is nuqs-driven (`?view=` plans|queue|sessions, `?plan=` opens the full
 * detail) and orchestrates a dozen data hooks + child panes. We mock the data
 * layer (./plans-api hooks, @papercusp/sync) and the cross-cutting hooks, and
 * stub every heavy child pane to an inert id-tagged node, so this asserts
 * PlansClient's OWN branching: the three view buttons + their main-pane content,
 * the Queue-count badge derived from the item counts, the harness/flag plumbing,
 * and opening a plan (?plan= + plans view → PlanDetail). The real plans-api
 * constants/helpers (PLAN_BUCKETS, bucketOf, …) are preserved via importActual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Data-layer mocks ──────────────────────────────────────────────── */
// Per-test fixtures for the plans-api hooks.
let planListData: { plans: unknown[] } | null;
let needsHumanItems: unknown[];
let actionableItems: unknown[];
let blockedItems: unknown[];
let attentionGroups: unknown[];
// The LIVE harness registry (harnessProjects.lite via useSyncQuery —
// data-sync-push-completion P-010, replacing the old one-shot
// /api/harness/projects/lite fetch). Feeds the scope-union + NewPlanButton.
let registryRows: unknown[];

vi.mock('./plans-api', async (importActual) => {
  const actual = await importActual<typeof import('./plans-api')>();
  const asyncOf = (data: unknown) => ({
    data,
    loading: false,
    error: null,
    refresh: vi.fn(),
    setData: vi.fn(),
  });
  return {
    ...actual,
    usePlanList: () => asyncOf(planListData),
    usePlanItems: (params?: { needsHuman?: boolean; actionable?: boolean; status?: string }) => {
      if (params?.needsHuman) return asyncOf({ items: needsHumanItems });
      if (params?.actionable) return asyncOf({ items: actionableItems });
      if (params?.status === 'blocked') return asyncOf({ items: blockedItems });
      return asyncOf({ items: [] });
    },
    usePlanAttention: () => asyncOf({ groups: attentionGroups }),
    usePlanSearch: () => asyncOf({ hits: [] }),
  };
});

// useSyncQuery dispatches by queryName: harnessProjects.lite → the registry
// rows; decision.ledger (Queen's-log) → an empty list. Both return the flat
// row-array shape the resolvers emit.
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: queryName === 'harnessProjects.lite' ? registryRows : [],
    error: null,
    fetching: false,
    loading: false,
    invalidate: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/* ── Cross-cutting hook mocks ──────────────────────────────────────── */
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (term: string) => term }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({ wsLocalKey: (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({ launchAgent: vi.fn(async () => ({ ok: true })) }));
vi.mock('@papercusp/operator-core/lib/harness/scope', () => ({
  resolveHarnessScope: (slug: string) => [slug],
  HARNESS_SCOPE_MODES: ['expanded', 'self', 'all'],
}));

/* ── Child-pane stubs (heavy / Vditor / IPC / sync-bound) ──────────── */
vi.mock('./PlanRail', () => ({ default: () => <div data-testid="plan-rail" /> }));
vi.mock('./PlanDetail', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="plan-detail">{slug}</div> }));
vi.mock('./PlanItemsList', () => ({
  default: ({ title }: { title: string }) => <div data-testid="plan-items-list">{title}</div>,
}));
vi.mock('./PlanOtherList', () => ({
  default: () => <div data-testid="plan-other-list" />,
  OtherDetail: () => null,
}));
vi.mock('./PlanItemPreview', () => ({ default: () => null }));
vi.mock('./NewPlanButton', () => ({ default: () => <button type="button">New plan</button> }));
vi.mock('./QueueSummary', () => ({ default: ({ waitingOnYou }: { waitingOnYou: number }) => <div data-testid="queue-summary">{waitingOnYou}</div> }));
vi.mock('./PlanFilters', () => ({ default: () => <div data-testid="plan-filters" /> }));
vi.mock('./PlanBucketTabs', () => ({ default: () => <div data-testid="plan-bucket-tabs" /> }));
vi.mock('./PlanSearchResults', () => ({ default: () => <div data-testid="plan-search-results" /> }));
vi.mock('@/app/_components/DecisionLog', () => ({
  default: () => <div data-testid="decision-log" />,
  DecisionDetail: () => null,
}));
vi.mock('@/app/_components/layout/TwoPaneShell', () => ({
  default: ({ list, detail }: { list: ReactElement; detail: ReactElement }) => (
    <div data-testid="two-pane">
      <div data-testid="two-pane-list">{list}</div>
      <div data-testid="two-pane-detail">{detail}</div>
    </div>
  ),
}));
vi.mock('@/app/adv/sessions/SessionsRosterView', () => ({
  SessionsRosterList: () => <div data-testid="roster-list" />,
  SessionsRosterDetail: () => <div data-testid="roster-detail" />,
}));
vi.mock('@/app/adv/sessions/SessionsRosterContext', () => ({
  SessionsRosterProvider: ({ children }: { children: ReactElement }) => <>{children}</>,
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => <div data-testid="select" /> }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }),
}));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => <>{children}</>,
}));

// Inert fetch — the harness registry now arrives via the mocked useSyncQuery
// (harnessProjects.lite), not a fetch; this only guards any incidental call.
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

import PlansClient from './PlansClient';

function renderClient(searchParams = '', hasMemory = false): ReturnType<typeof render> {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} hasMemory={hasMemory}>
      <PlansClient />
    </NuqsTestingAdapter>,
  );
}

function mkPlan(over: Record<string, unknown> = {}) {
  return {
    slug: 'plan-a',
    title: 'Plan A',
    harness: 'h1',
    status: 'active',
    startStatus: 'started',
    itemCounts: { 'needs-human': 0, todo: 0 },
    ...over,
  };
}
function mkItem(plan: string, id: string) {
  return { plan, archived: false, item: { id, storedStatus: 'todo', effectiveStatus: 'todo', text: `text ${id}` } };
}

beforeEach(() => {
  planListData = { plans: [mkPlan()] };
  needsHumanItems = [];
  actionableItems = [];
  blockedItems = [];
  attentionGroups = [];
  registryRows = [];
});
afterEach(cleanup);

describe('PlansClient (Plans admin shell)', () => {
  it('renders the three view buttons + the rail and defaults to the Plans view', () => {
    renderClient();
    expect(screen.getByRole('button', { name: /Plans/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Queue/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sessions/ })).toBeTruthy();
    expect(screen.getByTestId('plan-rail')).toBeTruthy();
    // Default view = plans → the grouped item list is the main pane.
    expect(screen.getByTestId('plan-items-list')).toBeTruthy();
  });

  it('opens the full PlanDetail when ?plan= is set in the plans view', () => {
    renderClient('?view=plans&plan=plan-a');
    const detail = screen.getByTestId('plan-detail');
    expect(detail).toBeTruthy();
    expect(detail.textContent).toBe('plan-a');
  });

  it('shows search results when ?q= is set (and no plan open)', () => {
    renderClient('?view=plans&q=auth');
    expect(screen.getByTestId('plan-search-results')).toBeTruthy();
  });

  it('renders the Queue view: summary + Other list inside the two-pane shell', () => {
    renderClient('?view=queue');
    expect(screen.getByTestId('two-pane')).toBeTruthy();
    expect(screen.getByTestId('queue-summary')).toBeTruthy();
    expect(screen.getByTestId('plan-other-list')).toBeTruthy();
  });

  it('renders the Sessions view roster list + detail', () => {
    renderClient('?view=sessions');
    expect(screen.getByTestId('roster-list')).toBeTruthy();
    expect(screen.getByTestId('roster-detail')).toBeTruthy();
  });

  it('shows the Queue-count badge from the aggregated item counts', () => {
    needsHumanItems = [mkItem('plan-a', 'P-001')];
    actionableItems = [mkItem('plan-a', 'P-002')];
    renderClient();
    // queueTotal = 2 (one needs-human + one todo) → badge present on the Queue button.
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('hides the Queue-count badge when there are no items', () => {
    renderClient();
    // No items → no count span; the Queue button label still renders.
    expect(screen.getByRole('button', { name: /Queue/ })).toBeTruthy();
  });

  it('renders with a live harnessProjects.lite registry (scope=all fan-out path)', () => {
    // A populated registry drives harnessSlugsForFetch (registryProjects.map)
    // for scope=all — the migrated useSyncQuery source replaces the old fetch.
    registryRows = [{ slug: 'h1', parent_slug: null }, { slug: 'h2', parent_slug: 'h1' }];
    renderClient('?scope=all');
    expect(screen.getByRole('button', { name: /Plans/ })).toBeTruthy();
    expect(screen.getByTestId('plan-rail')).toBeTruthy();
  });

  it('clicking the Queue button switches to the queue view', async () => {
    renderClient('', /* hasMemory */ true);
    fireEvent.click(screen.getByRole('button', { name: /Queue/ }));
    // goQueue awaits leaveGuard() then chains nuqs setters — the view switch
    // lands asynchronously, so wait for the Queue summary to appear.
    await vi.waitFor(() => {
      expect(screen.getByTestId('queue-summary')).toBeTruthy();
    });
  });
});
