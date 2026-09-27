// @vitest-environment jsdom
//
// CreateHarnessPicker × REAL TanStack router + REAL custom nuqs adapter — the
// "stuck Add-a-Hive modal" regression. The picker close must clear TWO url keys
// at once (?create + ?picker); over the real clobbering adapter that only works
// as a SINGLE useQueryStates write. This drives the REAL picker (not a stub)
// wired exactly like AdvShell (open ⇐ ?create), opens it on a non-grid step, and
// closes via Escape — then asserts BOTH keys clear and the modal unmounts. With
// the old two-separate-writes close, ?create survived and the modal stuck open.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { NuqsAdapter } from '../../lib/nuqs-tanstack-router-adapter';

// ── Mock the picker's heavy leaf deps (their data layers are tested elsewhere) ──
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (k: string) => ({ pot: 'Hive', cupboard: 'Comb', hive: 'Hive' })[k] ?? k,
}));
vi.mock('@papercusp/sync', () => ({ onSyncBusEvent: () => () => {}, useSyncQuery: () => ({ data: undefined, error: undefined, isLoading: false }) }));
vi.mock('@/app/adv/harnesses/useViewer', () => ({ useViewer: () => ({ viewer: null }), isViewer: () => false }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/harness/EntryGithubSearchForm', () => ({ EntryGithubSearchForm: () => <div data-testid="gh-search" /> }));
vi.mock('@/app/harness/PublishPotCard', () => ({ PublishPotCard: () => <div /> }));
vi.mock('@/app/_components/HowSharingWorks', () => ({ HowSharingWorks: () => <div /> }));
// RouteLink's progress bar needs the app's ProgressProvider; the link itself is real.
vi.mock('@bprogress/react', () => ({
  useProgress: () => ({ set: () => {}, start: () => {}, stop: () => {} }),
}));

import { CreateHarnessPicker } from '@/app/harness/CreateHarnessPicker';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

// Wire the picker EXACTLY like AdvShell: the modal's open state IS ?create.
function PickerHost() {
  const [open, setOpen] = useQueryState('create', parseAsBoolean.withDefault(false));
  return (
    <CreateHarnessPicker open={open} onOpenChange={(o) => void setOpen(o)} onCreated={() => {}} hiveScope={null} hiveLabel="Hive" />
  );
}

function mountAt(url: string) {
  window.history.replaceState(null, '', url);
  const rootRoute = createRootRoute({
    component: () => (
      <NuqsAdapter>
        <PickerHost />
        <Outlet />
      </NuqsAdapter>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <div /> });
  const cupboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/cupboard',
    component: () => <div data-testid="cupboard-page" />,
  });
  render(<RouterProvider router={createRouter({ routeTree: rootRoute.addChildren([indexRoute, cupboardRoute]) })} />);
}

describe('CreateHarnessPicker close × real adapter (stuck-modal regression)', () => {
  it('Escape on a non-grid step clears BOTH ?create and ?picker; the modal unmounts', async () => {
    // Open on the hive-invite step → both keys are present (the two-key race).
    mountAt('/?create=true&picker=hive-invite');
    // The modal is open (its title renders).
    await waitFor(() => expect(screen.getByText('Add a Hive')).toBeTruthy());
    expect(window.location.search).toContain('create=true');
    expect(window.location.search).toContain('picker=hive-invite');

    // Close via Escape → handleClose → single atomic useQueryStates write.
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    // BOTH keys must clear (atomic) AND the modal must actually close.
    await waitFor(() => expect(window.location.search).not.toContain('create=true'));
    expect(window.location.search).not.toContain('picker=hive-invite');
    await waitFor(() => expect(screen.queryByText('Add a Hive')).toBeNull());
  });

  // EI-544: the E2E repro was specifically on the TOP-LEVEL PICKER GRID step
  // (?create=true, NO ?picker — the picker-step has no Cancel/Close button by
  // design and relies entirely on Escape/backdrop). The test above only covers
  // a NON-grid step (?picker=hive-invite); pin the grid-step case separately in
  // case the two steps ever diverge in how Modal/Radix mounts them.
  it('Escape on the TOP-LEVEL PICKER GRID (no ?picker) clears ?create; the modal unmounts', async () => {
    mountAt('/?create=true');
    // The grid step renders BOTH the (hidden) Dialog.Title AND the PickerStep's
    // own visible <h2>, both reading "Add a Hive" — getByText throws on the
    // ambiguous match; getByRole('heading', ...) resolves the visible <h2> only
    // (the Dialog.Title is display:none, so it never satisfies the heading role's
    // default accessibility-tree visibility filtering).
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add a Hive' })).toBeTruthy());
    expect(window.location.search).toContain('create=true');

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(window.location.search).not.toContain('create=true'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add a Hive' })).toBeNull());
  });

  // WI-10003268: "Browse the Comb" was a raw <a> (a 404 on the portal, which
  // has no /cupboard page). As a router link it must land on the real
  // /cupboard route with the modal closed.
  it('Browse the Comb navigates to /cupboard through the router and closes the modal', async () => {
    mountAt('/?create=true');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add a Hive' })).toBeTruthy());

    fireEvent.click(screen.getByText('Browse the Comb'));

    await waitFor(() => expect(screen.getByTestId('cupboard-page')).toBeTruthy());
    expect(window.location.pathname).toBe('/cupboard');
    expect(window.location.search).not.toContain('create=true');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add a Hive' })).toBeNull());
  });

  it('a backdrop click on the picker grid step also closes it', async () => {
    mountAt('/?create=true');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add a Hive' })).toBeTruthy());

    // Radix mounts the Overlay as the `data-anim="fade"` sibling ahead of the
    // Dialog.Content inside the Portal (document.body).
    const backdrop = Array.from(document.body.querySelectorAll('div')).find(
      (el) => el.getAttribute('data-anim') === 'fade',
    );
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);

    await waitFor(() => expect(window.location.search).not.toContain('create=true'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add a Hive' })).toBeNull());
  });
});
