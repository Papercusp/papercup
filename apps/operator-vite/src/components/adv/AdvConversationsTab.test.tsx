// @vitest-environment jsdom
//
// AdvConversationsTab render coverage — the /adv Conversations tab's simplified
// design. Mounts the tab against a realistic dev.coordFeed snapshot (useSyncQuery
// + nuqs mocked, the pinned sibling pattern — see admin/GitClient.test.tsx) and
// asserts:
//   - the unified inbox is the default front door,
//   - the stale "Needs you" pill is gone (its home is now Create → Queue),
//   - the Raw events log is set apart but keeps raw traffic reachable,
//   - human category filters replace the raw 12-kind wall by default,
//   - a BROADCAST row is marked, and a "→ human" escalation is highlighted,
//   - the plan-slug chip renders,
//   - an ack groups under its parent as a reply (related_msg_id chain),
//   - one curated Conversations view replaces the source-specific sub-tabs,
//   - each source remains legible through a type pill on its unified row.
// Guards against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// nuqs: every useQueryState call needs the adapter context — stub each param to
// a stable [value, noop]. The component reads `conv` (view), the activity filters
// (fkind array, fadvanced, fagent/fplan/fq strings, fmsg selection). Default view is inbox.
const nuqsState: Record<string, unknown> = {
  conv: 'inbox',
  fkind: [],
  fadvanced: 'closed',
  fagent: '',
  fplan: '',
  fq: '',
  fmsg: null,
  // the new communication views' selection/filter params
  conversation: null,
  cstate: 'open',
  ckind: 'all',
  ctopic: '',
  thread: null,
  acharness: '',
  acrole: '',
  chat: null,
  msg: null,
  cq: '',
  cvf: {},
  opc: null,
};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
const { setQueryStates } = vi.hoisted(() => ({ setQueryStates: vi.fn() }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqsState[key], vi.fn()],
  useQueryStates: (parsers: Record<string, unknown>) => [
    Object.fromEntries(Object.keys(parsers).map((key) => [key, nuqsState[key]])),
    setQueryStates,
  ],
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsArrayOf: () => ({ withDefault: () => ({}) }),
  createParser: () => ({ withDefault: () => ({}) }),
}));

const TS = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
/** The moment the fixtures below froze (module import). The day-separator test
 *  pins Date to THIS so "minutes-old" rows and the component's "today" always
 *  share a UTC day — see the ⏰ note on that test. */
const FIXTURE_NOW = Date.now();

// A cross-channel snapshot: one of every salient kind, newest-first, with an ack
// whose related_msg_id points at the direct message (the thread-grouping case).
const directMsg = {
  ts: TS(9),
  msg_id: 'm-direct',
  from: 'system:coordinator',
  to: ['worker'],
  kind: 'message',
  surface: 'messages',
  broadcast: false,
  summary: 'please pick up the auth refactor',
};
const feedRows = [
  {
    ts: TS(1),
    msg_id: 'm-bc',
    from: 'system:release',
    to: ['*'],
    kind: 'message',
    surface: 'messages',
    broadcast: true,
    summary: 'fleet-wide: staging is green',
    // _meta rides on row[0] (the resolver contract).
    _meta: {
      total: 6,
      byKind: { message: 2, ack: 1, notify: 1, handoff: 1, escalation: 1 },
      nextCursor: TS(99),
    },
  },
  {
    ts: TS(2),
    msg_id: 'm-esc',
    from: 'system:gate',
    to: ['human'],
    kind: 'escalation',
    surface: 'escalations',
    broadcast: false,
    summary: 'need a decision on the schema migration',
    plan_slug: 'auth-refactor-2026',
  },
  {
    ts: TS(3),
    msg_id: 'm-notify',
    from: 'system:build',
    to: ['architect'],
    kind: 'notify',
    surface: 'messages',
    broadcast: false,
    summary: 'build finished',
  },
  {
    ts: TS(4),
    msg_id: 'm-handoff',
    from: 'system:scheduler',
    to: ['worker'],
    kind: 'handoff',
    surface: 'handoffs',
    broadcast: false,
    summary: 'handing off the UI work',
    plan_slug: 'auth-refactor-2026',
  },
  {
    ts: TS(8),
    msg_id: 'm-ack',
    from: 'system:delivery',
    to: ['architect'],
    kind: 'ack',
    surface: 'messages',
    broadcast: false,
    related_msg_id: 'm-direct', // groups under directMsg
    summary: 'got it',
  },
  directMsg,
];

let mockResult: Record<string, unknown> = {
  data: feedRows,
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
  transport: 'SSE',
};
const ready = (data: unknown[] = []): Record<string, unknown> => ({
  data,
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
  transport: 'SSE',
});
const syncKey = (queryName: string, args: Record<string, unknown> = {}) => `${queryName}:${JSON.stringify(args)}`;
let syncResults: Record<string, Record<string, unknown>> = {};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args = {}, enabled = true }: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    if (queryName === 'dev.coordFeed') return mockResult;
    if (!enabled) return ready();
    return syncResults[syncKey(queryName, args)] ?? syncResults[queryName] ?? ready();
  },
}));

// @tanstack/react-virtual: the agent-chats rail (U1) renders through a
// virtualized RichGrid (virtualMode). jsdom has no layout engine, so the REAL
// virtualizer sees a zero-height scroll container and yields no virtual items —
// the rail renders nothing and the row text can't be found. Mock useVirtualizer
// to yield one VirtualItem per row so the full window mounts under test. This
// mirrors grid-core's own RichGrid.virtual.test.tsx, which feeds a stub
// virtualizer rather than faking DOM geometry (jsdom can't drive the real one).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => {
    const ROW = 104;
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      key: getItemKey?.(index) ?? `vrow-${index}`,
      start: index * ROW,
      end: index * ROW + ROW,
      size: ROW,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * ROW,
      measureElement: () => {},
      measure: () => {},
      scrollToIndex: () => {},
    };
  },
}));

// WI-125: a LIVE agent chat embeds the real interactive <ChatPanel>; stub it so
// these tests assert the tab's live-vs-archived routing, not ChatPanel itself
// (it has its own data needs + suite).
vi.mock('@/app/harness/ChatPanel', () => ({
  default: ({ slug, chatId }: { slug: string; chatId: string }) => (
    <div data-testid="chat-panel-stub">{`live-chat:${slug}:${chatId}`}</div>
  ),
}));

import AdvConversationsTab, { composeUnifiedConversationRows, isSystemConversationActor } from './AdvConversationsTab';

beforeEach(() => {
  setQueryStates.mockReset();
  nuqsState.conv = 'inbox';
  nuqsState.fkind = [];
  nuqsState.fadvanced = 'closed';
  nuqsState.fagent = '';
  nuqsState.fplan = '';
  nuqsState.fq = '';
  nuqsState.fmsg = null;
  nuqsState.cq = '';
  nuqsState.cvf = {};
  nuqsState.conversation = null;
  nuqsState.cstate = 'open';
  nuqsState.ckind = 'all';
  nuqsState.ctopic = '';
  nuqsState.thread = null;
  nuqsState.acharness = '';
  nuqsState.acrole = '';
  nuqsState.chat = null;
  nuqsState.msg = null;
  nuqsState.opc = null;
  mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
  syncResults = {
    'conversations.questionsList': ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: 'why does the watchdog recycle the host?', asker_id: 'oracle', topics: ['infra'],
      promoted_issue_id: null, created_ts: new Date(Date.now() - 120_000).toISOString(),
      updated_ts: new Date(Date.now() - 120_000).toISOString(),
    }]),
    'conversations.deliberationList': ready(),
    'conversations.agentChatList': ready(),
    'conversations.messageList': ready([{
      id: 'msg-1', harness_slug: 'papercusp', from_slug: 'architect', to_slug: 'worker', to_role: null,
      kind: 'handoff', subject: 'pick up the UI work', body: 'the scoping is done, your turn', status: 'delivered',
      created_at: new Date(Date.now() - 60_000).toISOString(), from_feature_id: 'F-042', to_feature_id: 'F-042',
    }]),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [] }) })));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvConversationsTab — Create-style shell', () => {
  it('opens on the unified inbox with the compact source rail and + Ask action', () => {
    render(<AdvConversationsTab />);

    // design-pass (2026-06-23): the tab now mirrors the Create dock's sidebar│main
    // model. The in-body <h1> is gone — the page title lives in the AdvShell header
    // (same as Create) — so there is no heading inside the tab body.
    expect(screen.queryByRole('heading', { name: 'Conversations' })).toBeNull();
    // The Create-style primary action ("+ New plan" ⇒ "+ Ask").
    expect(screen.getByRole('button', { name: /Ask the agents/i })).toBeTruthy();
    // The view switcher moved into the sidebar rail (still role=tab).
    expect(screen.getByRole('tab', { name: 'Conversations', selected: true })).toBeTruthy();
    // The raw event log is relabelled + set apart, but still reachable.
    expect(screen.getByRole('tab', { name: 'Raw events' })).toBeTruthy();
    // The stale "Needs you" pill is removed — its canonical home is Create → Queue.
    expect(screen.queryByRole('button', { name: /Needs you/i })).toBeNull();
    // The active view's section header still labels the rail.
    expect(screen.getByText('pick up the UI work')).toBeTruthy();
    expect(screen.getByText('why does the watchdog recycle the host?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open pick up the UI work' })).toBeTruthy();
  });

  it('opens a unified row with one atomic view + selection route update', () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open pick up the UI work' }));
    expect(setQueryStates).toHaveBeenCalledTimes(1);
    expect(setQueryStates).toHaveBeenCalledWith({
      conv: 'messages',
      conversation: null,
      thread: null,
      chat: null,
      msg: 'msg-1',
      fmsg: null,
    });
  });

  it('keeps the same conversation list DOM mounted while the selected detail changes', async () => {
    syncResults[syncKey('conversations.messageDetail', { id: 'msg-1' })] = ready([{
      id: 'msg-1', harness_slug: 'papercusp', from_slug: 'architect', to_slug: 'worker', to_role: null,
      kind: 'handoff', subject: 'pick up the UI work', body: 'the scoping is done, your turn', status: 'delivered',
      created_at: new Date().toISOString(), from_feature_id: 'F-042', to_feature_id: 'F-042',
    }]);
    const { rerender } = render(<AdvConversationsTab />);
    const listBefore = screen.getByRole('region', { name: 'Conversation list' });
    const rowBefore = screen.getByRole('button', { name: 'Open pick up the UI work' });

    nuqsState.conv = 'messages';
    nuqsState.msg = 'msg-1';
    rerender(<AdvConversationsTab />);

    expect(screen.getByRole('region', { name: 'Conversation list' })).toBe(listBefore);
    expect(screen.getByRole('button', { name: 'Open pick up the UI work' })).toBe(rowBefore);
    expect(rowBefore.getAttribute('aria-current')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'pick up the UI work' })).toBeTruthy();
  });

  it('clears every source-owned selection atomically when returning to Conversations', () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'issue-thread-EI-9534';
    nuqsState.conversation = 'conv-from-an-earlier-qa-visit';
    nuqsState.chat = 'chat-from-an-earlier-agent-visit';
    nuqsState.msg = 'message-from-an-earlier-message-visit';
    nuqsState.fmsg = 'event-from-an-earlier-feed-visit';

    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('tab', { name: 'Conversations' }));

    expect(setQueryStates).toHaveBeenCalledWith({
      conv: 'inbox',
      conversation: null,
      thread: null,
      chat: null,
      msg: null,
      fmsg: null,
    });
  });

  it('turns an indefinitely pending initial inbox read into a retryable state', async () => {
    vi.useFakeTimers();
    for (const name of [
      'conversations.questionsList',
      'conversations.deliberationList',
      'conversations.agentChatList',
      'conversations.messageList',
    ]) {
      syncResults[name] = { data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'SSE' };
    }
    render(<AdvConversationsTab />);
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(8_000); });

    expect(screen.getByText("Couldn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload conversations' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps one curated view and one subordinate diagnostic view in the rail', () => {
    render(<AdvConversationsTab />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Raw events' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Q&A' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Deliberations' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Agent chats' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Messages' })).toBeNull();
  });

  // The primary communication surfaces form one visual set; the diagnostic raw
  // stream is subordinate inside the same accessible tablist. No heading/copy is
  // added to explain the split — hierarchy does that work.
  it('groups primary views separately from the subordinate diagnostic view', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).not.toContain('pc-advconv__viewtabs');
    const navRule = styles.match(/\.pc-advconv__nav\s*{[^}]*}/)?.[0] ?? '';
    expect(navRule).toContain('width:');
    const tablist = screen.getByRole('tablist', { name: 'Conversations view' });
    const primary = tablist.querySelector('.pc-advconv__nav-primary');
    const diagnostic = tablist.querySelector('.pc-advconv__nav-diagnostic');
    const conversations = screen.getByRole('tab', { name: 'Conversations' });
    const raw = screen.getByRole('tab', { name: 'Raw events' });
    expect(primary?.contains(conversations)).toBe(true);
    expect(primary?.contains(raw)).toBe(false);
    expect(diagnostic?.contains(raw)).toBe(true);
    const btnRule = styles.match(/\.pc-advconv__navbtn\s*{[^}]*}/)?.[0] ?? '';
    expect(btnRule).toContain('width: 40px');
    expect(styles).toContain('.pc-advconv__navbtn.is-active::before');
    expect(styles).toContain('.pc-advconv__navlabel { display: none; }');
    const shellRule = styles.match(/\.pc-advconv__shell\s*{[^}]*}/)?.[0] ?? '';
    expect(shellRule).toContain('min-width: 760px');
    expect(styles).not.toContain('.pc-advconv__shell:not(.is-detail-open) .pc-advconv__main:not(.pc-advconv__main--wide)');
    expect(styles).not.toContain('.pc-advconv__shell.is-detail-open .pc-advconv__inbox');
    expect(styles).not.toContain('.pc-advconv__shell.is-detail-open .pc-advconv__back');
  });

  it('connects the selected tab to one labelled detail panel', () => {
    render(<AdvConversationsTab />);
    const selected = screen.getByRole('tab', { name: 'Conversations', selected: true });
    const panel = screen.getByRole('tabpanel');
    expect(selected.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
  });

  it('opens the Ask composer from the + Ask action', async () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: /Ask the agents/i }));
    expect(await screen.findByPlaceholderText(/What do you want to ask the fleet/i)).toBeTruthy();
  });

  it('uses the semantic accent token instead of a component-local brand color', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const rootRule = styles.match(/\.pc-advconv\s*{[^}]*}/)?.[0] ?? '';
    expect(rootRule).toContain('--advconv-accent: var(--accent)');
    expect(rootRule).not.toContain('#ec4899');
  });

  it('shows the Raw events log as the set-apart view with grouped filters', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    expect(screen.getByText(/System coordination messages for debugging/i)).toBeTruthy();
    expect(screen.getByText(/6 matching/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Messages/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Handoffs/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Escalations/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Plan events/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advanced \/ all kinds/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^ack/i })).toBeNull();
  });

  it('keeps Activity search compact instead of using the old wide field', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    const search = screen.getByLabelText('Free-text search');
    expect(search.getAttribute('type')).toBe('search');
    expect(search.closest('label')?.className).toContain('pc-advfeed__field--search');
    expect(search.closest('label')?.className).not.toContain('pc-advfeed__field--wide');
  });

  it('shows raw kind filters only when the advanced URL state is open', () => {
    nuqsState.conv = 'feed';
    nuqsState.fadvanced = 'open';
    render(<AdvConversationsTab />);

    expect(screen.getByRole('button', { name: /^ack/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /handoff/i }).length).toBeGreaterThan(1);
  });

  it('shows channel summaries and kind badges in the Raw events log', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    // Summaries from each surface render.
    expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
    expect(screen.getByText('need a decision on the schema migration')).toBeTruthy();
    expect(screen.getByText('build finished')).toBeTruthy();
    expect(screen.getByText('handing off the UI work')).toBeTruthy();

    // Row badges still carry the raw event kind.
    const handoffChips = screen.getAllByText('handoff');
    expect(handoffChips.length).toBeGreaterThan(0);
  });

  it('marks a broadcast row and highlights a "→ human" escalation', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    expect(screen.getByText('BROADCAST')).toBeTruthy();
    expect(screen.getByText('→ human')).toBeTruthy();
  });

  it('renders the plan-slug chip on plan-scoped rows', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    // Two rows carry the slug (escalation + handoff) → at least one chip.
    expect(screen.getAllByText('auth-refactor-2026').length).toBeGreaterThan(0);
  });

  it('groups an ack under its parent message as a reply (related_msg_id chain)', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    // The ack is a CHILD of m-direct → it must NOT be a top-level summary row,
    // but the parent shows a "1 reply" marker.
    expect(screen.getByText('please pick up the auth refactor')).toBeTruthy();
    expect(screen.getByText(/1 reply/i)).toBeTruthy();
    // The ack's own summary ("got it") is not a standalone root row.
    expect(screen.queryByText('got it')).toBeNull();
  });

  // Regression: a Colony/Swarm message click deep-links with ?conv=feed&fmsg=<msg>.
  // When that message is a folded reply/ack (related_msg_id chain), there is no
  // top-level row for the child id — so the expand-set must resolve child→ROOT and
  // open the PARENT conversation. Before the fix, ?fmsg=<childId> matched no row and
  // nothing expanded ("clicking the message brings up the wrong/no conversation").
  it('expands the parent conversation when ?fmsg targets a folded reply (child→root)', () => {
    nuqsState.conv = 'feed';
    nuqsState.fmsg = 'm-ack'; // m-ack is a CHILD of m-direct (folded under it)
    render(<AdvConversationsTab />);
    // The parent conversation opens in the master/detail pane (WI-4216 redesign —
    // NOT an inline expand), so the parent summary legitimately appears twice
    // (list row + detail pane). Scope to the detail pane to assert the PARENT
    // opened there…
    const detail = document.querySelector('.pc-advfeed__detailpane') as HTMLElement | null;
    expect(detail).toBeTruthy();
    expect(within(detail!).getByText('please pick up the auth refactor')).toBeTruthy();
    // …and the clicked reply is now revealed inside the expanded conversation.
    expect(within(detail!).getByText('got it')).toBeTruthy();
  });

  it('shows the empty state when no traffic matches', () => {
    nuqsState.conv = 'feed';
    mockResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText(/No matching traffic/i)).toBeTruthy();
    expect(screen.getByText(/broaden the search/i)).toBeTruthy();
  });

  it('shows a "Load older" control when the server reports more rows', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    expect(screen.getByText(/Load older/i)).toBeTruthy();
  });

  // U1 (operator-vite-ui-consolidation): the feed is flattened into a single
  // virtualized RichGrid stream where each day contributes a separator row before
  // its events. All snapshot rows are minutes old → one "Today" separator.
  //
  // ⏰ Date is PINNED to the fixtures' freeze moment (Date-only fake; real timers
  // stay live for the virtualizer): the fixtures freeze at module IMPORT while the
  // component computes UTC day-keys at RENDER — on an EDT box from 20:00 local
  // (00:00 UTC) the "minutes-old" rows land on the PREVIOUS UTC day, the component
  // correctly says "Yesterday", and the bare getByText('Today') red-pinned the
  // whole green gate every evening (12h red, 2026-07-01).
  it('renders a day separator row in the virtualized activity stream', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] });
    try {
      nuqsState.conv = 'feed';
      render(<AdvConversationsTab />);
      expect(screen.getByText('Today')).toBeTruthy();
      // The events still render beneath it (the flatten preserved the items).
      expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── The unified communication views (every type, not just coord threads) ──────
//
// the-conversations-tab-surfaces-every-comm-type: the tab gained three views that
// read the shared named-query cache: agent chats, work-item messages, and
// deliberations. These guard the new views
// against render-time crashes the typecheck can't catch and assert each one
// surfaces its data.

/** Adapt the old endpoint-shaped fixtures into the named-query row contract. */
function stubComms(byUrl: Record<string, unknown>) {
  for (const [path, raw] of Object.entries(byUrl)) {
    const payload = raw as Record<string, unknown>;
    if (path.includes('/threads/list')) syncResults['conversations.deliberationList'] = ready((payload.items as unknown[]) ?? []);
    if (path.includes('/threads/get')) syncResults['conversations.deliberationDetail'] = ready([payload]);
    if (path.includes('/agent-chats/list')) syncResults['conversations.agentChatList'] = ready((payload.items as unknown[]) ?? []);
    if (path.includes('/agent-chats/get')) syncResults['conversations.agentChatDetail'] = ready(payload.chat ? [payload.chat] : []);
    if (path.includes('/messages/list')) syncResults['conversations.messageList'] = ready((payload.items as unknown[]) ?? []);
    if (path.includes('/messages/get')) syncResults['conversations.messageDetail'] = ready(payload.message ? [payload.message] : []);
    if (path.includes('/coordination/conversations/list')) syncResults['conversations.questionsList'] = ready((payload.conversations as unknown[]) ?? []);
    if (path.includes('/coordination/conversations/get')) {
      const conversation = payload.conversation as Record<string, unknown> | undefined;
      syncResults['conversations.questionDetail'] = ready(conversation ? [{
        ...conversation,
        topics: payload.topics ?? [],
        posts: payload.posts ?? [],
        subscriber_count: payload.subscriber_count ?? 0,
      }] : []);
    }
  }
}

describe('AdvConversationsTab — unified communication views', () => {
  it('exposes each communication type as a pill instead of a navigation tab', () => {
    syncResults['conversations.deliberationList'] = ready([{
      thread_id: 'th-pill', parent_kind: 'decision', parent_ref: 'WI-7', title: 'choose the release path',
      created_by: 'architect', harness_slug: 'papercusp', created_at: TS(4), last_post_at: TS(3), post_count: 3,
    }]);
    syncResults['conversations.agentChatList'] = ready([{
      id: 'chat-pill', harness_slug: 'papercusp', role: 'worker', feature_id: 'WI-8', title: 'implement the release path',
      created_at: Date.now() - 120_000, archived_at: null, total_input_tokens: 0, total_output_tokens: 0,
      total_cost_usd_cents: 0, turns: 6,
    }]);
    render(<AdvConversationsTab />);
    expect(screen.getByText('Questions & discussions')).toBeTruthy();
    expect(screen.getByText('Group decisions')).toBeTruthy();
    expect(screen.getByText('Agent chat')).toBeTruthy();
    expect(screen.getByText('Work-item mail')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Agent chats/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /Raw events/i })).toBeTruthy();
  });

  it('deduplicates semantic copies across timestamps without collapsing distinct content', () => {
    const base = {
      id: 'msg-a', harness_slug: 'papercusp', from_slug: 'architect', to_slug: 'worker', to_role: null,
      kind: 'handoff', subject: 'release path', body: 'please take this', status: 'delivered',
      created_at: '2026-07-11T12:00:00.000Z', from_feature_id: 'WI-7', to_feature_id: 'WI-7',
    };
    const rows = composeUnifiedConversationRows([], [], [], [
      base,
      { ...base },
      { ...base, id: 'msg-b', created_at: '2026-07-11T13:00:00.000Z' },
      { ...base, id: 'msg-c', body: 'a separate follow-up' },
    ], 50);

    expect(rows.map((row) => row.sourceId)).toEqual(['msg-b', 'msg-c']);
  });

  it('positions virtual rows without compositor transforms and keys them by conversation identity', () => {
    render(<AdvConversationsTab />);
    const row = screen.getByRole('button', { name: 'Open pick up the UI work' });
    expect(row.style.top).not.toBe('');
    expect(row.style.transform).toBe('');
  });

  it('shows the selected synchronized row in the detail pane while its detail query warms', () => {
    nuqsState.conv = 'threads';
    nuqsState.conversation = 'c-1';
    syncResults['conversations.questionDetail'] = {
      data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'SSE',
    };

    render(<AdvConversationsTab />);

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'why does the watchdog recycle the host?' })).toBeTruthy();
    expect(within(panel).getByRole('status', { name: 'Loading conversation' })).toBeTruthy();
  });

  it('partitions system-origin records out of every curated conversation source', () => {
    expect(isSystemConversationActor('system:watchdog')).toBe(true);
    expect(isSystemConversationActor('system-release')).toBe(true);
    expect(isSystemConversationActor('architect')).toBe(false);
    const rows = composeUnifiedConversationRows(
      [{ id: 'system-question', kind: 'question', state: 'open', scope: 'workspace', harness_slug: null, title: 'health tick', asker_id: 'system:watchdog', topics: [], promoted_issue_id: null, created_ts: TS(1), updated_ts: TS(1) }],
      [{ thread_id: 'agent-thread', parent_kind: null, parent_ref: null, title: 'agent decision', created_by: 'architect', harness_slug: null, created_at: TS(2), last_post_at: null, post_count: 1 }],
      [],
      [{ id: 'system-mail', harness_slug: null, from_slug: 'system-scheduler', to_slug: 'worker', to_role: null, kind: 'notify', subject: 'tick', body: null, status: 'sent', created_at: TS(3), from_feature_id: null, to_feature_id: null }],
      50,
    );
    expect(rows.map((row) => row.sourceId)).toEqual(['agent-thread']);
  });

  it('does not let a busy source crowd other conversation types out of the merged window', () => {
    syncResults['conversations.deliberationList'] = ready(Array.from({ length: 100 }, (_, index) => ({
      thread_id: `th-${index}`,
      parent_kind: 'issue',
      parent_ref: `WI-${index}`,
      title: `decision ${index}`,
      created_by: 'architect',
      harness_slug: 'papercusp',
      created_at: new Date(Date.now() - index * 1_000).toISOString(),
      last_post_at: new Date(Date.now() - index * 1_000).toISOString(),
      post_count: 1,
    })));
    syncResults['conversations.agentChatList'] = ready([{
      id: 'older-chat', harness_slug: 'papercusp', role: 'worker', feature_id: 'WI-older',
      title: 'older agent chat remains discoverable', created_at: Date.now() - 86_400_000,
      archived_at: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 2,
    }]);

    render(<AdvConversationsTab />);

    expect(screen.getByText('older agent chat remains discoverable')).toBeTruthy();
    expect(screen.getByText('103')).toBeTruthy();
  });

  it('Deliberations view lists threads and opens its posts', async () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'th-1';
    stubComms({
      '/comms/threads/list': {
        items: [
          {
            thread_id: 'th-1',
            parent_kind: 'issue',
            parent_ref: 'ISS-7',
            title: 'memory-watchdog recycles the host',
            created_by: 'oracle',
            harness_slug: 'papercup',
            created_at: new Date().toISOString(),
            last_post_at: new Date().toISOString(),
            post_count: 2,
          },
        ],
      },
      '/comms/threads/get': {
        thread: {
          thread_id: 'th-1',
          parent_kind: 'issue',
          parent_ref: 'ISS-7',
          title: 'memory-watchdog recycles the host',
          created_by: 'oracle',
          harness_slug: 'papercup',
          created_at: new Date().toISOString(),
          last_post_at: new Date().toISOString(),
          post_count: 2,
        },
        posts: [
          { id: 1, author_id: 'oracle', body: 'the host recycles every 12m', created_at: new Date().toISOString(), harness_slug: 'papercup' },
          { id: 2, author_id: 'worker', body: 'looks like the watchdog threshold', created_at: new Date().toISOString(), harness_slug: 'papercup' },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('the host recycles every 12m')).toBeTruthy();
    expect(screen.getByText('looks like the watchdog threshold')).toBeTruthy();
  });

  it('keys deliberation detail by the current selected id', async () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'th-a';
    const detail = (id: string, body: string) => ({
      thread: { thread_id: id, title: id, parent_kind: null, parent_ref: null, created_by: null, harness_slug: null, created_at: new Date().toISOString(), last_post_at: null, post_count: 1 },
      posts: [{ id: id === 'th-a' ? 1 : 2, author_id: 'worker', body, created_at: new Date().toISOString(), harness_slug: null }],
    });
    syncResults[syncKey('conversations.deliberationDetail', { id: 'th-a' })] = ready([detail('th-a', 'stale detail')]);
    syncResults[syncKey('conversations.deliberationDetail', { id: 'th-b' })] = ready([detail('th-b', 'newest detail')]);
    const { rerender } = render(<AdvConversationsTab />);
    expect(await screen.findByText('stale detail')).toBeTruthy();
    nuqsState.thread = 'th-b';
    rerender(<AdvConversationsTab />);
    expect(await screen.findByText('newest detail')).toBeTruthy();
    expect(screen.queryByText('stale detail')).toBeNull();
  });

  it('keeps agent chats in Conversations after removing their standalone view', async () => {
    stubComms({
      '/comms/agent-chats/list': {
        items: [
          {
            id: 'chat-1',
            harness_slug: 'papercup',
            role: 'worker',
            feature_id: 'F-042',
            title: 'implement the auth refactor',
            created_at: Date.now() - 3_600_000,
            archived_at: null,
            total_input_tokens: 1200,
            total_output_tokens: 800,
            total_cost_usd_cents: 34,
            turns: 6,
          },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('implement the auth refactor')).toBeTruthy();
    expect(screen.getAllByText('worker').length).toBeGreaterThan(0);
    expect(screen.getByText('Agent chat')).toBeTruthy();
    expect(screen.queryByText('Agent Chat Sessions')).toBeNull();
  });

  it('keeps the unified list mounted while a source refresh is in flight', async () => {
    const invalidate = vi.fn();
    syncResults['conversations.agentChatList'] = {
      ...ready([{
        id: 'chat-stable',
        harness_slug: 'papercusp',
        role: 'worker',
        feature_id: 'F-100',
        title: 'stable conversation row',
        created_at: Date.now(),
        archived_at: null,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd_cents: 0,
        turns: 1,
      }]),
      fetching: true,
      invalidate,
    };

    render(<AdvConversationsTab />);
    expect(await screen.findByText('stable conversation row')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload conversations' }));

    // The previous implementation swapped the complete rail for skeletons here,
    // producing the visible button flash on every slow refresh.
    expect(screen.getByText('stable conversation row')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('Agent chats view renders an ARCHIVED transcript read-only (no composer)', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-1';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-1',
          harness_slug: 'papercup',
          role: 'worker',
          feature_id: 'F-042',
          title: 'implement the auth refactor',
          created_at: Date.now(),
          archived_at: Date.now(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [
            { ts: new Date().toISOString(), role: 'user', content: 'start the refactor' },
            { ts: new Date().toISOString(), role: 'assistant', content: 'on it — opening the module' },
          ],
        },
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('start the refactor')).toBeTruthy();
    expect(screen.getByText('on it — opening the module')).toBeTruthy();
    // archived → no interactive panel
    expect(screen.queryByTestId('advconv-live-chat')).toBeNull();
  });

  it('keys agent-chat detail by the current selected id', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-a';
    const chat = (id: string, content: string) => ({
      id,
      harness_slug: null,
      role: 'worker',
      feature_id: null,
      title: id,
      created_at: Date.now(),
      archived_at: Date.now(),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd_cents: 0,
      turns: 1,
      transcript: [{ role: 'assistant', content }],
    });
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-a' })] = ready([chat('chat-a', 'stale chat detail')]);
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-b' })] = ready([chat('chat-b', 'newest chat detail')]);
    const { rerender } = render(<AdvConversationsTab />);
    expect(await screen.findByText('stale chat detail')).toBeTruthy();
    nuqsState.chat = 'chat-b';
    rerender(<AdvConversationsTab />);
    expect(await screen.findByText('newest chat detail')).toBeTruthy();
    expect(screen.queryByText('stale chat detail')).toBeNull();
  });

  // WI-125: the conversations tab is no longer a read-only transcript browser —
  // a LIVE chat embeds the interactive ChatPanel (transcript + composer).
  it('Agent chats view embeds the interactive ChatPanel for a LIVE chat', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-1';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-1',
          harness_slug: 'papercup',
          role: 'worker',
          feature_id: 'F-042',
          title: 'implement the auth refactor',
          created_at: Date.now(),
          archived_at: null,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [{ ts: new Date().toISOString(), role: 'user', content: 'start the refactor' }],
        },
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByTestId('advconv-live-chat')).toBeTruthy();
    // the real ChatPanel (stubbed) gets the harness + chat id
    expect(screen.getByText('live-chat:papercup:chat-1')).toBeTruthy();
    // the read-only transcript is replaced by the live panel
    expect(screen.queryByText('start the refactor')).toBeNull();
  });

  it('a live chat WITHOUT a harness slug falls back to the read-only transcript', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-2';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-2',
          harness_slug: null,
          role: 'worker',
          feature_id: null,
          title: 'workspace chat',
          created_at: Date.now(),
          archived_at: null,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [{ ts: new Date().toISOString(), role: 'user', content: 'hello there' }],
        },
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('hello there')).toBeTruthy();
    expect(screen.queryByTestId('advconv-live-chat')).toBeNull();
  });

  // U1 (operator-vite-ui-consolidation): the threads + deliberations rails now
  // render through the shared virtualized RichGrid (the agent-chats template).
  // This pins that a populated thread rail surfaces its row — title, state pill,
  // and the variable-height topic-tag line — through the grid cell.
  it('Threads view lists conversations through the virtualized rail', async () => {
    nuqsState.conv = 'threads';
    stubComms({
      '/coordination/conversations/list': {
        conversations: [
          {
            id: 'c-1',
            kind: 'question',
            state: 'open',
            scope: 'harness',
            harness_slug: 'papercup',
            title: 'why does the watchdog recycle the host?',
            asker_id: 'oracle',
            topics: ['infra'],
            created_ts: new Date().toISOString(),
          },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('why does the watchdog recycle the host?')).toBeTruthy();
    // the topic tag (the variable-height part of the row) renders in the cell —
    // `#infra` shows up both as the rail's topic-filter chip and the in-row tag.
    expect(screen.getAllByText('#infra').length).toBeGreaterThan(0);
  });

  it('Messages view lists work-item agent messages', async () => {
    nuqsState.conv = 'messages';
    stubComms({
      '/comms/messages/list': {
        items: [
          {
            id: 'msg-1',
            harness_slug: 'papercup',
            from_slug: 'architect',
            to_slug: 'worker',
            to_role: null,
            kind: 'handoff',
            subject: 'pick up the UI work',
            body: 'the scoping is done, your turn',
            status: 'delivered',
            created_at: new Date().toISOString(),
            from_feature_id: 'F-042',
            to_feature_id: 'F-042',
          },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('pick up the UI work')).toBeTruthy();
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getByText('→ worker')).toBeTruthy();
  });

  it('the unified view degrades to one empty state with no data', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = ready();
    syncResults['conversations.agentChatList'] = ready();
    syncResults['conversations.messageList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText('No conversations')).toBeTruthy();
  });

  it('a failed source query surfaces one retryable unified-list error', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = {
      ...ready(),
      error: new Error('HTTP 500'),
    };
    syncResults['conversations.agentChatList'] = ready();
    syncResults['conversations.messageList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText(/Couldn't load/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
    expect(screen.getByText(/HTTP 500/)).toBeTruthy();
  });
});

// ─── picker-kit adoption — the shared Create⇄Conversations visual vocabulary ──────
//
// adopt-picker-kit-in-conversations: the tab adopts the shared picker-kit
// primitives (EmptyState / ErrorBanner / Pill / inputStyle) so it looks + works
// like the Create flow. These pin the user-visible results of that adoption:
// standardized empty states, deep-linkable thread detail (nuqs `?conversation`),
// and the filter chips still toggling via aria-pressed.

describe('AdvConversationsTab — picker-kit adoption', () => {
  it('renders the shared EmptyState (icon + title + desc) for an empty unified view', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = ready();
    syncResults['conversations.agentChatList'] = ready();
    syncResults['conversations.messageList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText('No conversations')).toBeTruthy();
    expect(screen.getByText(/No curated communication is recorded/i)).toBeTruthy();
  });

  it('renders the shared EmptyState for the Raw events log when no traffic matches', () => {
    nuqsState.conv = 'feed';
    mockResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText('No matching traffic')).toBeTruthy();
    expect(screen.getByText(/broaden the search/i)).toBeTruthy();
  });

  // P2.5: the OPEN thread is fully driven by the nuqs `conversation` id, so a
  // refresh / pasted deep-link with `?conversation=<id>` reloads that thread.
  it('deep-links the open Q&A thread from the nuqs `conversation` id', async () => {
    nuqsState.conv = 'threads';
    nuqsState.conversation = 'c-1';
    stubComms({
      '/coordination/conversations/list': { conversations: [] },
      '/coordination/conversations/get': {
        conversation: {
          id: 'c-1',
          kind: 'question',
          state: 'open',
          scope: 'harness',
          harness_slug: 'papercup',
          title: 'why does the watchdog recycle the host?',
          body: 'it recycles roughly every 12 minutes',
          asker_id: 'oracle',
          accepted_answer: null,
          promoted_issue_id: null,
        },
        topics: ['infra'],
        posts: [{ id: 1, author_id: 'worker', body: 'looks like the watchdog threshold', created_ts: new Date().toISOString() }],
        subscriber_count: 2,
      },
    });
    render(<AdvConversationsTab />);
    // The detail pane loaded purely from the URL id — no list click needed.
    expect(await screen.findByText('it recycles roughly every 12 minutes')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /why does the watchdog recycle the host\?/i })).toBeTruthy();
    expect(screen.getByText('looks like the watchdog threshold')).toBeTruthy();
  });

  it('searches the unified projection and exposes the shared advanced filter bar', () => {
    nuqsState.cq = 'watchdog';
    render(<AdvConversationsTab />);
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveProperty('value', 'watchdog');
    expect(screen.getByText('why does the watchdog recycle the host?')).toBeTruthy();
    expect(screen.queryByText('pick up the UI work')).toBeNull();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /column filter/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });
});
