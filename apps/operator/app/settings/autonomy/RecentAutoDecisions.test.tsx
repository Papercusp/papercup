// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */

let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, fetching: false, invalidate: vi.fn() }),
}));

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
    // No revert handle → no undo affordance.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows a (currently disabled) Undo button only when a revert handle is present', () => {
    syncResult = { data: [decision({ revertHandle: 'rev-abc123' })], loading: false, error: null };
    render(<RecentAutoDecisions />);
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undo).toBeTruthy();
    // The revert ACTION is B-16's (P-080) — the button is present but inert until then.
    expect(undo.disabled).toBe(true);
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
