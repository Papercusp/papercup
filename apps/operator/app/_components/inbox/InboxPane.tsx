'use client';

/**
 * InboxPane (EI-13037, owner ask 2026-07-16 + placement correction) — the
 * owner's HUMAN INBOX as the op-chat sidebar's third view (`?opcv=inbox`),
 * beside the Papercup chat: everything addressed to YOU — coord messages
 * (`coord:send { to: ['human'] }`), escalations, standing approvals, agent
 * questions, operator reports — with the actions to answer them inline.
 *
 * inbox-pane-active-scope-dates-filters-2026-07-19 (owner ask 2026-07-19):
 *   - SCOPE (P-101): the shared `plans.attention` feed is the whole attention
 *     firehose (~15 sources incl. every non-terminal plan item across every
 *     plan) — correct for the /adv Queue, wrong for a human inbox where it
 *     rendered hundreds of backlog rows not awaiting the owner (the "328" bug).
 *     `scopeInboxItems` narrows it to genuinely-active, owner-addressed items
 *     (drops the plan-item execution backlog + recency-bounds stale activity).
 *   - DATES (P-2xx): each row shows a relative date (from `AttentionItem.occurredAt`)
 *     with an absolute-time tooltip; ties sort by recency.
 *   - FILTER/SEARCH (P-3xx): a QueueFilterBar-style collapsed Filter with
 *     per-kind facet chips + counts, plus a text search over title/body/owner/plan.
 *
 * REUSE, not re-derivation:
 *   - data: useInboxAttention → the SAME `plans.attention` sync feed the
 *     Queue + Overview render (shared cache entry, SSE-invalidated);
 *   - detail: the Queue's own exported OtherDetail — the unified
 *     AskChoiceCard + triage audit + QueueCardActions — rendered inline under
 *     the selected row, so acting from the sidebar IS acting in the Queue;
 *   - tier semantics: effectiveTier (mirrors AdvOverviewTab's fallback).
 *
 * "Discuss" here opens a chat with PAPERCUP about the item (owner ask
 * 2026-07-16): the card's discuss pick is intercepted (OtherDetail's
 * onDiscuss), a drafted message is staged via seedOperatorChatDraft, and the
 * pane flips back to the chat view.
 *
 * Filter + selection + search live in the URL (nuqs `?opci` / `?opcis` /
 * `?opcq` / `?opck` / `?opcf`) so the pane is deep-linkable and agent-driveable
 * (ui:get_state / ui:dispatch), per the nuqs-by-default policy.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useQueryState,
  useQueryStates,
  parseAsString,
  parseAsStringLiteral,
  parseAsBoolean,
} from 'nuqs';
import {
  ArrowLeft,
  ChevronRight,
  Inbox as InboxIcon,
  MessageCircle,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { OtherDetail, KIND_LABEL } from '@/app/admin/plans/PlanOtherList';
import {
  TIER_LABEL,
  type AttentionActionId,
  type AttentionItem,
  type AttentionTier,
} from '@/app/admin/plans/plans-api';
import { effectiveTier, scopeInboxItems, useInboxAttention } from './use-inbox-pending';
import { seedOperatorChatDraft } from './chat-seed';
import SessionChatModal from '../chat/SessionChatModal';
import {
  CHAT_WORK_ITEM_POPUP_PARAM,
  encodeScopedRef,
} from '../chat/chat-ref-popup-params';
// The Queue detail card's styles (pc-items__*, pc-tier/pc-kind badges). Global
// (non-module) CSS — importing it here makes the pane self-sufficient on
// every route.
import '@/app/admin/plans/plans.css';
import './inbox-pane.css';

const FILTERS = ['needs', 'alerts', 'all'] as const;
type InboxFilter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<InboxFilter, string> = {
  needs: 'Needs you',
  alerts: 'Alerts',
  all: 'All',
};

/** Decisions first, then alerts — the order the owner should read. */
const TIER_RANK: Record<AttentionTier, number> = { decision: 0, alert: 1, handled: 2, activity: 3 };

/** A relative "how long ago" label from an ISO timestamp — "just now", "5m",
 *  "3h", "2d", "3w", else an absolute short date. Null timestamp → null. */
export function formatRelativeDate(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Absolute timestamp for the date tooltip. */
function formatAbsoluteDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString();
}

/** The drafted "Papercup, look at this" message for an inbox item. */
export function buildDiscussDraft(i: AttentionItem): string {
  const kindLabel = KIND_LABEL[i.kind] ?? i.kind;
  const where = [i.planSlug && `plan ${i.planSlug}`, i.harnessSlug && `harness ${i.harnessSlug}`]
    .filter(Boolean)
    .join(' · ');
  // i.report is a STRUCTURED ReportBlock (title + plan rows), not a string —
  // flatten it to a one-liner-per-plan digest for the drafted chat message.
  const reportText = i.report
    ? [
        i.report.title,
        ...i.report.plans.map((p) =>
          [p.title, p.status && `[${p.status}]`, p.summary].filter(Boolean).join(' '),
        ),
      ]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join('\n')
    : '';
  const report = reportText.trim() ? `\n\n${reportText.trim().slice(0, 600)}` : '';
  return (
    // i.id already carries the kind prefix (e.g. "coord-message:m1") — don't re-prepend it.
    `About this inbox item (${kindLabel}${where ? ` — ${where}` : ''}, ref ${i.id}):\n` +
    `"${i.title}"${report}\n\n` +
    `Can you explain what this needs from me and help me resolve it?`
  );
}

/** Lowercase haystack for the text search (title + body + owner + plan/harness). */
function searchHaystack(i: AttentionItem): string {
  return [
    i.title,
    i.body,
    i.ownerLabel,
    i.ownerAgentId,
    i.planSlug,
    i.harnessSlug,
    KIND_LABEL[i.kind] ?? i.kind,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The durable work-item id a source-opening action can show in the shared
 * popup. Kept conservative: an owner-wall ref that is not a WI/EI/F id falls
 * back to the full Queue rather than guessing a destination. */
function attentionWorkItemId(i: AttentionItem): string | null {
  const ref = i.ref as Record<string, unknown>;
  switch (ref.kind) {
    case 'work-item-needs-human':
    case 'work-item-blocked':
      return typeof ref.workItemId === 'string' ? ref.workItemId : null;
    case 'improvement':
      return typeof ref.issueId === 'string' ? ref.issueId : null;
    case 'owner-wall':
      return typeof ref.wallRef === 'string' && /^(?:WI|EI|F)-\d+$/i.test(ref.wallRef)
        ? ref.wallRef.toUpperCase()
        : null;
    default:
      return null;
  }
}

export default function InboxPane({ onDiscussInChat }: {
  /** Flip the sidebar back to the chat view (the seed is already staged). */
  onDiscussInChat: () => void;
}) {
  const { items, loading, error, refresh } = useInboxAttention();
  const [filter, setFilter] = useQueryState(
    'opci',
    parseAsStringLiteral(FILTERS).withDefault('needs'),
  );
  const [sel, setSel] = useQueryState('opcis', parseAsString);
  // Free-text search over the scoped feed (deep-linkable/agent-driveable).
  const [query, setQuery] = useQueryState('opcq', parseAsString.withDefault(''));
  // Selected kind facets — comma-joined kind ids (a QueueFilterBar-style
  // per-kind narrowing). Empty ⇒ all kinds.
  const [kindsParam, setKindsParam] = useQueryState('opck', parseAsString.withDefault(''));
  // Filter panel open-state (the kind-facet chips are behind the collapsed
  // "Filter" trigger, like the Queue's).
  const [filtersOpen, setFiltersOpen] = useQueryState('opcf', parseAsBoolean.withDefault(false));
  // The "chat-grade session context" popup (P-007): which agent's live session
  // to show, keyed by ownerAgentId.
  const [chatOwner, setChatOwner] = useQueryState('opcsession', parseAsString);
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  // The Queue lives on /adv (?tab=plans&view=queue) — MERGE-write the params
  // when already there; hard-navigate otherwise (this sidebar is global).
  const [, setQueueParams] = useQueryStates({
    tab: parseAsString,
    view: parseAsString,
  });
  const openQueue = useCallback(() => {
    if (window.location.pathname.startsWith('/adv')) {
      void setQueueParams({ tab: 'plans', view: 'queue' });
    } else {
      window.location.assign('/adv?tab=plans&view=queue');
    }
  }, [setQueueParams]);

  const onDiscuss = useCallback(
    (i: AttentionItem) => {
      seedOperatorChatDraft(buildDiscussDraft(i));
      onDiscussInChat();
      return true; // handled — suppress the Queue's inline DiscussPanel
    },
    [onDiscussInChat],
  );

  const onResolved = useCallback(() => {
    // A resolved row is about to leave the live feed. Return the narrow layout
    // to its list rather than stranding it on a stale detail, then invalidate
    // the shared attention cache for every host.
    void setSel(null);
    refresh();
  }, [refresh, setSel]);

  const onNavigate = useCallback(
    (i: AttentionItem, actionId: AttentionActionId) => {
      if ((actionId === 'message-owner' || actionId === 'chat') && i.ownerAgentId) {
        void setChatOwner(i.ownerAgentId);
        return true;
      }
      if (actionId === 'open') {
        const workItemId = attentionWorkItemId(i);
        if (workItemId && i.harnessSlug) {
          void setOpenWorkItem(encodeScopedRef(i.harnessSlug, workItemId));
          return true;
        }
        openQueue();
        return true;
      }
      if (actionId === 'view-log') {
        // The Queue owns the source-specific smoke/log drill-ins. This is an
        // honest navigation, not the previous toast-only pseudo-action.
        openQueue();
        return true;
      }
      return false;
    },
    [openQueue, setChatOwner, setOpenWorkItem],
  );

  // P-101: narrow the shared attention firehose to genuinely-active, owner-
  // addressed items BEFORE anything else reads it — so the chip counts, the
  // kind facets, and the list all agree and never show the backlog again.
  const scoped = useMemo(() => scopeInboxItems(items), [items]);

  const selectedKinds = useMemo(
    () => new Set(kindsParam.split(',').map((s) => s.trim()).filter(Boolean)),
    [kindsParam],
  );
  const q = query.trim().toLowerCase();

  const toggleKind = useCallback(
    (kind: string) => {
      const next = new Set(selectedKinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      void setKindsParam([...next].join(','));
    },
    [selectedKinds, setKindsParam],
  );

  // Tier-chip counts (Needs / Alerts / All) over the SCOPED set.
  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = { needs: 0, alerts: 0, all: scoped.length };
    for (const i of scoped) {
      const tier = effectiveTier(i);
      if (tier === 'decision') c.needs += 1;
      else if (tier === 'alert') c.alerts += 1;
    }
    return c;
  }, [scoped]);

  // Kind facets present in the scoped set (id + label + count) — data-driven so
  // every emitted kind (incl. the P-005 owner-gate kinds absent from the client
  // union) shows a chip, in tier-then-count order.
  const kindFacets = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const i of scoped) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    return [...byKind.entries()]
      .map(([id, count]) => ({ id, count, label: KIND_LABEL[id as AttentionItem['kind']] ?? id }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [scoped]);

  const activeFilterCount = selectedKinds.size + (q ? 1 : 0);

  // Best-effort friendly label for the SessionChatModal title.
  const chatOwnerLabel = useMemo(
    () => scoped.find((i) => i.ownerAgentId === chatOwner)?.ownerLabel ?? null,
    [scoped, chatOwner],
  );

  const lastScrolledSel = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const filtered = scoped.filter((i) => {
      const tier = effectiveTier(i);
      if (filter === 'needs' && tier !== 'decision') return false;
      if (filter === 'alerts' && tier !== 'alert') return false;
      if (selectedKinds.size > 0 && !selectedKinds.has(i.kind)) return false;
      if (q && !searchHaystack(i).includes(q)) return false;
      return true;
    });
    // Stable sort: decisions on top, then alerts; within a tier, newest first
    // (an item with no occurredAt keeps its server order via the idx tiebreak).
    return filtered
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const tierDelta = TIER_RANK[effectiveTier(a.item)] - TIER_RANK[effectiveTier(b.item)];
        if (tierDelta !== 0) return tierDelta;
        const at = a.item.occurredAt ? new Date(a.item.occurredAt).getTime() : NaN;
        const bt = b.item.occurredAt ? new Date(b.item.occurredAt).getTime() : NaN;
        const aok = Number.isFinite(at);
        const bok = Number.isFinite(bt);
        if (aok && bok && bt !== at) return bt - at; // newest first
        if (aok !== bok) return aok ? -1 : 1; // dated before undated
        return a.idx - b.idx;
      })
      .map((x) => x.item);
  }, [scoped, filter, selectedKinds, q]);

  // Resolve selection against the SCOPED feed, not the filtered list: a deep
  // link remains inspectable while its tier/kind/search filter is adjusted.
  const selectedItem = useMemo(
    () => scoped.find((item) => item.id === sel) ?? null,
    [scoped, sel],
  );

  // Virtualize the row list (WI-5339): even scoped, the inbox can hold many rows.
  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => visible[i]?.id ?? i,
  });

  // Scroll a freshly deep-linked selection (opcis) into view.
  useEffect(() => {
    if (!sel) {
      lastScrolledSel.current = null;
      return;
    }
    if (sel === lastScrolledSel.current) return;
    const idx = visible.findIndex((i) => i.id === sel);
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'center' });
      lastScrolledSel.current = sel;
    }
  }, [sel, visible, rowVirtualizer]);

  return (
    <div
      className={`op-inbox${selectedItem ? ' op-inbox--has-selection' : ''}`}
      data-testid="inbox-tab"
    >
      <section className="op-inbox__master" aria-label="Resolution inbox items">
      <header className="op-inbox__masthead">
        <span className="op-inbox__masthead-icon" aria-hidden="true">
          <InboxIcon size={18} />
        </span>
        <span className="op-inbox__masthead-copy">
          <strong>Needs you</strong>
          <span>Resolve every owner-blocked item in one place.</span>
        </span>
        <span
          className="op-inbox__masthead-count"
          aria-label={`${counts.needs} items need you`}
        >
          {counts.needs}
        </span>
      </header>
      <div className="op-inbox__chips" aria-label="Inbox filter">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`op-inbox__chip${filter === f ? ' is-active' : ''}`}
            aria-pressed={filter === f}
            data-testid={`inbox-filter-${f}`}
            onClick={() => void setFilter(f)}
          >
            {FILTER_LABEL[f]}
            <span className="op-inbox__chip-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {/* Search + collapsible kind-facet filter (mimics the Queue's QueueFilterBar). */}
      <div className="op-inbox__toolbar">
        <div className="op-inbox__search">
          <Search size={13} aria-hidden="true" className="op-inbox__search-icon" />
          <input
            type="text"
            className="op-inbox__search-input"
            placeholder="Search blockers…"
            value={query}
            data-testid="inbox-search"
            aria-label="Search inbox"
            onChange={(e) => void setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="op-inbox__search-clear"
              aria-label="Clear search"
              data-testid="inbox-search-clear"
              onClick={() => void setQuery('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className={`op-inbox__filter-toggle${filtersOpen ? ' is-open' : ''}`}
          aria-expanded={filtersOpen}
          data-testid="inbox-filter-toggle"
          onClick={() => void setFiltersOpen(!filtersOpen)}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>Kinds</span>
          {activeFilterCount > 0 ? (
            <span className="op-inbox__filter-active">{activeFilterCount}</span>
          ) : null}
        </button>
      </div>

      {filtersOpen && kindFacets.length > 0 ? (
        <div className="op-inbox__facets" aria-label="Filter by kind">
          {selectedKinds.size > 0 ? (
            <button
              type="button"
              className="op-inbox__facet op-inbox__facet--clear"
              onClick={() => void setKindsParam('')}
              data-testid="inbox-facet-clear"
            >
              Clear kinds
            </button>
          ) : null}
          {kindFacets.map((k) => {
            const active = selectedKinds.has(k.id);
            return (
              <button
                key={k.id}
                type="button"
                className={`op-inbox__facet${active ? ' is-active' : ''}`}
                aria-pressed={active}
                data-testid={`inbox-facet-${k.id}`}
                onClick={() => toggleKind(k.id)}
              >
                <span className="op-inbox__facet-label">{k.label}</span>
                <span className="op-inbox__facet-count">{k.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <div className="op-inbox__error" role="alert">
          <span>Could not load the Resolution Inbox: {error}</span>
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      ) : null}
      {loading && items.length === 0 ? (
        <div className="op-inbox__loading" data-testid="inbox-loading">Loading blockers…</div>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <div className="op-inbox__empty" data-testid="inbox-empty">
          <InboxIcon size={20} className="op-inbox__empty-icon" aria-hidden="true" />
          <strong>{q || selectedKinds.size > 0 ? 'No matches' : 'Inbox zero'}</strong>
          <span>
            {q || selectedKinds.size > 0
              ? 'Nothing matches the current filters.'
              : filter === 'needs'
                ? 'Nothing needs you. New decisions and owner walls will land here.'
                : 'Nothing here right now.'}
          </span>
        </div>
      ) : null}

      <div className="op-inbox__list" ref={listRef}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const i = visible[vi.index]!;
            const isSel = i.id === sel;
            const tier = effectiveTier(i);
            const meta = [i.ownerLabel ?? i.ownerAgentId, i.planSlug ?? i.harnessSlug]
              .filter(Boolean)
              .join(' · ');
            const rel = formatRelativeDate(i.occurredAt);
            const abs = formatAbsoluteDate(i.occurredAt);
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  paddingBottom: 4,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <div className={`op-inbox__row op-inbox__row--${tier}${isSel ? ' is-selected' : ''}`}>
              {/* A `div` (not `button`) — the row nests a real chat-launch
                  <button>, and nested interactive elements are invalid HTML. */}
              <div
                role="button"
                tabIndex={0}
                className="op-inbox__rowbtn"
                data-testid={`inbox-row-${i.id}`}
                aria-expanded={isSel}
                onClick={() => void setSel(isSel ? null : i.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  void setSel(isSel ? null : i.id);
                }}
              >
                <span className="op-inbox__rowhead">
                  <span
                    className={`op-inbox__tierdot op-inbox__tierdot--${tier}`}
                    title={TIER_LABEL[tier]}
                    aria-label={TIER_LABEL[tier]}
                  />
                  <span className="op-inbox__kind">{KIND_LABEL[i.kind] ?? i.kind}</span>
                  {meta ? <span className="op-inbox__meta">{meta}</span> : null}
                  <span className="op-inbox__rowhead-spacer" />
                  {rel ? (
                    <Tooltip label={abs ?? rel}>
                      <span className="op-inbox__date" data-testid={`inbox-date-${i.id}`}>
                        {rel}
                      </span>
                    </Tooltip>
                  ) : null}
                  {i.ownerAgentId ? (
                    <Tooltip label="Open live chat with the originating agent">
                      <button
                        type="button"
                        className="op-inbox__chat-button"
                        data-testid={`inbox-chat-open-${i.id}`}
                        aria-label={`Open live chat with ${i.ownerLabel ?? i.ownerAgentId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void setChatOwner(i.ownerAgentId ?? null);
                        }}
                      >
                        <MessageCircle size={13} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  ) : null}
                </span>
                <span className="op-inbox__title">{i.title}</span>
                <span className="op-inbox__status">{i.status}</span>
                <ChevronRight className="op-inbox__row-chevron" size={16} aria-hidden="true" />
              </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="op-inbox__foot">
        <span>{visible.length} shown</span>
        <button
          type="button"
          className="op-inbox__queue-link"
          data-testid="inbox-open-queue"
          onClick={openQueue}
        >
          Open full queue →
        </button>
      </div>
      </section>

      <section className="op-inbox__detail-pane" aria-label="Selected blocker detail">
        {selectedItem ? (
          <>
            <header className="op-inbox__detail-head">
              <button
                type="button"
                className="op-inbox__detail-back"
                data-testid="inbox-detail-back"
                onClick={() => void setSel(null)}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                Inbox
              </button>
              <span className="op-inbox__detail-title-group">
                <span className="op-inbox__detail-kicker">
                  {KIND_LABEL[selectedItem.kind] ?? selectedItem.kind}
                  {selectedItem.itemRef ? ` · ${selectedItem.itemRef}` : ''}
                </span>
                <strong>{selectedItem.title}</strong>
              </span>
              {selectedItem.ownerAgentId ? (
                <Tooltip label={`Open live chat with ${selectedItem.ownerLabel ?? selectedItem.ownerAgentId}`}>
                  <button
                    type="button"
                    className="op-inbox__detail-chat"
                    aria-label={`Open live chat with ${selectedItem.ownerLabel ?? selectedItem.ownerAgentId}`}
                    onClick={() => void setChatOwner(selectedItem.ownerAgentId ?? null)}
                  >
                    <MessageCircle size={15} aria-hidden="true" />
                    <span>Agent</span>
                  </button>
                </Tooltip>
              ) : null}
            </header>
            <div className="op-inbox__detail-scroll" data-testid="inbox-detail">
              <OtherDetail
                key={selectedItem.id}
                item={selectedItem}
                onResolved={onResolved}
                onDiscuss={onDiscuss}
                onNavigate={onNavigate}
              />
            </div>
          </>
        ) : (
          <div className="op-inbox__detail-empty" data-testid="inbox-detail-empty">
            <span className="op-inbox__detail-empty-icon" aria-hidden="true">
              <ChevronRight size={20} />
            </span>
            <strong>Select a blocker</strong>
            <span>Its full context and type-aware resolution actions will appear here.</span>
          </div>
        )}
      </section>

      <SessionChatModal
        sessionOwnerId={chatOwner}
        ownerLabel={chatOwnerLabel}
        onClose={() => void setChatOwner(null)}
      />
    </div>
  );
}
