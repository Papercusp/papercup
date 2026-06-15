// @vitest-environment jsdom
//
// RuntimeView — the plugin-runtime status board. The `on` column flattener
// `onText` (string | string[] → comma-joined string) is extracted + tested. A
// render-smoke (RichGrid stubbed to a faithful row dump) confirms the stat
// header, the empty-state copy per card, and that load-error rows surface their
// message.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// RichGrid is a windowed virtual grid that needs layout APIs jsdom lacks; render
// a plain table-ish dump of the rows so the data is still assertable.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: Record<string, unknown>[]; getRowId: (r: Record<string, unknown>) => string }) => (
    <div data-testid="grid">
      {rows.map((r) => (
        <div key={getRowId(r)} data-row>{JSON.stringify(r)}</div>
      ))}
    </div>
  ),
}));

import RuntimeView, { onText } from './RuntimeView';

const EMPTY = {
  loaded: 0,
  errors: 0,
  reactionRules: [],
  plugins: [],
  loadErrors: [],
  initializedPairs: [],
  registeredActions: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('onText', () => {
  it('passes a plain string through', () => {
    expect(onText('feature.created')).toBe('feature.created');
  });
  it('comma-joins an array of event names', () => {
    expect(onText(['a', 'b', 'c'])).toBe('a, b, c');
  });
  it('renders an empty array as an empty string', () => {
    expect(onText([])).toBe('');
  });
});

describe('<RuntimeView />', () => {
  it('renders the stat header from the status counts', () => {
    render(<RuntimeView status={{ ...EMPTY, loaded: 4, errors: 2, initializedPairs: ['cf::h1'] }} />);
    expect(screen.getByText('Loaded')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Load errors')).toBeTruthy();
  });

  it('shows the per-card empty states when nothing is loaded', () => {
    render(<RuntimeView status={EMPTY} />);
    expect(screen.getByText(/No plugins loaded\./i)).toBeTruthy();
    expect(screen.getByText(/No \(plugin, harness\) pair has been initialized/i)).toBeTruthy();
    expect(screen.getByText('None.')).toBeTruthy(); // load errors card
  });

  it('renders the plugins grid when plugins are present', () => {
    render(
      <RuntimeView
        status={{ ...EMPTY, loaded: 1, plugins: [{ name: 'cloudflare', version: '1.0.0', source: 'global' }] }}
      />,
    );
    expect(screen.getByText(/Loaded plugins \(1\)/)).toBeTruthy();
    expect(screen.getByTestId('grid').textContent).toContain('cloudflare');
  });

  it('surfaces a load-error message and its trimmed path', () => {
    render(
      <RuntimeView
        status={{ ...EMPTY, loadErrors: [{ error: 'boom failed to import', path: '/a/b/global-plugins/cf/index.js' }] }}
      />,
    );
    expect(screen.getByText('cf/index.js')).toBeTruthy();
    expect(screen.getByText(/boom failed to import/)).toBeTruthy();
  });

  it('Reset cache fetches the reset endpoint and swaps in the fresh status', async () => {
    // Start empty; the reset re-discovers a plugin, which the grid then shows.
    const fresh = { ...EMPTY, loaded: 1, plugins: [{ name: 'rediscovered', version: '2.0.0', source: 'global' }] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => fresh }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeView status={EMPTY} />);
    expect(screen.getByText('No plugins loaded.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reset cache' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plugins/runtime/status?reset=1', { cache: 'no-store' }));
    await waitFor(() => expect(screen.getByText(/Loaded plugins \(1\)/)).toBeTruthy());
    expect(screen.getByTestId('grid').textContent).toContain('rediscovered');
  });

  it('keeps the existing status when the reset request returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    render(<RuntimeView status={EMPTY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset cache' }));
    // Button returns to its idle label; the empty state is untouched.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset cache' })).toBeTruthy());
    expect(screen.getByText('No plugins loaded.')).toBeTruthy();
  });
});
