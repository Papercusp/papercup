// @vitest-environment jsdom
//
// AdvConversationsTab render coverage — the /adv Conversations tab's simplified
// design. Mounts the tab against a realistic dev.coordFeed snapshot (useSyncQuery
// + nuqs mocked, the pinned sibling pattern — see admin/GitClient.test.tsx) and
// asserts:
//   - Threads is the default front door,
//   - the top "Needs you" affordance renders,
//   - the Activity log keeps raw traffic reachable,
//   - human category filters replace the raw 12-kind wall by default,
//   - a BROADCAST row is marked, and a "→ human" escalation is highlighted,
//   - the plan-slug chip renders,
//   - an ack groups under its parent as a reply (related_msg_id chain),
//   - the view switch shows Threads + Activity log.
// Guards against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

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

import AdvConversationsTab from './AdvConversationsTab';

beforeEach(() => {
  nuqsState.conv = 'threads';
  nuqsState.fkind = [];
  nuqsState.fadvanced = 'closed';
  nuqsState.fagent = '';
  nuqsState.fplan = '';
  nuqsState.fq = '';
  nuqsState.fmsg = null;
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

describe('AdvConversationsTab — simplified design', () => {
  it('opens on Threads with a compact header and Needs you summary', () => {
    render(<AdvConversationsTab />);

    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy();
    // The header description follows the active view (Threads is the default).
    expect(screen.getByText(/Questions & discussions — reply, accept, promote/i)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Threads/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Activity log/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Needs you/i })).toBeTruthy();
    expect(screen.getByText(/Question & discussion threads/i)).toBeTruthy();
  });

  // D-008 (conversations-tab-simplify-2026-06-08): the per-view one-liners are
  // THE ratified copy, including the two P-009 deltas (Deliberations +
  // Agent chats). Pinned exactly so the next copy churn is caught at review.
  it('renders the ratified D-008 one-liner for every view', () => {
    const FINAL_DESCS: Record<string, string> = {
      threads: 'Questions & discussions — reply, accept, promote.',
      deliberations: 'Group decisions — proposals and votes.',
      agentchats: 'What each pipeline agent said, with token + cost detail.',
      messages: 'Work-item-scoped agent → agent messages.',
      feed: 'Raw coordination events, newest first.',
    };
    for (const [view, desc] of Object.entries(FINAL_DESCS)) {
      nuqsState.conv = view;
      render(<AdvConversationsTab />);
      expect(screen.getByText(desc)).toBeTruthy();
      cleanup();
    }
  });

  // D-007/D-010 (OQ-4): when the tab row outgrows the header width the
  // tablist scrolls horizontally — it must never wrap to a second row.
  it('keeps the view tablist single-row with horizontal overflow scroll', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const tablistRule = styles.match(/\.pc-advconv__viewtabs\s*{[^}]*}/)?.[0] ?? '';
    expect(tablistRule).toContain('overflow-x: auto');
    expect(tablistRule).not.toContain('flex-wrap');
    const tabRule = styles.match(/\.pc-advconv__viewtab\s*{[^}]*}/)?.[0] ?? '';
    expect(tabRule).toContain('flex: 0 0 auto');
  });

  it('shows Activity log as the secondary view with grouped filters', () => {
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

  it('shows channel summaries and kind badges in the Activity log', () => {
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
    expect(screen.getByRole('tab', { name: /Threads/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Deliberations/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Agent chats/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Messages/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Activity log/i })).toBeTruthy();
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

  it('Agent chats view renders the selected transcript turns', async () => {
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
