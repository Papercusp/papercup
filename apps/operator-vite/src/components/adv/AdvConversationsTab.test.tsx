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
import { cleanup, render, screen } from '@testing-library/react';

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
  mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ conversations: [] }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvConversationsTab — simplified design', () => {
  it('opens on Threads with a compact header and Needs you summary', () => {
    render(<AdvConversationsTab />);

    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByText(/Questions, discussions, and agent messages/i)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Threads/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Activity log/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Needs you/i })).toBeTruthy();
    expect(screen.getByText(/Question & discussion threads/i)).toBeTruthy();
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
