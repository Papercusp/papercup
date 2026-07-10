// @vitest-environment jsdom
//
// LearningPackCandidates render + decide coverage (consume-edges P-032 / B-11).
// The fleet→pack review strip: pending candidates with provenance, the draft
// expander, and the adopt/dismiss POST through /api/learning-packs/candidate-decide
// (adopt surfaces the "pack updated" hint; failures surface role=alert; the
// empty queue renders nothing). useSyncQuery + nuqs mocked, the pinned
// sibling pattern (LearningTab.test.tsx).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LearningPackCandidate } from '@papercusp/operator-core/lib/learning-packs/candidates';

const nuqsState: Record<string, unknown> = { lcand: '' };
const setLcand = vi.fn();
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqsState[key], setLcand],
  parseAsString: { withDefault: () => ({}) },
}));

const invalidate = vi.fn();
let candidates: LearningPackCandidate[] = [];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: candidates, invalidate }),
}));
// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot') — isolates the
// hives→pot routed tooltip from the THE_HIVE flag hook (restore-pot-lexicon P-006).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

const { default: LearningPackCandidates } = await import('./LearningPackCandidates');

const cand = (over: Partial<LearningPackCandidate> = {}): LearningPackCandidate => ({
  id: 'cand-1',
  signature: 'lock edit serialize',
  title: 'Coordinate shared-tree edits',
  draftText: 'Find how this project serializes concurrent edits before writing.',
  kind: 'feedback',
  appliesTo: ['any'],
  scopes: ['operator', 'harness:sheets'],
  recurrenceCount: 4,
  sourceItemIds: ['EI-1', 'EI-2'],
  status: 'pending',
  createdBy: 'recurrence-escalation',
  createdAt: new Date(0).toISOString(),
  ...over,
});

beforeEach(() => {
  nuqsState.lcand = '';
  candidates = [cand()];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('<LearningPackCandidates />', () => {
  it('renders nothing when the queue is empty', () => {
    candidates = [];
    const { container } = render(<LearningPackCandidates />);
    expect(container.firstChild).toBeNull();
  });

  it('renders pending candidates with provenance; ?lcand expands the draft', () => {
    render(<LearningPackCandidates />);
    expect(screen.getByText('Coordinate shared-tree edits')).toBeTruthy();
    expect(screen.getByText(/recurred 4× across operator, harness:sheets/)).toBeTruthy();
    expect(screen.getByText(/from EI-1, EI-2/)).toBeTruthy();
    // Draft hidden until the row is selected via the URL param.
    expect(screen.queryByText(/serializes concurrent edits/)).toBeNull();

    cleanup();
    nuqsState.lcand = 'cand-1';
    render(<LearningPackCandidates />);
    expect(screen.getByText(/serializes concurrent edits/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'hide draft' })).toBeTruthy();
  });

  it('adopt POSTs the decide route and surfaces the pack-updated hint', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, action: 'adopt', packId: 'fleet-lessons', packVersion: '0.0.3' }), {
        status: 200,
      }),
    );
    render(<LearningPackCandidates />);
    fireEvent.click(screen.getByRole('button', { name: 'adopt' }));
    await waitFor(() => expect(screen.getByText(/Adopted into fleet-lessons v0\.0\.3/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/learning-packs/candidate-decide',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'cand-1', action: 'adopt' }) }),
    );
    expect(invalidate).toHaveBeenCalled();
  });

  it('dismiss POSTs the decide route; a failed decide surfaces role=alert', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<LearningPackCandidates />);
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/learning-packs/candidate-decide',
      expect.objectContaining({ body: JSON.stringify({ id: 'cand-1', action: 'dismiss' }) }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, reason: 'not_pending' }), { status: 409 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'adopt' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not_pending'));
  });
});
