// @vitest-environment jsdom
/**
 * PendingCardsBar tests — covers radio/checkbox rendering, decline,
 * submit POST, queue indicator, and unknown-presentation fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/use-state-snapshots', () => ({
  useStateSnapshots: vi.fn(),
}));
vi.mock('@papercusp/operator-core/lib/post-card-response', () => ({
  postCardResponse: vi.fn(),
  postRunCancel: vi.fn(),
}));

import { PendingCardsBar } from './PendingCardsBar';
import { useStateSnapshots, type OpenCardWithRun } from '@/lib/use-state-snapshots';
import { postCardResponse, postRunCancel } from '@papercusp/operator-core/lib/post-card-response';

afterEach(() => cleanup());

function makeCard(overrides: Partial<OpenCardWithRun> = {}): OpenCardWithRun {
  return {
    runId: 'r1',
    correlationId: 'cid-1',
    prompt: 'Pick one',
    dataSchemaJson: { type: 'object' },
    createdAt: 0,
    presentation: {
      kind: 'radio',
      options: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
    },
    ...overrides,
  };
}

describe('PendingCardsBar', () => {
  beforeEach(() => {
    vi.mocked(useStateSnapshots).mockReset();
    vi.mocked(postCardResponse).mockReset();
    vi.mocked(postRunCancel).mockReset();
    vi.mocked(postRunCancel).mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(postCardResponse).mockResolvedValue({ ok: true, status: 200 });
  });

  it('audit: optimistic-dismiss — card hides immediately after a successful submit, even if SSE never sends snapshot update', async () => {
    // Pre-fix: if the SSE stream dropped right after a successful POST,
    // the card stayed visible indefinitely because the snapshot-update
    // event never arrived.
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
    });
    const { container } = render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    await waitFor(() => {
      // After submit resolves, the card should be optimistically dismissed
      // even though the mocked useStateSnapshots still returns it.
      expect(container.querySelector('.ask-choice-card')).toBeNull();
    });
  });

  it('audit: disconnected indicator surfaces when SSE is closed', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: false,
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText(/Live updates disconnected/)).toBeTruthy();
  });

  it('renders nothing when no cards', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({ cards: [], connected: true, byRun: new Map() });
    const { container } = render(
      <PendingCardsBar conversationId="c1" workspaceId="w1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders single-select card and posts on submit', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'submit',
      payload: { picks: ['a'] },
    });
  });

  it('renders multi-select card and posts decline on Skip', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: {
            kind: 'checkbox',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          },
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'decline',
      reason: undefined,
    });
  });

  it('queue indicator: shows count when more than one card', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({ correlationId: 'a', runId: 'rA' }),
        makeCard({ correlationId: 'b', runId: 'rB' }),
        makeCard({ correlationId: 'c', runId: 'rC' }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText(/2 more cards after this/)).toBeTruthy();
  });

  it('queue indicator: singular wording for exactly one more card', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({ correlationId: 'a', runId: 'rA' }),
        makeCard({ correlationId: 'b', runId: 'rB' }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText(/1 more card after this/)).toBeTruthy();
  });

  it('text presentation: renders InputCard text and submits value', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: { kind: 'text', placeholder: 'type something' },
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    const input = screen.getByLabelText('response') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'submit',
      payload: { value: 'hello' },
    });
  });

  it('date presentation: renders InputCard date and submits ISO string', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: { kind: 'date' },
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    const { container } = render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'submit',
      payload: { value: '2026-09-01' },
    });
  });

  it('slider presentation: renders InputCard slider and submits numeric value', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: { kind: 'slider', min: 0, max: 100, step: 10 },
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    const range = screen.getByLabelText('value') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'submit',
      payload: { value: 70 },
    });
  });

  it('input Skip fires action:decline through to /card-response', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: { kind: 'text' },
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    await Promise.resolve();
    expect(postCardResponse).toHaveBeenCalledWith('c1', {
      correlationId: 'cid-1',
      workspaceId: 'w1',
      action: 'decline',
      reason: undefined,
    });
  });

  it('no-presentation: shows fallbackText (genuinely unknown)', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          presentation: undefined as any,
          fallbackText: 'No renderer for this',
        }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText('No renderer for this')).toBeTruthy();
    // The Cancel-run button is always rendered (chat-level affordance);
    // assert only that no interactive renderer button exists for the
    // unknown presentation kind itself.
    expect(screen.queryByRole('button', { name: /^(Submit|Skip|Option)/i })).toBeNull();
  });

  it('error from postCardResponse renders inline alert', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
      byRun: new Map(),
    });
    vi.mocked(postCardResponse).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'payload does not match dataSchema',
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/dataSchema/);
    });
  });

  it('Cancel button calls /run-cancel with head runId + workspaceId', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({ correlationId: 'a', runId: 'r-a' }),
        makeCard({ correlationId: 'b', runId: 'r-a' }),
        makeCard({ correlationId: 'c', runId: 'r-b' }),
      ],
      connected: true,
      byRun: new Map(),
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel this run/i }));
    await waitFor(() => {
      expect(postRunCancel).toHaveBeenCalledWith('c1', {
        runId: 'r-a',
        workspaceId: 'w1',
      });
    });
  });

  it('Cancel optimistically dismisses ALL cards in the head run (not other runs)', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({ correlationId: 'a', runId: 'r-a', prompt: 'prompt-a' }),
        makeCard({ correlationId: 'b', runId: 'r-a', prompt: 'prompt-b' }),
        makeCard({ correlationId: 'c', runId: 'r-b', prompt: 'prompt-c' }),
      ],
      connected: true,
      byRun: new Map(),
    });
    const { container } = render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel this run/i }));
    await waitFor(() => {
      // r-a cards (a, b) dismissed; r-b card (c) still visible as head.
      expect(container.textContent).toContain('prompt-c');
      expect(container.textContent).not.toContain('prompt-a');
      expect(container.textContent).not.toContain('prompt-b');
    });
  });

  it('Cancel error surfaces in alert; cards stay visible', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
      byRun: new Map(),
    });
    vi.mocked(postRunCancel).mockResolvedValue({
      ok: false,
      status: 404,
      error: 'run not found in workspace',
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel this run/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/run not found/);
    });
  });
});
