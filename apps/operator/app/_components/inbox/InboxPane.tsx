'use client';

/**
 * InboxPane (EI-13037, owner ask 2026-07-16 + placement correction) — the
 * owner's HUMAN INBOX as the op-chat sidebar's third view (`?opcv=inbox`),
 * beside the Papercup chat: everything addressed to YOU — coord messages
 * (`coord:send { to: ['human'] }`), escalations, standing approvals, agent
 * questions, operator reports — with the actions to answer them inline.
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
 * pane flips back to the chat view — instead of the Queue's inline thread
 * with the (usually system/dead) originating agent.
 *
 * Filter + selection live in the URL (nuqs `?opci` / `?opcis`) so the pane is
 * deep-linkable and agent-driveable (ui:get_state / ui:dispatch), per the
 * nuqs-by-default policy.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryState, useQueryStates, parseAsString, parseAsStringLiteral } from 'nuqs';
import { MessageCircle } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { OtherDetail, KIND_LABEL } from '@/app/admin/plans/PlanOtherList';
import { TIER_LABEL, type AttentionItem, type AttentionTier } from '@/app/admin/plans/plans-api';
import { effectiveTier, useInboxAttention } from './use-inbox-pending';
import { seedOperatorChatDraft } from './chat-seed';
import SessionChatModal from '../chat/SessionChatModal';
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
  // The "chat-grade session context" popup (P-007): which agent's live session
  // to show, keyed by ownerAgentId. Deep-linkable/agent-driveable like every
  // other pane selector here (nuqs-by-default policy).
  const [chatOwner, setChatOwner] = useQueryState('opcsession', parseAsString);
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

  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = { needs: 0, alerts: 0, all: items.length };
    for (const i of items) {
      const tier = effectiveTier(i);
      if (tier === 'decision') c.needs += 1;
      else if (tier === 'alert') c.alerts += 1;
    }
    return c;
  }, [items]);

  // Best-effort friendly label for the SessionChatModal title — looked up from
  // whichever visible item's ownerAgentId launched it; a stale/deep-linked
  // opcsession with no matching item just falls back to the raw id (the modal
  // handles that fine).
  const chatOwnerLabel = useMemo(
    () => items.find((i) => i.ownerAgentId === chatOwner)?.ownerLabel ?? null,
    [items, chatOwner],
  );

  // deterministic-status-cards-2026-07-17 P-003: when a curator card's drill-in
  // deep-links a selection (opcis), scroll that row into view once it renders.
  const selectedRowRef = useRef<HTMLLIElement | null>(null);
  const lastScrolledSel = useRef<string | null>(null);

  const visible = useMemo(() => {
    const filtered = items.filter((i) => {
      const tier = effectiveTier(i);
      if (filter === 'needs') return tier === 'decision';
      if (filter === 'alerts') return tier === 'alert';
      return true;
    });
    // Stable sort: decisions on top, then alerts; ties keep server order.
    return filtered
      .map((item, idx) => ({ item, idx }))
      .sort(
        (a, b) =>
          TIER_RANK[effectiveTier(a.item)] - TIER_RANK[effectiveTier(b.item)] || a.idx - b.idx,
      )
      .map((x) => x.item);
  }, [items, filter]);

  // Scroll a freshly deep-linked selection into view once its row is in the DOM.
  // Guarded so it fires only when `sel` CHANGES to a new value (not on every
  // background list refresh) — otherwise it would yank the user back after they
  // scroll away. `visible` in the deps retries after the async items load.
  useEffect(() => {
    if (!sel) {
      lastScrolledSel.current = null;
      return;
    }
    if (sel !== lastScrolledSel.current && selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ block: 'nearest' });
      lastScrolledSel.current = sel;
    }
  }, [sel, visible]);

  return (
    <div className="op-inbox" data-testid="inbox-tab">
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

      {error ? <div className="op-inbox__error">Error: {error}</div> : null}
      {loading && items.length === 0 ? <div className="op-inbox__loading">Loading…</div> : null}
      {!loading && !error && visible.length === 0 ? (
        <p className="op-inbox__empty" data-testid="inbox-empty">
          {filter === 'needs'
            ? 'Inbox zero — nothing needs you. Decisions, escalations and messages the fleet sends you land here.'
            : 'Nothing here right now.'}
        </p>
      ) : null}

      <ul className="op-inbox__list">
        {visible.map((i) => {
          const isSel = i.id === sel;
          const tier = effectiveTier(i);
          const meta = [i.ownerLabel ?? i.ownerAgentId, i.planSlug ?? i.harnessSlug]
            .filter(Boolean)
            .join(' · ');
          return (
            <li
              key={i.id}
              ref={isSel ? selectedRowRef : undefined}
              className={`op-inbox__row${isSel ? ' is-selected' : ''}`}
            >
              {/* A `div` (not `button`) — the row now nests a real chat-launch
                  <button>, and nested interactive elements are invalid HTML /
                  silently mis-parsed by the browser. Same click+keyboard
                  contract as a button (role, tabIndex, Enter/Space). */}
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
                  {i.ownerAgentId ? (
                    // Shared Tooltip primitive, not a native title= (design-primitives
                    // lint): title= renders the browser's own chrome, which ignores the
                    // design tokens and never matches the tooltips everywhere else. The
                    // aria-label below stays — it is the accessible name, which the
                    // tooltip does not provide.
                    <Tooltip label="Open live chat with the originating agent">
                      <button
                        type="button"
                        className="op-inbox__chat-button"
                        data-testid={`inbox-chat-open-${i.id}`}
                        aria-label={`Open live chat with ${i.ownerLabel ?? i.ownerAgentId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void setChatOwner(i.ownerAgentId);
                        }}
                      >
                        <MessageCircle size={13} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  ) : null}
                </span>
                <span className="op-inbox__title">{i.title}</span>
              </div>
              {isSel ? (
                <div className="op-inbox__detail" data-testid="inbox-detail">
                  {/* key remounts the detail per selection so its local card
                      state (answered/discuss/answer) resets — same contract as
                      PlansClient's OtherDetail usage. */}
                  <OtherDetail key={i.id} item={i} onResolved={refresh} onDiscuss={onDiscuss} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="op-inbox__foot">
        <button
          type="button"
          className="op-inbox__queue-link"
          data-testid="inbox-open-queue"
          onClick={openQueue}
        >
          Open full queue →
        </button>
      </div>

      <SessionChatModal
        sessionOwnerId={chatOwner}
        ownerLabel={chatOwnerLabel}
        onClose={() => void setChatOwner(null)}
      />
    </div>
  );
}
