// @vitest-environment jsdom
/**
 * WI-6503 — the USER's own chat messages wear the USER's profile icon.
 *
 * [owner 2026-07-27, verbatim] "remove the papercup icon from the chatbox for
 * the chatboces where the conversation isnt with papercup", clarified in the
 * follow-up to "the chat box should disaply the users profile icon in their
 * chat, not the papercup icon".
 *
 * The requirement is a SUBSTITUTION, not a deletion — so every case here pins
 * BOTH directions: the user's icon arrives AND the pane mark is gone from that
 * row, while non-user rows keep the pane mark they are supposed to have. A
 * test that only asserted "no papercup on the user row" would pass against a
 * regression that renders nothing at all, which is the outcome the owner
 * explicitly ruled out.
 *
 * The fallback matters as much as the happy path: if the identity can't be
 * resolved the row must degrade to a NEUTRAL person glyph, never back to the
 * pane/papercup mark — that fallback IS the reported bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

const { nuqs } = vi.hoisted(() => ({ nuqs: {} as Record<string, unknown> }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    vi.fn(async (v: unknown) => { nuqs[key] = v; }),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
  parseAsBoolean: { withDefault: (d: unknown) => ({ _d: d }) },
}));

// jsdom has no layout, so the real virtualizer renders nothing.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: [], loading: false, fetching: false, transport: 'sse' as const, invalidate: () => {}, error: null }),
}));

import { OperatorChat } from './OperatorChat';
import { __resetCurrentUserCacheForTests } from './use-current-user';
import type { ChatMessage } from './chat/ChatConversation';

/** Stand-in for the pane's brand mark (the Papercup cup in the real sidebar). */
const PaneIcon = (p: Record<string, unknown>) => <svg data-testid="pane-icon" {...p} />;

const fetchMock = vi.fn();

function authMeResolves(user: unknown) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user }) });
}

beforeEach(() => {
  __resetCurrentUserCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(over: Partial<React.ComponentProps<typeof OperatorChat>> = {}) {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'a message from the owner' },
    { role: 'assistant', content: 'a reply from the agent' },
  ];
  return render(
    <OperatorChat
      messages={messages}
      busy={false}
      passive={false}
      onSend={vi.fn()}
      paneIcon={PaneIcon}
      {...over}
    />,
  );
}

/** The avatar element of the row whose class marks it `user` / `assistant`. */
function avatarOfRole(container: HTMLElement, role: 'user' | 'assistant'): HTMLElement {
  const row = container.querySelector(`.oracle-msg-${role}`);
  if (!row) throw new Error(`no .oracle-msg-${role} row rendered`);
  const avatar = row.querySelector('.oracle-msg-avatar');
  if (!avatar) throw new Error(`no avatar in the ${role} row`);
  return avatar as HTMLElement;
}

describe('OperatorChat — the user’s own messages wear the user’s profile icon (WI-6503)', () => {
  it('renders the signed-in user’s initial on the user row, and NOT the pane mark', async () => {
    authMeResolves({ id: 'u1', username: 'testuser', display_name: 'Test Person' });
    const { container } = renderChat();

    await waitFor(() => {
      expect(avatarOfRole(container, 'user').textContent).toContain('T');
    });

    const userAvatar = avatarOfRole(container, 'user');
    // The substitution half: the pane/papercup mark is GONE from the user row…
    expect(userAvatar.querySelector('[data-testid="pane-icon"]')).toBeNull();
    // …and it was replaced, not merely removed.
    expect(userAvatar.classList.contains('oracle-msg-avatar--user-identity')).toBe(true);
    // Accessible name comes from the resolved identity, not a hardcoded label.
    expect(userAvatar.textContent).toContain('Test Person (you)');
  });

  it('NEGATIVE CONTROL: the assistant row still wears the pane mark', async () => {
    authMeResolves({ id: 'u1', username: 'testuser', display_name: 'Test Person' });
    const { container } = renderChat();

    await waitFor(() => {
      expect(avatarOfRole(container, 'user').textContent).toContain('T');
    });

    const assistantAvatar = avatarOfRole(container, 'assistant');
    expect(assistantAvatar.querySelector('[data-testid="pane-icon"]')).not.toBeNull();
    // The user's identity must not leak onto the counterparty's turn.
    expect(assistantAvatar.classList.contains('oracle-msg-avatar--user-identity')).toBe(false);
    expect(assistantAvatar.textContent).not.toContain('Test Person');
  });

  it('falls back to a neutral glyph — never the pane mark — when the identity cannot be resolved', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const { container } = renderChat();

    await waitFor(() => {
      expect(screen.getByText('a message from the owner')).toBeTruthy();
    });

    const userAvatar = avatarOfRole(container, 'user');
    // The whole point of the fallback: no branding borrowed from the pane.
    expect(userAvatar.querySelector('[data-testid="pane-icon"]')).toBeNull();
    expect(userAvatar.classList.contains('oracle-msg-avatar--user-identity')).toBe(true);
    expect(userAvatar.textContent).toContain('You');
  });

  it('a caller’s own renderAvatar still wins for the turns it claims (SessionChatModal’s identity chip)', async () => {
    authMeResolves({ id: 'u1', username: 'testuser', display_name: 'Test Person' });
    // Mirrors SessionChatModal: claims assistant turns, declines the rest.
    const renderAvatar = (m: ChatMessage) =>
      m.role === 'assistant' ? <span className="oracle-msg-avatar" data-testid="identity-chip">su-ae6cb</span> : null;
    const { container } = renderChat({ renderAvatar });

    await waitFor(() => {
      expect(avatarOfRole(container, 'user').textContent).toContain('T');
    });

    // The caller's chip owns the assistant row…
    expect(screen.getByTestId('identity-chip')).toBeTruthy();
    // …and declining on the user row is what hands it to the user's own icon,
    // rather than leaving the owner's turn wearing the agent's identity.
    const userAvatar = avatarOfRole(container, 'user');
    expect(userAvatar.querySelector('[data-testid="identity-chip"]')).toBeNull();
    expect(userAvatar.textContent).toContain('Test Person (you)');
  });

  it('issues ONE /api/auth/me request no matter how many chat panes mount', async () => {
    authMeResolves({ id: 'u1', username: 'testuser', display_name: 'Test Person' });
    renderChat();
    renderChat();

    await waitFor(() => {
      expect(screen.getAllByText('a message from the owner').length).toBe(2);
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/auth/me').length).toBe(1);
    });
  });
});
