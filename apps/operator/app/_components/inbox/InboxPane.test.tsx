// @vitest-environment jsdom
/**
 * InboxPane coverage (EI-13037; moved into the op-chat sidebar per the owner's
 * placement correction 2026-07-16). Pins:
 *   - the tier filter (default "Needs you" = decision tier, incl. the Brief 21
 *     wire-lag fallback for rows arriving without `tier`), chip counts;
 *   - row rendering (kind label, owner/plan meta) + selection (?opcis) that
 *     expands the Queue's OtherDetail inline (remount-per-selection key);
 *   - the empty ("inbox zero") state;
 *   - the "Open full queue" jump (?tab=plans&view=queue merge on /adv);
 *   - Discuss → stages a Papercup chat seed + flips back to the chat view
 *     (owner ask 2026-07-16 "opening up a chat with papercup about it");
 *   - useInboxPendingCount / effectiveTier (the header-badge derivation).
 *
 * nuqs runs through the first-party NuqsTestingAdapter (real parsers); the
 * sync layer is dispatched by queryName; OtherDetail is stubbed (its own
 * behavior is covered by the Queue's suites — this pane only re-hosts it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null as unknown, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
}));
// OtherDetail is the Queue's own component — stub it to a marker that echoes
// the hosted item id and exposes the onDiscuss seam (parity behavior is the
// Queue suites' job).
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item, onDiscuss }: { item: { id: string }; onDiscuss?: (i: unknown) => boolean }) => (
    <div data-testid="other-detail" data-item={item.id}>
      <button type="button" data-testid="stub-discuss" onClick={() => onDiscuss?.(item)} />
    </div>
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

import InboxPane, { buildDiscussDraft } from './InboxPane';
import { effectiveTier, useInboxPendingCount } from './use-inbox-pending';
import { consumePendingChatSeed } from './chat-seed';
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

function renderPane(searchParams = '') {
  const onUrlUpdate = vi.fn();
  const onDiscussInChat = vi.fn();
  render(<InboxPane onDiscussInChat={onDiscussInChat} />, {
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
  return { onUrlUpdate, lastQuery, onDiscussInChat };
}

afterEach(() => {
  cleanup();
  H.results = {};
  consumePendingChatSeed(); // drain any staged seed between tests
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

describe('<InboxPane>', () => {
  it('defaults to "Needs you" — decision-tier rows only, with chip counts', () => {
    seedAttention([
      mkItem('d1'),
      mkItem('a1', { tier: 'alert', needsHuman: false, kind: 'coord-escalation' }),
      mkItem('act1', { tier: 'activity', needsHuman: false }),
    ]);
    renderPane();
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-a1')).toBeNull();
    expect(screen.queryByTestId('inbox-row-act1')).toBeNull();
    expect(screen.getByTestId('inbox-filter-needs').textContent).toContain('1');
    expect(screen.getByTestId('inbox-filter-alerts').textContent).toContain('1');
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('3');
  });

  it('renders the kind label and owner/plan meta on a row', () => {
    seedAttention([mkItem('d1', { planSlug: 'plan-x' })]);
    renderPane();
    const row = screen.getByTestId('inbox-row-d1');
    expect(row.textContent).toContain('message');
    expect(row.textContent).toContain('su · su-abc');
    expect(row.textContent).toContain('plan-x');
    expect(row.textContent).toContain('Title of d1');
  });

  it('deep-links the ?opci=all filter and shows every tier, decisions first', () => {
    seedAttention([
      mkItem('act1', { tier: 'activity', needsHuman: false }),
      mkItem('d1'),
    ]);
    renderPane('?opci=all');
    const rows = screen.getAllByTestId(/^inbox-row-/).map((x) => x.getAttribute('data-testid'));
    expect(rows).toEqual(['inbox-row-d1', 'inbox-row-act1']);
  });

  it('clicking a row writes ?opcis; the ?opcis-selected row hosts OtherDetail inline', async () => {
    seedAttention([mkItem('d1'), mkItem('d2')]);
    const { lastQuery } = renderPane('?opcis=d2');
    // Pre-seeded selection renders the detail for d2 only.
    const detail = screen.getByTestId('other-detail');
    expect(detail.getAttribute('data-item')).toBe('d2');
    expect(screen.getAllByTestId('other-detail')).toHaveLength(1);
    // Clicking another row re-targets the selection (the adapter reports URL
    // writes on the next tick).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).toContain('opcis=d1'));
    // Clicking the (now-)selected row clears it (toggle).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcis='));
  });

  it('Discuss stages a Papercup chat seed and flips back to the chat view', () => {
    seedAttention([mkItem('d1', { planSlug: 'plan-x' })]);
    const { onDiscussInChat } = renderPane('?opcis=d1');
    fireEvent.click(screen.getByTestId('stub-discuss'));
    expect(onDiscussInChat).toHaveBeenCalledTimes(1);
    const seed = consumePendingChatSeed();
    expect(seed).toContain('Title of d1');
    expect(seed).toContain('plan plan-x');
    // The ref is the item id verbatim — real feed ids already carry the kind
    // prefix ("coord-message:m…"), so the draft must not re-prepend i.kind.
    expect(seed).toContain('ref d1)');
    expect(seed).not.toContain('coord-message:d1');
  });

  it('buildDiscussDraft folds kind, location, title and a bounded report digest', () => {
    // report is a STRUCTURED ReportBlock (title + plan rows), flattened to a
    // one-liner-per-plan digest and capped at 600 chars.
    const draft = buildDiscussDraft(
      mkItem('d9', {
        planSlug: 'plan-y',
        report: {
          title: 'Fleet report',
          plans: [{ title: 'Rate-limit v2', status: 'active', summary: 'x'.repeat(700) }],
        },
      } as Partial<AttentionItem>),
    );
    expect(draft).toContain('message — plan plan-y · harness papercusp');
    expect(draft).toContain('Title of d9');
    expect(draft).toContain('Fleet report');
    expect(draft).toContain('Rate-limit v2 [active]');
    expect(draft).toContain('x'.repeat(500)); // digest present…
    expect(draft).not.toContain('x'.repeat(601)); // …but bounded at 600 total
  });

  it('shows the inbox-zero empty state when nothing needs the owner', () => {
    seedAttention([mkItem('a1', { tier: 'alert', needsHuman: false })]);
    renderPane();
    expect(screen.getByTestId('inbox-empty').textContent).toContain('Inbox zero');
  });

  it('jumps to the full Queue by merge-writing tab=plans&view=queue on /adv', async () => {
    window.history.replaceState({}, '', '/adv?ws=w1');
    seedAttention([mkItem('d1')]);
    const { lastQuery } = renderPane();
    fireEvent.click(screen.getByTestId('inbox-open-queue'));
    await waitFor(() => {
      expect(lastQuery()).toContain('tab=plans');
      expect(lastQuery()).toContain('view=queue');
    });
  });

  it('surfaces a feed error', () => {
    H.results['plans.attention'] = { data: [], loading: false, fetching: false, error: new Error('coord down'), invalidate: vi.fn() };
    renderPane();
    expect(screen.getByText(/coord down/)).toBeTruthy();
  });
});
