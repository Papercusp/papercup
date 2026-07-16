// @vitest-environment jsdom
/**
 * InboxTab coverage (EI-13037) — the left-sidebar human inbox. Pins:
 *   - the tier filter (default "Needs you" = decision tier, incl. the Brief 21
 *     wire-lag fallback for rows arriving without `tier`), chip counts;
 *   - row rendering (kind label, owner/plan meta) + selection (?lsis) that
 *     expands the Queue's OtherDetail inline (remount-per-selection key);
 *   - the empty ("inbox zero") state;
 *   - the "Open full queue" deep-link (merge-updater → tab=plans&view=queue);
 *   - useInboxPendingCount / effectiveTier (the rail badge derivation).
 *
 * nuqs runs through the first-party NuqsTestingAdapter (real parsers); the
 * sync layer is dispatched by queryName; OtherDetail is stubbed (its own
 * behavior is covered by the Queue's suites — this pane only re-hosts it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null as unknown, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
// OtherDetail is the Queue's own component — stub it to a marker that echoes
// the hosted item id (parity behavior is the Queue suites' job).
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item }: { item: { id: string } }) => (
    <div data-testid="other-detail" data-item={item.id} />
  ),
  KIND_LABEL: {
    'plan-item': 'item',
    'coord-escalation': 'escalation',
    'coord-message': 'message',
    'smoke-fail': 'smoke',
    'operator-report': 'report',
    improvement: 'improvement',
    'standing-approval': 'approval',
    conversation: 'question',
    'scout-grade': 'grade',
  },
}));
// TanStack Link → a plain <a> whose href reflects to + resolved search (the
// component builds a `(prev) => …` merge updater; resolve against {}).
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, ...rest }: { to: string; search?: unknown; children?: React.ReactNode; className?: string; 'data-testid'?: string }) => {
    const resolved = (typeof search === 'function' ? search({}) : (search ?? {})) as Record<string, unknown>;
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(resolved)) {
      if (value != null && value !== '') qs.set(key, String(value));
    }
    return (
      <a href={`${to}?${qs.toString()}`} {...rest}>
        {children}
      </a>
    );
  },
}));

import InboxTab from './InboxTab';
import { effectiveTier, useInboxPendingCount } from './use-inbox-pending';
import type { AttentionItem } from '@/app/admin/plans/plans-api';

function mkItem(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: 'coord-message',
    source: 'coord',
    harnessSlug: 'papercusp',
    planSlug: null,
    itemRef: null,
    title: `Title of ${id}`,
    body: `Body of ${id}`,
    status: 'open',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: 'su-abc',
    ownerLabel: 'su · su-abc',
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [{ id: 'ack', label: 'Acknowledge', primary: true }],
    ref: { kind: 'coord-message', msgId: `m-${id}` },
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
    invalidate: vi.fn(),
  };
}

function renderTab(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<InboxTab active />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

afterEach(() => {
  cleanup();
  H.results = {};
});

describe('effectiveTier (badge/filter derivation)', () => {
  it('prefers the canonical tier field', () => {
    expect(effectiveTier(mkItem('a', { tier: 'alert' }))).toBe('alert');
  });
  it('falls back to needsHuman → decision for pre-tier wire rows (Brief 21 lag)', () => {
    expect(effectiveTier(mkItem('a', { tier: undefined as never, needsHuman: true }))).toBe('decision');
  });
  it('falls back to alert for smoke-fail / coord-escalation, else activity', () => {
    expect(effectiveTier(mkItem('a', { tier: undefined as never, needsHuman: false, kind: 'smoke-fail' }))).toBe('alert');
    expect(effectiveTier(mkItem('a', { tier: undefined as never, needsHuman: false, kind: 'operator-report' }))).toBe('activity');
  });
});

describe('useInboxPendingCount', () => {
  function Probe() {
    return <output data-testid="count">{useInboxPendingCount()}</output>;
  }
  it('counts decision-tier items only', () => {
    seedAttention([
      mkItem('d1'),
      mkItem('d2', { tier: undefined as never, needsHuman: true }),
      mkItem('a1', { tier: 'alert', needsHuman: false }),
      mkItem('h1', { tier: 'handled', needsHuman: false }),
    ]);
    render(<Probe />);
    expect(screen.getByTestId('count').textContent).toBe('2');
  });
});

describe('<InboxTab>', () => {
  it('defaults to "Needs you" — decision-tier rows only, with chip counts', () => {
    seedAttention([
      mkItem('d1'),
      mkItem('a1', { tier: 'alert', needsHuman: false, kind: 'coord-escalation' }),
      mkItem('act1', { tier: 'activity', needsHuman: false }),
    ]);
    renderTab();
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-a1')).toBeNull();
    expect(screen.queryByTestId('inbox-row-act1')).toBeNull();
    expect(screen.getByTestId('inbox-filter-needs').textContent).toContain('1');
    expect(screen.getByTestId('inbox-filter-alerts').textContent).toContain('1');
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('3');
  });

  it('renders the kind label and owner/plan meta on a row', () => {
    seedAttention([mkItem('d1', { planSlug: 'plan-x' })]);
    renderTab();
    const row = screen.getByTestId('inbox-row-d1');
    expect(row.textContent).toContain('message');
    expect(row.textContent).toContain('su · su-abc');
    expect(row.textContent).toContain('plan-x');
    expect(row.textContent).toContain('Title of d1');
  });

  it('deep-links the ?lsi=all filter and shows every tier, decisions first', () => {
    seedAttention([
      mkItem('act1', { tier: 'activity', needsHuman: false }),
      mkItem('d1'),
    ]);
    renderTab('?lsi=all');
    const rows = screen.getAllByTestId(/^inbox-row-/).map((x) => x.getAttribute('data-testid'));
    expect(rows).toEqual(['inbox-row-d1', 'inbox-row-act1']);
  });

  it('clicking a row writes ?lsis; the ?lsis-selected row hosts OtherDetail inline', () => {
    seedAttention([mkItem('d1'), mkItem('d2')]);
    const { lastQuery } = renderTab('?lsis=d2');
    // Pre-seeded selection renders the detail for d2 only.
    const detail = screen.getByTestId('other-detail');
    expect(detail.getAttribute('data-item')).toBe('d2');
    expect(screen.getAllByTestId('other-detail')).toHaveLength(1);
    // Clicking another row re-targets the selection.
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    expect(lastQuery()).toContain('lsis=d1');
    // Clicking the selected row clears it (toggle).
    fireEvent.click(screen.getByTestId('inbox-row-d2'));
    expect(lastQuery()).not.toContain('lsis=d2');
  });

  it('shows the inbox-zero empty state when nothing needs the owner', () => {
    seedAttention([mkItem('a1', { tier: 'alert', needsHuman: false })]);
    renderTab();
    expect(screen.getByTestId('inbox-empty').textContent).toContain('Inbox zero');
  });

  it('links to the full Queue preserving rail params (merge updater → tab=plans&view=queue)', () => {
    seedAttention([mkItem('d1')]);
    renderTab();
    const href = screen.getByTestId('inbox-open-queue').getAttribute('href') ?? '';
    expect(href.startsWith('/adv?')).toBe(true);
    expect(href).toContain('tab=plans');
    expect(href).toContain('view=queue');
  });

  it('surfaces a feed error', () => {
    H.results['plans.attention'] = { data: [], loading: false, fetching: false, error: new Error('coord down'), invalidate: vi.fn() };
    renderTab();
    expect(screen.getByText(/coord down/)).toBeTruthy();
  });
});
