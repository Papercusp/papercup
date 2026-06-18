// @vitest-environment jsdom
//
// Regression guard: the "Add a Hive menu won't close AFTER creating a hive".
// A create writes ?slug=<new hive> on close. AdvShell has a [activeSlug] effect
// (resolveAdvHarnessSelection) that, when the new slug is NOT YET in the (stale)
// projects list, fires setScopeMode('all') — a SECOND nuqs write triggered BY
// the create's ?slug write. The ORIGINAL bug: over a clobbering adapter that
// second write re-derived all keys from a stale snapshot and RE-ADDED
// ?create=true → the modal reopened. That clobber is FIXED at the adapter
// (the partial-update path no longer re-derives stale keys — see the committed
// nuqs-two-write-race.router-integration.test.tsx), so the modal now stays
// closed even on the real create path. These tests guard against that
// regressing: the effect's second write must NOT bring ?create back.
import { afterEach, describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router';
import { useQueryState, useQueryStates, parseAsBoolean, parseAsString } from 'nuqs';
import { NuqsAdapter } from '../../lib/nuqs-tanstack-router-adapter';

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
  render(<RouterProvider router={createRouter({ routeTree: rootRoute.addChildren([indexRoute]) })} />);
}

// Mirrors AdvShell: the modal open ⇐ ?create, plus a [activeSlug] effect that
// moves to all-scope when the slug isn't a known project (the stale-projects window).
function AdvLike({ writeSlugOnCreate }: { writeSlugOnCreate: boolean }) {
  const [slug] = useQueryState('slug', parseAsString);
  const [, setScope] = useQueryState('scope', parseAsString);
  const [nav, setNav] = useQueryStates({
    create: parseAsBoolean.withDefault(false),
    picker: parseAsString,
    slug: parseAsString,
  });
  const KNOWN_PROJECTS = ['existing-hive']; // stale — does NOT include the new hive yet
  useEffect(() => {
    if (slug && !KNOWN_PROJECTS.includes(slug)) {
      void setScope('all'); // the SECOND write — AdvShell's resolveAdvHarnessSelection path
    }
  }, [slug, setScope]);
  return (
    <div>
      <div data-testid="open">{String(nav.create)}</div>
      <button
        data-testid="create"
        onClick={() =>
          void setNav(
            writeSlugOnCreate
              ? { create: false, picker: null, slug: 'new-hive' } // production behavior: close writes ?slug
              : { create: false, picker: null }, // alt path: don't write ?slug on close
          )
        }
      >
        create
      </button>
    </div>
  );
}

describe('picker create-completion close × AdvShell [activeSlug] effect', () => {
  it('writing ?slug on close does NOT let the effect reopen the modal (adapter no longer clobbers)', async () => {
    mountAt('/?create=true&picker=github-url', <AdvLike writeSlugOnCreate />);
    await waitFor(() => expect(window.location.search).toContain('create=true'));
    fireEvent.click(screen.getByTestId('create'));
    await new Promise((r) => setTimeout(r, 80)); // let the effect's setScope land
    // FIXED: the close clears ?create, and the effect's SECOND write (setScope)
    // no longer re-derives ?create from a stale snapshot — so the modal stays
    // closed. The legitimate writes still land (the new slug + all-scope).
    expect(window.location.search).not.toContain('create=true');
    expect(window.location.search).toContain('slug=new-hive');
    expect(window.location.search).toContain('scope=all');
  });

  it('FIX: NOT writing ?slug on close keeps the modal closed (no effect trigger)', async () => {
    mountAt('/?create=true&picker=github-url', <AdvLike writeSlugOnCreate={false} />);
    await waitFor(() => expect(window.location.search).toContain('create=true'));
    fireEvent.click(screen.getByTestId('create'));
    await new Promise((r) => setTimeout(r, 80));
    expect(window.location.search).not.toContain('create=true'); // stays closed
    expect(window.location.search).not.toContain('picker=');
  });
});
