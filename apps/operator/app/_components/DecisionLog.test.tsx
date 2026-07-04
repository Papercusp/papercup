// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Lexicon resolver echoes its key (t('brain') → 'brain') — isolates the routed
// undo-tooltip copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import DecisionLog from './DecisionLog';

/** Render under a nuqs testing adapter (DecisionLog reads `?decision=<id>` for
 *  the expanded row). `searchParams` seeds the URL for deep-link cases. */
function renderLog(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

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
    renderLog(<DecisionLog title="Queen's log" emptyText="Nothing yet." />);
    expect(screen.getByRole('heading', { name: /Queen's log/i })).toBeTruthy();
    expect(screen.getByText(/Nothing yet\./i)).toBeTruthy();
  });

  it('renders a disposition row (label, category, posture, why)', () => {
    syncResult = { data: [decision()], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" />);
    expect(screen.getByText('Acted')).toBeTruthy(); // disposition act → "Acted"
    expect(screen.getByText('work-prioritization')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy(); // posture auto → "Auto"
    expect(screen.getByText(/Reranked the backlog/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('action-layer row with no disposition shows the posture as the primary label', () => {
    syncResult = { data: [decision({ disposition: null, posture: 'gated' })], loading: false, error: null };
    renderLog(<DecisionLog layer="action" title="Actions" />);
    // posture 'gated' → "Gated" used as the primary label AND the chip (≥1 match)
    expect(screen.getAllByText('Gated').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Undo only when a tripwireId is present', () => {
    syncResult = { data: [decision({ tripwireId: 'tw-abc' })], loading: false, error: null };
    renderLog(<DecisionLog title="x" />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  /* ── EI: click-to-expand a row for its full detail ─────────────────── */

  it('expands a row on click to reveal full detail, and collapses on a second click', () => {
    syncResult = { data: [decision()], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" />);

    // Collapsed: detail-only fields (Reversibility / Authority) are absent.
    expect(screen.queryByText('Reversibility')).toBeNull();
    expect(screen.queryByText('Authority')).toBeNull();

    const summary = screen.getByRole('button', { expanded: false });
    fireEvent.click(summary);

    // Expanded: the detail fields + full why are now shown.
    expect(screen.getByText('Reversibility')).toBeTruthy();
    expect(screen.getByText('reversible')).toBeTruthy();
    expect(screen.getByText('Authority')).toBeTruthy();
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('Reversibility')).toBeNull();
  });

  it('deep-links the expanded row from ?decision=<id>', () => {
    syncResult = { data: [decision({ id: 7 })], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" />, '?decision=7');
    expect(screen.getByText('Reversibility')).toBeTruthy();
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });

  /* ── external-detail mode (queue 3-pane, P-004): detail in the right pane ── */

  it('onSelectRow: a click reports the row to the parent and suppresses the inline expand', () => {
    const onSelectRow = vi.fn();
    syncResult = { data: [decision({ id: 5 })], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" onSelectRow={onSelectRow} />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // The parent is told which row to render in the shared right pane…
    expect(onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
    // …and the inline detail is NOT rendered here (it lives in the right pane).
    expect(screen.queryByText('Reversibility')).toBeNull();
  });

  it('onSelectRow: a ?decision= deep-link reports the row to the parent (no inline detail)', () => {
    const onSelectRow = vi.fn();
    syncResult = { data: [decision({ id: 9 })], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" onSelectRow={onSelectRow} />, '?decision=9');
    expect(onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    expect(screen.queryByText('Reversibility')).toBeNull();
  });

  it('clicking Undo does not expand the row', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    syncResult = { data: [decision({ tripwireId: 'tw-abc' })], loading: false, error: null };
    renderLog(<DecisionLog title="x" />);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // Row stays collapsed — the Undo click must not bubble into the row toggle.
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(screen.queryByText('Reversibility')).toBeNull();
    vi.unstubAllGlobals();
  });

  /* ── externalDetail (queue 3-pane): parent renders detail from ?decision= ── */

  it('externalDetail suppresses the inline detail on click (parent owns the right pane)', () => {
    syncResult = { data: [decision({ id: 5 })], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" externalDetail />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // The click selects the row (?decision=) but the inline accordion stays
    // closed — the detail is rendered externally from the URL by the parent.
    expect(screen.queryByText('Reversibility')).toBeNull();
  });

  it('externalDetail suppresses the inline detail on a ?decision= deep-link', () => {
    syncResult = { data: [decision({ id: 9 })], loading: false, error: null };
    renderLog(<DecisionLog title="Queen's log" externalDetail />, '?decision=9');
    expect(screen.queryByText('Reversibility')).toBeNull();
  });
});
