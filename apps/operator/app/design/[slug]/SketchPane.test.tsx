// @vitest-environment jsdom
//
// SketchPane — the design-tab freehand sketch canvas. Real render logic
// exercised: the "pick a feature" guard (featureId null), and the toolbar +
// prior-sketches surface once a feature is selected (tool select via the
// ?sketchTool nuqs param, Undo disabled with an empty history, prior-sketch
// list from a mocked query). The canvas 2d drawing itself needs a real canvas
// backend, so it's left to e2e. fetch is mocked; react-query client per render.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no real canvas backend; the component guards `if (!ctx) return`, so
// a null-returning getContext is a faithful stand-in — and it keeps jsdom from
// logging its "getContext not implemented" notice.
beforeAll(() => {
  if (!HTMLCanvasElement.prototype.getContext || (HTMLCanvasElement.prototype.getContext as { _stubbed?: boolean })._stubbed !== true) {
    const stub = Object.assign(() => null, { _stubbed: true });
    HTMLCanvasElement.prototype.getContext = stub as unknown as HTMLCanvasElement['getContext'];
  }
});

const { feed } = vi.hoisted(() => ({ feed: { sketches: [] as unknown[] } }));

function stubSketches() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => feed })) as unknown as typeof fetch,
  );
}

import SketchPane from './SketchPane';

function renderPane(featureId: string | null, searchParams = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SketchPane slug="my-harness" featureId={featureId} />
    </QueryClientProvider>,
    { wrapper: withNuqsTestingAdapter({ searchParams }) },
  );
}

beforeEach(() => {
  feed.sketches = [];
  stubSketches();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<SketchPane />', () => {
  it('prompts to pick a feature when none is selected', () => {
    renderPane(null);
    expect(screen.getByText(/Pick a feature on the left to sketch/i)).toBeTruthy();
  });

  it('renders the sketch toolbar + canvas once a feature is selected', async () => {
    renderPane('F-1');
    expect(screen.getByText('Sketch')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Eraser/ })).toBeTruthy();
    expect(screen.getByText('Save sketch')).toBeTruthy();
  });

  it('disables Undo when the history is empty', () => {
    renderPane('F-1');
    expect((screen.getByRole('button', { name: /Undo/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reflects the ?sketchTool=eraser selection in the toolbar', () => {
    renderPane('F-1', '?sketchTool=eraser');
    expect((screen.getByRole('button', { name: /Eraser/ }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: /Pen/ }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the prior-sketches empty state, then lists fetched sketches', async () => {
    renderPane('F-1');
    await waitFor(() => expect(screen.getByText('None yet.')).toBeTruthy());
  });

  it('lists prior sketches returned by the query', async () => {
    feed.sketches = [{ id: 's1', label: 'first idea', png: null, createdTs: 1_700_000_000_000 }];
    renderPane('F-1');
    await waitFor(() => expect(screen.getByText('first idea')).toBeTruthy());
  });
});
