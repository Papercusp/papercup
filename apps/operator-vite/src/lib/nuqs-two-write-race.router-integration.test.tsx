// @vitest-environment jsdom
//
// Regression for the "stuck Add-a-Hive modal" (CreateHarnessPicker): closing the
// modal must clear TWO url keys at once — ?create (open) and ?picker (step).
// History: over the OLD custom adapter, two SEPARATE same-tick useQueryState
// writes clobbered each other (the watchKeys-scoped merge-over-prev resurrected
// the OTHER hook's removed key — ?open survived, the stuck-modal bug). WI-3499
// (2026-07-17: unfiltered snapshot + wholesale updateUrl rebuild) fixed the
// adapter so separate same-tick removals are now SAFE — both keys land. Test 1
// pins the single-useQueryStates path (still preferred: one navigate); test 2
// now pins that even the two-separate-setter path clears BOTH keys, so a future
// adapter regression that reintroduces the clobber is caught.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return router;
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
  it('opening a popup does not re-render a consumer watching an unchanged key', async () => {
    const backgroundRender = vi.fn();
    function Background() {
      const [dock] = useQueryState('dock', parseAsString);
      backgroundRender(dock);
      return <div data-testid="background">{dock}</div>;
    }
    function Popup() {
      const [plan, setPlan] = useQueryState('wppop', parseAsString);
      return (
        <button data-testid="open-popup" onClick={() => void setPlan('papercusp::plan')}>
          {plan ?? 'closed'}
        </button>
      );
    }
    const router = mountAt('/?dock=plans', <><Background /><Popup /></>);
    await waitFor(() => expect(screen.getByTestId('background').textContent).toBe('plans'));
    await waitFor(() => expect(router.state.status).toBe('idle'));
    const before = backgroundRender.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-popup'));
    await waitFor(() => expect(window.location.search).toContain('wppop='));
    await waitFor(() => expect(router.state.status).toBe('idle'));
    expect(screen.getByTestId('open-popup').textContent).toBe('papercusp::plan');
    expect(backgroundRender.mock.calls.length).toBe(before);
  });

  it('a single useQueryStates write clears BOTH keys atomically (the fix)', async () => {
    mountAt('/?open=true&step=github', <CombinedHook />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await waitFor(() => expect(window.location.search).not.toContain('open=true'));
    expect(window.location.search).not.toContain('step=');
  });

  it('two SEPARATE same-tick setters now BOTH land (WI-3499 adapter fix made separate multi-key removals safe)', async () => {
    mountAt('/?open=true&step=github', <TwoSeparateHooks />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await new Promise((r) => setTimeout(r, 60));
    // BOTH keys clear — WI-3499's fix (unfiltered snapshot + wholesale updateUrl
    // rebuild) made two separate same-tick removals safe. Before the fix ?open
    // SURVIVED here (the stuck-modal bug); these assertions now GUARD that the
    // clobber cannot return. The single-useQueryStates pattern above is still
    // preferred (one navigate) but no longer required for correctness.
    expect(window.location.search).not.toContain('step=');
    expect(window.location.search).not.toContain('open=true');
  });
});
