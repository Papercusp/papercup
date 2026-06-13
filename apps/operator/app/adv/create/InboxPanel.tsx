'use client';

/**
 * create:inbox dock panel — the cross-plan item inbox.
 *
 * Mirrors PlansClient's "inbox" view: the item-status filter chips, the
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
  useInboxData,
  useItemStatusFilter,
  usePlanBucketFilter,
  useItemPlanFilter,
  ITEM_FILTERS,
  ITEM_FILTER_LABEL,
} from './use-create-data';

export default function InboxPanel(_props?: Partial<PanelComponentProps>) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [istatus, setIstatus] = useItemStatusFilter();
  const [pBuckets] = usePlanBucketFilter();
  const [itemPlans] = useItemPlanFilter();

  const inbox = useInboxData({
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
    <div className="pc-inbox__list" style={{ height: '100%', overflow: 'auto' }}>
      <nav className="pc-inbox__filters" aria-label="Queue item filters">
        {ITEM_FILTERS.map((f) => {
          const active = istatus.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              className={`pc-inbox__filter pc-plans__view--${f.id} ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => toggleItemStatus(f.id)}
              title={f.hint}
            >
              <span className="pc-inbox__filter-label">{f.label}</span>
              <span className="pc-inbox__filter-count">
                {inbox.loading ? '…' : inbox.itemStatusCounts[f.id]}
              </span>
            </button>
          );
        })}
      </nav>
      <div className="pc-items__listpane">
        {inbox.showOther ? (
          <PlanOtherList
            groups={inbox.otherGroups}
            loading={inbox.attentionRaw.loading}
            error={inbox.attentionRaw.error}
            refresh={inbox.attentionRaw.refresh}
            title="Other"
            kinds={inbox.otherFacets}
            planFilters={itemPlans}
          />
        ) : null}
        {inbox.showPlanItems ? (
          <PlanItemsList
            items={inbox.filteredItems}
            loading={inbox.loading}
            error={inbox.error}
            refresh={inbox.refresh}
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
