/** @vitest-environment jsdom */
/**
 * PapercupChat — persisted-card DOM parity across the two hosts
 * (papercup-chat-one-component-one-contract-2026-09-06, R-3).
 *
 * WI-10001780 was filed as "the persisted chat:ask_choice card does not replay
 * on the OPERATOR host": a live two-host witness counted `.pc-chat__card` and
 * read 1 on the portal and 0 on the operator. The card was never missing. The
 * two hosts reach the SAME `@papercusp/chat-cards` <AskChoiceCard> by two
 * different routes:
 *
 *   portal    — no `renderToolCard`, so the built-in branch renders it wrapped
 *               in `<div className="pc-chat__card">`.
 *   operator  — supplies `renderToolCard` (the chat-cards registry, via
 *               OperatorChat), so the host-card branch wrapped it in a BARE
 *               `<div>` carrying no class at all.
 *
 * So one selector saw the card and the other could not, for the same rendered
 * card — a false zero that reads exactly like a missing feature. These cases
 * pin BOTH halves of the contract:
 *
 *   1. the card itself renders on either route (`.ask-choice-card`), and
 *   2. its wrapper is the SAME addressable element on either route
 *      (`.pc-chat__card`) — one component, one contract.
 *
 * Case 2 is the regression guard: it fails against the pre-fix bare `<div>`.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskChoiceCard } from '@papercusp/chat-cards';
import type { ChatTurn } from '@papercusp/chat-protocol';
import { PapercupChat } from './PapercupChat';
import type { PapercupChatController } from './use-papercup-chat';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [], loading: false, error: null }),
}));

afterEach(cleanup);

function controller(overrides: Partial<PapercupChatController> = {}): PapercupChatController {
  return {
    conversationId: 'conv-1',
    turns: [],
    live: null,
    streaming: false,
    busy: false,
    loadingHistory: false,
    hasMoreEarlier: false,
    pendingCards: [],
    cardBusy: false,
    cardError: null,
    surfaceError: null,
    unsentQuestion: '',
    retryTarget: null,
    send: vi.fn(async () => {}),
    answerCard: vi.fn(async () => {}),
    answerPersistedCard: null,
    retry: vi.fn(async () => {}),
    loadEarlier: vi.fn(async () => {}),
    abort: vi.fn(),
    appendLocalTurns: vi.fn(),
    ...overrides,
  };
}

/** The persisted row the live witness seeded (conversation dc1c7dc0…, seq 2). */
const cardTurn: ChatTurn = {
  id: 'persisted-ask-choice',
  seq: 2,
  role: 'assistant',
  text: '',
  createdAt: Date.now(),
  tools: [
    {
      name: 'chat:ask_choice',
      input: {
        question: 'Which route should we take?',
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
      },
    },
  ],
};

/** What OperatorChat supplies: the chat-cards registry's renderer for the
 *  same tool name, returning the same shared card the built-in branch uses. */
function operatorRenderToolCard(tool: { name: string; input?: unknown }) {
  if (tool.name !== 'chat:ask_choice') return null;
  return <AskChoiceCard args={tool.input as never} onResponse={() => {}} />;
}

describe('PapercupChat — persisted card parity across hosts (WI-10001780 / R-3)', () => {
  // jsdom lays nothing out: @tanstack/virtual renders NO rows until the
  // scroller has a box. Same setup as PapercupChat.trust.test.tsx.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  function renderHost(withHostRenderer: boolean): HTMLElement {
    return render(
      <PapercupChat
        chat={controller({ turns: [cardTurn] })}
        hostTrust="owner"
        {...(withHostRenderer ? { renderToolCard: operatorRenderToolCard } : {})}
      />,
    ).container;
  }

  it('renders the shared ask-choice card on BOTH hosts (the card was never missing)', () => {
    const portal = renderHost(false);
    expect(portal.querySelectorAll('.ask-choice-card')).toHaveLength(1);
    expect(portal.textContent).toContain('Which route should we take?');

    cleanup();

    const operator = renderHost(true);
    expect(operator.querySelectorAll('.ask-choice-card')).toHaveLength(1);
    expect(operator.textContent).toContain('Which route should we take?');
  });

  it('wraps it in the SAME addressable `.pc-chat__card` element on both hosts', () => {
    const portal = renderHost(false);
    expect(portal.querySelectorAll('.pc-chat__card')).toHaveLength(1);

    cleanup();

    // Pre-fix this was 0: the host-card branch used a bare <div>, so a
    // `.pc-chat__card` probe reported "no card" for a card that had rendered.
    const operator = renderHost(true);
    expect(operator.querySelectorAll('.pc-chat__card')).toHaveLength(1);
  });

  it('keeps the card inside its wrapper on the host route, not merely adjacent', () => {
    const operator = renderHost(true);
    const wrapper = operator.querySelector('.pc-chat__card');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.ask-choice-card')).not.toBeNull();
  });
});
