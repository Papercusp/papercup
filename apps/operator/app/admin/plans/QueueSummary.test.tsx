// @vitest-environment jsdom
/**
 * QueueSummary.test.tsx — render-tier coverage for the two-halves strip above
 * the Queue (queue-authorization-redesign P-006/B1): "{N} waiting on you ·
 * {M} handled by the Queen". The handled count reads the decision.ledger
 * disposition layer via useSyncQuery (mocked here); the waiting-on-you count is
 * passed in. Exercises the empty/populated/capped (HANDLED_CAP) branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, error: null, fetching: false, loading: false, invalidate: vi.fn() }),
}));

import QueueSummary from './QueueSummary';

// The Queen/brain term renders via the lexicon (t('brain')) as its own node, so
// "{N} handled by the Queen" is split across text nodes and a flat getByText()
// can't match it. Assert on the strip element's full textContent instead — this
// is split-agnostic (works whether the lexicon term is a string or an element)
// and still verifies the exact rendered label.
const handledBadge = (full: string) =>
  screen.getByText(
    (_content, el) =>
      el?.classList.contains('pc-queue__summary-queen') === true &&
      el?.textContent?.replace(/\s+/g, ' ').trim() === full,
  );

beforeEach(() => {
  syncResult = { data: [] };
});
afterEach(cleanup);

describe('QueueSummary (queue-authorization-redesign P-006/B1)', () => {
  it('renders the waiting-on-you count from the prop', () => {
    render(<QueueSummary waitingOnYou={4} />);
    expect(screen.getByText('4 waiting on you')).toBeTruthy();
  });

  it('shows 0 handled when the disposition ledger is empty', () => {
    syncResult = { data: [] };
    render(<QueueSummary waitingOnYou={0} />);
    expect(screen.getByText('0 waiting on you')).toBeTruthy();
    expect(handledBadge('0 handled by the Queen')).toBeTruthy();
  });

  it('counts the disposition rows the ledger returns', () => {
    syncResult = { data: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    render(<QueueSummary waitingOnYou={1} />);
    expect(handledBadge('3 handled by the Queen')).toBeTruthy();
  });

  it('caps the handled count at HANDLED_CAP with a "100+" label', () => {
    // The hook is capped at limit:100; a full page reads as the cap → "100+".
    syncResult = { data: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
    render(<QueueSummary waitingOnYou={7} />);
    expect(handledBadge('100+ handled by the Queen')).toBeTruthy();
  });

  it('renders the separator between the two halves', () => {
    render(<QueueSummary waitingOnYou={2} />);
    expect(screen.getByText('·')).toBeTruthy();
  });
});
