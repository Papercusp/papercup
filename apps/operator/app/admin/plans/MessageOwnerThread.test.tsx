// @vitest-environment jsdom
//
// MessageOwnerThread — the inbox "Message owner" inline thread (P-009). Genuine
// logic: the ownerLabel fallback chain, the compose → open-thread transition,
// and the thread render (conversation root + posts). plans-api's coord calls
// and sonner toasts are mocked so no network/transport is touched.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AttentionItem, ConversationDetail } from './plans-api';

const { api } = vi.hoisted(() => ({
  api: {
    messageOwner: vi.fn(),
    getConversation: vi.fn(),
    postConversation: vi.fn(),
  },
}));

vi.mock('./plans-api', () => ({
  messageOwner: api.messageOwner,
  getConversation: api.getConversation,
  postConversation: api.postConversation,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import MessageOwnerThread from './MessageOwnerThread';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mkItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'plan-item:p:P-001',
    kind: 'plan-item',
    source: 'plan',
    harnessSlug: 'my-harness',
    planSlug: 'p',
    itemRef: 'P-001',
    title: 'Do the thing',
    body: '',
    status: 'needs-human',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'plan-item' },
    ...over,
  } as AttentionItem;
}

function detail(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation: {
      id: 'c1',
      kind: 'message',
      state: 'open',
      title: null,
      body: 'opening message',
      asker_id: 'human',
      harness_slug: 'my-harness',
    },
    topics: [],
    posts: [],
    subscriber_count: 1,
    ...over,
  };
}

describe('<MessageOwnerThread /> compose surface', () => {
  it('prefers ownerLabel for the compose label', () => {
    render(<MessageOwnerThread item={mkItem({ ownerLabel: 'Backend Bee' })} />);
    expect(screen.getByText(/message backend bee/i)).toBeTruthy();
  });

  it('falls back to ownerAgentId when there is no label', () => {
    render(<MessageOwnerThread item={mkItem({ ownerLabel: null, ownerAgentId: 'agent-42' })} />);
    expect(screen.getByText(/message agent-42/i)).toBeTruthy();
  });

  it('falls back to "<harness> agents" when there is no owner at all', () => {
    render(<MessageOwnerThread item={mkItem({ ownerLabel: null, ownerAgentId: null, harnessSlug: 'orch' })} />);
    expect(screen.getByText(/message orch agents/i)).toBeTruthy();
  });

  it('shows the item ref scope chip when present', () => {
    render(<MessageOwnerThread item={mkItem({ itemRef: 'P-009' })} />);
    expect(screen.getByText(/· P-009/)).toBeTruthy();
  });

  it('disables Send until the draft is non-empty', () => {
    render(<MessageOwnerThread item={mkItem()} />);
    const btn = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    expect(btn.disabled).toBe(false);
  });
});

describe('<MessageOwnerThread /> open + thread', () => {
  it('opens a thread and renders the conversation root + posts after Send', async () => {
    api.messageOwner.mockResolvedValue({ ok: true, conversation_id: 'c1', to: 'agent-42' });
    api.getConversation.mockResolvedValue(
      detail({
        conversation: {
          id: 'c1', kind: 'message', state: 'open', title: null,
          body: 'opening message', asker_id: 'human', harness_slug: 'h',
        },
        posts: [{ id: 1, author_id: 'agent-42', body: 'on it', created_ts: '2026-01-01' }],
      }),
    );

    render(<MessageOwnerThread item={mkItem({ ownerLabel: 'Backend Bee' })} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'please look' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The compose box gives way to the thread view (Refresh button + posts).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy());
    expect(screen.getByText('opening message')).toBeTruthy();
    expect(screen.getByText('on it')).toBeTruthy();
    expect(screen.getByText('Thread with Backend Bee')).toBeTruthy();
    expect(api.messageOwner).toHaveBeenCalledOnce();
  });

  it('stays on the compose surface when messageOwner reports a failure', async () => {
    const { toast } = await import('sonner');
    api.messageOwner.mockResolvedValue({ ok: false, error: 'no such agent' });

    render(<MessageOwnerThread item={mkItem()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // No thread opened — the compose textbox is still present.
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});
