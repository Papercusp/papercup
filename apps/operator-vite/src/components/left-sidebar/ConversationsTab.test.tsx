// @vitest-environment jsdom
/**
 * ConversationsTab coverage — the curated stream at rail width (WI-5754).
 *
 * The pins here are the things the NARROW layout is: that all three sources land
 * in one stream, that the source chips and search filter it, that a click DRILLS
 * IN (detail replaces the list) and back returns, that an open question can be
 * replied to / accepted through the audited endpoints, and — the placement the
 * owner corrected mid-build — that this pane carries NO compose control, because
 * asking lives in the Agents tab.
 *
 * nuqs is a per-key store seeded with spy setters; sync queries are dispatched by
 * queryName; fetch is stubbed so the write assertions see the real request body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lsc: '', lscq: '', lscs: 'all' };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { defaultValue?: unknown }) => {
    const set = vi.fn(async (v: unknown) => {
      nuqsState[key] = v;
    });
    nuqsSetters[key] = set;
    return [nuqsState[key] ?? parser?.defaultValue ?? '', set];
  },
  parseAsString: { withDefault: (d: unknown) => ({ defaultValue: d }) },
  parseAsStringLiteral: () => ({ withDefault: (d: unknown) => ({ defaultValue: d }) }),
}));

const H = vi.hoisted(() => ({
  results: {} as Record<
    string,
    { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }
  >,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null as unknown, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, enabled }: { queryName: string; enabled?: boolean }) =>
    enabled === false ? blank() : (H.results[queryName] ?? blank()),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

import ConversationsTab from './ConversationsTab';

const QUESTION = {
  id: 'conv-1',
  kind: 'question',
  state: 'open',
  scope: 'operator',
  harness_slug: null,
  title: 'Fold the out-of-lane bugs into the drain?',
  asker_id: 'su-791667d4',
  topics: ['bug-drain'],
  created_ts: '2026-07-20T23:00:00Z',
  updated_ts: '2026-07-20T23:04:26Z',
};
const DELIBERATION = {
  thread_id: 'thr-1',
  parent_kind: 'issue',
  parent_ref: 'WI-5738',
  title: 'p2p publish guard refusal is silent',
  created_by: 'su-61c46ac0',
  harness_slug: 'papercusp',
  created_at: '2026-07-25T20:00:00Z',
  last_post_at: '2026-07-25T20:14:34Z',
  post_count: 1,
};
const AGENT_CHAT = {
  id: 'chat-1',
  harness_slug: 'papercusp',
  role: 'worker',
  feature_id: 'WI-5404',
  title: 'remote placement misses pot-level offers',
  created_at: 1_753_000_000_000,
  updated_at: 1_753_100_000_000,
  archived_at: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost_usd_cents: 0,
  turns: 2,
};
const AGENT_MESSAGE = {
  msg_id: 'ms-1',
  kind: 'message',
  from: 'su-2846407f',
  to: ['su-8d9a671c'],
  summary: 'the release gate is red on a test I did not touch',
  body: 'Full body: see WI-6322 for the failing case.',
  harness_slug: 'papercusp',
  plan_slug: null,
  lifecycle: 'finding',
  audience: ['@object:issue:WI-6322'],
  broadcast: false,
  reply_count: 1,
  ts: '2026-07-26T09:00:00Z',
  last_reply_ts: '2026-07-26T09:05:00Z',
};

/**
 * Seeds every list this pane reads — PLUS `questionsList`, deliberately, so the
 * "Q&A is gone from the rail" pins below prove the pane IGNORES it rather than
 * merely proving the fixture was empty (owner, 2026-07-27 / plan D-001).
 */
function seedAllSources() {
  H.results['conversations.questionsList'] = { ...blank(), data: [QUESTION] };
  H.results['conversations.deliberationList'] = { ...blank(), data: [DELIBERATION] };
  H.results['conversations.agentChatList'] = { ...blank(), data: [AGENT_CHAT] };
  H.results['conversations.agentMessageList'] = { ...blank(), data: [AGENT_MESSAGE] };
}

beforeEach(() => {
  for (const k of Object.keys(H.results)) delete H.results[k];
  nuqsState.lsc = '';
  nuqsState.lscq = '';
  nuqsState.lscs = 'all';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConversationsTab — the unified stream', () => {
  it('merges every curated source into one stream, newest first', () => {
    seedAllSources();
    render(<ConversationsTab active />);
    const rows = screen.getAllByTestId(/^conversation-row-/);
    // Three sources, NOT four: the Q&A fixture is seeded and ignored (D-001).
    expect(rows).toHaveLength(3);
    // The agent message's last reply (2026-07-26 09:05) is the newest activity.
    expect(rows[0].getAttribute('data-testid')).toBe('conversation-row-messages:ms-1');
    expect(screen.getByTestId('conversations-count').textContent).toBe('3');
  });

  // Owner, 2026-07-27: "remove the q&a tab no one is using that feature". The
  // seeded QUESTION must reach neither the chip row nor the stream — while /adv
  // keeps reading the same store (this is a per-surface opt-out, not a
  // retirement), which is why the assertion is about THIS pane, not the query.
  it('drops the Q&A source: no chip, and no rows even when the store has some', () => {
    seedAllSources();
    render(<ConversationsTab active />);
    expect(screen.queryByTestId('conversations-filter-threads')).toBeNull();
    expect(screen.queryByText('Q&A')).toBeNull();
    expect(screen.queryByTestId('conversation-row-threads:conv-1')).toBeNull();
  });

  // The pane used to render a WINDOWED count as if it were the store total —
  // "Decisions 85" while 5,744 threads existed (owner, 2026-07-27). A capped
  // source now says so.
  it('marks a capped source window with a + instead of implying a total', () => {
    seedAllSources();
    H.results['conversations.agentMessageList'] = {
      ...blank(),
      // attachListMeta stashes the true store total on row[0]._meta.
      data: [{ ...AGENT_MESSAGE, _meta: { total: 10_633 } }],
    };
    render(<ConversationsTab active />);
    expect(screen.getByTestId('conversations-filter-messages').textContent).toContain('1+');
    // An uncapped source stays a bare number — the + must mean something.
    expect(screen.getByTestId('conversations-filter-agentchats').textContent).not.toContain('+');
  });

  // An inactive tab must not fetch: the rail mounts only the active pane, and a
  // background pane paying for three list queries is exactly what `enabled`
  // exists to prevent.
  it('renders nothing while the tab is inactive', () => {
    seedAllSources();
    const { container } = render(<ConversationsTab active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('filters by source chip, and counts each source', () => {
    seedAllSources();
    render(<ConversationsTab active />);
    // Every chip carries its own count, so the owner can see what is there
    // without switching to it.
    expect(screen.getByTestId('conversations-filter-messages').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('conversations-filter-agentchats'));
    expect(nuqsSetters.lscs).toHaveBeenCalledWith('agentchats');
  });

  it('applies the source filter from the URL', () => {
    seedAllSources();
    nuqsState.lscs = 'agentchats';
    render(<ConversationsTab active />);
    const rows = screen.getAllByTestId(/^conversation-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-testid')).toBe('conversation-row-agentchats:chat-1');
    expect(screen.getByTestId('conversations-count').textContent).toBe('1 of 3');
  });

  it('searches across every displayed field, not just the title', () => {
    seedAllSources();
    nuqsState.lscq = 'WI-5404'; // a RELATED WORK ref, which is not in any title
    render(<ConversationsTab active />);
    const rows = screen.getAllByTestId(/^conversation-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-testid')).toBe('conversation-row-agentchats:chat-1');
  });

  it('drills in on a row click by writing the compound selection', () => {
    seedAllSources();
    render(<ConversationsTab active />);
    fireEvent.click(screen.getByTestId('conversation-row-messages:ms-1'));
    expect(nuqsSetters.lsc).toHaveBeenCalledWith('messages:ms-1');
  });

  it('shows an empty state naming the Agents tab when nothing is recorded', () => {
    render(<ConversationsTab active />);
    expect(screen.getByText(/No conversations/)).toBeTruthy();
    expect(screen.getByText(/Agents tab/)).toBeTruthy();
  });
});

describe('ConversationsTab — detail mode', () => {
  const DETAIL = {
    id: 'conv-1',
    kind: 'question',
    state: 'open',
    scope: 'operator',
    title: 'Fold the out-of-lane bugs into the drain?',
    body: 'Two clean options: repoint the slug, or leave them out-of-lane.',
    asker_id: 'su-791667d4',
    accepted_answer: null,
    promoted_issue_id: null,
    topics: ['bug-drain'],
    posts: [{ id: 1, author_id: 'su-abc', body: 'Leaning toward leaving them out.', created_ts: '2026-07-20T23:02:00Z' }],
    subscriber_count: 2,
  };

  function openQuestion() {
    seedAllSources();
    nuqsState.lsc = 'threads:conv-1';
    H.results['conversations.questionDetail'] = { ...blank(), data: [DETAIL] };
    render(<ConversationsTab active />);
  }

  it('replaces the list with the detail, and offers a way back', () => {
    openQuestion();
    expect(screen.queryByTestId(/^conversation-row-/)).toBeNull();
    expect(screen.getByText(DETAIL.body)).toBeTruthy();
    fireEvent.click(screen.getByTestId('conversation-back'));
    expect(nuqsSetters.lsc).toHaveBeenCalledWith(null);
  });

  it('posts a reply through the audited coordination endpoint', async () => {
    openQuestion();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Leave them out-of-lane.' } });
    fireEvent.click(screen.getByTestId('conversation-reply'));
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/admin/coordination/conversations/post');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      conversation_id: 'conv-1',
      body: 'Leave them out-of-lane.',
    });
  });

  it('accepting an answer resolves rather than posting', () => {
    openQuestion();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Out-of-lane, deliberately.' } });
    fireEvent.click(screen.getByTestId('conversation-accept'));
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/admin/coordination/conversations/resolve');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      conversation_id: 'conv-1',
      accepted_answer: 'Out-of-lane, deliberately.',
    });
  });

  // Reply + accept are disabled on anything already terminal — the wide surface
  // refuses a post to a resolved conversation server-side, and the rail must not
  // offer a control whose only outcome is that refusal.
  it('offers no composer on a resolved question', () => {
    seedAllSources();
    nuqsState.lsc = 'threads:conv-1';
    H.results['conversations.questionDetail'] = { ...blank(), data: [{ ...DETAIL, state: 'resolved', accepted_answer: 'Left out-of-lane.' }] };
    render(<ConversationsTab active />);
    expect(screen.queryByTestId('conversation-reply')).toBeNull();
    expect(screen.getByText('Left out-of-lane.')).toBeTruthy();
  });

  // keepPreviousData hands back the PREVIOUS id's detail on a switch (WI-4142).
  // Rendering it under the new title would attribute one conversation's content
  // to another — the guard must fall through to the loading state instead.
  it('never renders another conversation’s detail while the selected one loads', () => {
    seedAllSources();
    nuqsState.lsc = 'threads:conv-1';
    H.results['conversations.questionDetail'] = { ...blank(), data: [{ ...DETAIL, id: 'conv-STALE', body: 'stale body' }] };
    render(<ConversationsTab active />);
    expect(screen.queryByText('stale body')).toBeNull();
    expect(screen.getByText(/Loading conversation/)).toBeTruthy();
  });

  it('renders a deliberation read-only, with what it is attached to', () => {
    seedAllSources();
    nuqsState.lsc = 'deliberations:thr-1';
    H.results['conversations.deliberationDetail'] = {
      ...blank(),
      data: [{ thread: DELIBERATION, posts: [{ id: 9, author_id: 'su-61c46ac0', body: 'Correction to the framing.', created_at: '2026-07-25T20:14:34Z', harness_slug: 'papercusp' }] }],
    };
    render(<ConversationsTab active />);
    expect(screen.getByText(/issue/)).toBeTruthy();
    // Owner, 2026-07-27: "the attached to things should actually link to the
    // thing". WI-5738 is no longer dead text — it is an activatable ref
    // rendering through the HUD chat's own pill, so it must be a CONTROL.
    const attached = screen.getByText('WI-5738');
    expect(attached.closest('button') ?? attached.closest('a')).toBeTruthy();
    expect(screen.getByText('Correction to the framing.')).toBeTruthy();
    expect(screen.queryByTestId('conversation-reply')).toBeNull();
  });

  it('renders an agent message with its routing, related work, and reply chain', () => {
    seedAllSources();
    nuqsState.lsc = 'messages:ms-1';
    H.results['conversations.agentMessageDetail'] = {
      ...blank(),
      data: [{
        message: AGENT_MESSAGE,
        replies: [{
          msg_id: 'ms-2', kind: 'ack', from: 'su-8d9a671c', to: ['su-2846407f'],
          summary: 'ack', body: 'Looking now.', ts: '2026-07-26T09:05:00Z',
        }],
      }],
    };
    render(<ConversationsTab active />);

    // Who told whom what — the whole reason to read agent traffic.
    expect(screen.getByText(/su-2846407f/)).toBeTruthy();
    expect(screen.getByText(/to su-8d9a671c/)).toBeTruthy();
    expect(screen.getByText('1 reply')).toBeTruthy();
    expect(screen.getByText('Looking now.')).toBeTruthy();
    // `@object:issue:WI-6322` is the audience selector this send targeted; it
    // becomes the openable "About" ref rather than an opaque selector string.
    const about = screen.getAllByText('WI-6322')[0];
    expect(about.closest('button') ?? about.closest('a')).toBeTruthy();
  });

  it('flattens agent-chat transcript turns', () => {
    seedAllSources();
    nuqsState.lsc = 'agentchats:chat-1';
    H.results['conversations.agentChatDetail'] = {
      ...blank(),
      data: [{ ...AGENT_CHAT, transcript: [{ role: 'user', content: [{ text: 'Widen the offer query.' }] }] }],
    };
    render(<ConversationsTab active />);
    expect(screen.getByText('Widen the offer query.')).toBeTruthy();
  });
});

describe('ConversationsTab — placement', () => {
  // Owner correction mid-build (2026-07-25): "the ask tab should be in the
  // agents pane not the conversations pane". If a later change reintroduces a
  // compose control here, the rail would offer two places to ask — which is the
  // exact duplication this pin exists to catch.
  it('carries no compose control — asking lives in the Agents tab', () => {
    seedAllSources();
    render(<ConversationsTab active />);
    expect(screen.queryByText(/^Ask/)).toBeNull();
    expect(screen.queryByTestId('ask-agent-pane')).toBeNull();
  });
});
