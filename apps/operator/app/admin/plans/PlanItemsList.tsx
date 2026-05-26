'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation.
 *
 * P-108 deliverable. Backs both view=inbox (needs-human) and
 * view=actionable (effective-todo with all blockers cleared). Items
 * grouped under their parent plan; clicking a row (or the plan head)
 * navigates to the plan in detail view.
 *
 * P-013: inbox mode adds a one-click "Mark resolved" button per row
 * that flips the item to done and optionally relaunches the harness loop.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { usePlanItems, setItemStatus, type PlanItemRow } from './plans-api';

interface Props {
  mode: 'inbox' | 'actionable';
  onPick: (slug: string, targetId?: string) => void;
  /** plan-slug → harness-slug map; required for inbox mode to relaunch the loop. */
  harnessByPlan?: Map<string, string>;
}

export default function PlanItemsList({ mode, onPick, harnessByPlan }: Props) {
  const args = mode === 'inbox' ? { needsHuman: true } : { actionable: true };
  const { data, loading, error, refresh } = usePlanItems(args);

  if (loading) {
    return (
      <div className="pc-items">
        <Heading mode={mode} count={null} />
        <p className="pc-plans__placeholder">Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-items">
        <Heading mode={mode} count={null} />
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

  const rows = data?.items ?? [];
  if (!rows.length) {
    const empty =
      mode === 'inbox'
        ? 'No items waiting on human input.'
        : 'No actionable items right now.';
    return (
      <div className="pc-items">
        <Heading mode={mode} count={0} />
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

  return (
    <div className="pc-items">
      <Heading mode={mode} count={rows.length} />
      <ul className="pc-items__groups" role="list">
        {[...groups.entries()].map(([planSlug, planRows]) => (
          <li key={planSlug} className="pc-items__group">
            <button
              type="button"
              className="pc-items__plan-head"
              onClick={() => onPick(planSlug)}
              aria-label={`Open plan ${planSlug}`}
            >
              <span className="pc-items__plan-name">{planSlug}</span>
              <span className="pc-items__plan-count">{planRows.length}</span>
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
                    <ResolveButton
                      planSlug={planSlug}
                      itemId={r.item.id}
                      harnessSlug={harnessByPlan?.get(planSlug)}
                      onResolved={refresh}
                    />
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResolveButton({
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

  const handleResolve = async () => {
    setBusy(true);
    try {
      const result = await setItemStatus({ slug: planSlug, itemId, status: 'done' });
      if (!result.ok) throw new Error(result.detail ?? 'unknown error');

      if (harnessSlug) {
        fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/launch?phase=staging`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(() => {});
      }

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

  return (
    <button
      type="button"
      className="pc-items__resolve"
      onClick={handleResolve}
      disabled={busy}
      aria-label={`Mark ${itemId} resolved`}
      title="Mark resolved — flips item to done and resumes the harness loop"
    >
      {busy ? '…' : '✓ Resolve'}
    </button>
  );
}

function Heading({
  mode,
  count,
}: {
  mode: 'inbox' | 'actionable';
  count: number | null;
}) {
  return (
    <header className="pc-items__head">
      <div className="pc-items__head-copy">
        <h2>{mode === 'inbox' ? 'Needs human' : 'Actionable'}</h2>
        <p>
          {mode === 'inbox'
            ? 'Items across every plan waiting on a human decision.'
            : 'Items pickable right now — effective todo, all blockers cleared.'}
        </p>
      </div>
      {count !== null ? <span className="pc-items__count">{count}</span> : null}
    </header>
  );
}
