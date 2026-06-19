// @vitest-environment jsdom
/**
 * CanvasView.test.tsx — the brainstorm "canvas" layer wraps Excalidraw, hydrated
 * from the `harnessBrainstorm.byHarness` sync row and debounce-saving to
 * /api/harness/<slug>/brainstorm-canvas. Excalidraw is dynamically imported and
 * extremely heavy, so we mock the `@excalidraw/excalidraw` module (and its CSS)
 * to a marker. This asserts CanvasView's OWN logic:
 *   - the loading guard (`brainstormRows === undefined` → "loading canvas…");
 *   - the staging-vs-first row selection;
 *   - hydration into a default empty scene when the row has no canvas;
 *   - the loaded surface mounting (the dynamic Excalidraw child).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] | undefined };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: syncResult.data, loading: false, error: null, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
// Heavy whiteboard — stub the dynamic import target to a marker that echoes the
// background-color override CanvasView injects via initialData.appState.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ initialData }: { initialData: { appState?: { viewBackgroundColor?: string } } }) => (
    <div data-testid="excalidraw" data-bg={initialData?.appState?.viewBackgroundColor} />
  ),
}));

import { CanvasView } from './CanvasView';

function row(over: Record<string, unknown> = {}) {
  return { harnessSlug: 'h', phase: 'staging', content: '', canvas: null, mindmap: null, updatedAt: 1, ...over };
}

beforeEach(() => { syncResult = { data: undefined }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CanvasView (brainstorm canvas layer)', () => {
  it('shows the loading guard while the sync row is undefined', () => {
    syncResult = { data: undefined }; // still loading → loaded stays false
    render(<CanvasView slug="h" />);
    expect(screen.getByText(/loading canvas/i)).toBeTruthy();
    expect(screen.queryByTestId('excalidraw')).toBeNull();
  });

  it('hydrates into a default empty scene when the row carries no canvas', async () => {
    syncResult = { data: [row({ canvas: null })] };
    render(<CanvasView slug="h" />);
    // Dynamic Excalidraw resolves via Suspense → marker mounts.
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
    // CanvasView forces a transparent background over whatever scene loaded.
    expect(screen.getByTestId('excalidraw').getAttribute('data-bg')).toBe('transparent');
  });

  it('hydrates a persisted canvas scene from the staging row', async () => {
    const scene = { elements: [{ id: 'e1' }], appState: { viewBackgroundColor: '#fff' }, files: {} };
    syncResult = { data: [row({ phase: 'production', canvas: null }), row({ phase: 'staging', canvas: scene })] };
    render(<CanvasView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
    // Even a persisted bg is overridden to transparent (z-stacked layer).
    expect(screen.getByTestId('excalidraw').getAttribute('data-bg')).toBe('transparent');
  });

  it('an empty data array (no rows) still hydrates to the empty-scene surface', async () => {
    syncResult = { data: [] };
    render(<CanvasView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
  });
});
