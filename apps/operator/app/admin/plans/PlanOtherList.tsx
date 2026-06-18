'use client';

/**
 * PlanOtherList — the "Other" attention surfaces in the Queue tab
 * (planning-attention-importance-2026-05-31, P-013 Other filter + P-015
 * detail pane).
 *
 * Renders the non-plan-item AttentionItem kinds from plans:attention —
 * coord escalations, coord messages-to-human, smoke-test failures,
 * improvements, conversations, standing-approvals — master-detail like
 * PlanItemsList: pick a row, the selected item shows in the right pane as
 * the shared chat card.
 *
 * queue-authorization-redesign-2026-06-14 (P-004/P-005): when
 * `groupByAuthorizer` is set (the new Queue view, flag-gated), the items are
 * grouped by AUTHORIZER — "Needs your call" (you) vs "Automatable — for now"
 * (the Queen could take it once armed) vs "Alerts & activity" (ungoverned
 * signals) — instead of by plan/harness; each card carries a "why it's here"
 * line + an autonomy-category badge, and the queen-eligible bucket links to
 * /settings/autonomy. When the flag is off the prior plan/harness grouping is
 * rendered byte-for-byte.
 *
 * The detail pane is the unified card (inbox-cards-unification P-020):
 * `attentionItemToCardSpec(item)` feeds `AskChoiceCard`; terminal picks
 * dispatch through `resolveAttentionAction`.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import DiscussPanel from './DiscussPanel';
import { AskChoiceCard, type AskChoiceResponse, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { InputCard, type InputCardResponse } from '@/app/_components/chat/InputCard';
import { QueueCardActions } from './QueueCardActions';
import { attentionItemToCardSpec, resolveAttentionAction, answerAttentionItem } from './attention-card';
import { TIER_LABEL, type AttentionGroup, type AttentionItem, type AttentionKind, type AttentionTier } from './plans-api';
import { byAuthorizer, planSections, whyLine } from './queue-authorizer';
import { Tooltip } from '@/app/harness/Tooltip';

const KIND_LABEL: Record<AttentionKind, string> = {
  'plan-item': 'item',
  'coord-escalation': 'escalation',
  'coord-message': 'message',
  'smoke-fail': 'smoke',
  'operator-report': 'report',
  // B-14 / P-100 folded disposition channels (D-011):
  improvement: 'improvement',
  'standing-approval': 'approval',
  conversation: 'question',
  'scout-grade': 'grade',
};

// A1 grouping helpers (byAuthorizer / whyLine / planSections / DisplaySection)
// live in ./queue-authorizer so they're unit-testable without this component's
// React/nuqs/radix import graph (queue-authorization-redesign P-004/P-005/P-009).

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
  /** A1 (P-004): group by authorizer + show why-line/category badge. Flag-gated;
   *  when false the prior plan/harness grouping renders unchanged. */
  groupByAuthorizer?: boolean;
  /** Queue unification: include needs-human plan-items in the buckets (they
   *  carry authorizer='you' → "Needs you"). A plan-item row routes its click to
   *  the shared ?item= preview (the Vditor plan preview), not the ?other= card. */
  includePlanItems?: boolean;
}

/** Keep the attention items to show: by default the non-plan-item kinds
 *  (optionally narrowed to `allow`); with `includePlanItems` the needs-human
 *  plan-items (authorizer='you') are kept too, so the unified Queue shows them
 *  in the "Needs you" bucket alongside escalations. Plan-items bypass the
 *  per-kind `allow` facet (it narrows the Other kinds, not the decisions). Also
 *  narrows by plan filter + tier; drops groups left empty. */
function otherOnly(
  groups: AttentionGroup[],
  allowKinds: AttentionKind[],
  allowPlans: string[],
  tier: AttentionTier | 'all',
  includePlanItems: boolean,
): AttentionGroup[] {
  const allow = allowKinds.length ? new Set(allowKinds) : null;
  const plans = allowPlans.length ? new Set(allowPlans) : null;
  const passesKind = (kind: AttentionKind) =>
    kind === 'plan-item' ? includePlanItems : !allow || allow.has(kind);
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          passesKind(i.kind) &&
          (!plans || (i.planSlug != null && plans.has(i.planSlug))) &&
          (tier === 'all' || i.tier === tier),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export default function PlanOtherList({
  groups,
  loading,
  error,
  refresh,
  title,
  kinds,
  planFilters,
  tierFilter,
  groupByAuthorizer,
  includePlanItems,
}: Props) {
  const [selected, setSelected] = useQueryState('other', parseAsString);
  // Inbox shares one preview pane across the Other + item lists; selecting an
  // Other item clears any plan-item selection (and vice-versa) so the shared
  // pane shows exactly one.
  const [selectedItem, setItemSel] = useQueryState('item', parseAsString);
  const selectOther = (id: string) => {
    void setSelected(id);
    void setItemSel(null);
  };
  // A plan-item row feeds the SAME ?item= preview the Plans/Queue item lists use
  // (the Vditor plan preview scrolled to the item), so a needs-human decision in
  // the "Needs you" bucket opens its full plan preview, not the generic card.
  const selectPlanItem = (planSlug: string, itemRef: string) => {
    void setItemSel(`${planSlug}::${itemRef}`);
    void setSelected(null);
  };
  const planItemSelKey = (it: AttentionItem): string | null =>
    it.kind === 'plan-item' && it.planSlug && it.itemRef ? `${it.planSlug}::${it.itemRef}` : null;
  // Collapsible groups — same `?expand=` model as the Plans tab's PlanItemsList.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  // P-007: selected autonomy-category filter (nuqs array; new Queue view only).
  const [catFilter, setCatFilter] = useQueryState('qcat', parseAsArrayOf(parseAsString).withDefault([]));

  const planList = planFilters ?? [];
  const otherGroups = otherOnly(groups, kinds ?? [], planList, tierFilter ?? 'all', includePlanItems ?? false);
  const allItems = otherGroups.flatMap((g) => g.items);
  // P-007: the autonomy categories present in the current items + the active filter
  // (new Queue view only; other-items only — plan-items are uniformly plan-governance).
  const presentCats = [...new Set(allItems.map((i) => i.category).filter((c): c is string => !!c))].sort();
  const catActive = groupByAuthorizer ? catFilter : [];
  const baseItems = catActive.length
    ? allItems.filter((i) => i.category != null && catActive.includes(i.category))
    : allItems;
  // A1: authorizer buckets in the new Queue view, else the legacy plan/harness groups.
  const sections = groupByAuthorizer ? byAuthorizer(baseItems) : planSections(otherGroups);

  // Auto-expand the selected item's section (mirrors the Plans tab). The ref
  // token stops us reopening a section the user just collapsed while the
  // selection stays put.
  const selectedGroupKey =
    selected || selectedItem
      ? sections.find((s) =>
          s.items.some(
            (i) =>
              (selected != null && i.id === selected) ||
              (selectedItem != null && planItemSelKey(i) === selectedItem),
          ),
        )?.key ?? null
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
      {groupByAuthorizer && allItems.length ? (
        <p className="pc-queue__intro">
          Things an agent paused on because acting needed sign-off. Clear the ones only you can
          decide; let the Queen take the rest by widening her autonomy.
        </p>
      ) : null}
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
      {sections.map((s) => {
        const isExpanded = expandedGroups.includes(s.key);
        const head = (
          <button type="button" className="pc-items__plan-head">
            <ChevronRight className="pc-items__group-chevron" size={13} aria-hidden />
            <span className="pc-items__plan-copy">
              <Tooltip label={s.title}>
                <span className="pc-items__plan-name">{s.title}</span>
              </Tooltip>
              {s.hint ? (
                <span className="pc-items__plan-meta">
                  <span className="pc-queue__section-hint">{s.hint}</span>
                </span>
              ) : s.harnessSlug ? (
                <span className="pc-items__plan-meta">
                  <span className="pc-pill pc-pill--harness">{s.harnessSlug}</span>
                </span>
              ) : null}
            </span>
            <span className="pc-items__plan-count">{s.items.length}</span>
          </button>
        );
        return (
          <li key={s.key} className="pc-items__group">
            <Collapsible.Root
              open={isExpanded}
              onOpenChange={(open) =>
                void setExpandedGroups(
                  open
                    ? Array.from(new Set([...expandedGroups, s.key]))
                    : expandedGroups.filter((k) => k !== s.key),
                )
              }
            >
              {/* The queen-eligible bucket carries a deep-link to the autonomy
                  policy — rendered as a sibling of the trigger (can't nest an
                  anchor inside the trigger button). Other sections render the
                  bare trigger so the legacy markup is unchanged. */}
              {s.queenLink ? (
                <div className="pc-queue__section-head">
                  <Collapsible.Trigger asChild>{head}</Collapsible.Trigger>
                  <a className="pc-queue__queen-link" href="/settings/autonomy">
                    Let the Queen handle these →
                  </a>
                </div>
              ) : (
                <Collapsible.Trigger asChild>{head}</Collapsible.Trigger>
              )}
              <Collapsible.Content className="pc-items__group-content">
                <ul className="pc-items__rows" role="list">
                  {s.items.map((it) => {
                    const itemKey = planItemSelKey(it);
                    const isSel = itemKey ? selectedItem === itemKey : selected === it.id;
                    const why = groupByAuthorizer ? whyLine(it) : null;
                    return (
                      <li key={it.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
                        <Tooltip label={it.title}><button
                          type="button"
                          className="pc-items__row"
                          aria-current={isSel ? 'true' : undefined}

                          onClick={() =>
                            itemKey ? selectPlanItem(it.planSlug!, it.itemRef!) : selectOther(it.id)
                          }
                        >
                          {/* Free-form text first (leftmost); the why-line stacks
                              under it in the authorizer view. */}
                          <span className={`pc-items__text${why ? ' pc-items__text--stacked' : ''}`}>
                            <span className="pc-queue__title">{it.title}</span>
                            {why ? <span className="pc-queue__why">{why}</span> : null}
                          </span>
                          <span className="pc-items__rowmeta">
                            {it.tier !== 'activity' ? (
                              <span className={`pc-tier pc-tier--${it.tier}`} title={TIER_LABEL[it.tier]}>
                                {it.tier === 'handled' ? '✓ handled' : it.tier}
                              </span>
                            ) : null}
                            {/* A plan-item shows its P-NNN (a decision on a known plan);
                                other kinds show their autonomy-category (authorizer view)
                                or kind badge. */}
                            {it.kind === 'plan-item' ? (
                              it.itemRef ? <span className="pc-items__id">{it.itemRef}</span> : null
                            ) : groupByAuthorizer && it.category ? (
                              <span
                                className={`pc-category${it.whyGated === 'protected' ? ' pc-category--protected' : ''}`}
                                title={`autonomy category: ${it.category}`}
                              >
                                {it.whyGated === 'protected' ? '🔒 ' : ''}
                                {it.category}
                              </span>
                            ) : (
                              <span className={`pc-kind pc-kind--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                            )}
                            {it.importance !== 'normal' ? (
                              <span className={`pc-imp pc-imp--${it.importance}`}>{it.importance}</span>
                            ) : null}
                          </span>
                        </button></Tooltip>
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

  // P-007: the category-filter chip row (new Queue view; other-items only).
  const categoryFacet =
    groupByAuthorizer && presentCats.length > 1 ? (
      <nav className="pc-queue__catfacet" aria-label="Filter by autonomy category">
        {presentCats.map((cat) => {
          const active = catFilter.includes(cat);
          return (
            <button
              key={cat}
              type="button"
              className={`pc-category pc-queue__catchip${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() =>
                void setCatFilter(active ? catFilter.filter((c) => c !== cat) : [...catFilter, cat])
              }
            >
              {cat}
            </button>
          );
        })}
        {catFilter.length ? (
          <button type="button" className="pc-queue__catclear" onClick={() => void setCatFilter([])}>
            clear
          </button>
        ) : null}
      </nav>
    ) : null;

  return wrap(
    <>
      {categoryFacet}
      {sections.length ? (
        groupsEl
      ) : (
        <div className="pc-items__empty">
          No items in the selected categor{catActive.length === 1 ? 'y' : 'ies'}.
        </div>
      )}
    </>,
  );
}

export function OtherDetail({ item, onResolved }: { item: AttentionItem | null; onResolved: () => void }) {
  const [discussOpen, setDiscussOpen] = useState(false);
  // D-027 follow-on (1): the inline Answer InputCard (conversation kind). State
  // resets per selection — PlansClient remounts OtherDetail with key={item.id}.
  const [answerOpen, setAnswerOpen] = useState(false);
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
  // A1 (P-005): who must sign off + why, surfaced in the detail pane too.
  const why = whyLine(item);

  // The shared card surfaces this item's options; terminal picks dispatch to
  // the durable backend, navigate picks open a sub-surface (inline chat / the
  // harness source view). (inbox-cards-unification P-020 / D-006.)
  const onResponse = async (resp: AskChoiceResponse) => {
    if (resp.action === 'navigate') {
      if (resp.option_id === 'discuss') {
        setDiscussOpen(true);
      } else if (resp.option_id === 'answer') {
        // D-027 follow-on (1): reveal the inline Answer InputCard (conversation).
        setAnswerOpen((v) => !v);
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

  // D-027 follow-on (1): the inline Answer submit (conversation kind). Resolves
  // the question with the owner's text as the accepted answer (captured for the
  // next asker), which drops it from the Queue.
  const onAnswerResponse = async (r: InputCardResponse) => {
    if (r.action !== 'submit') {
      setAnswerOpen(false);
      return;
    }
    if (busy || !item) return;
    setBusy(true);
    try {
      const res = await answerAttentionItem(item, String(r.value));
      if (res.resolved) {
        setAnswered({ picks: [{ option_id: 'answer', label: 'Answer' }], at: Date.now() });
        toast.success(`Answered ${kindLabel}`, { description: 'Recorded as the accepted answer; question resolved.' });
        onResolved();
      }
    } catch (e) {
      toast.error('Answer failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pc-items__detail">
      <div className="pc-items__detail-toolbar">
        <span className={`pc-tier pc-tier--${item.tier}`} title={TIER_LABEL[item.tier]}>{TIER_LABEL[item.tier]}</span>
        <span className={`pc-kind pc-kind--${item.kind}`}>{kindLabel}</span>
        {item.category ? (
          <span
            className={`pc-category${item.whyGated === 'protected' ? ' pc-category--protected' : ''}`}
            title={`autonomy category: ${item.category}`}
          >
            {item.whyGated === 'protected' ? '🔒 ' : ''}
            {item.category}
          </span>
        ) : null}
        <span className={`pc-count pc-count--${item.status}`}>{item.status}</span>
        {item.importance !== 'normal' ? (
          <span className={`pc-imp pc-imp--${item.importance}`}>{item.importance}</span>
        ) : null}
        {item.harnessSlug ? <span className="pc-pill pc-pill--harness">{item.harnessSlug}</span> : null}
        {/* #4: actions live in the toolbar, not in the card body. */}
        <QueueCardActions
          options={spec.options}
          answered={answered}
          busy={busy}
          onResponse={(r) => void onResponse(r)}
        />
      </div>
      {/* A1 (P-005): the "why it's here" line — who must sign off + why, with the
          autonomy-policy deep-link for queen-eligible items. */}
      {why ? (
        <div className="pc-items__why-line pc-queue__intro" style={{ margin: '4px 14px 0' }}>
          {why}
          {item.authorizer === 'queen-eligible' ? (
            <>
              {' · '}
              <a className="pc-queue__queen-link" href="/settings/autonomy">
                Let the Queen handle these →
              </a>
            </>
          ) : null}
        </div>
      ) : null}
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
        {answerOpen ? (
          <InputCard
            prompt="Your answer — recorded as the accepted answer (resolves the question and captures it for the next asker)."
            presentation={{ kind: 'text', placeholder: 'Type your answer…', multiline: true }}
            onResponse={(r) => void onAnswerResponse(r)}
          />
        ) : null}
        {discussOpen ? <DiscussPanel item={item} chatLabel={chatLabel} /> : null}
      </div>
    </aside>
  );
}
