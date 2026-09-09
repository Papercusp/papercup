// @vitest-environment jsdom
/**
 * OperatorChat composer-draft coverage (EI-13037 follow-up) — the draft must
 * SURVIVE a remount. The chat body unmounts whenever the sidebar swaps to the
 * inbox/pot view (and on reconnect re-keys), and before this a seeded Discuss
 * draft — or a half-typed message — silently vanished on any body swap. Pins:
 *   - a staged inbox seed (chat-seed.ts) lands in the composer on mount;
 *   - the composer text persists across unmount → remount (sessionStorage
 *     mirror, per-workspace key);
 *   - a fresh seed WINS over an older persisted draft;
 *   - sending clears both the composer and the stored draft.
 *
 * PapercupChat is stubbed to a bare controlled input + send button — the
 * transcript machinery has its own suites; this pins only the draft logic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test-ws:${k}`,
}));
vi.mock('../chat/PendingCardsBar', () => ({ PendingCardsBar: () => null }));
vi.mock('@/lib/chat-cards', () => ({ renderCard: () => null }));
vi.mock('../OperatorLogoMark', () => ({ OperatorLogoMark: () => null }));

// The frozen release still uses ChatConversation; staging uses PapercupChat.
// Pin only the controlled composer contract this draft test owns, so migration
// order and a sibling suite's renderer mock cannot decide whether it collects.
vi.mock('../chat/ChatConversation', () => ({
  ChatConversation: (props: {
    inputValue: string;
    onInputChange: (value: string) => void;
    onSubmit: () => void;
  }) => (
    <>
      <input data-testid="composer" value={props.inputValue}
        onChange={(event) => props.onInputChange(event.currentTarget.value)} />
      <button data-testid="send" onClick={props.onSubmit}>Send</button>
    </>
  ),
}));
vi.mock('@papercusp/operator-ui/papercup-chat', () => ({
  EMPTY_TURN: { text: '', toolCalls: [], cards: [], done: false },
  PAPERCUP_CHAT_CSS: '',
  PapercupChat: (props: {
    inputValue: string;
    onInputChange: (value: string) => void;
    chat: { send: (text: string) => unknown };
  }) => (
    <>
      <input data-testid="composer" value={props.inputValue}
        onChange={(event) => props.onInputChange(event.currentTarget.value)} />
      <button data-testid="send" onClick={() => {
        const text = props.inputValue.trim();
        if (!text) return;
        props.onInputChange('');
        void props.chat.send(text);
      }}>Send</button>
    </>
  ),
}));

import { OperatorChat } from '../OperatorChat';
import { seedOperatorChatDraft, consumePendingChatSeed, readChatDraft } from '../inbox/chat-seed';

beforeAll(() => {
  // The vitest jsdom storage shim can be broken (`getItem is not a function`);
  // install a real in-memory Storage (mirrors LeftSidebar.test.tsx's pattern).
  const store = new Map<string, string>();
  const ss: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'sessionStorage', { value: ss, configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: ss, configurable: true });
});
beforeEach(() => {
  sessionStorage.clear();
  consumePendingChatSeed(); // drain any staged seed between tests
});
afterEach(() => cleanup());

const props = () => ({
  messages: [],
  busy: false,
  passive: false,
  onSend: vi.fn(),
});

const composer = () => screen.getByTestId<HTMLInputElement>('composer');

// OperatorChat reads/writes two nuqs query params ('wpop', 'wppop') for its
// work-item/plan popups — outside a NuqsAdapter, useQueryState throws
// "nuqs requires an adapter to work with your framework" (NUQS-404).
const renderChat = (p: ReturnType<typeof props>) =>
  render(
    <NuqsTestingAdapter>
      <OperatorChat {...p} />
    </NuqsTestingAdapter>,
  );

describe('<OperatorChat> composer draft (EI-13037 follow-up)', () => {
  it('consumes a staged inbox seed into the composer on mount', () => {
    seedOperatorChatDraft('About this inbox item …');
    renderChat(props());
    expect(composer().value).toBe('About this inbox item …');
    // Consume-once: the pending store is drained…
    expect(consumePendingChatSeed()).toBeNull();
    // …but the draft is mirrored to storage so a remount keeps it.
    expect(readChatDraft()).toBe('About this inbox item …');
  });

  it('typed text survives unmount → remount (the inbox/pot body swap)', () => {
    const first = renderChat(props());
    fireEvent.change(composer(), { target: { value: 'half-typed thought' } });
    first.unmount();
    renderChat(props());
    expect(composer().value).toBe('half-typed thought');
  });

  it('a fresh seed wins over an older persisted draft', () => {
    const first = renderChat(props());
    fireEvent.change(composer(), { target: { value: 'older draft' } });
    first.unmount();
    seedOperatorChatDraft('fresh Discuss seed');
    renderChat(props());
    expect(composer().value).toBe('fresh Discuss seed');
  });

  it('sending clears the composer AND the stored draft', () => {
    const p = props();
    renderChat(p);
    fireEvent.change(composer(), { target: { value: 'ship it' } });
    expect(readChatDraft()).toBe('ship it');
    fireEvent.click(screen.getByTestId('send'));
    expect(p.onSend).toHaveBeenCalledWith('ship it');
    expect(composer().value).toBe('');
    expect(readChatDraft()).toBeNull();
  });
});
