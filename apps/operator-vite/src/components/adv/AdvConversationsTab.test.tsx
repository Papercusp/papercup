// @vitest-environment jsdom
//
// AdvConversationsTab render coverage — the /adv Conversations tab's simplified
// design. Mounts the tab against a realistic dev.coordFeed snapshot (useSyncQuery
// + nuqs mocked, the pinned sibling pattern — see admin/GitClient.test.tsx) and
// asserts:
//   - Q&A is the default front door,
//   - the stale "Needs you" pill is gone (its home is now Create → Queue),
//   - the Raw events log is set apart but keeps raw traffic reachable,
//   - human category filters replace the raw 12-kind wall by default,
//   - a BROADCAST row is marked, and a "→ human" escalation is highlighted,
//   - the plan-slug chip renders,
//   - an ack groups under its parent as a reply (related_msg_id chain),
//   - the view switch shows the curated views + the set-apart Raw events log.
// Guards against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// nuqs: every useQueryState call needs the adapter context — stub each param to
// a stable [value, noop]. The component reads `conv` (view), the activity filters
// (fkind array, fadvanced, fagent/fplan/fq strings, fmsg selection). Default view is threads.
const nuqsState: Record<string, unknown> = {
  conv: 'threads',
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
  opc: null,
};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [nuqsState[key], vi.fn()],
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsArrayOf: () => ({ withDefault: () => ({}) }),
}));

const TS = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// A cross-channel snapshot: one of every salient kind, newest-first, with an ack
// whose related_msg_id points at the direct message (the thread-grouping case).
const directMsg = {
  ts: TS(9),
  msg_id: 'm-direct',
  from: 'architect',
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
    from: 'operator',
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
    from: 'worker',
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
    from: 'operator',
    to: ['architect'],
    kind: 'notify',
    surface: 'messages',
    broadcast: false,
    summary: 'build finished',
  },
  {
    ts: TS(4),
    msg_id: 'm-handoff',
    from: 'architect',
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
    from: 'worker',
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
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => mockResult }));

// @tanstack/react-virtual: the agent-chats rail (U1) renders through a
// virtualized RichGrid (virtualMode). jsdom has no layout engine, so the REAL
// virtualizer sees a zero-height scroll container and yields no virtual items —
// the rail renders nothing and the row text can't be found. Mock useVirtualizer
// to yield one VirtualItem per row so the full window mounts under test. This
// mirrors grid-core's own RichGrid.virtual.test.tsx, which feeds a stub
// virtualizer rather than faking DOM geometry (jsdom can't drive the real one).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const ROW = 64;
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      key: `vrow-${index}`,
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

import AdvConversationsTab from './AdvConversationsTab';

beforeEach(() => {
  nuqsState.conv = 'threads';
  nuqsState.fkind = [];
  nuqsState.fadvanced = 'closed';
  nuqsState.fagent = '';
  nuqsState.fplan = '';
  nuqsState.fq = '';
  nuqsState.fmsg = null;
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
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [] }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvConversationsTab — Create-style shell', () => {
  it('opens on Q&A with the persistent nav sidebar, the + Ask action, and the view switcher', () => {
    render(<AdvConversationsTab />);

    // design-pass (2026-06-23): the tab now mirrors the Create dock's sidebar│main
    // model. The in-body <h1> is gone — the page title lives in the AdvShell header
    // (same as Create) — so there is no heading inside the tab body.
    expect(screen.queryByRole('heading', { name: 'Conversations' })).toBeNull();
    // The Create-style primary action ("+ New plan" ⇒ "+ Ask").
    expect(screen.getByRole('button', { name: /Ask the agents/i })).toBeTruthy();
    // The view switcher moved into the sidebar rail (still role=tab).
    expect(screen.getByRole('tab', { name: 'Q&A' })).toBeTruthy();
    // The raw event log is relabelled + set apart, but still reachable.
    expect(screen.getByRole('tab', { name: 'Raw events' })).toBeTruthy();
    // The stale "Needs you" pill is removed — its canonical home is Create → Queue.
    expect(screen.queryByRole('button', { name: /Needs you/i })).toBeNull();
    // The active view's section header still labels the rail.
    expect(screen.getByText(/Question & discussion threads/i)).toBeTruthy();
  });

  // The five views each get a switcher button in the sidebar rail (labels are
  // pinned copy; the per-view one-liner is now the button's tooltip, mirroring
  // Create's tooltip'd Plans/Queue/Sessions buttons).
  it('renders a switcher button for every view', () => {
    const LABELS = ['Q&A', 'Deliberations', 'Agent chats', 'Messages', 'Raw events'];
    render(<AdvConversationsTab />);
    for (const label of LABELS) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  // design-pass: the old horizontal tablist is replaced by a persistent left
  // sidebar rail (Create-style). Guard the new layout primitives and the
  // removal of the old tablist CSS.
  it('renders the view switcher in a persistent sidebar rail, not a horizontal tab strip', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).not.toContain('pc-advconv__viewtabs');
    const navRule = styles.match(/\.pc-advconv__nav\s*{[^}]*}/)?.[0] ?? '';
    expect(navRule).toContain('width:');
    const btnRule = styles.match(/\.pc-advconv__navbtn\s*{[^}]*}/)?.[0] ?? '';
    expect(btnRule).toContain('width: 100%');
  });

  it('opens the Ask composer from the + Ask action', async () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: /Ask the agents/i }));
    expect(await screen.findByPlaceholderText(/What do you want to ask the fleet/i)).toBeTruthy();
  });

  // design-pass: Conversations now honors its DECLARED pink tab accent (#ec4899,
  // AdvShell ADV_TABS) instead of silently falling back to the body sky --accent —
  // so the pink nav badge actually reaches the UI. Guards against re-introducing the
  // var(--accent, …) fallback. (Live-visual is build-gated; this locks the emit.)
  it('emits the declared pink tab accent (#ec4899) at the root, not the sky fallback', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const rootRule = styles.match(/\.pc-advconv\s*{[^}]*}/)?.[0] ?? '';
    expect(rootRule).toContain('--advconv-accent: #ec4899');
    expect(rootRule).toContain('--advconv-accent-strong: #f472b6');
  });

  it('shows the Raw events log as the set-apart view with grouped filters', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    expect(screen.getByText(/Raw coordination events for debugging/i)).toBeTruthy();
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
    // The parent root row is open…
    expect(screen.getByText('please pick up the auth refactor')).toBeTruthy();
    // …and the clicked reply is now revealed inside the expanded conversation.
    expect(screen.getByText('got it')).toBeTruthy();
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
  it('renders a day separator row in the virtualized activity stream', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    expect(screen.getByText('Today')).toBeTruthy();
    // The events still render beneath it (the flatten preserved the items).
    expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
  });
});

// ─── The unified communication views (every type, not just coord threads) ──────
//
// the-conversations-tab-surfaces-every-comm-type: the tab gained three views that
// read the global communication-surface dispatch (/api/admin/comms/:kind/:verb):
// agent chats, work-item messages, and operator chats. These guard the new views
// against render-time crashes the typecheck can't catch and assert each one
// surfaces its data.

/** Stub fetch to answer the comms dispatch by URL, everything else empty. */
function stubComms(byUrl: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const match = Object.keys(byUrl).find((frag) => url.includes(frag));
      return { ok: true, status: 200, json: async () => (match ? byUrl[match] : { conversations: [] }) };
    }),
  );
}

describe('AdvConversationsTab — unified communication views', () => {
  it('exposes a view tab for every communication type', () => {
    render(<AdvConversationsTab />);
    expect(screen.getByRole('tab', { name: /Q&A/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Deliberations/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Agent chats/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Messages/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Raw events/i })).toBeTruthy();
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

  it('Agent chats view lists sessions and opens a transcript', async () => {
    nuqsState.conv = 'agentchats';
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
    // role badge + per-row meta render
    expect(screen.getAllByText('worker').length).toBeGreaterThan(0);
    expect(screen.getByText(/6 turns/i)).toBeTruthy();
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

  it('each new view degrades to an empty state with no data', async () => {
    nuqsState.conv = 'agentchats';
    stubComms({ '/comms/agent-chats/list': { items: [] } });
    render(<AdvConversationsTab />);
    await waitFor(() => expect(screen.getByText(/No agent chats/i)).toBeTruthy());
  });

  it('a failed list fetch surfaces a retry-able error instead of a stuck loader', async () => {
    nuqsState.conv = 'deliberations';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<AdvConversationsTab />);
    await waitFor(() => expect(screen.getByText(/Couldn't load/i)).toBeTruthy());
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
  it('renders the shared EmptyState (icon + title + desc) for an empty Messages view', async () => {
    nuqsState.conv = 'messages';
    stubComms({ '/comms/messages/list': { items: [] } });
    render(<AdvConversationsTab />);
    await waitFor(() => expect(screen.getByText('No messages')).toBeTruthy());
    // The shared EmptyState renders the title in a <strong> and the desc beside it.
    expect(screen.getByText(/No agent-to-agent messages recorded/i)).toBeTruthy();
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

  it('the Q&A state filter chips toggle via aria-pressed (picker-kit Pill)', () => {
    nuqsState.conv = 'threads';
    nuqsState.cstate = 'open';
    render(<AdvConversationsTab />);
    // The active state filter reflects the URL via aria-pressed.
    const openChip = screen.getByRole('button', { name: /^open$/i, pressed: true });
    expect(openChip).toBeTruthy();
    // A non-active filter is present but not pressed.
    expect(screen.getByRole('button', { name: /^resolved$/i, pressed: false })).toBeTruthy();
  });
});
