'use client';

/**
 * PlanBucketTabs — the five lifecycle filter tabs that sit directly
 * under PlanFilters: Draft / Ready / Running / Shipped / Rejected.
 *
 * Each plan maps to exactly one bucket via `bucketOf` (plans-api), so
 * the tabs partition every visible plan. The active tab is a togglable
 * filter on the `?pBucket=` nuqs key — clicking the active tab clears
 * it (back to "all buckets"). PlanRail reads the same key.
 *
 * Count badges reflect the CURRENT view: they apply the search box +
 * every other active filter (date/owner/legacy/archived/needs-human/
 * actionable) via the shared `applyPlanFilters`, then group by bucket.
 * So the badge on a tab is exactly how many rows the rail would show if
 * that tab were selected.
 */

import { useMemo } from 'react';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import {
  bucketOf,
  PLAN_BUCKETS,
  type PlanBucket,
  type PlanListRow,
} from './plans-api';
import { applyPlanFilters } from './plan-filtering';
import { type DateWindow } from './PlanFilters';

const BUCKET_IDS: PlanBucket[] = PLAN_BUCKETS.map((b) => b.id);

interface Props {
  /** The harness-scoped plan list (pre bucket/filter), as PlansClient holds it. */
  plans: PlanListRow[];
  /** The search box value (`?q=`). */
  query: string;
  /** Server-side cross-plan body-search hits, unioned into the query match. */
  searchHitSlugs?: ReadonlySet<string>;
  /** True when the plan (Browse) view is active — chips highlight only then. */
  isBrowse?: boolean;
  /** Enter the plan (Browse) view. Fired on any chip click so selecting a
   *  status from an item view returns to browsing plans. */
  onBrowse?: () => void;
}

export default function PlanBucketTabs({ plans, query, searchHitSlugs, isBrowse = true, onBrowse }: Props) {
  const [bucket, setBucket] = useQueryState(
    'pBucket',
    parseAsStringEnum<PlanBucket>(BUCKET_IDS),
  );

  // Same filter keys PlanRail reads — so the badges track the live view.
  const [date] = useQueryState('pDate', parseAsStringEnum<DateWindow>(['today', '7d', '30d']));
  const [owner] = useQueryState('pOwner', parseAsString);
  const [archived] = useQueryState('pArchived', parseAsBoolean.withDefault(false));
  const [legacy] = useQueryState('pLegacy', parseAsBoolean.withDefault(false));
  const [inbox] = useQueryState('pInbox', parseAsBoolean.withDefault(false));
  const [actionable] = useQueryState('pActionable', parseAsBoolean.withDefault(false));

  const counts = useMemo<Record<PlanBucket, number>>(() => {
    const filtered = applyPlanFilters(
      plans,
      { date, owner, archived, legacy, inbox, actionable },
      query,
      searchHitSlugs,
    );
    const acc: Record<PlanBucket, number> = {
      draft: 0,
      ready: 0,
      running: 0,
      shipped: 0,
      rejected: 0,
    };
    for (const p of filtered) acc[bucketOf(p)] += 1;
    return acc;
  }, [plans, date, owner, archived, legacy, inbox, actionable, query, searchHitSlugs]);

  const total = BUCKET_IDS.reduce((n, id) => n + counts[id], 0);

  return (
    <div className="pc-plan-buckets" role="group" aria-label="Plan lifecycle buckets">
      {/* "All" — no status filter; also the entry into the plan (Browse)
          view. Sits to the left of Draft. */}
      <button
        type="button"
        className={`pc-plans__view pc-plan-bucket pc-plan-bucket--all ${isBrowse && bucket === null ? 'is-active' : ''}`}
        aria-pressed={isBrowse && bucket === null}
        onClick={() => {
          onBrowse?.();
          void setBucket(null);
        }}
        title="Show all plans — no status filter"
      >
        <span className="pc-plans__view-label">All</span>
        <span className="pc-plans__view-count">{total}</span>
      </button>
      {PLAN_BUCKETS.map(({ id, label }) => {
        const active = isBrowse && bucket === id;
        return (
          <button
            key={id}
            type="button"
            className={`pc-plans__view pc-plan-bucket pc-plan-bucket--${id} ${active ? 'is-active' : ''}`}
            aria-pressed={active}
            onClick={() => {
              onBrowse?.();
              void setBucket(active ? null : id);
            }}
            title={active ? `Showing ${label} — click to show all buckets` : `Filter to ${label} plans`}
          >
            <span className="pc-plans__view-label">{label}</span>
            <span className="pc-plans__view-count">{counts[id]}</span>
          </button>
        );
      })}
    </div>
  );
}
