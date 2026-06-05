'use client';

/**
 * PlanOtherList — the "Other" attention surfaces in the Planning tab
 * (planning-attention-importance-2026-05-31, P-013 Other filter + P-015
 * detail pane).
 *
 * Renders the non-plan-item AttentionItem kinds from plans:attention —
 * coord escalations, coord messages-to-human, smoke-test failures, plans
 * awaiting review — grouped (per the reader's plan / "Alerts" buckets),
 * importance-sorted, master-detail like PlanItemsList: pick a row, the
 * selected item shows in the right pane as the shared chat card.
 *
 * The detail pane is now the unified card (inbox-cards-unification P-020):
 * `attentionItemToCardSpec(item)` feeds `AskChoiceCard`; terminal picks
 * dispatch through `resolveAttentionAction` (coord:resolve / coord:ack via
 * the /api/admin/coord proxy, D-007) and refresh on success; the "💬 Chat"
 * navigate option expands an inline `PlanChat` beneath the card (D-006);
 * View-log / Open point at the source harness view.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import PlanChat from './PlanChat';
import MessageOwnerThread from './MessageOwnerThread';
import { AskChoiceCard, type AskChoiceResponse, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { InboxCardActions } from './InboxCardActions';
import { attentionItemToCardSpec, resolveAttentionAction } from './attention-card';
import { TIER_LABEL, type AttentionGroup, type AttentionItem, type AttentionKind, type AttentionTier } from './plans-api';

const KIND_LABEL: Record<AttentionKind, string> = {
  'plan-item': 'item',
  'coord-escalation': 'escalation',
  'coord-message': 'message',
  'smoke-fail': 'smoke',
  'plan-review': 'review',
  'operator-report': 'report',
};

interface Props {
  groups: AttentionGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  title: string;
  /** When non-empty, show only these kinds (the active per-kind facets). */
  kinds?: AttentionKind[];
  /** When non-empty, the rail's plan selection — narrows the Other list to
   *  attention items belonging to these plans, so the left sidebar acts as a
   *  filter here too (harness-level alerts with no plan are dropped). */
  planFilters?: string[];
  /** Inbox tier filter (D-006). 'all' (or undefined) shows every tier. */
  tierFilter?: AttentionTier | 'all';
}

/** Keep only the non-plan-item kinds (optionally narrowed to `allow`), and —
 *  when a plan filter is active — only items belonging to those plans; when a
 *  tier filter is active — only that tier; drop groups left empty. */
function otherOnly(
  groups: AttentionGroup[],
  allowKinds: AttentionKind[],
  allowPlans: string[],
  tier: AttentionTier | 'all',
): AttentionGroup[] {
  const allow = allowKinds.length ? new Set(allowKinds) : null;
  const plans = allowPlans.length ? new Set(allowPlans) : null;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.kind !== 'plan-item' &&
          (!allow || allow.has(i.kind)) &&
          (!plans || (i.planSlug != null && plans.has(i.planSlug))) &&
          (tier === 'all' || i.tier === tier),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export default function PlanOtherList({ groups, loading, error, refresh, title, kinds, planFilters, tierFilter }: Props) {
  const [selected, setSelected] = useQueryState('other', parseAsString);
  // Inbox shares one preview pane across the Other + item lists; selecting an
  // Other item clears any plan-item selection so the shared pane shows it.
  const [, setItemSel] = useQueryState('item', parseAsString);
  const selectOther = (id: string) => {
    void setSelected(id);
    void setItemSel(null);
  };
  // Collapsible plan groups — same `?expand=` model as the Plans tab's
  // PlanItemsList, so a plan's expand state stays consistent across both views.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  const planList = planFilters ?? [];
  const otherGroups = otherOnly(groups, kinds ?? [], planList, tierFilter ?? 'all');
  const allItems = otherGroups.flatMap((g) => g.items);

  // Auto-expand the selected item's group (mirrors the Plans tab). The ref
  // token stops us reopening a group the user just collapsed while the
  // selection stays put.
  const selectedGroupKey = selected
    ? otherGroups.find((g) => g.items.some((i) => i.id === selected))?.key ?? null
    : null;
  const autoExpandRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedGroupKey) {
      autoExpandRef.current = null;
      return;
    }
    if (expandedGroups.includes(selectedGroupKey)) {
      autoExpandRef.current = selectedGroupKey;
      return;
    }
    if (autoExpandRef.current === selectedGroupKey) return;
    autoExpandRef.current = selectedGroupKey;
    void setExpandedGroups([...expandedGroups, selectedGroupKey]);
  }, [selectedGroupKey, expandedGroups, setExpandedGroups]);

  // This list is one section of the shared TwoPaneShell's left column;
  // PlansClient hosts the one shared detail pane (rendering the selected
  // item via the exported OtherDetail), so this renders just heading + rows.
  const wrap = (inner: ReactNode) => (
    <section className="pc-items__section">
      <h3 className="pc-items__section-label">{title}</h3>
      {inner}
    </section>
  );

  if (loading) {
    return wrap(<p className="pc-plans__placeholder">Loading…</p>);
  }
  if (error) {
    return wrap(
      <div className="pc-plans__placeholder pc-plans__placeholder--error">
        <p>Failed to load attention items:</p>
        <code>{error}</code>
        <button type="button" className="pc-plans__retry" onClick={refresh}>
          Retry
        </button>
      </div>,
    );
  }
  if (!allItems.length) {
    return wrap(
      <div className="pc-items__empty">
        {planList.length
          ? 'No alerts for the selected plan(s).'
          : 'Nothing else needs attention right now.'}
      </div>,
    );
  }

  const groupsEl = (
    <ul className="pc-items__groups" role="list">
      {otherGroups.map((g) => {
              const isExpanded = expandedGroups.includes(g.key);
              return (
                <li key={g.key} className="pc-items__group">
                  <Collapsible.Root
                    open={isExpanded}
                    onOpenChange={(open) =>
                      void setExpandedGroups(
                        open
                          ? Array.from(new Set([...expandedGroups, g.key]))
                          : expandedGroups.filter((k) => k !== g.key),
                      )
                    }
                  >
                    <Collapsible.Trigger asChild>
                      <button type="button" className="pc-items__plan-head" title={g.title}>
                        <ChevronRight className="pc-items__group-chevron" size={13} aria-hidden />
                        <span className="pc-items__plan-copy">
                          <span className="pc-items__plan-name">{g.title}</span>
                          {g.harnessSlug ? (
                            <span className="pc-items__plan-meta">
                              <span className="pc-pill pc-pill--harness">{g.harnessSlug}</span>
                            </span>
                          ) : null}
                        </span>
                        <span className="pc-items__plan-count">{g.items.length}</span>
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content className="pc-items__group-content">
                      <ul className="pc-items__rows" role="list">
                        {g.items.map((it) => {
                          const isSel = selected === it.id;
                          return (
                            <li key={it.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
                              <button
                                type="button"
                                className="pc-items__row"
                                aria-current={isSel ? 'true' : undefined}
                                title={it.title}
                                onClick={() => selectOther(it.id)}
                              >
                                {/* Free-form text first (leftmost); kind + importance
                                    pills follow on the right. */}
                                <span className="pc-items__text">{it.title}</span>
                                <span className="pc-items__rowmeta">
                                  {it.tier !== 'activity' ? (
                                    <span className={`pc-tier pc-tier--${it.tier}`} title={TIER_LABEL[it.tier]}>
                                      {it.tier === 'handled' ? '✓ handled' : it.tier}
                                    </span>
                                  ) : null}
                                  <span className={`pc-kind pc-kind--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                                  {it.importance !== 'normal' ? (
                                    <span className={`pc-imp pc-imp--${it.importance}`}>{it.importance}</span>
                                  ) : null}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </Collapsible.Content>
                  </Collapsible.Root>
                </li>
        );
      })}
    </ul>
  );

  return wrap(groupsEl);
}

export function OtherDetail({ item, onResolved }: { item: AttentionItem | null; onResolved: () => void }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [msgOwnerOpen, setMsgOwnerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<AskChoiceAnswered | undefined>(undefined);

  if (!item) {
    return (
      <aside className="pc-items__detail">
        <div className="pc-items__detail-empty">Select an item to see its detail and actions.</div>
      </aside>
    );
  }

  const kindLabel = KIND_LABEL[item.kind];
  const spec = attentionItemToCardSpec(item);
  const chatLabel = item.planSlug
    ? `${item.planSlug} · ${kindLabel}`
    : `${item.harnessSlug ?? 'harness'} · ${kindLabel}`;

  // The shared card surfaces this item's options; terminal picks dispatch to
  // the durable backend, navigate picks open a sub-surface (inline chat / the
  // harness source view). (inbox-cards-unification P-020 / D-006.)
  const onResponse = async (resp: AskChoiceResponse) => {
    if (resp.action === 'navigate') {
      if (resp.option_id === 'chat') {
        setChatOpen(true);
      } else if (resp.option_id === 'message-owner') {
        setMsgOwnerOpen(true);
      } else {
        toast.info(
          `${resp.label}: this ${kindLabel} lives in its harness view${
            item.harnessSlug ? ` (${item.harnessSlug})` : ''
          }; the detail above mirrors it.`,
        );
      }
      return;
    }
    if (resp.action === 'submit') {
      const pick = resp.picks[0];
      if (!pick || busy) return;
      setBusy(true);
      try {
        const r = await resolveAttentionAction(item, pick.option_id);
        if (r.resolved) {
          setAnswered({ picks: resp.picks, at: Date.now() });
          toast.success(`${kindLabel} resolved (${pick.label}).`);
          onResolved();
        }
      } catch (e) {
        toast.error('Action failed', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <aside className="pc-items__detail">
      <div className="pc-items__detail-toolbar">
        <span className={`pc-tier pc-tier--${item.tier}`} title={TIER_LABEL[item.tier]}>{TIER_LABEL[item.tier]}</span>
        <span className={`pc-kind pc-kind--${item.kind}`}>{kindLabel}</span>
        <span className={`pc-count pc-count--${item.status}`}>{item.status}</span>
        {item.importance !== 'normal' ? (
          <span className={`pc-imp pc-imp--${item.importance}`}>{item.importance}</span>
        ) : null}
        {item.harnessSlug ? <span className="pc-pill pc-pill--harness">{item.harnessSlug}</span> : null}
        {/* #4: actions live in the toolbar, not in the card body. */}
        <InboxCardActions
          options={spec.options}
          answered={answered}
          busy={busy}
          onResponse={(r) => void onResponse(r)}
        />
      </div>
      {/* Operator-triage audit (D-006): a downgraded/handled item shows what the
          operator did + why — never a silent vanish. */}
      {item.tier === 'handled' || item.triageState !== 'untriaged' ? (
        <div className="pc-items__triage-audit" data-testid="triage-audit">
          <span className="pc-items__triage-state">{item.triageState}</span>
          {item.triagedBy ? <span className="pc-items__triage-by"> by {item.triagedBy}</span> : null}
          {item.triageNote ? <span className="pc-items__triage-note"> — {item.triageNote}</span> : null}
        </div>
      ) : null}
      <div className="pc-items__detail-body">
        <AskChoiceCard
          args={spec}
          answered={answered}
          allowDecline={false}
          hideOptions
          onResponse={(r) => void onResponse(r)}
        />
        {msgOwnerOpen ? <MessageOwnerThread item={item} /> : null}
        {chatOpen ? <PlanChat harnessSlug={item.harnessSlug} label={chatLabel} /> : null}
      </div>
    </aside>
  );
}

