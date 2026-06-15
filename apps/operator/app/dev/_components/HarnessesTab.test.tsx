// @vitest-environment jsdom
//
// HarnessesTab — the cross-workspace harness health matrix. Its only genuine
// pure logic is fmtAge, the "last run" age formatter shared by the matrix's
// Last-run column (it tolerates null/undefined for harnesses that never ran).
// fmtAge is extracted + exported and pinned at its s/m/h/d boundaries + the
// null case. The render-level tests below drive the three fetch states
// (loading / error / populated) through a stubbed fetch + a RichGrid mock that
// surfaces the row count, since a runtime bug in the fetch-shape unwrap or the
// loading/error gating would never show up in the pure-fn tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// RichGrid mock surfaces the row count so we can assert the populated branch
// actually handed parsed rows through (not just that *some* grid rendered).
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="grid" data-rows={rows.length} />
  ),
}));

import HarnessesTab, { fmtAge } from './HarnessesTab';

describe('fmtAge', () => {
  it('renders an em dash for null / undefined (never ran)', () => {
    expect(fmtAge(null)).toBe('—');
    expect(fmtAge(undefined)).toBe('—');
  });
  it('renders seconds under a minute', () => {
    expect(fmtAge(0)).toBe('0s');
    expect(fmtAge(45)).toBe('45s');
  });
  it('renders whole minutes / hours / days at each boundary', () => {
    expect(fmtAge(90)).toBe('1m');
    expect(fmtAge(2 * 3600)).toBe('2h');
    expect(fmtAge(3 * 86400)).toBe('3d');
  });
});

// The tab unwraps the MCP envelope: r.json() → d.content[0].text → JSON.parse →
// .harnesses. A wrong unwrap path or missing loading/error gate is the class of
// bug the pure-fn test can't see, so render each state for real.
describe('<HarnessesTab /> fetch states', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const envelope = (payload: unknown) =>
    ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(payload) }] }) }) as Response;

  it('shows the loading placeholder before the fetch resolves', () => {
    // Never-resolving fetch keeps the tab in its loading state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<HarnessesTab workspaceIds={null} />);
    expect(screen.getByText('loading…')).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the grid with the parsed harness rows once loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        envelope({
          harnesses: [
            { slug: 'a', path: '/a', workspaceId: 'w1', workspaceName: 'W1' },
            { slug: 'b', path: '/b', workspaceId: 'w1', workspaceName: 'W1' },
          ],
        }),
      ),
    );
    render(<HarnessesTab workspaceIds={['w1']} />);
    const grid = await screen.findByTestId('grid');
    expect(grid.getAttribute('data-rows')).toBe('2');
    // The header count reflects the loaded rows.
    expect(screen.getByText('2 across selected workspaces')).toBeTruthy();
    expect(screen.queryByText('loading…')).toBeNull();
  });

  it('renders the error message on a non-ok response (and never shows the grid)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    render(<HarnessesTab workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('HTTP 503')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
    expect(screen.queryByText('loading…')).toBeNull();
  });

  it('treats a missing harnesses array as empty (header reads 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({})));
    render(<HarnessesTab workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('0 across selected workspaces')).toBeTruthy());
    expect(screen.getByTestId('grid').getAttribute('data-rows')).toBe('0');
  });
});
