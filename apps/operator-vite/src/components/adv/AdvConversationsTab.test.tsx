// @vitest-environment jsdom
//
// AdvConversationsTab render coverage — the /adv Conversations tab's new "Feed"
// view (the fix for "Conversations only shows a small number"). Mounts the tab
// against a realistic dev.coordFeed snapshot (useSyncQuery + nuqs mocked, the
// pinned sibling pattern — see admin/GitClient.test.tsx) and asserts:
//   - the clarity bar + total count render,
//   - every kind appears with its colour badge,
//   - a BROADCAST row is marked, and a "→ human" escalation is highlighted,
//   - the plan-slug chip renders,
//   - an ack groups under its parent as a reply (related_msg_id chain),
//   - the view switch shows Feed + Threads.
// Guards against render-time crashes the typecheck can't catch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// nuqs: every useQueryState call needs the adapter context — stub each param to
// a stable [value, noop]. The component reads `conv` (view), the feed filters
// (fkind array, fagent/fplan/fq strings, fmsg selection). Default view is feed.
const nuqsState: Record<string, unknown> = {
  conv: 'feed',
  fkind: [],
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

afterEach(() => cleanup());

describe('AdvConversationsTab — Feed view', () => {
  it('renders the clarity bar, the total count, and the view switch', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);

    expect(screen.getByText(/Every coordination envelope across the fleet/i)).toBeTruthy();
    expect(screen.getByText(/6 matching/)).toBeTruthy();
    // View switch tabs.
    expect(screen.getByRole('tab', { name: /Feed/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Threads/i })).toBeTruthy();
  });

  it('shows every kind across the channels with kind badges + counts', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);

    // Summaries from each surface render.
    expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
    expect(screen.getByText('need a decision on the schema migration')).toBeTruthy();
    expect(screen.getByText('build finished')).toBeTruthy();
    expect(screen.getByText('handing off the UI work')).toBeTruthy();

    // Kind filter chips carry counts from byKind.
    const handoffChips = screen.getAllByText('handoff');
    expect(handoffChips.length).toBeGreaterThan(0);
  });

  it('marks a broadcast row and highlights a "→ human" escalation', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);

    expect(screen.getByText('BROADCAST')).toBeTruthy();
    expect(screen.getByText('→ human')).toBeTruthy();
  });

  it('renders the plan-slug chip on plan-scoped rows', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    // Two rows carry the slug (escalation + handoff) → at least one chip.
    expect(screen.getAllByText('auth-refactor-2026').length).toBeGreaterThan(0);
  });

  it('groups an ack under its parent message as a reply (related_msg_id chain)', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);

    // The ack is a CHILD of m-direct → it must NOT be a top-level summary row,
    // but the parent shows a "1 reply" marker.
    expect(screen.getByText('please pick up the auth refactor')).toBeTruthy();
    expect(screen.getByText(/1 reply/i)).toBeTruthy();
    // The ack's own summary ("got it") is not a standalone root row.
    expect(screen.queryByText('got it')).toBeNull();
  });

  it('shows the empty state when no traffic matches', () => {
    mockResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText(/No coordination traffic matches/i)).toBeTruthy();
  });

  it('shows a "Load older" control when the server reports more rows', () => {
    mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText(/Load older/i)).toBeTruthy();
  });
});
