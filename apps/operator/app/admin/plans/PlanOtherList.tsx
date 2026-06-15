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
import PlanChat from './PlanChat';
import MessageOwnerThread from './MessageOwnerThread';
import { AskChoiceCard, type AskChoiceResponse, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { InputCard, type InputCardResponse } from '@/app/_components/chat/InputCard';
import { QueueCardActions } from './QueueCardActions';
import { attentionItemToCardSpec, resolveAttentionAction, answerAttentionItem } from './attention-card';
import { TIER_LABEL, type AttentionGroup, type AttentionItem, type AttentionKind, type AttentionTier } from './plans-api';

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

/* ── A1 authorizer split (queue-authorization-redesign P-004/P-005) ───────── */

/** Human reason for each whyGated value — the tail of the per-card why-line. */
const WHYGATED_REASON: Record<string, string> = {
  protected: 'protected category — your call by right',
  'owner-only': 'your ratification',
  unarmed: 'the Queen isn’t armed yet',
  'above-ceiling': 'above the Queen’s autonomy ceiling',
};

/** The "why it's here" line: who must sign off + why. Null for non-decisions. */
function whyLine(it: AttentionItem): string | null {
  if (!it.authorizer) return null;
  const who = it.authorizer === 'you' ? 'needs you' : 'the Queen could take this';
  const reason = it.whyGated ? WHYGATED_REASON[it.whyGated] : null;
  return reason ? `${who} · ${reason}` : who;
}

/** A rendered section of the Other list — either an authorizer bucket or, in the
 *  legacy view, one plan/harness AttentionGroup. */
interface DisplaySection {
  key: string;
  title: string;
  /** Authorizer-bucket explainer (new view). */
  hint?: string;
  /** Source harness pill (legacy plan/harness grouping). */
  harnessSlug?: string | null;
  /** Render the "Let the Queen handle these →" link (queen-eligible bucket). */
  queenLink?: boolean;
  items: AttentionItem[];
}

const AUTH_BUCKETS: {
  key: string;
  match: 'you' | 'queen-eligible' | 'other';
  title: string;
  hint: string;
  queenLink?: boolean;
}[] = [
  {
    key: 'auth:you',
    match: 'you',
    title: 'Needs your call',
    hint: 'Only you can decide these — protected actions and your ratifications.',
  },
  {
    key: 'auth:queen',
    match: 'queen-eligible',
    title: 'Automatable — for now',
    hint: 'The Queen could handle these once her autonomy is widened.',
    queenLink: true,
  },
  {
    key: 'auth:other',
    match: 'other',
    title: 'Alerts & activity',
    hint: 'Signals and FYI — not a decision waiting on anyone.',
  },
];

/** Partition flat items into the three authorizer buckets, dropping empties. */
function byAuthorizer(items: AttentionItem[]): DisplaySection[] {
  return AUTH_BUCKETS.map((b) => ({
    key: b.key,
    title: b.title,
    hint: b.hint,
    queenLink: b.queenLink,
    items: items.filter((i) => (b.match === 'other' ? !i.authorizer : i.authorizer === b.match)),
  })).filter((s) => s.items.length > 0);
}

/** Legacy: one section per plan/harness AttentionGroup. */
function planSections(groups: AttentionGroup[]): DisplaySection[] {
  return groups.map((g) => ({ key: g.key, title: g.title, harnessSlug: g.harnessSlug, items: g.items }));
}

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
}: Props) {
  const [selected, setSelected] = useQueryState('other', parseAsString);
  // Inbox shares one preview pane across the Other + item lists; selecting an
  // Other item clears any plan-item selection so the shared pane shows it.
  const [, setItemSel] = useQueryState('item', parseAsString);
  const selectOther = (id: string) => {
    void setSelected(id);
    void setItemSel(null);
  };
  // Collapsible groups — same `?expand=` model as the Plans tab's PlanItemsList.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  // P-007: selected autonomy-category filter (nuqs array; new Queue view only).
  const [catFilter, setCatFilter] = useQueryState('qcat', parseAsArrayOf(parseAsString).withDefault([]));

  const planList = planFilters ?? [];
  const otherGroups = otherOnly(groups, kinds ?? [], planList, tierFilter ?? 'all');
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
  const selectedGroupKey = selected
    ? sections.find((s) => s.items.some((i) => i.id === selected))?.key ?? null
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
          <button type="button" className="pc-items__plan-head" title={s.title}>
            <ChevronRight className="pc-items__group-chevron" size={13} aria-hidden />
            <span className="pc-items__plan-copy">
              <span className="pc-items__plan-name">{s.title}</span>
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
                    const isSel = selected === it.id;
                    const why = groupByAuthorizer ? whyLine(it) : null;
                    return (
                      <li key={it.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
                        <button
                          type="button"
                          className="pc-items__row"
                          aria-current={isSel ? 'true' : undefined}
                          title={it.title}
                          onClick={() => selectOther(it.id)}
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
                            {groupByAuthorizer && it.category ? (
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
  const [chatOpen, setChatOpen] = useState(false);
  const [msgOwnerOpen, setMsgOwnerOpen] = useState(false);
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
      if (resp.option_id === 'chat') {
        setChatOpen(true);
      } else if (resp.option_id === 'message-owner') {
        setMsgOwnerOpen(true);
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
        {msgOwnerOpen ? <MessageOwnerThread item={item} /> : null}
        {chatOpen ? <PlanChat harnessSlug={item.harnessSlug} label={chatLabel} /> : null}
      </div>
    </aside>
  );
}
