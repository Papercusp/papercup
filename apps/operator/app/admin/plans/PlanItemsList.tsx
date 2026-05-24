'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation.
 *
 * P-108 deliverable. Backs both view=inbox (needs-human) and
 * view=actionable (effective-todo with all blockers cleared). Items
 * grouped under their parent plan; clicking a row (or the plan head)
 * navigates to the plan in detail view. Per the underlying plan's
 * §4.3, the inbox is "the single most useful view for the human
 * reviewer" — surface it as a first-class panel, not a filter preset.
 */

import { usePlanItems, type PlanItemRow } from './plans-api';

interface Props {
  mode: 'inbox' | 'actionable';
  onPick: (slug: string, targetId?: string) => void;
}

export default function PlanItemsList({ mode, onPick }: Props) {
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
        {[...groups.entries()].map(([slug, planRows]) => (
          <li key={slug} className="pc-items__group">
            <button
              type="button"
              className="pc-items__plan-head"
              onClick={() => onPick(slug)}
              aria-label={`Open plan ${slug}`}
            >
              <span className="pc-items__plan-name">{slug}</span>
              <span className="pc-items__plan-count">{planRows.length}</span>
            </button>
            <ul className="pc-items__rows" role="list">
              {planRows.map((r) => (
                <li key={r.item.id}>
                  <button
                    type="button"
                    className="pc-items__row"
                    onClick={() => onPick(slug, r.item.id)}
                  >
                    <span className="pc-items__id">{r.item.id}</span>
                    <span className={`pc-count pc-count--${r.item.storedStatus}`}>
                      {r.item.storedStatus}
                    </span>
                    <span className="pc-items__text">{r.item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
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
