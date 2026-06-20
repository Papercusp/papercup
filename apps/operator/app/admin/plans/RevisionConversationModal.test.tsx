// @vitest-environment jsdom
/**
 * RevisionConversationModal.test.tsx — the per-revision transcript drill-down +
 * its two exported pure helpers. Covers unavailableReason / rowSessionTag, and
 * the modal: closed when revisionId is null, the loaded-turns render (+ titled
 * by seq), the unavailable-reason and empty (incl. filtered) states, the error
 * state, query re-fetch, Load-more pagination, and close.
 *
 * Seams: @/app/harness/Modal stubbed to render children when open,
 * fetchPlanRevisionTranscript stubbed per call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-testid="modal">{children}</div> : null),
}));
let transcriptImpl: (args: { revisionId: number; query?: string; cursor?: number; limit: number }) => Promise<unknown>;
vi.mock('./plans-api', () => ({ fetchPlanRevisionTranscript: (a: never) => transcriptImpl(a) }));

import RevisionConversationModal, { unavailableReason, rowSessionTag } from './RevisionConversationModal';

const turn = (seq: number, content: string) => ({ seq, role: seq % 2 ? 'user' : 'assistant', content, createdAt: 1_700_000_000_000 });

describe('unavailableReason', () => {
  it('explains each unavailable reason', () => {
    expect(unavailableReason('no_session')).toMatch(/direct edit/i);
    expect(unavailableReason('git_backfill')).toMatch(/git history/i);
    expect(unavailableReason('session_kind_unsupported')).toMatch(/not yet readable/i);
  });
});

describe('rowSessionTag', () => {
  it('returns null for a drill-downable plan_run revision', () => {
    expect(rowSessionTag('sess-1', 'plan_run')).toBeNull();
  });
  it('tags git backfill and a plan_run missing its session', () => {
    expect(rowSessionTag(null, 'git_backfill')).toBe('from git history');
    expect(rowSessionTag(null, 'plan_run')).toBe('plan-run session missing');
  });
  it('tags reserved chat session kinds as not shown', () => {
    expect(rowSessionTag('s', 'operator_chat')).toBe('operator chat (not shown)');
    expect(rowSessionTag('s', 'agent_chat')).toBe('agent chat (not shown)');
  });
  it('falls back to direct edit', () => {
    expect(rowSessionTag(null, null)).toBe('direct edit');
  });
});

describe('RevisionConversationModal', () => {
  const onClose = vi.fn();
  function renderModal(revisionId: number | null) {
    return render(<RevisionConversationModal revisionId={revisionId} onClose={onClose} />);
  }
  beforeEach(() => {
    onClose.mockReset();
    transcriptImpl = async () => ({ available: true, turns: [turn(1, 'hello'), turn(2, 'hi there')], nextCursor: null, seq: 5 });
  });
  afterEach(cleanup);

  it('renders nothing when revisionId is null', () => {
    renderModal(null);
    expect(screen.queryByTestId('modal')).toBeNull();
  });

  it('loads and renders the transcript turns, titled by revision seq', async () => {
    renderModal(10);
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(screen.getByText(/Conversation behind revision #5/)).toBeTruthy();
  });

  it('shows the unavailable reason when the transcript is not drill-downable', async () => {
    transcriptImpl = async () => ({ available: false, reason: 'git_backfill' });
    renderModal(10);
    expect(await screen.findByText(/reconstructed from git history/i)).toBeTruthy();
  });

  it('shows the empty state when an available transcript has no turns', async () => {
    transcriptImpl = async () => ({ available: true, turns: [], nextCursor: null, seq: 5 });
    renderModal(10);
    expect(await screen.findByText('No turns in this conversation.')).toBeTruthy();
  });

  it('shows the filtered-empty message after a query that matches nothing', async () => {
    transcriptImpl = async ({ query }) =>
      query ? { available: true, turns: [], nextCursor: null, seq: 5 } : { available: true, turns: [turn(1, 'hello')], nextCursor: null, seq: 5 };
    renderModal(10);
    await screen.findByText('hello');
    fireEvent.change(screen.getByLabelText('Filter turns by substring'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No turns match this filter.')).toBeTruthy();
  });

  it('surfaces a fetch error', async () => {
    transcriptImpl = async () => { throw new Error('kaboom'); };
    renderModal(10);
    expect(await screen.findByText('kaboom')).toBeTruthy();
  });

  it('paginates with Load more', async () => {
    transcriptImpl = async ({ cursor }) =>
      cursor === undefined
        ? { available: true, turns: [turn(1, 'page-one')], nextCursor: 1, seq: 5 }
        : { available: true, turns: [turn(2, 'page-two')], nextCursor: null, seq: 5 };
    renderModal(10);
    await screen.findByText('page-one');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('page-two')).toBeTruthy();
    expect(screen.getByText('page-one')).toBeTruthy(); // first page still present
  });

  it('calls onClose when the close button is clicked', async () => {
    renderModal(10);
    await screen.findByText('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
