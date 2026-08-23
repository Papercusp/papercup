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
 *   - Discuss → writes the scoped work-item target and mounts the durable
 *     Papercup thread beneath the expanded row without touching global chat;
 *   - useInboxPendingCount / effectiveTier (the header-badge derivation).
 *
 * nuqs runs through the first-party NuqsTestingAdapter (real parsers); the
 * sync layer is dispatched by queryName; OtherDetail is stubbed (its own
 * behavior is covered by the Queue's suites — this pane only re-hosts it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null as unknown, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
  // The bulk-run wiring the pane now mounts subscribes to the sync bus. Without
  // this export the mock throws mid-render, which React reports only as "error
  // during concurrent rendering … recovered by rendering synchronously" — an
  // UNHANDLED error that fails the FILE while every expect still passes, so the
  // summary reads "46 passed" next to exit 1. Same stub PlansPane.test.tsx uses.
  onSyncBusEvent: () => () => {},
}));
// jsdom has no layout, so the real @tanstack/react-virtual renders zero rows
// (WI-5339 virtualization) — mock it to render every item (same seam as
// ChatConversation.test).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 52, size: 52 })),
    getTotalSize: () => opts.count * 52,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));
// OtherDetail is the Queue's own component — stub it to a marker that echoes
// the hosted item id and exposes the onDiscuss seam (parity behavior is the
// Queue suites' job).
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item, onDiscuss, onResolved, onNavigate, actionsPlacement }: {
    item: { id: string };
    onDiscuss?: (i: unknown) => boolean;
    onResolved: () => void;
    onNavigate?: (i: unknown, actionId: 'open' | 'message-owner') => boolean;
    actionsPlacement?: 'toolbar' | 'after-body';
  }) => (
    <div data-testid="other-detail" data-item={item.id} data-actions-placement={actionsPlacement}>
      <button type="button" data-testid="stub-discuss" onClick={() => onDiscuss?.(item)} />
      <button type="button" data-testid="stub-resolve" onClick={onResolved} />
      <button type="button" data-testid="stub-open" onClick={() => onNavigate?.(item, 'open')} />
      <button type="button" data-testid="stub-message-owner" onClick={() => onNavigate?.(item, 'message-owner')} />
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

// SessionChatModal (P-007) does its own real work (fetch, SSE, OperatorChat) —
// out of scope for InboxPane's own suite (mirrors the OtherDetail stub above).
// The stub renders its props so this file can assert InboxPane wires the
// right owner id/label and reacts to onClose.
const chatModalProps = vi.fn();
vi.mock('../chat/SessionChatModal', () => ({
  default: (props: { sessionOwnerId: string | null; ownerLabel: string | null; onClose: () => void }) => {
    chatModalProps(props);
    if (props.sessionOwnerId === null) return null;
    return (
      <div data-testid="session-chat-modal-stub" data-owner={props.sessionOwnerId} data-owner-label={props.ownerLabel ?? ''}>
        <button type="button" data-testid="session-chat-modal-close" onClick={props.onClose} />
      </div>
    );
  },
}));

// The sort picker is the shared Radix Select (design-primitives allowlists ZERO
// native <select>s in app code). Radix's popup does not open under jsdom, so
// stand in a native <select> carrying the SAME testId + aria-label — the same
// seam GoalProposalCard/FleetLaunchRow/PlanFilters already use.
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel, testId }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: React.ReactNode }>;
    ariaLabel?: string;
    testId?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

const discussionProps = vi.fn();
vi.mock('../work-items/WorkItemDiscussion', () => ({
  WORK_ITEM_DISCUSSION_PARAM: 'opcid',
  default: (props: {
    harnessSlug: string;
    workItemId: string;
    title?: string | null;
    onClose?: () => void;
  }) => {
    discussionProps(props);
    return (
      <div
        data-testid="work-item-discussion-stub"
        data-harness={props.harnessSlug}
        data-work-item={props.workItemId}
      >
        <button type="button" data-testid="work-item-discussion-close" onClick={props.onClose} />
      </div>
    );
  },
}));

import InboxPane, {
  formatRelativeDate,
  sortInboxItems,
  INBOX_SORTS,
  INBOX_SORT_IDS,
  DEFAULT_INBOX_SORT,
  inboxSortLabel,
} from './InboxPane';
import { effectiveTier, useInboxPendingCount, isInboxActive, scopeInboxItems } from './use-inbox-pending';
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
  render(<InboxPane />, {
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
  chatModalProps.mockClear();
  discussionProps.mockClear();
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

  /** Seed the ~100-byte badge aggregate (WI-5955). */
  function seedCounts(row: Partial<{ decisionItems: number; decisionPlans: number; alerts: number; total: number }>) {
    H.results['plans.attentionCounts'] = {
      data: [{ decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0, ...row }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
  }

  it('reads the decision count from the counts aggregate', () => {
    seedCounts({ decisionItems: 2, decisionPlans: 1, total: 4 });
    render(<Probe />);
    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('does NOT read the full attention feed (WI-5955: the badge is mounted on every app start)', () => {
    // The whole point of the change: a seeded FEED with 3 decisions must not
    // move the badge — only the aggregate does. If someone reverts the badge to
    // deriving from `plans.attention`, this reds instead of silently restoring
    // a ~1MB fetch to every session.
    seedAttention([
      mkItem('d1'),
      mkItem('d2'),
      mkItem('d3', { tier: undefined as never, needsHuman: true }),
    ]);
    seedCounts({ decisionItems: 0, total: 0 });
    render(<Probe />);
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('degrades to 0 while the aggregate is still loading', () => {
    render(<Probe />);
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});

describe('<InboxPane>', () => {
  it('keeps the tier-filter rail visible when the 360px pane is height-constrained', () => {
    const css = readFileSync(join(__dirname, 'inbox-pane.css'), 'utf8');
    const chipsRule = css.match(/\.op-inbox__chips\s*\{[^}]*\}/)?.[0] ?? '';
    expect(chipsRule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('does not visually line-clamp the full body inside an expanded row', () => {
    const css = readFileSync(join(__dirname, 'inbox-pane.css'), 'utf8');
    const bodyRule =
      css.match(/\.op-chat-sidebar \.op-inbox__detail \.ask-choice-question\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toMatch(/-webkit-line-clamp:\s*unset/);
    expect(bodyRule).toMatch(/overflow:\s*visible/);
  });

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

  // deterministic-status-cards-2026-07-17 P-003: the curator-card drill-in bug.
  // A curator status card points at an OPERATIONAL/ALERT-tier escalation; under
  // the DEFAULT 'needs' filter that row is hidden, so a deep-linked ?opcis lands
  // on nothing ("Open just opens the inbox page"). The drill-in fix also writes
  // ?opci=all, which is what actually makes the row visible + selectable.
  it("an ALERT-tier deep-link keeps its row visible without clearing the current filter", () => {
    seedAttention([
      mkItem('coord-escalation:m9', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d1'),
    ]);
    renderPane('?opcis=coord-escalation:m9'); // default 'needs' filter
    const row = screen.getByTestId('inbox-row-coord-escalation:m9');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('inbox-filter-needs').getAttribute('aria-pressed')).toBe('true');
    expect(row.closest('.op-inbox__row')?.contains(screen.getByTestId('other-detail'))).toBe(true);
  });

  it("?opci=all + ?opcis SELECTS the deep-linked alert escalation (the drill-in target)", () => {
    seedAttention([
      mkItem('coord-escalation:m9', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d1'),
    ]);
    renderPane('?opci=all&opcis=coord-escalation:m9');
    const row = screen.getByTestId('inbox-row-coord-escalation:m9');
    expect(row.getAttribute('aria-expanded')).toBe('true'); // selected
    expect(screen.getByTestId('other-detail').getAttribute('data-item')).toBe('coord-escalation:m9');
  });

  it('clicking a row writes ?opcis and expands OtherDetail inside that row', async () => {
    seedAttention([mkItem('d1'), mkItem('d2')]);
    const { lastQuery } = renderPane('?opcis=d2');
    // Pre-seeded selection renders the detail for d2 only.
    const detail = screen.getByTestId('other-detail');
    expect(detail.getAttribute('data-item')).toBe('d2');
    expect(screen.getAllByTestId('other-detail')).toHaveLength(1);
    const row = screen.getByTestId('inbox-row-d2');
    const expanded = screen.getByTestId('inbox-expanded-d2');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.getAttribute('aria-controls')).toBe('inbox-expanded-d2');
    expect(expanded.contains(detail)).toBe(true);
    expect(detail.getAttribute('data-actions-placement')).toBe('after-body');
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    // Clicking another row re-targets the selection (the adapter reports URL
    // writes on the next tick).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).toContain('opcis=d1'));
    // Clicking the (now-)selected row clears it (toggle).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcis='));
  });

  it('clicking the expanded row collapses it and a resolution refreshes the feed', async () => {
    seedAttention([mkItem('d1')]);
    const source = H.results['plans.attention']!;
    const { lastQuery } = renderPane('?opcis=d1');

    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcis='));

    cleanup();
    renderPane('?opcis=d1');
    fireEvent.click(screen.getByTestId('stub-resolve'));
    expect(source.invalidate).toHaveBeenCalledTimes(1);
  });

  it('toggles an inline row with Enter and Space while preserving aria state', async () => {
    seedAttention([mkItem('d1')]);
    const { lastQuery } = renderPane();
    const row = screen.getByTestId('inbox-row-d1');

    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(lastQuery()).toContain('opcis=d1'));

    cleanup();
    const rerendered = renderPane('?opcis=d1');
    const selectedRow = screen.getByTestId('inbox-row-d1');
    expect(selectedRow.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(selectedRow, { key: ' ' });
    await waitFor(() => expect(rerendered.lastQuery()).not.toContain('opcis='));
  });

  it('a row with an ownerAgentId shows a chat-launch button that opens SessionChatModal without also selecting the row', async () => {
    seedAttention([mkItem('d1', { ownerAgentId: 'su-live-1', ownerLabel: 'su · live-1' })]);
    const { lastQuery } = renderPane();
    // Modal starts closed.
    expect(chatModalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionOwnerId: null }),
    );
    expect(screen.queryByTestId('session-chat-modal-stub')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-chat-open-d1'));

    // Opens the modal with the row's owner id + label…
    expect(screen.getByTestId('session-chat-modal-stub').getAttribute('data-owner')).toBe('su-live-1');
    expect(screen.getByTestId('session-chat-modal-stub').getAttribute('data-owner-label')).toBe('su · live-1');
    // …and does NOT ALSO toggle the row's own selection (?opcis stays unset —
    // the click must not bubble to the row's onClick now that it's nested
    // inside a real <button>, not stopped by browser button-nesting rules).
    await new Promise((r) => setTimeout(r, 0));
    expect(lastQuery()).not.toContain('opcis=d1');
  });

  it('a row with no ownerAgentId renders no chat-launch button', () => {
    seedAttention([mkItem('d1', { ownerAgentId: undefined, ownerLabel: undefined })]);
    renderPane();
    expect(screen.queryByTestId('inbox-chat-open-d1')).toBeNull();
  });

  it('SessionChatModal onClose clears ?opcsession', async () => {
    seedAttention([mkItem('d1', { ownerAgentId: 'su-live-1' })]);
    const { lastQuery } = renderPane('?opcsession=su-live-1');
    expect(screen.getByTestId('session-chat-modal-stub')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-chat-modal-close'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcsession='));
  });

  it('the detail Open action launches the shared work-item popup for a needs-human item', async () => {
    seedAttention([
      mkItem('work-item-needs-human:WI-42', {
        kind: 'work-item-needs-human',
        ref: { kind: 'work-item-needs-human', workItemId: 'WI-42', itemKind: 'change' },
      }),
    ]);
    const { lastQuery } = renderPane('?opcis=work-item-needs-human%3AWI-42');
    fireEvent.click(screen.getByTestId('stub-open'));
    await waitFor(() => expect(lastQuery()).toContain('wpop=papercusp::WI-42'));
  });

  it('the detail Message owner action focuses the live agent session instead of showing a toast', () => {
    seedAttention([mkItem('wall-1', { ownerAgentId: 'su-live-1', ownerLabel: 'su · live-1' })]);
    renderPane('?opcis=wall-1');
    fireEvent.click(screen.getByTestId('stub-message-owner'));
    expect(screen.getByTestId('session-chat-modal-stub').getAttribute('data-owner')).toBe('su-live-1');
  });

  it('Discuss writes the scoped inline target instead of switching or seeding global chat', async () => {
    seedAttention([
      mkItem('work-item-needs-human:WI-42', {
        kind: 'work-item-needs-human',
        ref: { kind: 'work-item-needs-human', workItemId: 'WI-42', itemKind: 'change' },
      }),
    ]);
    const { lastQuery } = renderPane('?opcis=work-item-needs-human%3AWI-42');
    fireEvent.click(screen.getByTestId('stub-discuss'));
    await waitFor(() => expect(lastQuery()).toContain('opcid=papercusp::WI-42'));
  });

  it('a deep-linked discussion renders beneath the expanded work-item and close clears only opcid', async () => {
    seedAttention([
      mkItem('work-item-needs-human:WI-42', {
        kind: 'work-item-needs-human',
        ref: { kind: 'work-item-needs-human', workItemId: 'WI-42', itemKind: 'change' },
      }),
    ]);
    const { lastQuery } = renderPane(
      '?opcis=work-item-needs-human%3AWI-42&opcid=papercusp%3A%3AWI-42',
    );
    const expanded = screen.getByTestId('inbox-expanded-work-item-needs-human:WI-42');
    const discussion = screen.getByTestId('work-item-discussion-stub');
    expect(expanded.contains(screen.getByTestId('other-detail'))).toBe(true);
    expect(expanded.contains(discussion)).toBe(true);
    expect(discussion.getAttribute('data-harness')).toBe('papercusp');
    expect(discussion.getAttribute('data-work-item')).toBe('WI-42');

    fireEvent.click(screen.getByTestId('work-item-discussion-close'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcid='));
    expect(lastQuery()).toContain('opcis=work-item-needs-human:WI-42');
  });

  it('Discuss falls back to the Queue panel when the attention item has no canonical work-item id', async () => {
    seedAttention([mkItem('d1')]);
    const { lastQuery } = renderPane('?opcis=d1');
    fireEvent.click(screen.getByTestId('stub-discuss'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastQuery()).not.toContain('opcid=');
    expect(screen.queryByTestId('work-item-discussion-stub')).toBeNull();
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

// inbox-pane-active-scope-dates-filters-2026-07-19
describe('inbox active scope (P-101)', () => {
  const DAY = 86_400_000;
  it('drops the non-decision plan-item backlog but KEEPS needs-human plan decisions', () => {
    const backlog = mkItem('todo1', { kind: 'plan-item', tier: 'activity', needsHuman: false });
    const blockedPlan = mkItem('blk1', { kind: 'plan-item', tier: 'alert', needsHuman: false });
    const planDecision = mkItem('dec1', { kind: 'plan-item', tier: 'decision', needsHuman: true });
    const kept = scopeInboxItems([backlog, blockedPlan, planDecision]);
    expect(kept.map((i) => i.id)).toEqual(['dec1']);
    expect(isInboxActive(backlog)).toBe(false);
    expect(isInboxActive(blockedPlan)).toBe(false);
    expect(isInboxActive(planDecision)).toBe(true);
  });

  it('keeps alerts + decisions regardless of age, recency-bounds only stale activity', () => {
    const now = Date.now();
    const oldActivity = mkItem('act-old', { tier: 'activity', needsHuman: false, occurredAt: new Date(now - 30 * DAY).toISOString() });
    const freshActivity = mkItem('act-new', { tier: 'activity', needsHuman: false, occurredAt: new Date(now - 1 * DAY).toISOString() });
    const undatedActivity = mkItem('act-undated', { tier: 'activity', needsHuman: false, occurredAt: undefined });
    const oldAlert = mkItem('alert-old', { kind: 'coord-escalation', tier: 'alert', needsHuman: false, occurredAt: new Date(now - 90 * DAY).toISOString() });
    expect(isInboxActive(oldActivity, now)).toBe(false); // stale FYI dropped
    expect(isInboxActive(freshActivity, now)).toBe(true);
    expect(isInboxActive(undatedActivity, now)).toBe(true); // undated → kept
    expect(isInboxActive(oldAlert, now)).toBe(true); // current-state, never expires
  });

  it('the pane "All" count reflects the SCOPED set (backlog excluded)', () => {
    seedAttention([
      mkItem('d1'),
      mkItem('todo1', { kind: 'plan-item', tier: 'activity', needsHuman: false }),
      mkItem('todo2', { kind: 'plan-item', tier: 'alert', needsHuman: false }),
    ]);
    renderPane('?opci=all');
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('1');
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-todo1')).toBeNull();
  });
});

describe('inbox dates (P-2xx)', () => {
  it('formatRelativeDate renders compact relative labels', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    expect(formatRelativeDate(new Date(now - 10_000).toISOString(), now)).toBe('just now');
    expect(formatRelativeDate(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m');
    expect(formatRelativeDate(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h');
    expect(formatRelativeDate(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d');
    expect(formatRelativeDate(null, now)).toBeNull();
    expect(formatRelativeDate('not-a-date', now)).toBeNull();
  });

  it('renders a date element on a row that carries occurredAt', () => {
    seedAttention([mkItem('d1', { occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })]);
    renderPane();
    const date = screen.getByTestId('inbox-date-d1');
    expect(date.textContent).toBe('2h');
  });

  it('renders no date element when occurredAt is absent', () => {
    seedAttention([mkItem('d1', { occurredAt: undefined })]);
    renderPane();
    expect(screen.queryByTestId('inbox-date-d1')).toBeNull();
  });
});

describe('inbox search + kind facets (P-3xx)', () => {
  it('the ?opcq search narrows the list over title/body/owner', () => {
    seedAttention([
      mkItem('d1', { title: 'Deploy the release', tier: 'alert', needsHuman: false }),
      mkItem('d2', { title: 'Rotate the API key', tier: 'alert', needsHuman: false }),
    ]);
    renderPane('?opci=all&opcq=release');
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-d2')).toBeNull();
  });

  it('typing in the search box writes ?opcq', async () => {
    seedAttention([mkItem('d1')]);
    const { lastQuery } = renderPane();
    fireEvent.change(screen.getByTestId('inbox-search'), { target: { value: 'foo' } });
    await waitFor(() => expect(lastQuery()).toContain('opcq=foo'));
  });

  it('a selected ?opck kind facet narrows to that kind', () => {
    seedAttention([
      mkItem('d1', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d2', { kind: 'coord-message', tier: 'alert', needsHuman: false }),
    ]);
    renderPane('?opci=all&opck=coord-escalation');
    expect(screen.getByTestId('inbox-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-row-d2')).toBeNull();
  });

  it('shows data-driven kind facets with counts EXPANDED by default, with no toggle (WI-40982)', () => {
    seedAttention([
      mkItem('d1', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d2', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d3', { kind: 'coord-message', tier: 'alert', needsHuman: false }),
    ]);
    // No ?opcf — the owner's ask (2026-08-23) is that the facets are simply open.
    renderPane('?opci=all');
    const facet = screen.getByTestId('inbox-facet-coord-escalation');
    expect(facet.textContent).toContain('escalation');
    expect(facet.textContent).toContain('2');
    expect(screen.getByTestId('inbox-facet-coord-message')).toBeTruthy();
    // Both halves pinned: facets present AND the disclosure button gone.
    expect(screen.queryByTestId('inbox-filter-toggle')).toBeNull();
  });

  it('exposes the sort picker in the toolbar and writes ?opcsort (WI-40982)', async () => {
    seedAttention([mkItem('d1')]);
    const { lastQuery } = renderPane();
    const sort = screen.getByTestId('inbox-sort') as HTMLSelectElement;
    expect(sort.getAttribute('aria-label')).toBe('Sort inbox');
    expect(sort.value).toBe(DEFAULT_INBOX_SORT);

    fireEvent.change(sort, { target: { value: 'oldest' } });
    await waitFor(() => expect(lastQuery()).toContain('opcsort=oldest'));
  });

  it('renders rows in the ?opcsort order, over the filtered set only', () => {
    // Titles run inverse to age, so "oldest" and "title" disagree with the
    // default priority order — a fixture where the orders coincide would pass
    // against a sort wired to nothing.
    const common = { tier: 'alert' as const, needsHuman: false, kind: 'coord-message' as const };
    seedAttention([
      mkItem('zulu', { ...common, title: 'Zulu', occurredAt: '2026-08-09T00:00:00Z' }),
      mkItem('alpha', { ...common, title: 'Alpha', occurredAt: '2026-08-01T00:00:00Z' }),
    ]);
    const rowsInOrder = () =>
      Array.from(document.querySelectorAll('[data-testid^="inbox-row-"]')).map((el) =>
        el.getAttribute('data-testid'),
      );

    const first = renderPane('?opci=all');
    expect(rowsInOrder()).toEqual(['inbox-row-zulu', 'inbox-row-alpha']); // newest first
    cleanup();
    void first;

    renderPane('?opci=all&opcsort=oldest');
    expect(rowsInOrder()).toEqual(['inbox-row-alpha', 'inbox-row-zulu']);
    cleanup();

    // …and the tier filter still governs WHICH rows exist under a chosen sort:
    // "Needs you" admits only decision-tier rows, whatever the order.
    renderPane('?opci=needs&opcsort=oldest');
    expect(rowsInOrder()).toEqual([]);
  });
});

describe('inbox sort orders (WI-40982)', () => {
  // The fixture is built so that ALL SIX orders land on a DIFFERENT permutation
  // of the same three rows. That is the whole point: on a careless fixture the
  // orders coincide, and every assertion then passes even against a comparator
  // that silently fell through to the default — a green test measuring nothing.
  //   priority → b,a,c   newest → a,c,b   oldest  → b,c,a
  //   kind     → c,a,b   agent  → a,b,c   title   → c,b,a
  const items = [
    mkItem('a', { occurredAt: '2026-08-09T00:00:00Z', title: 'Zulu', kind: 'improvement', ownerLabel: 'alfa', tier: 'alert', needsHuman: false }),
    mkItem('b', { occurredAt: '2026-08-01T00:00:00Z', title: 'Mike', kind: 'coord-message', ownerLabel: 'mike', tier: 'decision', needsHuman: true }),
    mkItem('c', { occurredAt: '2026-08-05T00:00:00Z', title: 'Alpha', kind: 'coord-escalation', ownerLabel: 'zeta', tier: 'alert', needsHuman: false }),
  ] as AttentionItem[];
  const ids = (sort?: Parameters<typeof sortInboxItems>[1]) =>
    sortInboxItems(items, sort).map((i) => i.id);

  it('gives every offered order a DISTINCT result on this fixture (the guard on the guards)', () => {
    const seen = INBOX_SORT_IDS.map((id) => ids(id).join(''));
    expect(new Set(seen).size, `orders collided: ${seen.join(' | ')}`).toBe(seen.length);
  });

  it('defaults to priority: decisions above alerts, newest within a tier', () => {
    expect(ids()).toEqual(['b', 'a', 'c']);
    expect(ids(DEFAULT_INBOX_SORT)).toEqual(ids());
  });

  it('orders by date in both directions, ignoring tier', () => {
    // b is the DECISION and also the oldest — so a date sort that quietly kept
    // the tier rank would be caught here rather than agreeing by accident.
    expect(ids('newest')).toEqual(['a', 'c', 'b']);
    expect(ids('oldest')).toEqual(['b', 'c', 'a']);
  });

  it('orders by kind label, agent and title', () => {
    expect(ids('kind')).toEqual(['c', 'a', 'b']); // escalation < improvement < message
    expect(ids('agent')).toEqual(['a', 'b', 'c']); // alfa < mike < zeta
    expect(ids('title')).toEqual(['c', 'b', 'a']); // Alpha < Mike < Zulu
  });

  it('sorts an UNDATED row last in BOTH directions — unknown is not "oldest"', () => {
    const withUndated = [...items, mkItem('u', { occurredAt: null, tier: 'alert', needsHuman: false })];
    expect(sortInboxItems(withUndated, 'newest').map((i) => i.id).at(-1)).toBe('u');
    expect(sortInboxItems(withUndated, 'oldest').map((i) => i.id).at(-1)).toBe('u');
  });

  it('is STABLE and never adds or drops a row, under every offered order', () => {
    for (const id of INBOX_SORT_IDS) {
      const out = sortInboxItems(items, id);
      expect(out.map((i) => i.id).slice().sort(), `sort=${id}`).toEqual(['a', 'b', 'c']);
      // Same input twice ⇒ same output (no Array#sort instability on ties).
      expect(sortInboxItems(items, id).map((i) => i.id), `sort=${id}`).toEqual(
        out.map((i) => i.id),
      );
    }
    expect(sortInboxItems([], 'newest')).toEqual([]);
  });

  it('exposes a label for every offered order, and no duplicate ids', () => {
    expect(new Set(INBOX_SORT_IDS).size).toBe(INBOX_SORT_IDS.length);
    expect(INBOX_SORT_IDS).toContain(DEFAULT_INBOX_SORT);
    for (const s of INBOX_SORTS) {
      expect(inboxSortLabel(s.id)).toBe(s.label);
      expect(s.label.trim()).not.toBe('');
    }
  });
});
