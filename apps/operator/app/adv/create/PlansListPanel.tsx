'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * create:filter — the left FILTER sidebar of the Create dock, always visible.
 * Top: New plan + the Plans/Inbox/Sessions view buttons (set ?view, which
 * create:main renders). Below: search + plan-status bucket filters, then the
 * plan list. The plan list acts as a filter on whichever view is active —
 * clicking a plan in Inbox/Sessions toggles the ?itemPlans item filter; in
 * Plans view it opens that plan full-width on the right (?plan).
 *
 * Mirrors PlansClient's rail (search + buckets + PlanRail) plus its
 * rail-actions row (New plan + view buttons), lifted so the dock behaves like
 * the original Plans tab.
 */

import { useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { ClipboardList, Eye, Inbox, Plus, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import { useLexicon } from '@/lib/useLexicon';
import PlanFilters from '@/app/admin/plans/PlanFilters';
import PlanBucketTabs from '@/app/admin/plans/PlanBucketTabs';
import PlanRail from '@/app/admin/plans/PlanRail';
import { usePlanSearch } from '@/app/admin/plans/plans-api';
import { Select } from '@/app/harness/Select';
import {
  useCreateScope,
  usePlanListMaps,
  useItemPlanFilter,
  useResolvedHarnessSlug,
  useCreateView,
} from './use-create-data';

export default function PlansListPanel(_props?: PanelComponentProps) {
  const t = useLexicon();
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [view, setView] = useCreateView();
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [plan, setPlan] = useQueryState('plan', parseAsString);
  const [harnessFilter, setHarnessFilter] = useQueryState('h', parseAsString);
  const [itemPlans, setItemPlans] = useItemPlanFilter();
  const searchRef = useRef<HTMLInputElement>(null);

  // ── New-plan launch (mirrors PlansClient.onNewPlan) ──
  const resolvedSlug = useResolvedHarnessSlug();
  const [launching, setLaunching] = useState(false);
  const onNewPlan = async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: resolvedSlug ?? null,
        planSlug: null,
        label: resolvedSlug ? `new-plan · ${resolvedSlug}` : 'new-plan',
        kickoff: { kind: 'new-plan' },
        // Open as a pane in the zellij dock (owner ask, pui-dock-agent-stack):
        // record a pending workbench launch; the dock's pui dock-driver panes it
        // reactively instead of the server spawning an OS terminal window.
        deferSpawn: true,
      });
      if (result.ok) {
        toast.success('Plan-drafting agent queued — opening as a pane in the dock.', { duration: 3000 });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  };

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

  // The plan list filters whichever view is active: in Plans view it OPENS the
  // plan full-width (?plan) — a plain select, not a toggle, since the Plans
  // view always shows a plan; in Inbox/Sessions it toggles the ?itemPlans filter.
  const onSelectPlan = (s: string) => {
    if (view === 'plans') {
      void setPlan(s);
    } else {
      void setItemPlans(itemPlans.includes(s) ? itemPlans.filter((x) => x !== s) : [...itemPlans, s]);
    }
  };
  const selectedSlugs = view === 'plans' ? (plan ? [plan] : []) : itemPlans;

  return (
    <div className="pc-plans__rail" style={{ height: '100%', overflow: 'auto' }}>
      {/* New plan + the 3 view buttons — above the plan list, exactly as before. */}
      <div className="pc-plans__rail-actions">
        <Tooltip label={resolvedSlug
              ? `Launch an agent session to draft a new plan in ${resolvedSlug}`
              : `Launch an agent session to draft a new plan (no active ${t('pot', { lower: true })} — agent will ask)`}><button
          type="button"
          className="pc-plans__new-plan"
          onClick={onNewPlan}
          disabled={launching}

        >
          <Plus size={14} aria-hidden />
          {launching ? 'Launching…' : 'New plan'}
        </button></Tooltip>
        <Tooltip label="Plans — open a plan from the list to view/edit it full-width."><button
          type="button"
          className={`pc-plans__plans-btn${view === 'plans' ? ' is-active' : ''}`}
          onClick={() => void setView('plans')}

        >
          <ClipboardList size={14} aria-hidden />
          Plans
        </button></Tooltip>
        <Tooltip label="Queue — every decision & action surface across plans the Queen did not auto-handle (list + detail)."><button
          type="button"
          className={`pc-plans__queue-btn${view === 'queue' ? ' is-active' : ''}`}
          onClick={() => void setView('queue')}

        >
          <Inbox size={14} aria-hidden />
          <span className="pc-plans__queue-btn-label">Queue</span>
        </button></Tooltip>
        <Tooltip label="Sessions — live agent roster (list + detail)."><button
          type="button"
          className={`pc-plans__sessions-btn${view === 'sessions' ? ' is-active' : ''}`}
          onClick={() => void setView('sessions')}

        >
          <Terminal size={14} aria-hidden />
          <span className="pc-plans__queue-btn-label">Sessions</span>
        </button></Tooltip>
        <Tooltip label="Observations — pre-idea sensor readings agents record at end of turn (browse only; never enters the work queue)."><button
          type="button"
          className={`pc-plans__sessions-btn${view === 'observations' ? ' is-active' : ''}`}
          onClick={() => void setView('observations')}

        >
          <Eye size={14} aria-hidden />
          <span className="pc-plans__queue-btn-label">Observations</span>
        </button></Tooltip>
      </div>

      <div className="pc-plans__group">
        {maps.harnessOptions.length > 1 ? (
          <div className="pc-plans__harness-filter">
            <label className="pc-plans__harness-filter-label" htmlFor="pc-create-harness-filter">
              {t('pot')}
            </label>
            <Select
              id="pc-create-harness-filter"
              triggerClassName="pc-plans__harness-filter-select"
              value={harnessFilter ?? ''}
              onChange={(value) => void setHarnessFilter(value === '_all' ? null : value)}
              ariaLabel={`Filter plans by ${t('pot', { lower: true })}`}
              options={[
                { value: '_all', label: `All (${maps.planList.data?.plans.length ?? 0})` },
                ...maps.harnessOptions.map((h) => {
                  const count = (maps.planList.data?.plans ?? []).filter((p) => p.harness === h).length;
                  return { value: h, label: `${h} (${count})` };
                }),
              ]}
            />
          </div>
        ) : null}

        <PlanFilters list={filteredPlanList} query={q} onQueryChange={setQ} searchRef={searchRef} />
        <PlanBucketTabs plans={maps.visiblePlans} query={q} searchHitSlugs={searchHitSlugs} />
      </div>

      <div className="pc-plans__list" aria-label="Plans">
        <PlanRail
          list={filteredPlanList}
          selectedSlugs={selectedSlugs}
          query={q}
          searchHitSlugs={searchHitSlugs}
          onSelect={onSelectPlan}
          onStartToggle={() => maps.planList.refresh()}
        />
      </div>
    </div>
  );
}
