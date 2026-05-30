'use client';

/**
 * PlanItemsList — flat, cross-plan items aggregation (presentational).
 *
 * Backs view=inbox (needs-human) and view=actionable (effective-todo,
 * all blockers cleared). The item fetch is lifted into PlansClient so a
 * single request feeds both this list and the PlanItemRail filter — this
 * component renders the rows it's handed.
 *
 * `planFilter` narrows the displayed groups to one plan. In inbox/
 * actionable views the left rail (PlanItemRail) sets it: clicking a plan
 * FILTERS the list instead of navigating, so it no longer loads a plan
 * tab you then have to switch to.
 *
 * inbox mode adds a one-click "Resolve" button per row that flips the
 * item to done and relaunches the harness loop.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { setItemStatus, type PlanItemRow } from './plans-api';

interface Props {
  mode: 'inbox' | 'actionable';
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
                      <ResolveButton
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
 * PlanItemRail — left-rail filter for inbox/actionable views. Lists only
 * the plans that actually have items in the active bucket; clicking one
 * filters the main list to that plan (clicking again, or "All plans",
 * clears it). This replaces the full plan rail in these views so the
 * sidebar stays useful when many plans carry items, mirroring Browse's
 * rail-as-filter behaviour without the plan-open navigation.
 */
export function PlanItemRail({
  mode,
  plans,
  selected,
  onSelect,
  loading,
  error,
}: {
  mode: 'inbox' | 'actionable';
  plans: Array<{ slug: string; count: number; harness?: string }>;
  selected: string | null;
  onSelect: (slug: string | null) => void;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <p className="pc-plans__placeholder">Loading…</p>;
  }
  if (error) {
    return (
      <div className="pc-plans__placeholder pc-plans__placeholder--error">
        <code>{error}</code>
      </div>
    );
  }
  if (!plans.length) {
    return (
      <p className="pc-plans__placeholder">
        {mode === 'inbox' ? 'No plans need human input.' : 'No plans with actionable items.'}
      </p>
    );
  }

  const total = plans.reduce((n, p) => n + p.count, 0);

  return (
    <div
      className="pc-item-rail"
      role="list"
      aria-label={mode === 'inbox' ? 'Plans needing human input' : 'Plans with actionable items'}
    >
      <button
        type="button"
        className={`pc-item-rail__entry pc-item-rail__entry--all${selected === null ? ' is-active' : ''}`}
        onClick={() => onSelect(null)}
        aria-current={selected === null ? 'true' : undefined}
      >
        <span className="pc-item-rail__name">All plans</span>
        <span className="pc-item-rail__count">{total}</span>
      </button>
      {plans.map((p) => (
        <button
          key={p.slug}
          type="button"
          className={`pc-item-rail__entry${selected === p.slug ? ' is-active' : ''}`}
          onClick={() => onSelect(selected === p.slug ? null : p.slug)}
          aria-current={selected === p.slug ? 'true' : undefined}
          title={p.harness ? `${p.slug} · ${p.harness}` : p.slug}
        >
          <span className="pc-item-rail__copy">
            <span className="pc-item-rail__name">{p.slug}</span>
            {p.harness ? <span className="pc-pill pc-pill--harness">{p.harness}</span> : null}
          </span>
          <span className="pc-item-rail__count">{p.count}</span>
        </button>
      ))}
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
      if ('error' in result) throw new Error(result.error ?? 'unknown error');

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
  groupCount,
}: {
  mode: 'inbox' | 'actionable';
  count: number | null;
  groupCount: number | null;
}) {
  return (
    <header className="pc-items__head">
      <div className="pc-items__head-copy">
        <h2>{mode === 'inbox' ? 'Needs Human' : 'Needs Decision'}</h2>
        <p>
          {mode === 'inbox'
            ? 'Items across every plan waiting on a human decision.'
            : 'Items pickable right now — effective todo, all blockers cleared.'}
        </p>
        {count !== null && groupCount !== null ? (
          <div className="pc-items__meta" aria-label="Items summary">
            <span className="pc-items__meta-chip">{itemCountLabel(count)}</span>
            <span className="pc-items__meta-chip">{groupCount} {groupCount === 1 ? 'plan' : 'plans'}</span>
            <span className="pc-items__meta-chip pc-items__meta-chip--accent">
              {mode === 'inbox'
                ? 'Resolve marks done and resumes the harness loop'
                : 'Open an item to continue the next available task'}
            </span>
          </div>
        ) : null}
      </div>
      {count !== null ? <span className="pc-items__count">{count}</span> : null}
    </header>
  );
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
