// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DecisionLog from './DecisionLog';

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

describe('DecisionLog (queue-authorization-redesign P-003/P-006)', () => {
  it('renders the title + empty state', () => {
    render(<DecisionLog title="Queen's log" emptyText="Nothing yet." />);
    expect(screen.getByRole('heading', { name: /Queen's log/i })).toBeTruthy();
    expect(screen.getByText(/Nothing yet\./i)).toBeTruthy();
  });

  it('renders a disposition row (label, category, posture, why)', () => {
    syncResult = { data: [decision()], loading: false, error: null };
    render(<DecisionLog title="Queen's log" />);
    expect(screen.getByText('Acted')).toBeTruthy(); // disposition act → "Acted"
    expect(screen.getByText('work-prioritization')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy(); // posture auto → "Auto"
    expect(screen.getByText(/Reranked the backlog/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('action-layer row with no disposition shows the posture as the primary label', () => {
    syncResult = { data: [decision({ disposition: null, posture: 'gated' })], loading: false, error: null };
    render(<DecisionLog layer="action" title="Actions" />);
    // posture 'gated' → "Gated" used as the primary label AND the chip (≥1 match)
    expect(screen.getAllByText('Gated').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Undo only when a tripwireId is present', () => {
    syncResult = { data: [decision({ tripwireId: 'tw-abc' })], loading: false, error: null };
    render(<DecisionLog title="x" />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });
});
