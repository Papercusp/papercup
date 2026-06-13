// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */

let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import RecentAutoDecisions from './RecentAutoDecisions';

function decision(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    ts: new Date().toISOString(),
    layer: 'disposition',
    action: 'work_items:set_priority',
    category: 'work-prioritization',
    riskTier: 'low',
    reversibility: 'reversible',
    authority: 'system',
    posture: 'auto',
    disposition: 'act',
    why: 'Reranked the backlog by blocking-impact',
    revertHandle: null,
    tripwireId: null,
    links: null,
    metadata: null,
    ...over,
  };
}

beforeEach(() => {
  syncResult = { data: [], loading: false, error: null };
});
afterEach(cleanup);

describe('RecentAutoDecisions', () => {
  it('renders the empty state when no decisions are logged', () => {
    render(<RecentAutoDecisions />);
    expect(screen.getByRole('heading', { name: /Recent auto-decisions/i })).toBeTruthy();
    expect(screen.getByText(/No decisions logged yet/i)).toBeTruthy();
  });

  it('renders a disposition row with its label, category, posture and rationale', () => {
    syncResult = { data: [decision()], loading: false, error: null };
    render(<RecentAutoDecisions />);
    expect(screen.getByText('Acted')).toBeTruthy(); // disposition act → "Acted"
    expect(screen.getByText('work-prioritization')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy(); // posture auto → "Auto"
    expect(screen.getByText(/Reranked the backlog/i)).toBeTruthy();
    // No tripwireId → no undo affordance.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows an enabled Undo button only when a tripwireId is present', () => {
    syncResult = { data: [decision({ tripwireId: 'tw-abc123' })], loading: false, error: null };
    render(<RecentAutoDecisions />);
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undo).toBeTruthy();
    expect(undo.disabled).toBe(false);
  });

  it('clicking Undo posts the tripwireId to the revert route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, demoted: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      syncResult = { data: [decision({ tripwireId: 'tw-xyz' })], loading: false, error: null };
      render(<RecentAutoDecisions />);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/agent-mcp/autonomy-tripwire-revert');
      expect(JSON.parse(String(opts.body)).tripwireId).toBe('tw-xyz');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps each disposition kind to its human label', () => {
    syncResult = {
      data: [
        decision({ id: 1, disposition: 'defer' }),
        decision({ id: 2, disposition: 'route-to-research' }),
        decision({ id: 3, disposition: 'no-op' }),
      ],
      loading: false,
      error: null,
    };
    render(<RecentAutoDecisions />);
    expect(screen.getByText('Deferred')).toBeTruthy();
    expect(screen.getByText('Routed to research')).toBeTruthy();
    expect(screen.getByText('No-op')).toBeTruthy();
  });

  it('surfaces a load error', () => {
    syncResult = { data: [], loading: false, error: new Error('ledger offline') };
    render(<RecentAutoDecisions />);
    expect(screen.getByRole('alert').textContent).toMatch(/ledger offline/i);
  });
});
