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

import { useState } from 'react';
import { toast } from 'sonner';
import { setItemStatus, addPlanDecision, type PlanItemRow } from './plans-api';

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

  return (
    <div className={`pc-items pc-items--${mode}`}>
      <Heading mode={mode} count={rows.length} groupCount={groupCount} />
      <ul className="pc-items__groups" role="list">
        {[...groups.entries()].map(([planSlug, planRows]) => {
          const harnessSlug = harnessByPlan?.get(planSlug);
          return (
            <li key={planSlug} className="pc-items__group">
              <button
                type="button"
                className="pc-items__plan-head"
                onClick={() => onPick(planSlug)}
                aria-label={`Open plan ${planSlug}`}
              >
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
              <ul className="pc-items__rows" role="list">
                {planRows.map((r) => (
                  <li key={r.item.id} className="pc-items__row-wrap">
                    <button
                      type="button"
                      className="pc-items__row"
                      onClick={() => onPick(planSlug, r.item.id)}
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
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
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
