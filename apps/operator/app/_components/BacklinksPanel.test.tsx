// @vitest-environment jsdom
//
// BacklinksPanel — lists wiki files that [[reference]] the current file, grepped
// at view-time via /api/wiki-backlinks. Real render logic: null when there's no
// target, the count in the header, the no-references empty state, and one
// linked row per hit (with an href that strips `.md` and the directory path).
// A render-smoke drives a mocked fetch; ?backlinks open-state via nuqs adapter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

import { BacklinksPanel } from './BacklinksPanel';

const HITS = [
  { harness: 'h1', filename: 'notes/knowledge.md', line: 12, snippet: 'see [[target]] here' },
  { harness: 'h2', filename: 'supervisor.md', line: 3, snippet: 'also [[target]]' },
];

function stubFetch(hits: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ hits }) })) as unknown as typeof fetch,
  );
}

beforeEach(() => stubFetch(HITS));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<BacklinksPanel />', () => {
  it('renders nothing when target is empty', () => {
    const { container } = render(<BacklinksPanel target="" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders the hit count in the header once loaded', async () => {
    render(<BacklinksPanel target="target" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    await waitFor(() => expect(screen.getByText(/Backlinks \(2\)/)).toBeTruthy());
  });

  it('renders a linked row per hit with harness + line metadata', async () => {
    render(<BacklinksPanel target="target" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    await waitFor(() => expect(screen.getByText('see [[target]] here')).toBeTruthy());
    // First hit's nested filename collapses to its basename and strips `.md`.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toContain('target=knowledge');
    expect(links[0].getAttribute('href')).toContain('harness=h1');
  });

  it('shows the no-references empty state when there are no hits', async () => {
    stubFetch([]);
    render(<BacklinksPanel target="lonely" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    await waitFor(() => expect(screen.getByText(/No files reference/i)).toBeTruthy());
  });

  it('hides the body when the panel is collapsed (?backlinks=false)', async () => {
    render(<BacklinksPanel target="target" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?backlinks=false' }),
    });
    // Header still renders the count; the hit rows do not.
    await waitFor(() => expect(screen.getByText(/Backlinks \(2\)/)).toBeTruthy());
    expect(screen.queryByText('see [[target]] here')).toBeNull();
  });

  it('the header button toggles the body open/closed', async () => {
    render(<BacklinksPanel target="target" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    // Default open → rows visible.
    await waitFor(() => expect(screen.getByText('see [[target]] here')).toBeTruthy());
    // Click the header → collapse → rows gone, count still shown.
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByText('see [[target]] here')).toBeNull());
    expect(screen.getByText(/Backlinks \(2\)/)).toBeTruthy();
    // Click again → re-expand.
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('see [[target]] here')).toBeTruthy());
  });

  it('falls back to the empty state (not a crash) when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    render(<BacklinksPanel target="lonely" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    // .catch sets hits to [] → the no-references empty state renders.
    await waitFor(() => expect(screen.getByText(/No files reference/i)).toBeTruthy());
    expect(screen.getByText(/Backlinks \(0\)/)).toBeTruthy();
  });

  it('threads the harness slug into the backlinks query', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ hits: [] }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<BacklinksPanel target="knowledge" harness="my-h" />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('target=knowledge');
    expect(url).toContain('harness=my-h');
  });
});
