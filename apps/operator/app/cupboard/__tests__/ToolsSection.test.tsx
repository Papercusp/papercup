/**
 * @vitest-environment jsdom
 *
 * Cupboard ToolsSection — the tool-level discovery view
 * (tool-distribution-granularity-2026-06-05 P-006).
 *
 * Pins the discovery contract on the rendered side:
 *   - rows render per tool with status + provider attribution;
 *   - an installable tool's Install button routes to its PROVIDING listing
 *     (D-005 — tools install via their unit, never in isolation);
 *   - the degraded banner appears when the Cupboard is unreachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToolsSection, type ToolDiscoveryEntry } from '../ToolsSection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function payload(over: Partial<{ tools: ToolDiscoveryEntry[]; counts: { available: number; installable: number }; cupboardReachable: boolean }> = {}) {
  return {
    tools: [
      {
        tool: 'coord:send',
        status: 'available',
        provider: { kind: 'builtin', name: 'builtin' },
      },
      {
        tool: 'repomix.pack',
        status: 'available',
        provider: { kind: 'plugin', name: '@papercupai/repomix' },
        unit: { name: '@papercupai/repomix', kind: 'plugin', source: 'installed', version: '1.0.0' },
      },
      {
        tool: 'md.render',
        status: 'installable',
        provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
        unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', listingId: 'lst-1' },
      },
    ] as ToolDiscoveryEntry[],
    counts: { available: 2, installable: 1 },
    cupboardReachable: true,
    ...over,
  };
}

function stubFetch(body: unknown) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
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
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('/api/cupboard/tools?');
    expect(url).toContain('q=repomix');
  });

  it('renders the empty state when no tools match', async () => {
    stubFetch(payload({ tools: [], counts: { available: 0, installable: 0 } }));
    render(<ToolsSection q="zzz" onOpenListing={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No tools found/)).toBeTruthy());
  });
});
