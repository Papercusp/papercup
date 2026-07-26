// @vitest-environment jsdom
/**
 * SessionChatModal — owner-inbox-single-pane-2026-07-17 P-007's chat-grade
 * popup. The SSE transport is mocked the same way AgentInspectorModal.test.tsx
 * mocks it (so `useAgentThinkingStream` runs for real, unmodified); `fetch`
 * is mocked for the two REST hops (sessions:list owner-resolution, coord:send).
 *
 * P-008 (cards in the popup): `@papercusp/sync` and `PlanOtherList` are
 * mocked the SAME way InboxPane.test.tsx mocks them — a hoisted per-queryName
 * result table + an `OtherDetail` stub that echoes its item id/onResolved seam
 * (parity behavior is the Queue suites' job; this file only asserts the right
 * item is selected + hosted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

// chat-ref-pills-2026-07-26 P-008: OperatorChat (rendered by SessionChatModal
// via LiveSessionChat) now owns `useQueryState` calls for the ref-pill popup
// routing below — every suite rendering it needs a nuqs mock. Hand-rolled +
// resettable (same pattern PlansPane.test.tsx uses), not `createNuqsMock()`'s
// singleton, so state can't leak between this file's own test cases.
const { nuqs, nuqsSetters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkNuqsSetter(key: string) {
  if (!nuqsSetters[key]) nuqsSetters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return nuqsSetters[key];
}
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkNuqsSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
// The two popup DESTINATIONS (→ PlanDetail / DetailPanel) are heavy — mocked
// the SAME way PlansPane.test.tsx mocks PlanPopupModal away, to a tiny probe
// asserting only what THIS file cares about: which id/harness reached them.
let lastWorkItemPopupProps: Record<string, any> = {};
vi.mock('../work-items/WorkItemPopupModal', () => ({
  default: (props: Record<string, any>) => {
    lastWorkItemPopupProps = props;
    return null;
  },
}));
vi.mock('../plans/PlanPopupModal', () => ({
  default: () => null,
}));

// jsdom-vs-virtualization seam (same as ChatConversation.test.tsx): the real
// @tanstack/react-virtual renders nothing without real layout, and the
// scroll-to-bottom / load-earlier effects need stand-ins for APIs jsdom lacks.
const scrollToIndexSpy = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
    scrollToIndex: scrollToIndexSpy,
  }),
}));

type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void; url: string } | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { url: string; handlers: Handlers; onError?: (e: Error) => void }) => {
    // EI-14216: OperatorChat transitively imports OperatorConversationProvider
    // (for CardAnswerError), which imports voice-mode.ts, which — on some
    // renders — async-inits a cross-tab "leader bridge" that ALSO calls
    // createResilientEventSource, for an unrelated
    // /api/agent-mcp/run-command/sse?workspace=default&sessionId=tab-... URL.
    // That call has nothing to do with this component's own live-session
    // stream and must never clobber `captured` — only the session/thinking
    // stream this file actually asserts on should be captured.
    if (!opts.url.startsWith('/api/adv/session/thinking')) {
      return { close: vi.fn() };
    }
    captured = { handlers: opts.handlers, onError: opts.onError, url: opts.url };
    return { close: closeSpy };
  },
}));

// P-008: the shared sync layer, mocked exactly like InboxPane.test.tsx —
// keyed by queryName, defaulting to an empty/blank result so every existing
// (pre-P-008) test in this file keeps rendering with zero pending escalations.
const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const attentionInvalidate = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));
// OtherDetail is the Queue's own component (its behavior is covered by the
// Queue's own suites) — stub it to a marker that echoes the hosted item id
// and exposes the onResolved seam, mirroring InboxPane.test.tsx's stub.
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item, onResolved }: { item: { id: string }; onResolved: () => void }) => (
    <div data-testid="other-detail" data-item={item.id}>
      <button type="button" data-testid="stub-resolve" onClick={onResolved} />
    </div>
  ),
}));

import SessionChatModal from './SessionChatModal';

function mkEscalation(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: 'coord-escalation',
    source: 'coord',
    harnessSlug: 'papercusp',
    planSlug: null,
    itemRef: null,
    title: `Escalation ${id}`,
    body: `Body of ${id}`,
    status: 'open',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: 'su-live-1',
    ownerLabel: 'su · live-1',
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [{ id: 'resolve', label: 'Resolve', primary: true }],
    ref: { kind: 'coord-escalation', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    ...over,
  } as AttentionItem;
}

function seedAttention(items: AttentionItem[]) {
  H.results['plans.attention'] = {
    data: [
      { key: 'g1', kind: 'plan', planSlug: 'plan-x', harnessSlug: 'papercusp', title: 'plan-x', items, maxImportance: 'normal' },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: attentionInvalidate,
  };
}

const fetchMock = vi.fn();

function mockFetchOnce(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  captured = null;
  closeSpy.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  H.results = {};
  attentionInvalidate.mockClear();
  lastWorkItemPopupProps = {};
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionChatModal', () => {
  it('renders nothing (closed) when sessionOwnerId is null', () => {
    const { container } = render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
    expect(screen.queryByText(/Chat —/)).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('resolves the owner’s claude session via sessions:list, then opens the live stream at it', async () => {
    mockFetchOnce(200, {
      sessions: [
        { source_kind: 'omp', session_id: 'omp-1', last_ts: null },
        { source_kind: 'claude', session_id: 'claude-abc', last_ts: '2026-07-17T00:00:00Z' },
      ],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);

    expect(screen.getByText("Finding this agent's session…")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/coordination/sessions/list',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ owner: 'su-live-1', limit: 10 }),
      }),
    );

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe('/api/adv/session/thinking?sessionId=claude-abc&owner=su-live-1');
    expect(screen.getByText('Chat — su · live-1')).toBeTruthy();
  });

  it('prefers the active/live row over an older claude session (EI-11403 synthetic fallback)', async () => {
    mockFetchOnce(200, {
      sessions: [
        { source_kind: 'claude', session_id: 'claude-old', last_ts: '2026-07-01T00:00:00Z' },
        { source_kind: 'claude', session_id: 'claude-live', active: true, last_ts: null },
      ],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toContain('sessionId=claude-live');
  });

  it('EI-16982: appends &ended=1 when the resolved session is not active, so the backend rematerializes the archived transcript', async () => {
    mockFetchOnce(200, {
      sessions: [{ source_kind: 'claude', session_id: 'claude-ended', active: false, last_ts: '2026-07-01T00:00:00Z' }],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe('/api/adv/session/thinking?sessionId=claude-ended&owner=su-live-1&ended=1');
  });

  it('does NOT append ended for an active/live session (no regression)', async () => {
    mockFetchOnce(200, {
      sessions: [{ source_kind: 'claude', session_id: 'claude-live', active: true, last_ts: null }],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).not.toContain('ended=');
  });

  it('shows a not-found state when the owner has no indexed claude session', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'omp', session_id: 'omp-1', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy(),
    );
    expect(captured).toBeNull(); // never opened a stream with no session id
  });

  it('surfaces a sessions:list resolution failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    // WI-5364: friendly headline leads; the raw transport error rides below it
    // in muted mono (both live inside the same testid'd banner).
    await waitFor(() => expect(screen.getByText(/Couldn't load this agent's conversation/)).toBeTruthy());
    expect(screen.getByTestId('session-chat-resolve-error').textContent).toContain('500');
  });

  it('maps the live backfill through the tool-noise-filtering layer and renders it as chat', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());

    act(() => {
      captured!.handlers.backfill!(
        JSON.stringify([
          { kind: 'prompt', text: 'owner asks something' },
          { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' } },
          { kind: 'tool_result', text: 'A'.repeat(20_000) },
          { kind: 'text', text: 'Here is my answer.' },
        ]),
      );
    });

    expect(screen.getByText('owner asks something')).toBeTruthy();
    expect(screen.getByText('Here is my answer.')).toBeTruthy();
    // The 20KB tool_result never reaches the DOM — the tool-noise filter.
    expect(screen.queryByText(/A{100,}/)).toBeNull();
  });

  describe('P-012 identity chip', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('renders the roster handle + LEAD marker on the assistant avatar for a fleet leader', async () => {
      seedRoster([
        { ownerId: 'su-live-1', fleetColor: '#86efac', fleetRole: 'leader' },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'Here is my answer.' }]));
      });

      await waitFor(() => expect(screen.getByText('Here is my answer.')).toBeTruthy());
      // Scoped to the identity-chip avatar specifically: P-007's footer (below
      // the composer) also renders the handle now, so a page-wide getByText
      // would ambiguously match both.
      const chip = document.querySelector('.oracle-msg-avatar--identity') as HTMLElement;
      expect(chip).toBeTruthy();
      expect(within(chip).getByText('su-live-1')).toBeTruthy();
      expect(within(chip).getByLabelText('Fleet leader')).toBeTruthy();
    });

    it('omits the LEAD marker for a non-leader member, and falls back to the default icon avatar when the owner has no roster row', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'member reply' }]));
      });

      await waitFor(() => expect(screen.getByText('member reply')).toBeTruthy());
      const chip = document.querySelector('.oracle-msg-avatar--identity') as HTMLElement;
      expect(chip).toBeTruthy();
      expect(within(chip).getByText('su-live-1')).toBeTruthy();
      expect(within(chip).queryByLabelText('Fleet leader')).toBeNull();
    });

    it('falls back to the default icon avatar when the roster has no matching entry', async () => {
      seedRoster([{ ownerId: 'su-someone-else', fleetColor: null, fleetRole: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'no roster row' }]));
      });

      await waitFor(() => expect(screen.getByText('no roster row')).toBeTruthy());
      expect(screen.queryByText('su-live-1')).toBeNull();
    });
  });

  describe('P-007 session footer', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('renders fleet/plan/context/claims/objective from the SAME roster entry the identity chip reads', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          fleetSlug: 'gui-chat-controls',
          fleetColor: '#86efac',
          fleetRole: 'leader',
          currentPlanSlug: 'gui-chat-session-controls-2026-07-25',
          contextTokens: 40_000,
          compactionLimit: 200_000,
          modes: [],
          claims: [{ id: 'WI-1', status: 'done' }, { id: 'WI-2', status: 'wip' }],
          currentFiles: [],
          intent: 'Building the session footer',
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const footer = await waitFor(() => screen.getByTestId('session-chat-footer'));
      expect(footer.textContent).toContain('gui-chat-controls');
      expect(footer.textContent).toContain('👑');
      expect(footer.textContent).toContain('gui-chat-session-controls-2026-07-25');
      expect(footer.textContent).toContain('ctx 20%');
      expect(footer.textContent).toContain('1/2');
      expect(footer.textContent).toContain('Building the session footer');
    });

    it('never renders the always-armed inbox-wake as a blocked-on gate (isInfrastructureAwait)', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'coord:inbox-wake:su-live-1',
            note: null,
            sinceIso: new Date().toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const footer = await waitFor(() => screen.getByTestId('session-chat-footer'));
      expect(footer.textContent).not.toContain('Waiting on');
      expect(footer.textContent).not.toContain('coord:inbox-wake');
    });

    it('renders a real open-await note as the blocked-on line', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: new Date().toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const footer = await waitFor(() => screen.getByTestId('session-chat-footer'));
      expect(footer.textContent).toContain('waiting for review');
    });

    it('omits the footer entirely when there is no matching roster row (same fallback as the identity chip)', async () => {
      seedRoster([{ ownerId: 'su-someone-else' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-footer')).toBeNull();
    });
  });

  it('the composer sends a coord:send to the resolved owner with wake:"required"', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    mockFetchOnce(200, { ok: true, msg_id: 'm1' });
    const input = screen.getByPlaceholderText(/Type to wake su · live-1/i);
    fireEvent.change(input, { target: { value: 'hey, can you clarify X?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/admin/coord/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            to: ['su-live-1'],
            summary: 'hey, can you clarify X?',
            body: 'hey, can you clarify X?',
            wake: 'required',
          }),
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/Sent — the agent is woken/)).toBeTruthy());
  });

  it('surfaces a coord:send failure instead of silently dropping the message', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'send failed' });
    const input = screen.getByPlaceholderText(/Type to wake/i);
    fireEvent.change(input, { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/coord:send.*500/)).toBeTruthy());
  });

  it('calls onClose when the dialog is dismissed', async () => {
    mockFetchOnce(200, { sessions: [] });
    const onClose = vi.fn();
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  describe('P-008 chat:ask_choice card rendering (mcp-mangled tool names)', () => {
    it('renders the AskChoiceCard (not a plain chip) for a raw mcp-mangled tool_use in the live transcript', async () => {
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());

      act(() => {
        captured!.handlers.backfill!(
          JSON.stringify([
            { kind: 'prompt', text: 'owner asks something' },
            {
              // What Claude's own tool_use block actually carries for an
              // MCP-routed call — the client-mangled id, never the registry's
              // canonical colon-form 'chat:ask_choice' (gui-chat-session-controls
              // -2026-07-25 P-008: this is why the card silently never rendered).
              kind: 'tool_use',
              toolName: 'mcp__papercusp-su__chat_ask_choice',
              toolInput: {
                question: 'Which route?',
                options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
              },
            },
          ]),
        );
      });

      await waitFor(() => expect(screen.getByText('Which route?')).toBeTruthy());
      expect(screen.getByText('Option A')).toBeTruthy();
      expect(screen.getByText('Option B')).toBeTruthy();
    });
  });

  describe('P-008 cards in the popup', () => {
    it('renders this owner\'s pending coord-escalation-with-options inline via the shared OtherDetail card', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const card = screen.getByTestId('other-detail');
      expect(card.getAttribute('data-item')).toBe('esc-1');
    });

    it('answering the inline card (onResolved) refreshes the shared attention feed', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('other-detail')).toBeTruthy());
      fireEvent.click(screen.getByTestId('stub-resolve'));
      expect(attentionInvalidate).toHaveBeenCalled();
    });

    it('ignores an escalation belonging to a DIFFERENT agent', async () => {
      seedAttention([mkEscalation('esc-other', { ownerAgentId: 'su-someone-else' })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('ignores an already-handled escalation', async () => {
      seedAttention([mkEscalation('esc-handled', { tier: 'handled' })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('ignores a coord-escalation with no named options (nothing to pick)', async () => {
      seedAttention([mkEscalation('esc-no-opts', { ref: { kind: 'coord-escalation', options: [] } })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('ignores a non-escalation attention item (e.g. a coord-message) for the same owner', async () => {
      seedAttention([mkEscalation('msg-1', { kind: 'coord-message', ref: { kind: 'coord-message', msgId: 'm1' } })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent Claude session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('renders no pending-escalations section while closed (sessionOwnerId null)', () => {
      seedAttention([mkEscalation('esc-1')]);
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });
  });

  describe('P-008 ref-pill popup routing (chat-ref-pills-2026-07-26, D-002 seam)', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('scopes a WI- ref pill click to the roster entry\'s harnessSlug', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member', harnessSlug: 'papercusp' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see WI-1234 for detail' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('WI-1234'));
      fireEvent.click(pill);

      expect(lastWorkItemPopupProps.id).toBe('WI-1234');
      expect(lastWorkItemPopupProps.harnessSlug).toBe('papercusp');
    });

    it('renders a static (non-clickable) pill when the roster entry has no harnessSlug', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member', harnessSlug: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see WI-1234 for detail' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('WI-1234'));
      // No harnessSlug ⇒ OperatorChat's handleWorkRefActivate no-ops rather
      // than opening a popup pointed at no harness — but ChatConversation
      // still WIRES onWorkRefActivate (renders an interactive <button>); the
      // click itself is the thing that safely does nothing.
      fireEvent.click(pill);
      expect(lastWorkItemPopupProps.id ?? null).toBeNull();
    });
  });
});
