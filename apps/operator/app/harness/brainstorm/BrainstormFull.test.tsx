// @vitest-environment jsdom
/**
 * BrainstormFull.test.tsx — the brainstorm shell that z-stacks three editor
 * layers (write / map / canvas) plus the partner chat, switched by a subtab
 * chip group bound to the `brainstormTab` nuqs state.
 *
 * The three layer editors + the chat are heavy dynamic imports, so we stub all
 * four (and the Tooltip wrapper around the chips) to markers. This exercises
 * BrainstormFull's OWN logic:
 *   - the default active layer ('write') + the active caption;
 *   - the three subtabs (role=tab, aria-selected) and click → setActive (which
 *     writes `?brainstormTab=` and flips the caption);
 *   - the compact-vs-grid layout fork driven by matchMedia.
 *
 * matchMedia is shimmed (jsdom omits it); `?brainstormTab=` is async (nuqs), so
 * tab-switch assertions go through onUrlUpdate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from 'nuqs/adapters/testing';
import type { ReactElement, ReactNode } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Stub the four dynamic children to markers so no real editor/canvas mounts.
vi.mock('./WriteView', () => ({ WriteView: ({ slug }: { slug: string }) => <div data-testid="write" data-slug={slug} /> }));
vi.mock('./MapView', () => ({ MapView: ({ slug }: { slug: string }) => <div data-testid="map" data-slug={slug} /> }));
vi.mock('./CanvasView', () => ({ CanvasView: ({ slug }: { slug: string }) => <div data-testid="canvas" data-slug={slug} /> }));
vi.mock('./BrainstormChat', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="chat" data-slug={slug} /> }));
// Tooltip would need a TooltipProvider ancestor; pass children through.
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));

import { BrainstormFull } from './BrainstormFull';

/** matchMedia shim — `matches` is forced by the test to drive compact/grid. */
function installMatchMedia(matches: boolean) {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as (q: string) => MediaQueryList;
}

function renderFull(ui: ReactElement, searchParams = '', onUrlUpdate?: OnUrlUpdateFunction) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>{ui}</NuqsTestingAdapter>,
  );
}

beforeEach(() => { installMatchMedia(false); });
afterEach(cleanup);

describe('BrainstormFull (brainstorm shell)', () => {
  it('defaults to the write layer and renders all three stacked layers + the partner chat', async () => {
    renderFull(<BrainstormFull slug="hh" />);
    // The dynamic children resolve through Suspense — wait for the markers.
    await waitFor(() => expect(screen.getByTestId('write')).toBeTruthy());
    expect(screen.getByTestId('map')).toBeTruthy();
    expect(screen.getByTestId('canvas')).toBeTruthy();
    expect(screen.getByTestId('chat')).toBeTruthy();
    // The active layer's caption is shown (write → "shape the spec…").
    expect(screen.getByText(/shape the spec in rich notes/i)).toBeTruthy();
  });

  it('renders the three subtab buttons with the write tab selected by default', () => {
    renderFull(<BrainstormFull slug="hh" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(3);
    const write = screen.getByRole('tab', { name: /write/i });
    expect(write.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /map/i }).getAttribute('aria-selected')).toBe('false');
  });

  it('passes the slug down to every layer + the chat', async () => {
    renderFull(<BrainstormFull slug="proj-x" />);
    await waitFor(() => expect(screen.getByTestId('write').getAttribute('data-slug')).toBe('proj-x'));
    expect(screen.getByTestId('chat').getAttribute('data-slug')).toBe('proj-x');
  });

  it('clicking the map subtab writes ?brainstormTab=map', async () => {
    const onUrlUpdate = vi.fn();
    renderFull(<BrainstormFull slug="hh" />, '', onUrlUpdate);
    fireEvent.click(screen.getByRole('tab', { name: /map/i }));
    await waitFor(() => {
      const wrote = onUrlUpdate.mock.calls.some(([u]) => u.searchParams.get('brainstormTab') === 'map');
      expect(wrote).toBe(true);
    });
  });

  it('seeded with ?brainstormTab=canvas: the canvas tab is selected and its caption shown', () => {
    renderFull(<BrainstormFull slug="hh" />, '?brainstormTab=canvas');
    expect(screen.getByRole('tab', { name: /canvas/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/sketch flows, branches, ideas/i)).toBeTruthy();
  });

  it('compact viewport (matchMedia matches) renders the stacked layout, not the grid', () => {
    installMatchMedia(true);
    const { container } = renderFull(<BrainstormFull slug="hh" />);
    // Compact → .h-bsfull-stack wrapper; not the .h-bsfull-grid wrapper.
    expect(container.querySelector('.h-bsfull-stack')).toBeTruthy();
    expect(container.querySelector('.h-bsfull-grid')).toBeNull();
  });

  it('wide viewport (matchMedia does not match) renders the grid layout', () => {
    installMatchMedia(false);
    const { container } = renderFull(<BrainstormFull slug="hh" />);
    expect(container.querySelector('.h-bsfull-grid')).toBeTruthy();
    expect(container.querySelector('.h-bsfull-stack')).toBeNull();
  });
});
