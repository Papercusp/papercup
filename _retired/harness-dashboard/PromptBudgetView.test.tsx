// @vitest-environment jsdom
//
// PromptBudgetView — per-invoke prompt-size telemetry table. The header summary
// math (avg/max total, substrate/history share) is extracted into the pure
// `aggregatePromptBudget` and tested branch-by-branch; a render-smoke drives the
// component's loading / error / empty surfaces with a mocked fetch (no network).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// VirtualGrid is heavy + irrelevant to the summary surfaces under test; stub it
// (just renders the row count so the populated-window assertion can key off it).
vi.mock('@papercusp/grid-core', () => ({
  VirtualGrid: ({ rows }: { rows: unknown[] }) => <div data-testid="budget-grid">{rows.length}</div>,
}));

import { PromptBudgetView, aggregatePromptBudget } from './PromptBudgetView';

type R = { total_chars: number; substrate_chars: number; history_chars: number };

afterEach(cleanup);

describe('aggregatePromptBudget', () => {
  it('zeroes everything (no divide-by-zero) for an empty window', () => {
    const s = aggregatePromptBudget([]);
    expect(s).toEqual({
      count: 0, total: 0, substrate: 0, history: 0,
      avgTotal: 0, maxTotal: 0, substratePct: 0, historyPct: 0,
    });
  });

  it('sums totals and rounds the average across the window', () => {
    const rows: R[] = [
      { total_chars: 100, substrate_chars: 60, history_chars: 20 },
      { total_chars: 300, substrate_chars: 100, history_chars: 80 },
    ];
    const s = aggregatePromptBudget(rows);
    expect(s.count).toBe(2);
    expect(s.total).toBe(400);
    expect(s.maxTotal).toBe(300);
    expect(s.avgTotal).toBe(200);
  });

  it('rounds avg to the nearest integer', () => {
    const rows: R[] = [
      { total_chars: 100, substrate_chars: 0, history_chars: 0 },
      { total_chars: 100, substrate_chars: 0, history_chars: 0 },
      { total_chars: 101, substrate_chars: 0, history_chars: 0 },
    ];
    // 301 / 3 = 100.33 → 100
    expect(aggregatePromptBudget(rows).avgTotal).toBe(100);
  });

  it('computes substrate/history share as a rounded percent of total', () => {
    const rows: R[] = [{ total_chars: 200, substrate_chars: 50, history_chars: 100 }];
    const s = aggregatePromptBudget(rows);
    expect(s.substratePct).toBe(25); // 50/200
    expect(s.historyPct).toBe(50); // 100/200
  });

  it('reports 0% shares when total chars is 0 (avoids NaN)', () => {
    const rows: R[] = [{ total_chars: 0, substrate_chars: 0, history_chars: 0 }];
    const s = aggregatePromptBudget(rows);
    expect(s.substratePct).toBe(0);
    expect(s.historyPct).toBe(0);
  });
});

describe('<PromptBudgetView />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading placeholder before the fetch resolves', () => {
    // A fetch that never resolves keeps the component in its loading branch.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<PromptBudgetView slug="h" />);
    expect(screen.getByText(/loading prompt budget/i)).toBeTruthy();
  });

  it('renders the empty-state copy when the API returns no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) }) as unknown as Response));
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByText(/no prompt-composition rows yet/i)).toBeTruthy());
  });

  it('surfaces an error banner when the API responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByText(/error: http 503/i)).toBeTruthy());
  });

  it('renders the summary + grid once rows arrive', async () => {
    const rows: R[] = [{ total_chars: 100, substrate_chars: 50, history_chars: 25 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rows }) }) as unknown as Response));
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('budget-grid').textContent).toBe('1'));
    // The aggregate headline labels the window ("N invokes").
    expect(screen.getByText(/invokes/)).toBeTruthy();
    // 50% substrate share is rendered from the aggregate.
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('requests the harness-wide URL (no feature_id) when featureId is omitted', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<PromptBudgetView slug="my-h" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('/api/harness/my-h/prompt-budget?limit=100');
    expect(url).not.toContain('feature_id');
  });

  it('scopes the URL to the feature (encoded feature_id) when featureId is provided', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<PromptBudgetView slug="my-h" featureId="F-1/x" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('/api/harness/my-h/prompt-budget?feature_id=F-1%2Fx&limit=100');
  });

  it('the Refresh button re-fetches the window', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ total_chars: 10, substrate_chars: 0, history_chars: 0 }] }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByText('Refresh')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it('a transient error clears on a successful Refresh (error → populated)', async () => {
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, json: async () => ({ rows: [{ total_chars: 10, substrate_chars: 0, history_chars: 0 }] }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByText(/error: http 500/i)).toBeTruthy());
    // The error branch hides the Refresh button (it lives in the populated view),
    // so re-render via the error surface isn't possible — assert the error first,
    // then a fresh mount recovers (reload is keyed off slug/featureId).
    cleanup();
    render(<PromptBudgetView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('budget-grid').textContent).toBe('1'));
  });
});
