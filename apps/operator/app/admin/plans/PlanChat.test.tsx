// @vitest-environment jsdom
//
// PlanChat — inline agent-chat host (inbox-cards-unification D-006). Genuine
// logic: the no-harness short-circuit, the create-chat fetch lifecycle
// (loading → mounted ChatPanel, or error surface), and re-creation when the
// harness/label changes. ChatPanel is stubbed (not under test) and fetch is a
// vi.fn so no network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/harness/ChatPanel', () => ({
  default: ({ slug, chatId }: { slug: string; chatId: string }) => (
    <div data-testid="chat-panel" data-slug={slug} data-chat-id={chatId} />
  ),
}));

import PlanChat from './PlanChat';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<PlanChat />', () => {
  it('shows the "no harness" note and never fetches when harnessSlug is null', () => {
    render(<PlanChat harnessSlug={null} label="p · P-001" />);
    expect(screen.getByText(/isn’t attached to a harness/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mounts the ChatPanel once the chat is created', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'chat-99' }) });
    render(<PlanChat harnessSlug="my-harness" label="p · P-001" />);
    const panel = await screen.findByTestId('chat-panel');
    expect(panel.getAttribute('data-slug')).toBe('my-harness');
    expect(panel.getAttribute('data-chat-id')).toBe('chat-99');
    // It POSTs to the per-harness agent-chats endpoint.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/harness/my-harness/agent-chats',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces the server error message when chat creation fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'spawn failed' }) });
    render(<PlanChat harnessSlug="my-harness" label="p · P-001" />);
    await waitFor(() => expect(screen.getByText('spawn failed')).toBeTruthy());
    expect(screen.queryByTestId('chat-panel')).toBeNull();
  });

  it('falls back to an HTTP status message when the error body has no error field', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render(<PlanChat harnessSlug="my-harness" label="p · P-001" />);
    await waitFor(() => expect(screen.getByText('HTTP 503')).toBeTruthy());
  });
});
