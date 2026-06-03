'use client';

/**
 * create:main — the right MAIN region of the Create dock. Renders the active
 * `?view` (the buttons in the create:filter sidebar set it):
 *
 *   - plans    → ONE full-width pane: the opened plan (PlanDetail), search
 *                results, or the cross-plan items list to browse.
 *   - inbox    → split: InboxPanel (items) | PreviewPanel (detail).
 *   - sessions → split: the live roster (SessionsPanel is its own 2-pane).
 *
 * State is nuqs (?view/?plan/?q/?item/…) shared with create:filter and the
 * child panels; the shared useSyncQuery cache dedupes fetches across them. An
 * open ?plan fills the region full-width (single pane) regardless of how it
 * was opened — that is the "Plans view is a single pane" behavior; Sessions
 * ignores ?plan (matches the original Plans tab).
 */

import { useRef } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanDetail from '@/app/admin/plans/PlanDetail';
import PlanItemsList from '@/app/admin/plans/PlanItemsList';
import PlanSearchResults from '@/app/admin/plans/PlanSearchResults';
import TwoPaneShell from '@/app/_components/layout/TwoPaneShell';
import InboxPanel from './InboxPanel';
import PreviewPanel from './PreviewPanel';
import SessionsPanel from './SessionsPanel';
import {
  useCreateScope,
  usePlanListMaps,
  useInboxData,
  useItemStatusFilter,
  usePlanBucketFilter,
  useItemPlanFilter,
  useCreateView,
  ITEM_FILTER_LABEL,
  type ItemStatusFilter,
} from './use-create-data';

/** Plans view, no plan open: the cross-plan items list, full-width (single pane). */
function PlansItemsFull() {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [istatus] = useItemStatusFilter();
  const [pBuckets] = usePlanBucketFilter();
  const [itemPlans] = useItemPlanFilter();
  const inbox = useInboxData({ istatus, pBuckets, planBucketBySlug: maps.planBucketBySlug, scope });
  const title = istatus.length
    ? istatus.map((s: ItemStatusFilter) => ITEM_FILTER_LABEL[s]).join(' · ')
    : 'All items';
  return (
    <div className="pc-plans__items" style={{ height: '100%', overflow: 'auto' }}>
      <PlanItemsList
        items={inbox.filteredItems}
        loading={inbox.loading}
        error={inbox.error}
        refresh={inbox.refresh}
        harnessByPlan={maps.harnessByPlan}
        planMeta={maps.planMetaBySlug}
        planFilters={itemPlans}
        title={title}
      />
    </div>
  );
}

export default function MainViewPanel(_props?: PanelComponentProps) {
  const [view] = useCreateView();
  const [plan, setPlan] = useQueryState('plan', parseAsString);
  const [q] = useQueryState('q', parseAsString.withDefault(''));
  const dirtyRef = useRef(false);

  // A loaded plan fills the whole region (single pane) — except in Sessions,
  // which ignores ?plan.
  if (view !== 'sessions' && plan) {
    return (
      <PlanDetail
        key={plan}
        slug={plan}
        onClose={() => {
          if (
            dirtyRef.current &&
            typeof window !== 'undefined' &&
            !window.confirm('Discard unsaved changes to this plan?')
          ) {
            return;
          }
          void setPlan(null);
        }}
        onDirtyChange={(d: boolean) => {
          dirtyRef.current = d;
        }}
        startStatus={null}
        onStartStatusChange={() => {}}
        onPlanStatusChange={() => {}}
      />
    );
  }
  if (view === 'sessions') return <SessionsPanel />;
  if (view === 'inbox') return <TwoPaneShell list={<InboxPanel />} detail={<PreviewPanel />} />;
  // view === 'plans', no plan open
  if (q.trim()) return <PlanSearchResults query={q} onPick={(s) => void setPlan(s)} />;
  return <PlansItemsFull />;
}
