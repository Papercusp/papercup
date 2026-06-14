'use client';

/**
 * create:queue dock panel — the cross-plan item Queue.
 *
 * Mirrors PlansClient's "Queue" view: the item-status filter chips, the
 * "Other" attention list (PlanOtherList) and the grouped plan-item list
 * (PlanItemsList). Selection (?item / ?other) is owned by those list
 * components via nuqs; the create:preview panel renders the selection. Data
 * comes from the shared hooks (shared useSyncQuery cache → coherent with the
 * other panels + live-invalidated on plan writes).
 */

import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanItemsList from '@/app/admin/plans/PlanItemsList';
import PlanOtherList from '@/app/admin/plans/PlanOtherList';
import {
  useCreateScope,
  usePlanListMaps,
  useQueueData,
  useItemStatusFilter,
  usePlanBucketFilter,
  useItemPlanFilter,
  ITEM_FILTERS,
  ITEM_FILTER_LABEL,
} from './use-create-data';

export default function QueuePanel(_props?: Partial<PanelComponentProps>) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [istatus, setIstatus] = useItemStatusFilter();
  const [pBuckets] = usePlanBucketFilter();
  const [itemPlans] = useItemPlanFilter();

  const queue = useQueueData({
    istatus,
    pBuckets,
    planBucketBySlug: maps.planBucketBySlug,
    scope,
  });

  const toggleItemStatus = (id: (typeof ITEM_FILTERS)[number]['id']) =>
    void setIstatus(istatus.includes(id) ? istatus.filter((x) => x !== id) : [...istatus, id]);

  const itemTitle = istatus.length
    ? istatus.map((s) => ITEM_FILTER_LABEL[s]).join(' · ')
    : 'All items';

  return (
    <div className="pc-queue__list" style={{ height: '100%', overflow: 'auto' }}>
      <nav className="pc-queue__filters" aria-label="Queue item filters">
        {ITEM_FILTERS.map((f) => {
          const active = istatus.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              className={`pc-queue__filter pc-plans__view--${f.id} ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => toggleItemStatus(f.id)}
              title={f.hint}
            >
              <span className="pc-queue__filter-label">{f.label}</span>
              <span className="pc-queue__filter-count">
                {queue.loading ? '…' : queue.itemStatusCounts[f.id]}
              </span>
            </button>
          );
        })}
      </nav>
      <div className="pc-items__listpane">
        {queue.showOther ? (
          <PlanOtherList
            groups={queue.otherGroups}
            loading={queue.attentionRaw.loading}
            error={queue.attentionRaw.error}
            refresh={queue.attentionRaw.refresh}
            title="Other"
            kinds={queue.otherFacets}
            planFilters={itemPlans}
          />
        ) : null}
        {queue.showPlanItems ? (
          <PlanItemsList
            items={queue.filteredItems}
            loading={queue.loading}
            error={queue.error}
            refresh={queue.refresh}
            harnessByPlan={maps.harnessByPlan}
            planMeta={maps.planMetaBySlug}
            planFilters={itemPlans}
            title={itemTitle}
          />
        ) : null}
      </div>
    </div>
  );
}
