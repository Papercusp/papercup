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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null as unknown, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
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
  OtherDetail: ({ item, onDiscuss, onResolved, onNavigate }: {
    item: { id: string };
    onDiscuss?: (i: unknown) => boolean;
    onResolved: () => void;
    onNavigate?: (i: unknown, actionId: 'open' | 'message-owner') => boolean;
  }) => (
    <div data-testid="other-detail" data-item={item.id}>
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

import InboxPane, { buildDiscussDraft, formatRelativeDate } from './InboxPane';
import { effectiveTier, useInboxPendingCount, isInboxActive, scopeInboxItems } from './use-inbox-pending';
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
  chatModalProps.mockClear();
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
  it("an ALERT-tier selection remains inspectable even when the current list filter hides its row", () => {
    seedAttention([
      mkItem('coord-escalation:m9', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d1'),
    ]);
    renderPane('?opcis=coord-escalation:m9'); // default 'needs' filter
    expect(screen.queryByTestId('inbox-row-coord-escalation:m9')).toBeNull(); // filtered out
    expect(screen.getByTestId('other-detail').getAttribute('data-item')).toBe('coord-escalation:m9');
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

  it('clicking a row writes ?opcis; selection renders OtherDetail in a dedicated sibling pane', async () => {
    seedAttention([mkItem('d1'), mkItem('d2')]);
    const { lastQuery } = renderPane('?opcis=d2');
    // Pre-seeded selection renders the detail for d2 only.
    const detail = screen.getByTestId('other-detail');
    expect(detail.getAttribute('data-item')).toBe('d2');
    expect(screen.getAllByTestId('other-detail')).toHaveLength(1);
    expect(screen.getByTestId('inbox-row-d2').contains(detail)).toBe(false);
    expect(screen.getByTestId('inbox-tab').classList.contains('op-inbox--has-selection')).toBe(true);
    // Clicking another row re-targets the selection (the adapter reports URL
    // writes on the next tick).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).toContain('opcis=d1'));
    // Clicking the (now-)selected row clears it (toggle).
    fireEvent.click(screen.getByTestId('inbox-row-d1'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcis='));
  });

  it('the narrow-pane Back affordance clears selection and a resolution refreshes the feed', async () => {
    seedAttention([mkItem('d1')]);
    const source = H.results['plans.attention']!;
    const { lastQuery } = renderPane('?opcis=d1');

    fireEvent.click(screen.getByTestId('inbox-detail-back'));
    await waitFor(() => expect(lastQuery()).not.toContain('opcis='));

    cleanup();
    renderPane('?opcis=d1');
    fireEvent.click(screen.getByTestId('stub-resolve'));
    expect(source.invalidate).toHaveBeenCalledTimes(1);
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

  it('the Filter toggle reveals data-driven kind facets with counts', () => {
    seedAttention([
      mkItem('d1', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d2', { kind: 'coord-escalation', tier: 'alert', needsHuman: false }),
      mkItem('d3', { kind: 'coord-message', tier: 'alert', needsHuman: false }),
    ]);
    renderPane('?opci=all&opcf=true');
    const facet = screen.getByTestId('inbox-facet-coord-escalation');
    expect(facet.textContent).toContain('escalation');
    expect(facet.textContent).toContain('2');
    expect(screen.getByTestId('inbox-facet-coord-message')).toBeTruthy();
  });
});
