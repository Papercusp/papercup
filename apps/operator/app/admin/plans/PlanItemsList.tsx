'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation (presentational).
 *
 * Backs view=inbox (needs-human) and view=actionable (effective-todo,
 * all blockers cleared). The item fetch is lifted into PlansClient so a
 * single request feeds both this list and the (filtered) PlanRail in the
 * left sidebar — this component renders the rows it's handed.
 *
 * `planFilter` narrows the displayed groups to one plan. In inbox/
 * actionable views the left rail (the same rich PlanRail as Browse, but
 * narrowed to plans-with-items) sets it: clicking a plan FILTERS the list
 * instead of navigating, so it no longer loads a plan tab you then have
 * to switch to.
 *
 * inbox mode adds a one-click "Resolve" button per row that flips the
 * item to done and relaunches the harness loop.
 */

import { useEffect, useRef, useState } from 'react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { setItemStatus, addPlanDecision, type PlanItemRow } from './plans-api';
import PlanItemPreview from './PlanItemPreview';

type ItemMode = 'inbox' | 'actionable' | 'blocked';

interface Props {
  mode: ItemMode;
  items: PlanItemRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  onPick: (slug: string, targetId?: string) => void;
  /** plan-slug → harness-slug map; required for inbox mode to relaunch the loop. */
  harnessByPlan?: Map<string, string>;
  /** When set, show only this plan's items (the rail acts as a filter). */
  planFilter?: string | null;
}

export default function PlanItemsList({
  mode,
  items,
  loading,
  error,
  refresh,
  onPick,
  harnessByPlan,
  planFilter,
}: Props) {
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
    if (!selectedPlan || !selectedItemId || planFilter) {
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
  }, [selectedPlan, selectedItemId, planFilter, expandedGroups, setExpandedGroups]);

  if (loading) {
    return (
      <div className={`pc-items pc-items--${mode}`}>
        <Heading mode={mode} count={null} groupCount={null} />
        <p className="pc-plans__placeholder">Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={`pc-items pc-items--${mode}`}>
        <Heading mode={mode} count={null} groupCount={null} />
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

  const rows = planFilter ? items.filter((r) => r.plan === planFilter) : items;
  if (!rows.length) {
    const empty = planFilter
      ? `No items in ${planFilter}.`
      : mode === 'inbox'
        ? 'No items waiting on human input.'
        : mode === 'blocked'
          ? 'No blocked items right now.'
          : 'No actionable items right now.';
    return (
      <div className={`pc-items pc-items--${mode}`}>
        <Heading mode={mode} count={0} groupCount={0} />
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

  const groupCount = groups.size;

  // The rows for one plan — shared by the bare (rail-filtered) and the
  // collapsible group renders. Clicking a row selects it into the detail
  // pane; it no longer redirects to the full plan tab.
  const renderRows = (planSlug: string, planRows: PlanItemRow[], harnessSlug: string | undefined) => (
    <ul className="pc-items__rows" role="list">
      {planRows.map((r) => {
        const isSel = selectedItem === itemKey(planSlug, r.item.id);
        return (
          <li key={r.item.id} className={`pc-items__row-wrap${isSel ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="pc-items__row"
              aria-current={isSel ? 'true' : undefined}
              onClick={() => void setSelectedItem(itemKey(planSlug, r.item.id))}
            >
              <span className="pc-items__id">{r.item.id}</span>
              <span className={`pc-count pc-count--${r.item.storedStatus}`}>
                {r.item.storedStatus}
              </span>
              <span className="pc-items__text">{r.item.text}</span>
            </button>
            {mode === 'inbox' && (
              <InboxItemActions
                planSlug={planSlug}
                itemId={r.item.id}
                harnessSlug={harnessSlug}
                onResolved={refresh}
              />
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={`pc-items pc-items--${mode}`}>
      <Heading mode={mode} count={rows.length} groupCount={groupCount} />
      <div className="pc-items__layout">
        <div className="pc-items__listpane">
          <ul className="pc-items__groups" role="list">
            {[...groups.entries()].map(([planSlug, planRows]) => {
              const harnessSlug = harnessByPlan?.get(planSlug);
              // Point 4: when the left rail has filtered to one plan, don't
              // repeat its title here — render the items bare (the plan name
              // is already shown, selected, in the rail).
              if (planFilter) {
                return (
                  <li key={planSlug} className="pc-items__group pc-items__group--bare">
                    {renderRows(planSlug, planRows, harnessSlug)}
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
                      {renderRows(planSlug, planRows, harnessSlug)}
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
function InboxItemActions({
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

const HEADING_META: Record<ItemMode, { kicker: string; title: string; desc: string; note: string }> = {
  inbox: {
    kicker: 'Human review',
    title: 'Needs Human',
    desc: 'Items waiting on a human decision, grouped by plan.',
    note: 'Resolve handled items or open one for context.',
  },
  actionable: {
    kicker: 'Ready queue',
    title: 'Needs Decision',
    desc: 'Unblocked plan work that is ready to pick up now.',
    note: 'Open an item to jump straight to the next task.',
  },
  blocked: {
    kicker: 'Stuck',
    title: 'Blocked',
    desc: 'Items stuck on unresolved blockers or external waits, grouped by plan.',
    note: 'Open an item to see what it is waiting on.',
  },
};

function Heading({
  mode,
  count,
  groupCount,
}: {
  mode: ItemMode;
  count: number | null;
  groupCount: number | null;
}) {
  const meta = HEADING_META[mode];
  return (
    <header className="pc-items__head">
      <div className="pc-items__head-copy">
        <span className="pc-items__kicker">{meta.kicker}</span>
        <h2>{meta.title}</h2>
        <p>{meta.desc}</p>
      </div>
      {count !== null && groupCount !== null ? (
        <div className="pc-items__summary-card" aria-label="Items summary">
          <strong>{itemCountLabel(count)}</strong>
          <span>{groupCount} {groupCount === 1 ? 'plan' : 'plans'}</span>
          <span className="pc-items__summary-note">{meta.note}</span>
        </div>
      ) : null}
    </header>
  );
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
