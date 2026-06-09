/**
 * @vitest-environment jsdom
 *
 * Cupboard ToolsSection — the tool-level discovery view
 * (tool-distribution-granularity-2026-06-05 P-006 +
 * tool-distribution-discovery-2026-06-08 P-007).
 *
 * Pins the discovery contract on the rendered side:
 *   - rows render per tool with status + provider attribution + description;
 *   - an installable tool's Install button routes to its PROVIDING listing
 *     (D-005 — tools install via their unit, never in isolation);
 *   - the degraded banner appears when the Cupboard is unreachable;
 *   - the capability search box forwards `q`, the status filter forwards
 *     `status`, the category facets forward `category` + drive the callbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToolsSection, type ToolDiscoveryEntry } from '../ToolsSection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function payload(
  over: Partial<{
    tools: ToolDiscoveryEntry[];
    counts: { available: number; installable: number };
    categories: { name: string; count: number }[];
    cupboardReachable: boolean;
  }> = {},
) {
  return {
    tools: [
      {
        tool: 'coord:send',
        status: 'available',
        category: 'coord',
        description: 'send a message to a peer',
        provider: { kind: 'builtin', name: 'builtin' },
      },
      {
        tool: 'repomix.pack',
        status: 'available',
        category: 'repomix',
        provider: { kind: 'plugin', name: '@papercupai/repomix' },
        unit: { name: '@papercupai/repomix', kind: 'plugin', source: 'installed', version: '1.0.0' },
      },
      {
        tool: 'md.render',
        status: 'installable',
        category: 'md',
        provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
        unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', listingId: 'lst-1' },
      },
    ] as ToolDiscoveryEntry[],
    counts: { available: 2, installable: 1 },
    categories: [
      { name: 'coord', count: 1 },
      { name: 'md', count: 1 },
      { name: 'repomix', count: 1 },
    ],
    cupboardReachable: true,
    ...over,
  };
}

function stubFetch(body: unknown) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

function lastFetchUrl(): string {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]![0] as string;
}

function categoryChip(cat: string): HTMLElement {
  return screen.getAllByTestId('cupboard-tool-category').find((b) => b.getAttribute('data-cat') === cat)!;
}

function statusChip(status: string): HTMLElement {
  return screen.getAllByTestId('cupboard-tool-status-filter').find((b) => b.getAttribute('data-status') === status)!;
}

beforeEach(() => stubFetch(payload()));

describe('Cupboard ToolsSection', () => {
  it('renders a row per tool with status + provider attribution', async () => {
    render(<ToolsSection q="" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('cupboard-tool-row')).toHaveLength(3));
    const rows = screen.getAllByTestId('cupboard-tool-row');
    expect(rows.map((r) => r.getAttribute('data-tool'))).toEqual(['coord:send', 'repomix.pack', 'md.render']);
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['available', 'available', 'installable']);
    expect(screen.getByTestId('cupboard-tools-counts').textContent).toContain('2 available · 1 installable');
  });

  it('renders a tool capability description line', async () => {
    render(<ToolsSection q="" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getByText('send a message to a peer')).toBeTruthy());
  });

  it('routes an installable tool to its providing listing', async () => {
    const onOpenListing = vi.fn();
    render(<ToolsSection q="" onOpenListing={onOpenListing} />);
    await waitFor(() => expect(screen.getAllByTestId('cupboard-tool-install')).toHaveLength(1));
    screen.getByTestId('cupboard-tool-install').click();
    expect(onOpenListing).toHaveBeenCalledWith('lst-1');
  });

  it('shows the degraded banner when the Cupboard is unreachable', async () => {
    stubFetch(payload({ cupboardReachable: false }));
    render(<ToolsSection q="" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-tools-degraded')).toBeTruthy());
  });

  it('forwards the shared search text as the q param', async () => {
    render(<ToolsSection q="repomix" onOpenListing={() => {}} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(lastFetchUrl()).toContain('/api/cupboard/tools?');
    expect(lastFetchUrl()).toContain('q=repomix');
  });

  it('renders the empty state when no tools match', async () => {
    stubFetch(payload({ tools: [], counts: { available: 0, installable: 0 }, categories: [] }));
    render(<ToolsSection q="zzz" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No tools found/)).toBeTruthy());
  });

  it('renders category facet chips from the payload (+ an All chip)', async () => {
    render(<ToolsSection q="" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('cupboard-tool-category').length).toBeGreaterThan(0));
    const cats = screen.getAllByTestId('cupboard-tool-category').map((b) => b.getAttribute('data-cat'));
    expect(cats).toEqual(['all', 'coord', 'md', 'repomix']);
  });

  it('clicking a category facet drives onCategoryChange', async () => {
    const onCategoryChange = vi.fn();
    render(<ToolsSection q="" onOpenListing={() => {}} onCategoryChange={onCategoryChange} />);
    await waitFor(() => expect(categoryChip('md')).toBeTruthy());
    categoryChip('md').click();
    expect(onCategoryChange).toHaveBeenCalledWith('md');
  });

  it('clicking the active category again clears it', async () => {
    const onCategoryChange = vi.fn();
    render(<ToolsSection q="" onOpenListing={() => {}} category="md" onCategoryChange={onCategoryChange} />);
    await waitFor(() => expect(categoryChip('md')).toBeTruthy());
    categoryChip('md').click();
    expect(onCategoryChange).toHaveBeenCalledWith(null);
  });

  it('clicking a status filter drives onStatusChange', async () => {
    const onStatusChange = vi.fn();
    render(<ToolsSection q="" onOpenListing={() => {}} onStatusChange={onStatusChange} />);
    await waitFor(() => expect(statusChip('installable')).toBeTruthy());
    statusChip('installable').click();
    expect(onStatusChange).toHaveBeenCalledWith('installable');
  });

  it('forwards the status + category filters as query params', async () => {
    render(<ToolsSection q="md" onOpenListing={() => {}} status="installable" category="md" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const url = lastFetchUrl();
    expect(url).toContain('q=md');
    expect(url).toContain('status=installable');
    expect(url).toContain('category=md');
  });
});
