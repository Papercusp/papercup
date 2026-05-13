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
vi.mock('@/lib/post-card-response', () => ({
  postCardResponse: vi.fn(),
}));

import { PendingCardsBar } from './PendingCardsBar';
import { useStateSnapshots, type OpenCardWithRun } from '@/lib/use-state-snapshots';
import { postCardResponse } from '@/lib/post-card-response';

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
    vi.mocked(postCardResponse).mockResolvedValue({ ok: true, status: 200 });
  });

  it('renders nothing when no cards', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({ cards: [], connected: true });
    const { container } = render(
      <PendingCardsBar conversationId="c1" workspaceId="w1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders single-select card and posts on submit', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
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
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText(/1 more card after this/)).toBeTruthy();
  });

  it('unknown presentation: shows fallbackText not a renderer', () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [
        makeCard({
          presentation: { kind: 'slider', min: 0, max: 10, step: 1 },
          fallbackText: 'Type a number 0-10',
        }),
      ],
      connected: true,
    });
    render(<PendingCardsBar conversationId="c1" workspaceId="w1" />);
    expect(screen.getByText('Type a number 0-10')).toBeTruthy();
    // No interactive buttons rendered.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('error from postCardResponse renders inline alert', async () => {
    vi.mocked(useStateSnapshots).mockReturnValue({
      cards: [makeCard()],
      connected: true,
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
});
