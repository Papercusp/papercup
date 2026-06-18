// @vitest-environment jsdom
//
// Regression for the "stuck Add-a-Hive modal" (CreateHarnessPicker): closing the
// modal must clear TWO url keys at once — ?create (open) and ?picker (step). Over
// the REAL custom adapter (nuqs-tanstack-router-adapter), two SEPARATE same-tick
// useQueryState writes CLOBBER each other (the adapter re-derives every watched
// key from the last navigate's snapshot), and awaiting them does NOT serialize
// (the setter resolves before the startTransition→navigate lands). The proven
// fix is a SINGLE useQueryStates write — one navigate, no race. The picker now
// routes every multi-key transition through one useQueryStates; this pins the
// pattern so a future "just call the two setters" regression is caught.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { useQueryState, useQueryStates, parseAsBoolean, parseAsString } from 'nuqs';
import { NuqsAdapter } from './nuqs-tanstack-router-adapter';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function mountAt(url: string, ui: React.ReactNode) {
  window.history.replaceState(null, '', url);
  const rootRoute = createRootRoute({
    component: () => (
      <NuqsAdapter>
        {ui}
        <Outlet />
      </NuqsAdapter>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <div /> });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });
  render(<RouterProvider router={router} />);
}

// THE FIX PATTERN: one useQueryStates → one navigate → both keys land.
function CombinedHook() {
  const [, set] = useQueryStates({ open: parseAsBoolean.withDefault(false), step: parseAsString });
  return (
    <button data-testid="close" onClick={() => void set({ open: false, step: null })}>
      close
    </button>
  );
}

// THE FOOTGUN: two separate hooks written same-tick (what the picker did before).
function TwoSeparateHooks() {
  const [, setOpen] = useQueryState('open', parseAsBoolean.withDefault(false));
  const [, setStep] = useQueryState('step', parseAsString);
  return (
    <button
      data-testid="close"
      onClick={() => {
        void setStep(null);
        void setOpen(false);
      }}
    >
      close
    </button>
  );
}

describe('nuqs custom-adapter multi-key write (CreateHarnessPicker close regression)', () => {
  it('a single useQueryStates write clears BOTH keys atomically (the fix)', async () => {
    mountAt('/?open=true&step=github', <CombinedHook />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await waitFor(() => expect(window.location.search).not.toContain('open=true'));
    expect(window.location.search).not.toContain('step=');
  });

  it('two SEPARATE same-tick setters CLOBBER (documents why the picker must not do this)', async () => {
    mountAt('/?open=true&step=github', <TwoSeparateHooks />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await new Promise((r) => setTimeout(r, 60));
    // ?step cleared but ?open SURVIVES — the exact stuck-modal failure mode. If a
    // future adapter change makes separate writes safe, this flips and we can
    // simplify the picker; until then, the single-useQueryStates pattern is required.
    expect(window.location.search).not.toContain('step=');
    expect(window.location.search).toContain('open=true');
  });
});
