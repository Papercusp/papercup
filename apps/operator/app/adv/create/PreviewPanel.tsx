'use client';

/**
 * create:preview dock panel — the shared item/Other detail reader.
 *
 * Renders whichever selection is live (?item → PlanItemPreview, ?other →
 * OtherDetail), exactly as PlansClient's renderQueuePreview did. The list
 * panels set ?item/?other; this panel reacts. "View full plan" opens (or
 * focuses) the create:plan-editor panel for that slug.
 */

import { useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanItemPreview from '@/app/admin/plans/PlanItemPreview';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import { usePlanAttention } from '@/app/admin/plans/plans-api';
import { useCreateScope, usePlanListMaps } from './use-create-data';

/**
 * Open a plan full-width: switch to Plans view and set ?plan. create:main
 * renders the loaded plan as a single pane. A plain URL write — nuqs patches
 * history.replaceState to broadcast, so the ?view/?plan subscribers re-render.
 */
export function openPlanEditor(slug: string, jump?: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'plans');
  url.searchParams.set('plan', slug);
  if (jump) url.searchParams.set('jump', jump);
  else url.searchParams.delete('jump');
  window.history.replaceState({}, '', url.toString());
}

export default function PreviewPanel(_props?: Partial<PanelComponentProps>) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [queueItemSel] = useQueryState('item', parseAsString);
  const [queueOtherSel, setQueueOtherSel] = useQueryState('other', parseAsString);

  const attention = usePlanAttention(
    scope.scopeMode === 'all'
      ? undefined
      : { harnessSlug: scope.harnessFilter ?? scope.advActiveSlug ?? undefined },
  );
  const otherItems = useMemo(
    () => (attention.data?.groups ?? []).flatMap((g) => g.items).filter((i) => i.kind !== 'plan-item'),
    [attention.data],
  );

  if (queueItemSel) {
    const idx = queueItemSel.indexOf('::');
    const pSlug = idx === -1 ? null : queueItemSel.slice(0, idx);
    const iId = idx === -1 ? null : queueItemSel.slice(idx + 2);
    return (
      <PlanItemPreview
        key={queueItemSel}
        planSlug={pSlug}
        itemId={iId}
        harnessSlug={pSlug ? maps.harnessByPlan.get(pSlug) ?? null : null}
        onResolved={() => attention.refresh()}
        onViewFullPlan={(slug: string, targetId?: string) => openPlanEditor(slug, targetId)}
      />
    );
  }
  if (queueOtherSel) {
    const sel = otherItems.find((i) => i.id === queueOtherSel) ?? null;
    return (
      <OtherDetail
        key={queueOtherSel}
        item={sel}
        onResolved={() => {
          void setQueueOtherSel(null);
          attention.refresh();
        }}
      />
    );
  }
  return (
    <aside className="pc-items__detail">
      <div className="pc-items__detail-empty">Select an item to see its detail and actions.</div>
    </aside>
  );
}
