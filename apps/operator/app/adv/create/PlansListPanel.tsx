'use client';

/**
 * create:plans-list dock panel — the plan browser (search + lifecycle bucket
 * filters + the plan rail). Mirrors PlansClient's left rail. Clicking a plan
 * toggles the per-plan item filter (?itemPlans) — which the inbox panel reacts
 * to — matching PlansClient's "rail as item-navigator" behavior.
 *
 * Simplification vs PlansClient (noted): the rail lists all in-scope plans
 * (bucket/search filtered) rather than only plans-with-matching-items; a
 * dedicated browser panel surfacing every plan is the more useful default.
 */

import { useMemo, useRef } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanFilters from '@/app/admin/plans/PlanFilters';
import PlanBucketTabs from '@/app/admin/plans/PlanBucketTabs';
import PlanRail from '@/app/admin/plans/PlanRail';
import { usePlanSearch } from '@/app/admin/plans/plans-api';
import { useCreateScope, usePlanListMaps, useItemPlanFilter } from './use-create-data';

export default function PlansListPanel(_props: PanelComponentProps) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [harnessFilter, setHarnessFilter] = useQueryState('h', parseAsString);
  const [itemPlans, setItemPlans] = useItemPlanFilter();
  const searchRef = useRef<HTMLInputElement>(null);

  const railSearchHits = usePlanSearch(q);
  const searchHitSlugs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const h of railSearchHits.data?.hits ?? []) s.add(h.plan);
    return s;
  }, [railSearchHits.data]);

  const filteredPlanList = useMemo(
    () => ({
      ...maps.planList,
      data: maps.planList.data ? { ...maps.planList.data, plans: maps.visiblePlans } : null,
    }),
    [maps.planList, maps.visiblePlans],
  );

  const toggleItemPlan = (s: string) =>
    void setItemPlans(itemPlans.includes(s) ? itemPlans.filter((x) => x !== s) : [...itemPlans, s]);

  return (
    <div className="pc-plans__rail" style={{ height: '100%', overflow: 'auto' }}>
      <div className="pc-plans__group">
        {maps.harnessOptions.length > 1 ? (
          <div className="pc-plans__harness-filter">
            <label className="pc-plans__harness-filter-label" htmlFor="pc-create-harness-filter">
              Harness
            </label>
            <select
              id="pc-create-harness-filter"
              className="pc-plans__harness-filter-select"
              value={harnessFilter ?? ''}
              onChange={(e) => void setHarnessFilter(e.target.value || null)}
            >
              <option value="">All ({maps.planList.data?.plans.length ?? 0})</option>
              {maps.harnessOptions.map((h) => {
                const count = (maps.planList.data?.plans ?? []).filter((p) => p.harness === h).length;
                return (
                  <option key={h} value={h}>
                    {h} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        ) : null}

        <PlanFilters list={filteredPlanList} query={q} onQueryChange={setQ} searchRef={searchRef} />
        <PlanBucketTabs plans={maps.visiblePlans} query={q} searchHitSlugs={searchHitSlugs} />
      </div>

      <div className="pc-plans__list" aria-label="Plans">
        <PlanRail
          list={filteredPlanList}
          selectedSlugs={itemPlans}
          query={q}
          searchHitSlugs={searchHitSlugs}
          onSelect={toggleItemPlan}
          onStartToggle={() => maps.planList.refresh()}
          harnessSlug={harnessFilter ?? scope.advActiveSlug}
        />
      </div>
    </div>
  );
}
