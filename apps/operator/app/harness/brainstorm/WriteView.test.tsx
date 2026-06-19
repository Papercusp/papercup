// @vitest-environment jsdom
/**
 * WriteView.test.tsx — the brainstorm "write" layer is a BlockNote editor that
 * hydrates from the `harnessBrainstorm.byHarness` sync row and debounce-saves
 * to /api/harness/<slug>/brainstorm. The heavy editor (BlockNote + mantine) is
 * stubbed to a marker, so this exercises WriteView's OWN logic:
 *   - the `initialMd === null` loading guard;
 *   - hydration once the row arrives (loading → editor surface);
 *   - the staging-vs-first row selection (find phase==='staging');
 *   - the save-hint render branches driven by `onChange` → fetch.
 *
 * The mocked editor captures the `onChange` handler so we can fire a change and
 * drive the debounced save into its saving/saved/error states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, loading: false, error: null, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// CSS side-effect imports — alias to nothing so vitest doesn't choke.
vi.mock('@blocknote/core/fonts/inter.css', () => ({}));
vi.mock('@blocknote/mantine/style.css', () => ({}));

// The BlockNote editor: capture the registered onChange handler so the test can
// fire a content change and drive the save path.
let changeHandler: (() => void) | null = null;
const editorStub = {
  document: [],
  tryParseMarkdownToBlocks: vi.fn(async () => []),
  replaceBlocks: vi.fn(),
  blocksToMarkdownLossy: vi.fn(async () => 'edited markdown'),
  onChange: vi.fn((h: () => void) => { changeHandler = h; return () => {}; }),
};
vi.mock('@blocknote/react', () => ({
  useCreateBlockNote: () => editorStub,
}));
vi.mock('@blocknote/mantine', () => ({
  BlockNoteView: () => <div data-testid="blocknote" />,
}));

import { WriteView } from './WriteView';

function row(over: Record<string, unknown> = {}) {
  return { harnessSlug: 'h', phase: 'staging', content: '# notes', canvas: null, mindmap: null, updatedAt: 1, ...over };
}

beforeEach(() => {
  syncResult = { data: [] };
  changeHandler = null;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('WriteView (brainstorm write layer)', () => {
  it('shows the loading guard until a brainstorm row arrives', () => {
    syncResult = { data: [] }; // no row → brainstormRow undefined → initialMd null
    render(<WriteView slug="h" />);
    expect(screen.getByText(/loading brainstorm/i)).toBeTruthy();
    expect(screen.queryByTestId('blocknote')).toBeNull();
  });

  it('hydrates the editor once the row arrives (loading guard clears)', async () => {
    syncResult = { data: [row({ content: '# hello' })] };
    render(<WriteView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('blocknote')).toBeTruthy());
    expect(screen.queryByText(/loading brainstorm/i)).toBeNull();
    // Non-empty markdown is parsed into blocks for the editor.
    expect(editorStub.tryParseMarkdownToBlocks).toHaveBeenCalledWith('# hello');
  });

  it('prefers the staging-phase row over other rows', async () => {
    syncResult = { data: [row({ phase: 'production', content: 'PROD' }), row({ phase: 'staging', content: 'STAGE' })] };
    render(<WriteView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('blocknote')).toBeTruthy());
    expect(editorStub.tryParseMarkdownToBlocks).toHaveBeenCalledWith('STAGE');
  });

  it('an empty-content row hydrates without attempting a markdown parse', async () => {
    syncResult = { data: [row({ content: '   ' })] };
    render(<WriteView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('blocknote')).toBeTruthy());
    expect(editorStub.tryParseMarkdownToBlocks).not.toHaveBeenCalled();
  });

  it('a content change triggers the debounced save and shows the "saved" hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'ok' }) as unknown as Response));
    syncResult = { data: [row({ content: '# initial' })] };
    render(<WriteView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('blocknote')).toBeTruthy());
    expect(changeHandler).toBeTruthy();

    await act(async () => { changeHandler!(); });
    // The debounced save (600ms) fires; wait for the PUT + the "saved" hint.
    await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy(), { timeout: 2000 });
    expect(fetch).toHaveBeenCalledWith('/api/harness/h/brainstorm', expect.objectContaining({ method: 'PUT' }));
  });

  it('a failed save surfaces the "save failed" hint and toasts the error', async () => {
    const { toast } = await import('sonner');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'boom' }) as unknown as Response));
    syncResult = { data: [row({ content: '# initial' })] };
    render(<WriteView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('blocknote')).toBeTruthy());

    await act(async () => { changeHandler!(); });
    await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy(), { timeout: 2000 });
    expect(toast.error).toHaveBeenCalled();
  });
});
