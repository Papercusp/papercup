// @vitest-environment jsdom
//
// SketchPane — the design-tab freehand sketch canvas. Real render logic
// exercised: the "pick a feature" guard (featureId null), and the toolbar +
// prior-sketches surface once a feature is selected (tool select via the
// ?sketchTool nuqs param, Undo disabled with an empty history, prior-sketch
// list from a mocked sync query). The canvas 2d drawing itself needs a real
// canvas backend, so it's left to e2e.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

// jsdom has no real canvas backend; the component guards `if (!ctx) return`, so
// a null-returning getContext is a faithful stand-in — and it keeps jsdom from
// logging its "getContext not implemented" notice.
beforeAll(() => {
  if (!HTMLCanvasElement.prototype.getContext || (HTMLCanvasElement.prototype.getContext as { _stubbed?: boolean })._stubbed !== true) {
    const stub = Object.assign(() => null, { _stubbed: true });
    HTMLCanvasElement.prototype.getContext = stub as unknown as HTMLCanvasElement['getContext'];
  }
});

const { syncRows, invalidateMock } = vi.hoisted(() => ({
  syncRows: { sketches: [] as unknown[] },
  invalidateMock: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: syncRows.sketches,
    loading: false,
    fetching: false,
    error: null,
    transport: 'SSE',
    invalidate: invalidateMock,
  }),
}));

import SketchPane from './SketchPane';

function renderPane(featureId: string | null, searchParams = '') {
  return render(<SketchPane slug="my-harness" featureId={featureId} />, {
    wrapper: withNuqsTestingAdapter({ searchParams }),
  });
}

beforeEach(() => {
  syncRows.sketches = [];
  invalidateMock.mockClear();
});
afterEach(() => {
  cleanup();
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
    syncRows.sketches = [{ id: 's1', label: 'first idea', png: null, createdTs: 1_700_000_000_000 }];
    renderPane('F-1');
    await waitFor(() => expect(screen.getByText('first idea')).toBeTruthy());
  });

  it('clicking Eraser switches the active tool (aria-pressed flips) and disables the color picker', async () => {
    renderPane('F-1'); // defaults to pen
    const pen = screen.getByRole('button', { name: /Pen/ });
    const eraser = screen.getByRole('button', { name: /Eraser/ });
    expect(pen.getAttribute('aria-pressed')).toBe('true');
    // Color picker is enabled under the pen.
    expect((screen.getByLabelText('Stroke color') as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(eraser);
    await waitFor(() => expect(eraser.getAttribute('aria-pressed')).toBe('true'));
    expect(pen.getAttribute('aria-pressed')).toBe('false');
    // Eraser disables the stroke-color input.
    expect((screen.getByLabelText('Stroke color') as HTMLInputElement).disabled).toBe(true);

    // Switching back to pen re-enables it.
    fireEvent.click(pen);
    await waitFor(() => expect(pen.getAttribute('aria-pressed')).toBe('true'));
    expect((screen.getByLabelText('Stroke color') as HTMLInputElement).disabled).toBe(false);
  });
});
