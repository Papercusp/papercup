'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation (presentational).
 *
 * Renders the items it's handed, already filtered by PlansClient via the
 * additive filter model: item-status (Needs Human / Needs Decision /
 * Blocked, OR within) AND plan-status buckets (OR within). The list is
 * therefore mixed-status, so per-item affordances key off each item's own
 * status (needs-human items get the Answer/Resolve/Drop toolkit).
 *
 * `planFilter` narrows the displayed groups to one plan (the left rail
 * sets it). Plans are collapsible groups; a row selects the item into the
 * right-hand PlanItemPreview rather than navigating away.
 */

import { useEffect, useRef, useState } from 'react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { setItemStatus, addPlanDecision, type PlanItemRow } from './plans-api';
import PlanItemPreview from './PlanItemPreview';

interface Props {
  items: PlanItemRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  onPick: (slug: string, targetId?: string) => void;
  /** plan-slug → harness-slug map; lets needs-human rows relaunch the loop. */
  harnessByPlan?: Map<string, string>;
  /** Narrow the list to these plans (multi-select OR; the rail toggles
   *  them). Empty/undefined = all plans. */
  planFilters?: string[];
  /** Heading title + one-line summary of the active filter (from PlansClient). */
  title: string;
  subtitle: string;
}

// The items view groups by EFFECTIVE status, so the row pill surfaces that
// (not stored) — otherwise a blocked item (stored 'todo', effective 'blocked')
// would show a "todo" pill instead of "blocked".
function itemPillStatus(item: { effectiveStatus: string }): string {
  return item.effectiveStatus;
}

export default function PlanItemsList({
  items,
  loading,
  error,
  refresh,
  onPick,
  harnessByPlan,
  planFilters,
}: Props) {
  // A single selected plan renders "bare" (no repeated title); multiple
  // selected (or none) render grouped with plan headers.
  const planList = planFilters ?? [];
  const planFiltersKey = planList.join('|');
  const bareSingle = planList.length === 1 ? planList[0]! : null;
  // Selected item for the read-only detail pane, encoded
  // "<planSlug>::<itemId>". Distinct from PlansClient's `?plan=` (which
  // opens the FULL PlanDetail) — this only drives the right-hand preview.
  const [selectedItem, setSelectedItem] = useQueryState('item', parseAsString);
  // Expanded plan groups (Radix Collapsible), URL-pinned like Sessions.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  const [selectedPlan, selectedItemId] = splitItemKey(selectedItem);

  // Auto-expand the selected item's group (mirrors the Sessions tab). The
  // ref token stops us reopening a group the user just collapsed while the
  // selection stays put.
  const autoExpandRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPlan || !selectedItemId || planList.length > 0) {
      autoExpandRef.current = null;
      return;
    }
    const token = `${selectedItemId}:${selectedPlan}`;
    if (expandedGroups.includes(selectedPlan)) {
      autoExpandRef.current = token;
      return;
    }
    if (autoExpandRef.current === token) return;
    autoExpandRef.current = token;
    void setExpandedGroups([...expandedGroups, selectedPlan]);
  }, [selectedPlan, selectedItemId, planFiltersKey, expandedGroups, setExpandedGroups]);

  if (loading) {
    return (
      <div className="pc-items pc-items--mixed">
        <p className="pc-plans__placeholder">Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-items pc-items--mixed">
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Failed to load items:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const rows = planList.length ? items.filter((r) => planList.includes(r.plan)) : items;
  if (!rows.length) {
    const empty = bareSingle
      ? `No items in ${bareSingle}.`
      : planList.length
        ? 'No items in the selected plans.'
        : 'No items match the current filters.';
    return (
      <div className="pc-items pc-items--mixed">
        <div className="pc-items__empty">{empty}</div>
      </div>
    );
  }

  // Group by parent plan; Map preserves insertion order, which is the
  // server's ordering (active plans tend to appear before archived).
  const groups = new Map<string, PlanItemRow[]>();
  for (const r of rows) {
    if (!groups.has(r.plan)) groups.set(r.plan, []);
    groups.get(r.plan)!.push(r);
  }

  // The rows for one plan — shared by the bare (rail-filtered) and the
  // collapsible group renders. Clicking a row selects it into the detail
  // pane; it no longer redirects to the full plan tab. Per-item actions
  // key off the item's own status, since the list is mixed-status.
  // Rows are plain selectable buttons. The per-item actions (Answer /
  // Resolve / Drop for needs-human, Chat with agent) live in the right-hand
  // PlanItemPreview toolbar — rendering them inline in the row broke the
  // layout and crowded the answer textarea.
  const renderRows = (planSlug: string, planRows: PlanItemRow[]) => (
    <ul className="pc-items__rows" role="list">
      {planRows.map((r) => {
        const isSel = selectedItem === itemKey(planSlug, r.item.id);
        return (
          <li key={r.item.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="pc-items__row"
              aria-current={isSel ? 'true' : undefined}
              title={r.item.text}
              onClick={() => void setSelectedItem(itemKey(planSlug, r.item.id))}
            >
              <span className="pc-items__id">{r.item.id}</span>
              <span className={`pc-count pc-count--${itemPillStatus(r.item)}`}>
                {itemPillStatus(r.item)}
              </span>
              {r.item.importance && r.item.importance !== 'normal' ? (
                <span
                  className={`pc-imp pc-imp--${r.item.importance}`}
                  title={`Importance: ${r.item.importance}`}
                >
                  {r.item.importance}
                </span>
              ) : null}
              <span className="pc-items__text">{r.item.text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="pc-items pc-items--mixed">
      <div className="pc-items__layout">
        <div className="pc-items__listpane">
          <ul className="pc-items__groups" role="list">
            {[...groups.entries()].map(([planSlug, planRows]) => {
              const harnessSlug = harnessByPlan?.get(planSlug);
              // When the left rail has filtered to one plan, don't repeat
              // its title here — render the items bare (the plan name is
              // already shown, selected, in the rail).
              if (bareSingle) {
                return (
                  <li key={planSlug} className="pc-items__group pc-items__group--bare">
                    {renderRows(planSlug, planRows)}
                  </li>
                );
              }
              const isExpanded = expandedGroups.includes(planSlug);
              return (
                <li key={planSlug} className="pc-items__group">
                  <Collapsible.Root
                    open={isExpanded}
                    onOpenChange={(open) =>
                      void setExpandedGroups(
                        open
                          ? Array.from(new Set([...expandedGroups, planSlug]))
                          : expandedGroups.filter((k) => k !== planSlug),
                      )
                    }
                  >
                    <Collapsible.Trigger asChild>
                      <button type="button" className="pc-items__plan-head">
                        <ChevronRight className="pc-items__group-chevron" size={13} aria-hidden />
                        <span className="pc-items__plan-copy">
                          <span className="pc-items__plan-name">{planSlug}</span>
                          {harnessSlug ? (
                            <span className="pc-items__plan-meta">
                              <span className="pc-pill pc-pill--harness">{harnessSlug}</span>
                            </span>
                          ) : null}
                        </span>
                        <span className="pc-items__plan-count">{itemCountLabel(planRows.length)}</span>
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content className="pc-items__group-content">
                      {renderRows(planSlug, planRows)}
                    </Collapsible.Content>
                  </Collapsible.Root>
                </li>
              );
            })}
          </ul>
        </div>

        <PlanItemPreview
          planSlug={selectedPlan}
          itemId={selectedItemId}
          harnessSlug={selectedPlan ? harnessByPlan?.get(selectedPlan) ?? null : null}
          onResolved={refresh}
          onViewFullPlan={onPick}
        />
      </div>
    </div>
  );
}

/** Encode / decode the `?item=` selection key ("<planSlug>::<itemId>"). */
function itemKey(planSlug: string, itemId: string): string {
  return `${planSlug}::${itemId}`;
}
function splitItemKey(key: string | null): readonly [string | null, string | null] {
  if (!key) return [null, null];
  const idx = key.indexOf('::');
  if (idx === -1) return [null, null];
  return [key.slice(0, idx), key.slice(idx + 2)];
}

/**
 * InboxItemActions — the human's response toolkit for a needs-human item.
 * A needs-human item is the agent blocked on a decision, so a lone
 * "Resolve" was too thin. Three moves:
 *   - Answer  → record the decision (plans:add-decision, D-NNN, refs the
 *               item) so the agent reads it next, mark the item done, and
 *               resume the loop. This is the real "I answered you".
 *   - Resolve → quick "done, proceed" with no recorded answer + resume.
 *   - Drop    → decline: item → dropped, loop NOT resumed.
 */
export function InboxItemActions({
  planSlug,
  itemId,
  harnessSlug,
  onResolved,
}: {
  planSlug: string;
  itemId: string;
  harnessSlug: string | undefined;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');

  const resumeLoop = () => {
    if (!harnessSlug) return;
    fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/launch?phase=staging`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  };

  const handleResolve = async () => {
    setBusy(true);
    try {
      const result = await setItemStatus({ slug: planSlug, itemId, status: 'done' });
      if ('error' in result) throw new Error(result.error ?? 'unknown error');
      resumeLoop();
      toast.success(`${itemId} resolved`, {
        description: harnessSlug ? `Harness loop resumed for ${harnessSlug}.` : undefined,
      });
      onResolved();
    } catch (e) {
      toast.error('Resolve failed', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = async () => {
    setBusy(true);
    try {
      const result = await setItemStatus({ slug: planSlug, itemId, status: 'dropped' });
      if ('error' in result) throw new Error(result.error ?? 'unknown error');
      toast.success(`${itemId} dropped`, { description: "Marked won't-do; loop not resumed." });
      onResolved();
    } catch (e) {
      toast.error('Drop failed', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleAnswer = async () => {
    const body = answer.trim();
    if (!body) return;
    setBusy(true);
    try {
      const dec = await addPlanDecision({
        slug: planSlug,
        title: `Answer to ${itemId}`,
        body,
        refs: [itemId],
      });
      if ('error' in dec) throw new Error(dec.error ?? 'unknown error');
      const result = await setItemStatus({ slug: planSlug, itemId, status: 'done' });
      if ('error' in result) throw new Error(result.error ?? 'unknown error');
      resumeLoop();
      toast.success(`Answered ${itemId}`, {
        description: 'Recorded as a plan decision; harness loop resumed.',
      });
      setAnswering(false);
      setAnswer('');
      onResolved();
    } catch (e) {
      toast.error('Answer failed', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (answering) {
    return (
      <div className="pc-items__answer">
        <textarea
          className="pc-items__answer-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your decision / answer — recorded as a plan decision (D-NNN) the agent reads next."
          rows={3}
          autoFocus
          disabled={busy}
        />
        <div className="pc-items__answer-actions">
          <button
            type="button"
            className="pc-items__resolve"
            onClick={handleAnswer}
            disabled={busy || !answer.trim()}
          >
            {busy ? '…' : 'Send answer'}
          </button>
          <button
            type="button"
            className="pc-items__action-btn"
            onClick={() => {
              setAnswering(false);
              setAnswer('');
            }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-items__actions">
      <button
        type="button"
        className="pc-items__action-btn pc-items__action-btn--answer"
        onClick={() => setAnswering(true)}
        disabled={busy}
        title="Answer the question — records a decision the agent reads, marks the item done, and resumes the loop"
      >
        ✍ Answer
      </button>
      <button
        type="button"
        className="pc-items__resolve"
        onClick={handleResolve}
        disabled={busy}
        aria-label={`Mark ${itemId} resolved`}
        title="Mark done and resume the loop — no recorded answer"
      >
        {busy ? '…' : '✓ Resolve'}
      </button>
      <button
        type="button"
        className="pc-items__action-btn pc-items__action-btn--drop"
        onClick={handleDrop}
        disabled={busy}
        title="Drop — won't do (item → dropped); the loop is not resumed"
      >
        ✕ Drop
      </button>
    </div>
  );
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
