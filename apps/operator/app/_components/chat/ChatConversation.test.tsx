// @vitest-environment jsdom
/**
 * ChatConversation.test.tsx — the shared Oracle/Operator chat surface. Covers
 * the exported lastUserMessageText recall helper and the component: empty state,
 * message rendering (role labels + content), the busy "thinking" row + disabled
 * input, the error row, submit + send-button enable/disable, the ↑-recall, tool
 * chip vs card rendering, the banner, hideInput, and the load-earlier states.
 *
 * Seam: @tanstack/react-virtual is mocked to render every message (jsdom has no
 * layout, so the real virtualizer would render nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// jsdom lacks both — the scroll-to-bottom effect and the load-earlier
// IntersectionObserver effect call them on render.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

const scrollToIndexSpy = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
    scrollToIndex: scrollToIndexSpy,
  }),
}));

// chat-ref-pills-2026-07-26 P-004: HydratedWorkRefPill's useSyncQuery — no
// live rows needed for these tests (rendering/no-linkify/activation, not
// hydration itself, which HydratedWorkRefPill.test.tsx already covers).
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: [], loading: false, fetching: false, transport: 'sse' as const, invalidate: () => {}, error: null }),
}));

import {
  ChatConversation,
  findAnchoredMessageIndex,
  lastUserMessageText,
  type ChatConversationProps,
  type ChatMessage,
} from './ChatConversation';

const Icon = (p: Record<string, unknown>) => <svg data-testid="empty-icon" {...p} />;

describe('lastUserMessageText', () => {
  it('returns the most recent non-empty user message', () => {
    expect(lastUserMessageText([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'last' }])).toBe('last');
    expect(lastUserMessageText([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toBe('hi');
  });
  it('skips assistant/system and whitespace-only user messages', () => {
    expect(lastUserMessageText([{ role: 'assistant', content: 'yo' }])).toBeNull();
    expect(lastUserMessageText([{ role: 'user', content: '   ' }])).toBeNull();
    expect(lastUserMessageText([])).toBeNull();
  });
});

function renderChat(over: Record<string, unknown> = {}) {
  const onInputChange = vi.fn();
  const onSubmit = vi.fn();
  const props = {
    messages: [] as ChatMessage[], busy: false, error: null as string | null,
    emptyState: { title: 'Oracle', body: 'Ask me anything', icon: Icon },
    inputValue: '', onInputChange, onSubmit,
    ...over,
  };
  render(<ChatConversation {...(props as unknown as ChatConversationProps)} />);
  return { onInputChange, onSubmit };
}

afterEach(cleanup);

describe('ChatConversation', () => {
  it('renders the empty state when there are no messages', () => {
    renderChat();
    expect(screen.getByText('Oracle')).toBeTruthy();
    expect(screen.getByText('Ask me anything')).toBeTruthy();
  });

  it('renders message content and the You role label', () => {
    renderChat({ messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' }] });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
  });

  /* session-chat-popup-timestamps-and-modes-2026-08-09 P-001 — the per-message
     stamp. formatMessageStamp's own suite covers the formatting; these cover the
     two properties that only exist once it is mounted in a row. */
  describe('message timestamp (P-001)', () => {
    it('renders both halves, with the full instant on the time element', () => {
      const at = new Date(2026, 7, 9, 23, 14, 7);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(at.getTime() + 4 * 60_000));
      try {
        renderChat({ messages: [{ role: 'user', content: 'go', ts: at.toISOString() }] });
        const el = screen.getByTestId('chat-message-time');
        expect(el.textContent).toBe('23:14 · 4m ago');
        expect(el.getAttribute('dateTime') ?? el.getAttribute('datetime')).toBe(at.toISOString());
        expect(el.getAttribute('title')).toBe(at.toISOString());
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders NO stamp for a message with no ts — every non-transcript surface stays byte-identical', () => {
      // The guarantee that let this ship without a per-caller opt-in flag: the
      // operator sidebar, the card surfaces and every existing test feed set no
      // `ts`, so they must render exactly as before rather than gaining an
      // invented or placeholder time.
      renderChat({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }] });
      expect(screen.queryByTestId('chat-message-time')).toBeNull();
    });

    it('an unparseable ts renders no stamp rather than "Invalid Date"', () => {
      renderChat({ messages: [{ role: 'user', content: 'go', ts: 'not-a-date' }] });
      expect(screen.queryByTestId('chat-message-time')).toBeNull();
    });

    it('THE MEMO PROPERTY: a clock tick repaints the age WITHOUT re-rendering the row body', () => {
      /* This is plan D-001's constraint, and it is the reason the stamp is a
         separate leaf component subscribing to a shared clock instead of a
         `nowMs` prop on the row.

         ChatMessageRow is the WI-6502 typing-lag memo boundary. A ticking PROP
         would re-render every visible row's full body — avatar, markdown, and
         one renderToolChip per tool, each eagerly JSON.stringifying its payload
         for a hover tooltip — every 15 seconds, silently undoing that fix. The
         chip renderer is the cheapest observable proxy for "the row body
         re-rendered": it is called during the row's render and nowhere else.

         Both directions are asserted deliberately. A test that only checked the
         chip count would pass if the stamp were frozen; one that only checked
         the text would pass if the whole row re-rendered. */
      const at = new Date(2026, 7, 9, 23, 14, 7);
      vi.useFakeTimers();
      vi.setSystemTime(at);
      try {
        const renderToolChip = vi.fn((t: { name: string }, i: number) => (
          <span key={i} data-testid="chip">{t.name}</span>
        ));
        renderChat({
          messages: [
            {
              role: 'assistant',
              content: 'working',
              ts: at.toISOString(),
              tools: [{ name: 'Bash', input: { command: 'npm test' } }],
            },
          ],
          renderToolChip,
        });
        expect(screen.getByTestId('chat-message-time').textContent).toBe('23:14 · 0s ago');
        const rowRendersBefore = renderToolChip.mock.calls.length;
        expect(rowRendersBefore).toBeGreaterThan(0);

        act(() => {
          vi.advanceTimersByTime(15_000);
        });

        // The age MOVED...
        expect(screen.getByTestId('chat-message-time').textContent).toBe('23:14 · 15s ago');
        // ...and the row body did NOT re-render to make that happen.
        expect(renderToolChip.mock.calls.length).toBe(rowRendersBefore);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('renders markdown (bold, links, line breaks) instead of literal asterisks (gui-chat-session-controls-2026-07-25 P-009)', () => {
    renderChat({
      messages: [
        { role: 'assistant', content: '**bold** and https://example.com/path plain text\nsecond line' },
      ],
    });
    // Bold text renders as a real <strong>, not literal "**bold**".
    const strong = screen.getByText('bold');
    expect(strong.tagName).toBe('STRONG');
    // A bare URL autolinks (remark-gfm) to a real anchor, opened in a new tab.
    const link = screen.getByRole('link', { name: 'https://example.com/path' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/path');
    expect(link.target).toBe('_blank');
    // A single \n is a real line break, not collapsed into a space.
    expect(screen.getByText(/second line/).closest('.oracle-msg-content')?.textContent).toContain('second line');
  });

  it('pins the transcript to the latest message on first render (WI-4692)', () => {
    // Regression guard for the virtualized-scroll strand: the mount pin must
    // go through the virtualizer's measurement-aware scrollToIndex targeting
    // the LAST index — a bare endRef.scrollIntoView({behavior:'smooth'})
    // strands mid-history while row estimates correct themselves.
    scrollToIndexSpy.mockClear();
    renderChat({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'middle' },
        { role: 'assistant', content: 'latest' },
      ],
    });
    expect(scrollToIndexSpy).toHaveBeenCalledWith(2, { align: 'end' });
  });

  it('lets a newer T# focus request supersede an in-flight virtualizer correction loop', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'T1 question' },
      { role: 'assistant', content: 'T1 answer' },
      { role: 'user', content: 'T2 question' },
      { role: 'assistant', content: 'T2 answer' },
    ];
    const base = {
      messages,
      busy: false,
      error: null,
      emptyState: { title: 'Oracle', body: 'Ask me anything', icon: Icon },
      inputValue: '',
      onInputChange: vi.fn(),
      onSubmit: vi.fn(),
    } satisfies ChatConversationProps;
    const view = render(<ChatConversation {...base} focusIndex={1} focusNonce={1} />);
    // Click T2 before T1's 45-frame correction has completed. The old
    // active-loop boolean dropped this request and kept targeting index 1.
    view.rerender(<ChatConversation {...base} focusIndex={3} focusNonce={2} />);
    scrollToIndexSpy.mockClear();
    const pending = frames.splice(0);
    act(() => { for (const frame of pending) frame(0); });
    expect(scrollToIndexSpy).toHaveBeenCalledWith(3, { align: 'start' });
    expect(scrollToIndexSpy.mock.calls.at(-1)?.[0]).toBe(3);
  });

  it('keeps correcting the same T# after its programmatic scroll event fires', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let region: HTMLElement | null = null;
    scrollToIndexSpy.mockImplementation(() => {
      region?.dispatchEvent(new Event('scroll'));
    });
    renderChat({
      messages: [
        { role: 'user', content: 'T1 question' },
        { role: 'assistant', content: 'T1 answer' },
      ],
      focusIndex: 1,
      focusNonce: 1,
    });
    region = screen.getByRole('region', { name: 'Conversation messages' });
    scrollToIndexSpy.mockClear();
    act(() => { frames.shift()?.(0); });
    act(() => { frames.shift()?.(16); });
    // Before the fix, the first programmatic event set followRef=true and the
    // second frame aborted, so a first-frame estimate miss made this T# click
    // work only sometimes.
    expect(scrollToIndexSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the thinking row and disables input while busy', () => {
    renderChat({ busy: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(screen.getByText(/Oracle is thinking/)).toBeTruthy();
    expect((screen.getByLabelText('Send a message…') as HTMLInputElement).disabled).toBe(true);
  });

  it('renders the error row', () => {
    renderChat({ error: 'boom' });
    expect(screen.getByText(/⚠ boom/)).toBeTruthy();
  });

  it('submits on send and gates the button on input/busy', () => {
    const { onSubmit } = renderChat({ inputValue: 'hey' });
    const send = screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    cleanup();
    renderChat({ inputValue: '' });
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('forwards typing to onInputChange', () => {
    const { onInputChange } = renderChat();
    fireEvent.change(screen.getByLabelText('Send a message…'), { target: { value: 'draft' } });
    expect(onInputChange).toHaveBeenCalledWith('draft');
  });

  it('recalls the last user message on ↑ in an empty composer', () => {
    const { onInputChange } = renderChat({ inputValue: '', messages: [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'reply' }] });
    fireEvent.keyDown(screen.getByLabelText('Send a message…'), { key: 'ArrowUp' });
    expect(onInputChange).toHaveBeenCalledWith('previous');
  });

  it('hides the composer when hideInput is set', () => {
    renderChat({ hideInput: true });
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });

  it('renders a tool card below content (and suppresses the chip for it)', () => {
    renderChat({
      messages: [{ role: 'assistant', content: 'C', tools: [{ name: 'ask' }] }],
      renderToolCard: () => <div data-testid="tool-card" />,
      renderToolChip: () => <div data-testid="tool-chip" />,
    });
    expect(screen.getByTestId('tool-card')).toBeTruthy();
    expect(screen.queryByTestId('tool-chip')).toBeNull();
  });

  it('falls back to the tool chip when no card is produced', () => {
    renderChat({
      messages: [{ role: 'assistant', content: 'C', tools: [{ name: 'ask' }] }],
      renderToolChip: (_t: unknown, i: number) => <div key={i} data-testid="tool-chip" />,
    });
    expect(screen.getByTestId('tool-chip')).toBeTruthy();
  });

  it('renders a renderAvatar override in place of the default icon avatar (gui-chat-session-controls-2026-07-25 P-012)', () => {
    renderChat({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
      renderAvatar: (m: ChatMessage) => (m.role === 'assistant' ? <span data-testid="identity-chip">su-ae6cb</span> : null),
    });
    // The override renders for the assistant turn…
    expect(screen.getByTestId('identity-chip')).toBeTruthy();
    // …and only ONE avatar renders per message (override replaces, not adds to,
    // the default `.oracle-msg-avatar` icon span) — the user turn still gets the
    // default icon avatar since renderAvatar returned null for it.
    expect(document.querySelectorAll('.oracle-msg-avatar').length).toBe(1);
  });

  it('renders footer under the composer form (gui-chat-session-controls-2026-07-25 P-007)', () => {
    renderChat({ footer: <div data-testid="session-footer">status</div> });
    const footer = screen.getByTestId('session-footer');
    const form = document.querySelector('form.oracle-form');
    expect(footer).toBeTruthy();
    // "under the composer" — the footer node must follow the form in the DOM.
    expect(form).toBeTruthy();
    expect(form!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders nothing extra when footer is omitted', () => {
    renderChat();
    expect(screen.queryByTestId('session-footer')).toBeNull();
  });

  it('renders a banner above the transcript', () => {
    renderChat({ banner: <div data-testid="banner" /> });
    expect(screen.getByTestId('banner')).toBeTruthy();
  });

  it('renders live cards after transcript rows and before thinking/composer (WI-40828)', () => {
    renderChat({
      messages: [{ role: 'assistant', content: 'The message that opened the card' }],
      busy: true,
      transcriptTail: <div data-testid="transcript-tail-card">Choose one</div>,
    });

    const body = screen.getByRole('region', { name: 'Conversation messages' });
    const card = screen.getByTestId('transcript-tail-card');
    const rows = document.querySelector('.oracle-virtual-container');
    const thinking = document.querySelector('.oracle-thinking-row');
    const form = document.querySelector('form.oracle-form');

    expect(body.contains(card)).toBe(true);
    expect(rows).toBeTruthy();
    expect(thinking).toBeTruthy();
    expect(form).toBeTruthy();
    expect(rows!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(thinking!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('work-ref pills (chat-ref-pills-2026-07-26 P-004)', () => {
    it('renders a WI-/EI-/F-/P- ref in prose as a pill, not literal text', () => {
      renderChat({
        messages: [{ role: 'assistant', content: 'see WI-5927 and P-004 for detail' }],
      });
      // The pill's accessible name is the bare id (no live title in this test —
      // useSyncQuery is mocked to return no rows).
      expect(screen.getByLabelText('WI-5927')).toBeTruthy();
      expect(screen.getByLabelText('P-004')).toBeTruthy();
      // Never rendered as literal, unlinkified prose.
      expect(screen.queryByText('see WI-5927 and P-004 for detail')).toBeNull();
    });

    it('does NOT linkify a ref inside a fenced code block or an inline code span', () => {
      renderChat({
        messages: [
          { role: 'assistant', content: 'inline `WI-1111` and:\n\n```\nWI-2222 fenced\n```' },
        ],
      });
      expect(screen.queryByLabelText('WI-1111')).toBeNull();
      expect(screen.queryByLabelText('WI-2222')).toBeNull();
      expect(screen.getByText('WI-1111')).toBeTruthy();
      expect(screen.getByText(/WI-2222 fenced/)).toBeTruthy();
    });

    it('does NOT double-linkify a ref that is already an existing markdown link label', () => {
      renderChat({
        messages: [{ role: 'assistant', content: 'already linked: [WI-3333](https://example.com/x)' }],
      });
      // One real <a>, no nested pill/anchor inside it.
      const link = screen.getByRole('link', { name: 'WI-3333' }) as HTMLAnchorElement;
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('https://example.com/x');
      expect(screen.queryByLabelText('WI-3333')).toBeNull();
    });

    it('forwards a pill click through onWorkRefActivate with { id, kind }', () => {
      const onWorkRefActivate = vi.fn();
      renderChat({
        messages: [{ role: 'assistant', content: 'see WI-5927' }],
        onWorkRefActivate,
      });
      screen.getByLabelText('WI-5927').click();
      expect(onWorkRefActivate).toHaveBeenCalledWith({ id: 'WI-5927', kind: 'work-item' });
    });

    it('renders a static, non-interactive pill when onWorkRefActivate is omitted', () => {
      renderChat({ messages: [{ role: 'assistant', content: 'see WI-5927' }] });
      const pill = screen.getByLabelText('WI-5927');
      expect(pill.tagName).toBe('SPAN');
    });
  });

  /* hud-open-destinations-and-true-counts-2026-07-27 P-005. Reported as "how
     come the pot list did not return any results?" — the real shape was an
     assistant turn persisted with EMPTY text (operator_turns seq 16456) after
     pot:list returned ok twice. The renderer had no way to say "no answer", so
     the failure was indistinguishable from absence. */
  describe('empty assistant turn (P-005)', () => {
    const NOTICE = /returned no answer for this turn/;

    it('says so when an assistant turn has no content at all', () => {
      renderChat({ messages: [{ role: 'assistant', content: '' }] });
      expect(screen.getByText(/Papercup returned no answer for this turn/)).toBeTruthy();
    });

    it('says the tools RAN when the turn called some and still said nothing — the reported case', () => {
      renderChat({
        messages: [{ role: 'assistant', content: '', tools: [{ name: 'pot:list' }] }],
      });
      expect(screen.getByText(/ran its tools but returned no answer/)).toBeTruthy();
    });

    it('stays silent while the turn is still STREAMING (last row + busy)', () => {
      renderChat({ messages: [{ role: 'assistant', content: '' }], busy: true });
      expect(screen.queryByText(NOTICE)).toBeNull();
    });

    it('still flags an earlier empty turn even while a LATER turn streams', () => {
      renderChat({
        messages: [
          { role: 'assistant', content: '' },
          { role: 'user', content: 'again?' },
          { role: 'assistant', content: '' },
        ],
        busy: true,
      });
      // The first empty assistant turn is finished, so it is a real failure;
      // only the trailing one is exempt.
      expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    });

    it('never fires on a turn that DID answer, or on a user turn', () => {
      renderChat({
        messages: [
          { role: 'user', content: '' },
          { role: 'assistant', content: 'here you go' },
        ],
      });
      expect(screen.queryByText(NOTICE)).toBeNull();
    });
  });

  it('shows load-earlier states (beginning vs loading)', () => {
    renderChat({ messages: [{ role: 'user', content: 'hi' }], onLoadEarlier: () => {}, hasMoreEarlier: false });
    expect(screen.getByText('Beginning of conversation')).toBeTruthy();
    cleanup();
    renderChat({ messages: [{ role: 'user', content: 'hi' }], onLoadEarlier: () => {}, hasMoreEarlier: true, loadingEarlier: true });
    expect(screen.getByText('Loading earlier…')).toBeTruthy();
  });
});

/**
 * The focus anchor's whole reason to be text rather than an index: the search
 * index (`harness_shared.session_turns`) and the transcript this component
 * renders (`/api/adv/session/thinking`, grouped and tool-filtered on the way
 * in) are DIFFERENT stores whose row numbering nothing keeps in step. These
 * cases pin the properties that survive that boundary.
 */
describe('findAnchoredMessageIndex', () => {
  const msgs = (...contents: string[]) => contents.map((content) => ({ content }));

  it('finds the message containing the anchor', () => {
    expect(
      findAnchoredMessageIndex(msgs('hello there', 'the deploy wedged on a lock timeout', 'bye'),
        'wedged on a lock timeout'),
    ).toBe(1);
  });

  it('matches across a newline the headline reflowed into a space', () => {
    // This is the case that makes a byte-exact comparison useless: ts_headline
    // returns the turn's text with its hard newlines collapsed, so any
    // multi-line agent message fails a strict compare.
    expect(
      findAnchoredMessageIndex(msgs('intro', 'the deploy wedged\n\n  on a lock timeout'),
        'the deploy wedged on a lock timeout'),
    ).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(findAnchoredMessageIndex(msgs('The Deploy Wedged Here'), 'the deploy wedged here')).toBe(0);
  });

  it('shortens progressively when the full anchor straddles a mapper boundary', () => {
    // The mapper lifts tool calls out of the text, so an 18-word headline
    // fragment can span text that is no longer contiguous in the message. A
    // full-length miss must not be read as "absent".
    expect(
      findAnchoredMessageIndex(
        msgs('unrelated', 'the deploy wedged on a lock timeout and then it was'),
        'the deploy wedged on a lock timeout and then it was RESTARTED BY HAND at noon',
      ),
    ).toBe(1);
  });

  it('returns -1 rather than guessing when the anchor is nowhere', () => {
    expect(findAnchoredMessageIndex(msgs('a', 'b'), 'nothing like this at all here')).toBe(-1);
  });

  it('declines an anchor too short to discriminate', () => {
    // Under the floor a match says nothing about WHICH message is the hit.
    expect(findAnchoredMessageIndex(msgs('aaa bbb', 'aaa bbb'), 'aaa')).toBe(-1);
    expect(findAnchoredMessageIndex(msgs('x'), null)).toBe(-1);
    expect(findAnchoredMessageIndex(msgs('x'), undefined)).toBe(-1);
  });

  it('breaks a genuine tie toward the turnIdx hint — a tiebreak, never a selector', () => {
    const dupes = msgs('the deploy wedged here', 'filler', 'the deploy wedged here');
    expect(findAnchoredMessageIndex(dupes, 'the deploy wedged here', 2)).toBe(2);
    expect(findAnchoredMessageIndex(dupes, 'the deploy wedged here', 0)).toBe(0);
  });

  it('IGNORES the hint when it points at a message that does NOT contain the text', () => {
    // The hint comes from the other store. If it ever outranked the text this
    // whole design would collapse back into the bug it exists to avoid.
    expect(
      findAnchoredMessageIndex(msgs('nope', 'the deploy wedged here', 'also nope'),
        'the deploy wedged here', 0),
    ).toBe(1);
  });

  it('survives an empty transcript (the modal mounts before the stream arrives)', () => {
    expect(findAnchoredMessageIndex([], 'the deploy wedged here')).toBe(-1);
  });
});
