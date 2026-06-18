// @vitest-environment jsdom
//
// Isolation repro for the "stuck Add-a-Hive modal": two nuqs writes from two
// DIFFERENT useQueryState hooks, fired together, over the REAL custom adapter
// (nuqs-tanstack-router-adapter) inside a real TanStack router. The picker's
// close does exactly this — clear ?picker AND ?create — and one write was lost,
// leaving ?create in the URL (modal stuck open). This test pins down which write
// pattern reliably lands BOTH so the picker fix can mirror it.
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

// Two SEPARATE hooks (like ?create in AdvShell + ?picker in the picker).
function TwoSeparateHooks({ mode }: { mode: 'sync' | 'await' }) {
  const [, setOpen] = useQueryState('open', parseAsBoolean.withDefault(false));
  const [, setStep] = useQueryState('step', parseAsString);
  return (
    <button
      data-testid="close"
      onClick={async () => {
        if (mode === 'await') {
          await setStep(null);
          await setOpen(false);
        } else {
          void setStep(null);
          void setOpen(false);
        }
      }}
    >
      close
    </button>
  );
}

// ONE combined hook (single atomic write).
function CombinedHook() {
  const [, set] = useQueryStates({ open: parseAsBoolean.withDefault(false), step: parseAsString });
  return (
    <button data-testid="close" onClick={() => void set({ open: false, step: null })}>
      close
    </button>
  );
}

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

describe('nuqs custom-adapter: two writes from different hooks', () => {
  it('SYNC two-hook close: does ?open clear alongside ?step? (reproduces the race if not)', async () => {
    mountAt('/?open=true&step=github', <TwoSeparateHooks mode="sync" />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    // give the router/transition time to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.search).not.toContain('step=');
    expect(window.location.search).not.toContain('open=true'); // ← the assertion the bug fails
  });

  it('AWAIT two-hook close: does awaiting serialize the two writes?', async () => {
    mountAt('/?open=true&step=github', <TwoSeparateHooks mode="await" />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.search).not.toContain('step=');
    expect(window.location.search).not.toContain('open=true');
  });

  it('COMBINED useQueryStates close: both keys clear atomically', async () => {
    mountAt('/?open=true&step=github', <CombinedHook />);
    await waitFor(() => expect(window.location.search).toContain('open=true'));
    fireEvent.click(screen.getByTestId('close'));
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.search).not.toContain('step=');
    expect(window.location.search).not.toContain('open=true');
  });
});
