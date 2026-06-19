// @vitest-environment jsdom
/**
 * PlanDetail.test.tsx — render-tier coverage for the plan-detail main pane.
 * The data comes from usePlan (+ usePlanLock / usePlanLint / usePlanRevisions
 * from ./plans-api) and a featuresConsolidated.byPlanSlug sync query; all are
 * mocked here so the four load branches (loading / error+Retry / no-data /
 * loaded), the legacy-vs-normal split, the Now hero, the frontmatter card, and
 * the read→edit toggle render in isolation. The heavy editor/action/panel
 * children are stubbed to inert nodes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// usePlan drives the load branches; the other hooks/fetchers are inert.
let planResult: {
  data: unknown;
  loading: boolean;
  error: string | null;
};
const refreshSpy = vi.fn();
const setDataSpy = vi.fn();

vi.mock('./plans-api', () => ({
  usePlan: () => ({ ...planResult, refresh: refreshSpy, setData: setDataSpy }),
  usePlanLock: () => ({ data: null }),
  usePlanLint: () => ({ data: null }),
  usePlanRevisions: () => ({ data: [], loading: false }),
  setPlanContent: vi.fn(async () => ({ ok: true })),
  staleConflictOf: () => null,
  writeErrorOf: () => null,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [], error: null, fetching: false, loading: false, invalidate: vi.fn() }),
}));

// Heavy / Vditor / IPC children — stub to inert nodes (their own tests cover them).
vi.mock('./PlanEditor', () => ({ default: () => <div data-testid="plan-editor" /> }));
vi.mock('./PlanJumpToItem', () => ({ default: () => null }));
vi.mock('./LockBanner', () => ({ default: () => null }));
vi.mock('./LintBanner', () => ({ default: () => null }));
vi.mock('./PlanActions', () => ({ default: () => <div data-testid="plan-actions" /> }));
vi.mock('./AssignDialog', () => ({ default: () => null }));
vi.mock('./RevisionsPanel', () => ({ default: () => null }));
vi.mock('./RevisionDiffModal', () => ({ default: () => null }));
vi.mock('./RevisionConversationModal', () => ({ default: () => null }));
vi.mock('./AgentsPanel', () => ({ default: () => null }));
vi.mock('./RunsPanel', () => ({ default: () => null }));
vi.mock('./PlanConflictModal', () => ({ default: () => null }));
vi.mock('./PlanKanbanView', () => ({ default: () => null }));
vi.mock('./PlanStatusPopover', () => ({
  default: () => null,
  resolveItemId: () => null,
}));
vi.mock('../../_components/AuthorBadge', () => ({ AuthorBadge: () => null }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }),
}));

import PlanDetail from './PlanDetail';

function renderDetail(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

function mkPlan(over: Record<string, unknown> = {}) {
  return {
    slug: 'my-plan',
    archived: false,
    legacy: false,
    frontmatter: { title: 'My Plan', status: 'active' },
    now: null,
    items: [],
    decisions: [],
    raw: '# My Plan\n\nbody',
    contentHash: 'h1',
    version: 1,
    ...over,
  };
}

beforeEach(() => {
  planResult = { data: null, loading: false, error: null };
  refreshSpy.mockClear();
  setDataSpy.mockClear();
});
afterEach(cleanup);

describe('PlanDetail (plan-detail main pane)', () => {
  it('renders the loading state with the slug', () => {
    planResult = { data: null, loading: true, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Loading my-plan/)).toBeTruthy();
  });

  it('renders the error state and Retry calls refresh', () => {
    planResult = { data: null, loading: false, error: 'kaboom' };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Failed to load plan/)).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('renders the no-data placeholder when data is null and not loading', () => {
    planResult = { data: null, loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('No data.')).toBeTruthy();
  });

  it('surfaces a server error embedded in the data', () => {
    planResult = { data: { error: 'plan_not_found' }, loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Server: plan_not_found/)).toBeTruthy();
  });

  it('renders a loaded plan: title, editor, and the structured-action strip', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    // Heading uses the frontmatter title.
    expect(screen.getByRole('heading', { name: 'My Plan' })).toBeTruthy();
    expect(screen.getByTestId('plan-editor')).toBeTruthy();
    // Non-legacy plans get the PlanActions strip + an Edit toggle.
    expect(screen.getByTestId('plan-actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
  });

  it('renders the Now hero when the plan has a ## Now block', () => {
    planResult = {
      data: mkPlan({ now: { state: 'Halfway through', next: 'Ship the editor' } }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('Halfway through')).toBeTruthy();
    expect(screen.getByText('Ship the editor')).toBeTruthy();
  });

  it('renders the legacy banner and omits PlanActions for a legacy plan', () => {
    planResult = {
      data: mkPlan({ legacy: true, frontmatter: undefined }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Legacy plan/)).toBeTruthy();
    // No action strip / edit toggle for a legacy plan.
    expect(screen.queryByTestId('plan-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('shows the "← All plans" back button by default and fires onClose', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    const onClose = vi.fn();
    renderDetail(<PlanDetail slug="my-plan" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /All plans/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the back button when showBack is false', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} showBack={false} />);
    expect(screen.queryByRole('button', { name: /All plans/ })).toBeNull();
  });

  it('shows the source pill (you) for a user-authored draft', () => {
    planResult = {
      data: mkPlan({ frontmatter: { title: 'Draft Plan', status: 'draft' } }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('you')).toBeTruthy();
  });

  it('renders the editor in edit mode when ?pane=edit', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />, '?pane=edit');
    // The EditBar Save button is present in edit mode.
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
