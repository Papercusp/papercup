// @vitest-environment jsdom
/**
 * ChatConversation.memo.test.tsx — the typing-lag regression guard.
 *
 * Owner bug 2026-07-27: "typing into the chat is incredibly laggy". Cause: the
 * composer's text lives in OperatorChat's `input` state and arrives here as the
 * `inputValue` prop, so every keystroke re-renders ChatConversation — and with it
 * re-ran `ReactMarkdown` (a full parse with remarkGfm + remarkWorkRefs) for every
 * message on screen. `ChatMessageContent` is now `memo`-wrapped; this file is what
 * stops that from silently regressing.
 *
 * It lives in its OWN file because it must mock `react-markdown` with a render
 * counter, and ChatConversation.test.tsx asserts against real markdown output
 * (work-ref pills, emphasis) — one file cannot do both.
 *
 * The guard is easy to write vacuously, so it is paired with a companion that
 * proves the counter still fires when the content genuinely changes. Without that
 * pair, a memo that never re-rendered at all — or a broken mock — would pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

// jsdom has no layout, so the real virtualizer renders nothing — render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: [], loading: false, fetching: false, transport: 'sse' as const, invalidate: () => {}, error: null,
  }),
}));

/** Counts one call per markdown RENDER — the exact work the memo must skip. */
const markdownRender = vi.fn();
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: ReactNode }) => {
    markdownRender();
    return <div data-testid="md">{children}</div>;
  },
}));

import { ChatConversation, type ChatConversationProps, type ChatMessage } from './ChatConversation';

const Icon = (p: Record<string, unknown>) => <svg data-testid="empty-icon" {...p} />;

const MESSAGES: ChatMessage[] = [
  { role: 'assistant', content: 'hello **world**' },
  { role: 'user', content: 'a question about WI-1234' },
  { role: 'assistant', content: 'a third message so the count is clearly > 1' },
];

function props(over: Record<string, unknown> = {}) {
  return {
    messages: MESSAGES,
    busy: false,
    error: null as string | null,
    emptyState: { title: 'Oracle', body: 'Ask me anything', icon: Icon },
    inputValue: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  } as unknown as ChatConversationProps;
}

describe('ChatConversation — typing does not re-parse message markdown', () => {
  beforeEach(() => markdownRender.mockClear());

  it('re-renders NO message markdown across a burst of keystrokes', () => {
    const { rerender } = render(<ChatConversation {...props()} />);
    const afterMount = markdownRender.mock.calls.length;
    // Sanity: the mount really did render every message's markdown, so a zero
    // delta below means "skipped", not "never rendered anything".
    expect(afterMount).toBe(MESSAGES.length);

    for (const typed of ['h', 'he', 'hel', 'hell', 'hello']) {
      rerender(<ChatConversation {...props({ inputValue: typed })} />);
    }

    // 5 keystrokes × 3 visible messages = 15 markdown parses before the memo.
    expect(markdownRender.mock.calls.length).toBe(afterMount);
  });

  it('STILL re-renders markdown when a message\'s content actually changes', () => {
    // Non-vacuity companion: the same accessor must produce a DIFFERENT result
    // when the input genuinely changes, or the assertion above proves nothing.
    const { rerender } = render(<ChatConversation {...props()} />);
    const afterMount = markdownRender.mock.calls.length;

    rerender(
      <ChatConversation
        {...props({ messages: [...MESSAGES.slice(0, 2), { role: 'assistant', content: 'edited body' }] })}
      />,
    );

    expect(markdownRender.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it('STILL renders markdown for a newly arrived message while typing', () => {
    // The memo must not swallow real conversation updates that land mid-compose.
    const { rerender } = render(<ChatConversation {...props({ inputValue: 'draft' })} />);
    const afterMount = markdownRender.mock.calls.length;

    rerender(
      <ChatConversation
        {...props({ inputValue: 'draft!', messages: [...MESSAGES, { role: 'assistant', content: 'brand new reply' }] })}
      />,
    );

    // Exactly one more: the new message parses, the three existing ones do not.
    expect(markdownRender.mock.calls.length).toBe(afterMount + 1);
  });
});
