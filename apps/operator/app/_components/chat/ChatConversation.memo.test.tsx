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
//
// `measureElement`/`scrollToIndex` are hoisted OUT of the hook body on purpose:
// the real `useVirtualizer` holds ONE Virtualizer instance
// (`React.useState(() => new Virtualizer(...))`) and binds `measureElement` once
// in its constructor, so their identity is stable across renders. A fresh arrow
// per call would fabricate prop churn the running app never sees — and, since
// `measureElement` is a prop of every row, would break the <ChatMessageRow> memo
// in the test ONLY, making a correct fix look broken (WI-6502).
vi.mock('@tanstack/react-virtual', () => {
  const measureElement = () => {};
  const scrollToIndex = () => {};
  return {
    useVirtualizer: (opts: { count: number }) => ({
      getVirtualItems: () =>
        Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
      getTotalSize: () => opts.count * 64,
      measureElement,
      scrollToIndex,
    }),
  };
});

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
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

/**
 * The SECOND half of the same owner bug (WI-6502). Memoizing the markdown alone
 * left the rest of every row re-rendering per keystroke — avatar, role label,
 * tool cards, and one tool CHIP per tool call. Measured in a driven Tauri webview
 * against :3270: ~70ms of main-thread block per keystroke vs a 32ms idle floor,
 * with 28 chip tooltips rebuilt each keystroke (each eagerly JSON.stringify-ing
 * its payload) and zero network requests / zero forced reflows — pure re-render.
 *
 * The chip renderer is the probe precisely BECAUSE it sits outside
 * ChatMessageContent: it is the work the markdown guard above cannot see, so
 * these tests fail on the pre-fix tree even though that suite passes.
 */
/**
 * WI-6547: the LATE-ARRIVING `renderAvatar` guard.
 *
 * The row memo's whole risk is that it freezes a row against a real change. The
 * comment above `ChatMessageRow` cites this file as guarding "a new `rosterEntry`
 * behind `renderAvatar`" — but until now nothing here ever varied `renderAvatar`,
 * so that claim was vacuous and the direction was untested.
 *
 * It matters because the roster is a sync query: `SessionChatModal` first renders
 * with `rosterEntry === null` (every avatar falls back), and the entry lands a
 * beat later. If the memo did not see the new `renderAvatar` identity, only rows
 * mounted AFTER the roster arrived would ever wear the identity chip — which is
 * exactly the "chip shows on ~1 of 12 rows" symptom WI-6547 was filed for. The
 * message array is deliberately the SAME REFERENCE across the rerender, so a pass
 * cannot be explained by message churn re-rendering the rows for free.
 */
describe('ChatConversation — a late-arriving renderAvatar reaches ALREADY-PAINTED rows', () => {
  const ASSISTANT_ROWS = MESSAGES.filter((m) => m.role === 'assistant').length;

  /** Stands in for the identity chip; null models "roster has not landed yet". */
  const noRoster = () => null;
  const withRoster = (m: ChatMessage) =>
    m.role === 'assistant' ? <span data-testid="identity-chip">su-abc12</span> : null;

  it('paints the chip on EVERY assistant row, not just ones mounted after it', () => {
    const { rerender, queryAllByTestId } = render(
      <ChatConversation {...props({ renderAvatar: noRoster })} />,
    );
    // Sanity: pre-roster there is genuinely no chip, so a count below is a real
    // transition and not a chip that was present all along.
    expect(queryAllByTestId('identity-chip')).toHaveLength(0);

    // Same `messages` reference — ONLY renderAvatar's identity changes.
    rerender(<ChatConversation {...props({ renderAvatar: withRoster })} />);

    expect(queryAllByTestId('identity-chip')).toHaveLength(ASSISTANT_ROWS);
    expect(ASSISTANT_ROWS).toBeGreaterThan(1); // a 1-row fixture could not detect staleness
  });

  it('is a REAL guard: a stable-identity renderAvatar (latest-ref) freezes the rows', () => {
    // The non-vacuity control for the test above, and the reason the comment on
    // ChatMessageRow forbids latest-ref shims. Here the function IDENTITY never
    // changes — only the value its closure reads does, exactly as a
    // `useRef`-backed callback would behave. The row memo therefore (correctly)
    // skips, and the chip never appears.
    //
    // If someone "optimises" ChatMessageRow to stop depending on renderAvatar's
    // identity, THIS test starts passing trivially while the one above fails —
    // so the pair, not either alone, is what pins the behaviour.
    let roster: { id: string } | null = null;
    const latestRefAvatar = (m: ChatMessage) =>
      m.role === 'assistant' && roster ? <span data-testid="identity-chip">{roster.id}</span> : null;

    const { rerender, queryAllByTestId } = render(
      <ChatConversation {...props({ renderAvatar: latestRefAvatar })} />,
    );
    expect(queryAllByTestId('identity-chip')).toHaveLength(0);

    roster = { id: 'su-abc12' }; // the roster query resolves…
    // …and a keystroke re-renders the PARENT, so the rows are re-offered the
    // same renderAvatar identity. Without an identity change the memo holds.
    rerender(<ChatConversation {...props({ renderAvatar: latestRefAvatar, inputValue: 'x' })} />);

    expect(queryAllByTestId('identity-chip')).toHaveLength(0);
  });

  it('drops the chip from every row again when the roster entry goes away', () => {
    // The opposite direction: a frozen row would keep a stale chip forever.
    const { rerender, queryAllByTestId } = render(
      <ChatConversation {...props({ renderAvatar: withRoster })} />,
    );
    expect(queryAllByTestId('identity-chip')).toHaveLength(ASSISTANT_ROWS);

    rerender(<ChatConversation {...props({ renderAvatar: noRoster })} />);

    expect(queryAllByTestId('identity-chip')).toHaveLength(0);
  });
});

describe('ChatConversation — typing does not re-render message ROWS', () => {
  const MESSAGES_WITH_TOOLS: ChatMessage[] = [
    { role: 'assistant', content: 'first', tools: [{ name: 'coord:orient', input: { a: 1 } }] },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'third', tools: [{ name: 'plans:get', input: { b: 2 } }] },
  ] as unknown as ChatMessage[];
  const TOOL_COUNT = 2;

  /** One call per tool-chip RENDER — row work the markdown memo does NOT cover. */
  const chipRender = vi.fn();
  const renderToolChip = (t: { name: string }, i: number) => {
    chipRender();
    return <span key={i} data-testid="chip">{t.name}</span>;
  };
  // Stable across rerenders, exactly as OperatorChat passes a module-level fn.
  const rowProps = (over: Record<string, unknown> = {}) =>
    props({ messages: MESSAGES_WITH_TOOLS, renderToolChip, ...over });

  beforeEach(() => chipRender.mockClear());

  it('re-renders NO row across a burst of keystrokes', () => {
    const { rerender } = render(<ChatConversation {...rowProps()} />);
    const afterMount = chipRender.mock.calls.length;
    // Sanity: mount really did render every chip, so a zero delta means
    // "skipped", not "the probe never fired".
    expect(afterMount).toBe(TOOL_COUNT);

    for (const typed of ['h', 'he', 'hel', 'hell', 'hello']) {
      rerender(<ChatConversation {...rowProps({ inputValue: typed })} />);
    }

    // 5 keystrokes × 2 chips = 10 rebuilds before the row memo.
    expect(chipRender.mock.calls.length).toBe(afterMount);
  });

  it('STILL re-renders the row when its message actually changes', () => {
    // Non-vacuity companion: a frozen row would pass the assertion above while
    // silently breaking the transcript, so the probe must still fire here.
    const { rerender } = render(<ChatConversation {...rowProps()} />);
    const afterMount = chipRender.mock.calls.length;

    rerender(
      <ChatConversation
        {...rowProps({
          messages: [
            ...MESSAGES_WITH_TOOLS.slice(0, 2),
            { role: 'assistant', content: 'third', tools: [{ name: 'plans:edit', input: { b: 3 } }] },
          ] as unknown as ChatMessage[],
        })}
      />,
    );

    expect(chipRender.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it('STILL renders rows for a message that arrives while typing', () => {
    const { rerender } = render(<ChatConversation {...rowProps({ inputValue: 'draft' })} />);
    const afterMount = chipRender.mock.calls.length;

    rerender(
      <ChatConversation
        {...rowProps({
          inputValue: 'draft!',
          messages: [
            ...MESSAGES_WITH_TOOLS,
            { role: 'assistant', content: 'new', tools: [{ name: 'fleet:status', input: {} }] },
          ] as unknown as ChatMessage[],
        })}
      />,
    );

    // Exactly one more: the arriving message's chip renders, the existing ones
    // are skipped even though a keystroke landed in the same commit.
    expect(chipRender.mock.calls.length).toBe(afterMount + 1);
  });
});
