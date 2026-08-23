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
 *   - FILTER/SEARCH (P-3xx): QueueFilterBar-style per-kind facet chips + counts,
 *     plus a text search over title/body/owner/plan.
 *   - SORT (WI-40982): a sort picker whose orders run over the ALREADY-FILTERED
 *     set — the tier chip, the kind facets and the search all narrow first, and
 *     the chosen order is applied last to whatever survived.
 *
 * REUSE, not re-derivation:
 *   - data: useInboxAttention → the SAME `plans.attention` sync feed the
 *     Queue + Overview render (shared cache entry, SSE-invalidated);
 *   - detail: the Queue's own exported OtherDetail — the unified
 *     AskChoiceCard + triage audit + QueueCardActions — rendered inline inside
 *     the selected row, with the full body before its actions, so acting from
 *     the sidebar IS acting in the Queue;
 *   - tier semantics: effectiveTier (mirrors AdvOverviewTab's fallback).
 *
 * "Discuss" here opens the item's durable Papercup thread INLINE (P-018 /
 * D-014): the card's discuss pick writes the scoped `?opcid` target and mounts
 * WorkItemDiscussion directly beneath the expanded item. The workspace-global
 * Papercup transcript is never seeded or selected by this path.
 *
 * Filter + selection + search + sort live in the URL (nuqs `?opci` / `?opcis` /
 * `?opcq` / `?opck` / `?opcsort`) so the pane is deep-linkable and
 * agent-driveable (ui:get_state / ui:dispatch), per the nuqs-by-default policy.
 *
 * The kind facets are ALWAYS OPEN (owner ask 2026-08-23, WI-40982). The old
 * `?opcf` disclosure and its "Kinds" toggle button are GONE: the facet chips
 * are the pane's cheapest read of what is actually waiting, and hiding them
 * behind a click bought nothing. The toolbar slot the toggle vacated now holds
 * the sort picker. A stale `?opcf=…` deep link is inert.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useQueryState,
  useQueryStates,
  parseAsString,
  parseAsStringLiteral,
} from 'nuqs';
import {
  ArrowUpDown,
  ChevronDown,
  ClipboardList,
  ChevronRight,
  Inbox as InboxIcon,
  MessageCircle,
  Search,
  X,
} from 'lucide-react';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { OtherDetail, KIND_LABEL } from '@/app/admin/plans/PlanOtherList';
import {
  TIER_LABEL,
  type AttentionActionId,
  type AttentionItem,
  type AttentionTier,
} from '@/app/admin/plans/plans-api';
import { effectiveTier, scopeInboxItems, useInboxAttention } from './use-inbox-pending';
import InboxBulkStrip from './InboxBulkStrip';
import InboxBulkRecommendation from './InboxBulkRecommendation';
import { useBulkRunOps, useInboxBulkRun, type BulkRunItem } from './use-inbox-bulk-run';
import { useFlag } from '@/lib/flag-hooks';
import SessionChatModal from '../chat/SessionChatModal';
import {
  CHAT_WORK_ITEM_POPUP_PARAM,
  decodeScopedRef,
  encodeScopedRef,
} from '../chat/chat-ref-popup-params';
import WorkItemDiscussion, {
  WORK_ITEM_DISCUSSION_PARAM,
} from '../work-items/WorkItemDiscussion';
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

/** Sort orders this pane offers (WI-40982). `priority` is the pane's original
 *  order and stays the default: tier first, newest within a tier. */
export const INBOX_SORTS = [
  { id: 'priority', label: 'Priority' },
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'kind', label: 'Kind' },
  { id: 'agent', label: 'Agent' },
  { id: 'title', label: 'Title A–Z' },
] as const;

export type InboxSort = (typeof INBOX_SORTS)[number]['id'];

export const INBOX_SORT_IDS = INBOX_SORTS.map((s) => s.id) as InboxSort[];

export const DEFAULT_INBOX_SORT: InboxSort = 'priority';

export function inboxSortLabel(sort: InboxSort): string {
  return INBOX_SORTS.find((s) => s.id === sort)?.label ?? sort;
}

/** Epoch ms for an item's timestamp, or null when it has none / an unparseable
 *  one. Null is "unknown", never "old" — see the ordering rules below. */
function occurredMs(i: AttentionItem): number | null {
  const t = i.occurredAt ? new Date(i.occurredAt).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Newest first. An undated row sorts AFTER every dated one in BOTH directions:
 *  a missing timestamp means "we don't know when", so promoting it to the top of
 *  the oldest-first list would be an invented fact. */
function byNewest(a: AttentionItem, b: AttentionItem): number {
  const at = occurredMs(a);
  const bt = occurredMs(b);
  if (at !== null && bt !== null) return bt - at;
  if (at !== bt) return at === null ? 1 : -1;
  return 0;
}

function byOldest(a: AttentionItem, b: AttentionItem): number {
  const at = occurredMs(a);
  const bt = occurredMs(b);
  if (at !== null && bt !== null) return at - bt;
  if (at !== bt) return at === null ? 1 : -1;
  return 0;
}

/** Case-insensitive text order; an EMPTY key sorts last rather than first, so a
 *  row with no agent/title never leads the list. */
function byText(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function agentKey(i: AttentionItem): string {
  return (i.ownerLabel ?? i.ownerAgentId ?? '').trim();
}

function kindKey(i: AttentionItem): string {
  return KIND_LABEL[i.kind] ?? i.kind ?? '';
}

/** Comparator for one inbox order. Pure — exported for unit tests. */
export function compareInboxItems(
  sort: InboxSort,
): (a: AttentionItem, b: AttentionItem) => number {
  switch (sort) {
    case 'newest':
      return byNewest;
    case 'oldest':
      return byOldest;
    case 'kind':
      return (a, b) => byText(kindKey(a), kindKey(b)) || byNewest(a, b);
    case 'agent':
      return (a, b) => byText(agentKey(a), agentKey(b)) || byNewest(a, b);
    case 'title':
      return (a, b) => byText(a.title ?? '', b.title ?? '') || byNewest(a, b);
    case 'priority':
    default:
      // The pane's original order: decisions on top, then alerts; newest within
      // a tier.
      return (a, b) =>
        TIER_RANK[effectiveTier(a)] - TIER_RANK[effectiveTier(b)] || byNewest(a, b);
  }
}

/** Order a filtered item set. STABLE: ties keep the server's order via the idx
 *  decoration, so an undated backlog never reshuffles between renders. */
export function sortInboxItems(
  items: readonly AttentionItem[],
  sort: InboxSort = DEFAULT_INBOX_SORT,
): AttentionItem[] {
  const cmp = compareInboxItems(sort);
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => cmp(a.item, b.item) || a.idx - b.idx)
    .map((x) => x.item);
}

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

function InboxRowIcon({ kind }: { kind: AttentionItem['kind'] }) {
  if (kind === 'plan-item') return <ClipboardList size={17} aria-hidden="true" />;
  if (kind === 'blocked-session' || kind === 'conversation') {
    return <MessageCircle size={17} aria-hidden="true" />;
  }
  return <InboxIcon size={17} aria-hidden="true" />;
}

export default function InboxPane() {
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
  // Sort order over the filtered set (WI-40982).
  const [sort, setSort] = useQueryState(
    'opcsort',
    parseAsStringLiteral(INBOX_SORT_IDS).withDefault(DEFAULT_INBOX_SORT),
  );
  // The BULK RESOLVE run being shown (inbox-bulk-resolve-2026-08-23 P-006).
  // In the URL like every other pane selection, so a run is deep-linkable and
  // agent-driveable; empty ⇒ the strip reads the workspace's LATEST run, which
  // is what "is there a run I should be showing?" actually means on open.
  const [bulkRunId, setBulkRunId] = useQueryState('opcbr', parseAsString);
  // The "chat-grade session context" popup (P-007): which agent's live session
  // to show, keyed by ownerAgentId.
  const [chatOwner, setChatOwner] = useQueryState('opcsession', parseAsString);
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  const [discussionRef, setDiscussionRef] = useQueryState(
    WORK_ITEM_DISCUSSION_PARAM,
    parseAsString,
  );
  const discussionTarget = useMemo(
    () => decodeScopedRef(discussionRef),
    [discussionRef],
  );
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
      const workItemId = attentionWorkItemId(i);
      if (!workItemId || !i.harnessSlug) return false;
      void setDiscussionRef(encodeScopedRef(i.harnessSlug, workItemId));
      return true; // handled — suppress the Queue's legacy DiscussPanel
    },
    [setDiscussionRef],
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

  // Best-effort friendly label for the SessionChatModal title.
  const chatOwnerLabel = useMemo(
    () => scoped.find((i) => i.ownerAgentId === chatOwner)?.ownerLabel ?? null,
    [scoped, chatOwner],
  );

  const lastScrolledSel = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Resolve selection against the SCOPED feed, not the filtered list. The
  // selected row is admitted below even when a deep link's tier/kind/search
  // filter would otherwise hide it, so inspection remains inline without
  // silently clearing the owner's current filters.
  const selectedItem = useMemo(
    () => scoped.find((item) => item.id === sel) ?? null,
    [scoped, sel],
  );

  const visible = useMemo(() => {
    const filtered = scoped.filter((i) => {
      const tier = effectiveTier(i);
      if (filter === 'needs' && tier !== 'decision') return false;
      if (filter === 'alerts' && tier !== 'alert') return false;
      if (selectedKinds.size > 0 && !selectedKinds.has(i.kind)) return false;
      if (q && !searchHaystack(i).includes(q)) return false;
      return true;
    });
    // Sort runs LAST, over the already-filtered set (WI-40982), so changing the
    // order can never re-admit a row the tier/kind/search filters excluded.
    const ordered = sortInboxItems(filtered, sort);
    if (selectedItem && !ordered.some((item) => item.id === selectedItem.id)) {
      return [selectedItem, ...ordered];
    }
    return ordered;
  }, [scoped, filter, selectedKinds, q, selectedItem, sort]);

  /* ── BULK RESOLVE (inbox-bulk-resolve-2026-08-23, P-006) ─────────────────
     The strip and the per-row recommendations read the SAME run: one sync
     subscription here, passed down, so the band and the rows can never disagree
     about a run's phase. Flag-gated as a unit — OFF makes the pane render
     exactly what it rendered before this existed.

     Declared after `visible` because the strip acts on the pane's CURRENT
     filtered set, which is what `visible` is. */
  const bulkEnabled = useFlag('INBOX_BULK_RESOLVE');
  const bulk = useInboxBulkRun(bulkEnabled ? bulkRunId : null);
  const { acceptRecommendation } = useBulkRunOps();
  const [acceptingCount, setAcceptingCount] = useState(0);

  // Provenance for the record — what the pane SAID it was showing when the owner
  // clicked. Never the source of the run's membership (the posted ids are), so a
  // filter that has moved since cannot silently change which items get acted on.
  const bulkFilterSnapshot = useMemo(
    () => ({
      tier: filter,
      kinds: [...selectedKinds],
      query: query.trim() || null,
      shownCount: visible.length,
    }),
    [filter, selectedKinds, query, visible.length],
  );

  const acceptOneRecommendation = useCallback(
    async (item: AttentionItem, rec: BulkRunItem) => {
      if (!bulk.run) return { ok: false, error: 'no active run' };
      setAcceptingCount((n) => n + 1);
      try {
        const res = await acceptRecommendation(bulk.run.runId, item, rec);
        // A resolved row is about to leave the live feed — the same cleanup a
        // hand resolve does, through the same callback.
        if (res.ok) onResolved();
        return res;
      } finally {
        setAcceptingCount((n) => Math.max(0, n - 1));
      }
    },
    [bulk.run, acceptRecommendation, onResolved],
  );

  const acceptAllRecommendations = useCallback(async () => {
    if (!bulk.run) return;
    // SEQUENTIALLY, not Promise.all: each accept dispatches a real resolve that
    // wakes an agent and writes an audit row, and firing N of those at once
    // against the same feed is how a partial failure becomes unattributable.
    // Sequential also means a mid-way failure leaves the REST still pending and
    // visible, rather than an indeterminate half-applied batch.
    for (const rec of bulk.recommendations) {
      const item = scoped.find((i) => i.id === rec.itemId);
      if (!item) continue; // already gone from the feed — nothing left to resolve
      await acceptOneRecommendation(item, rec);
    }
  }, [bulk.run, bulk.recommendations, scoped, acceptOneRecommendation]);

  // Virtualize the row list (WI-5339): even scoped, the inbox can hold many rows.
  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => visible[i]?.id ?? i,
  });

  // owner-inbox D-012: expanding/collapsing a disclosure must preserve the
  // list's scroll position. ReactVirtualizerOptions does not expose this core
  // switch, but the returned Virtualizer's public typed property does.
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

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
    <div className="op-inbox" data-testid="inbox-tab">
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
        {/* Sort picker — the shared Radix Select (native <select> is banned by
            _lints/design-primitives), standing where the retired "Kinds" toggle
            was. A fixed toolbar slot: putting it down with the facet chips
            would let it move every time the chip row rewraps. */}
        <Select
          value={sort}
          onChange={(v) =>
            void setSort(v === DEFAULT_INBOX_SORT ? null : (v as InboxSort))
          }
          options={INBOX_SORTS.map((s) => ({ value: s.id, label: s.label }))}
          ariaLabel="Sort inbox"
          testId="inbox-sort"
          triggerClassName="op-inbox__sort"
          align="end"
          triggerChildren={
            <>
              <ArrowUpDown size={13} aria-hidden="true" />
              <span className="op-inbox__sort-label">{inboxSortLabel(sort)}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </>
          }
        />
      </div>

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

      {/* Always open (WI-40982) — no disclosure, no toggle. Still conditional on
          HAVING facets: an empty scoped feed has no kinds to chip. */}
      {kindFacets.length > 0 ? (
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
              <div className="op-inbox__row-summary">
              <span className="op-inbox__row-icon" aria-hidden="true">
                <InboxRowIcon kind={i.kind} />
              </span>
              {/* A `div` (not `button`) — the row nests a real chat-launch
                  <button>, and nested interactive elements are invalid HTML. */}
              <div
                role="button"
                tabIndex={0}
                className="op-inbox__rowbtn"
                data-testid={`inbox-row-${i.id}`}
                aria-expanded={isSel}
                aria-controls={`inbox-expanded-${i.id}`}
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
              {isSel ? (
                <div
                  id={`inbox-expanded-${i.id}`}
                  className="op-inbox__detail"
                  data-testid={`inbox-expanded-${i.id}`}
                >
                  <OtherDetail
                    key={i.id}
                    item={i}
                    actionsPlacement="after-body"
                    onResolved={onResolved}
                    onDiscuss={onDiscuss}
                    onNavigate={onNavigate}
                  />
                  {(() => {
                    const workItemId = attentionWorkItemId(i);
                    const harnessMatches =
                      !discussionTarget.harness || discussionTarget.harness === i.harnessSlug;
                    if (
                      !workItemId ||
                      !i.harnessSlug ||
                      discussionTarget.id !== workItemId ||
                      !harnessMatches
                    ) {
                      return null;
                    }
                    return (
                      <WorkItemDiscussion
                        harnessSlug={i.harnessSlug}
                        workItemId={workItemId}
                        title={i.title}
                        onClose={() => void setDiscussionRef(null)}
                      />
                    );
                  })()}
                </div>
              ) : null}
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

      <SessionChatModal
        sessionOwnerId={chatOwner}
        ownerLabel={chatOwnerLabel}
        onClose={() => void setChatOwner(null)}
      />
    </div>
  );
}
