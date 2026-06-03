'use client';

/**
 * create:preview dock panel — the shared item/Other detail reader.
 *
 * Renders whichever selection is live (?item → PlanItemPreview, ?other →
 * OtherDetail), exactly as PlansClient's renderInboxPreview did. The list
 * panels set ?item/?other; this panel reacts. "View full plan" opens (or
 * focuses) the create:plan-editor panel for that slug.
 */

import { useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanItemPreview from '@/app/admin/plans/PlanItemPreview';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import { usePlanAttention } from '@/app/admin/plans/plans-api';
import { focusPanel, groupIdOfPanelType, listPanels, openPanel } from '@/app/harness/dock/dock-actions';
import { useCreateScope, usePlanListMaps } from './use-create-data';

const EDITOR_TYPE = 'create:plan-editor';
const PREVIEW_TYPE = 'create:preview';

/**
 * Open (or focus an existing) plan-editor panel for a slug. The editor opens
 * INTO the preview's group (the right region) so it stacks over the preview
 * and — with the Create dock's headers hidden — fills the full width of the
 * right side. AdvCreateDock widens that region while an editor is open.
 */
export function openPlanEditor(slug: string, jump?: string): void {
  try {
    const existing = listPanels().find((p) => p.type === EDITOR_TYPE && p.params.plan === slug);
    if (existing) {
      focusPanel(existing.id);
      return;
    }
    const id = openPanel({
      type: EDITOR_TYPE,
      title: slug,
      // Drop into the right region (preview's group); falls back to
      // auto-position if no preview is open.
      group: groupIdOfPanelType(PREVIEW_TYPE),
      params: { plan: slug, ...(jump ? { jump } : {}) },
    });
    focusPanel(id);
  } catch {
    // Dock api not bound yet — fall back to the URL param the editor also reads.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('plan', slug);
      if (jump) url.searchParams.set('jump', jump);
      window.history.replaceState({}, '', url.toString());
    }
  }
}

export default function PreviewPanel(_props: PanelComponentProps) {
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const [inboxItemSel] = useQueryState('item', parseAsString);
  const [inboxOtherSel, setInboxOtherSel] = useQueryState('other', parseAsString);

  const attention = usePlanAttention(
    scope.scopeMode === 'all'
      ? undefined
      : { harnessSlug: scope.harnessFilter ?? scope.advActiveSlug ?? undefined },
  );
  const otherItems = useMemo(
    () => (attention.data?.groups ?? []).flatMap((g) => g.items).filter((i) => i.kind !== 'plan-item'),
    [attention.data],
  );

  if (inboxItemSel) {
    const idx = inboxItemSel.indexOf('::');
    const pSlug = idx === -1 ? null : inboxItemSel.slice(0, idx);
    const iId = idx === -1 ? null : inboxItemSel.slice(idx + 2);
    return (
      <PlanItemPreview
        key={inboxItemSel}
        planSlug={pSlug}
        itemId={iId}
        harnessSlug={pSlug ? maps.harnessByPlan.get(pSlug) ?? null : null}
        onResolved={() => attention.refresh()}
        onViewFullPlan={(slug: string, targetId?: string) => openPlanEditor(slug, targetId)}
      />
    );
  }
  if (inboxOtherSel) {
    const sel = otherItems.find((i) => i.id === inboxOtherSel) ?? null;
    return (
      <OtherDetail
        key={inboxOtherSel}
        item={sel}
        onResolved={() => {
          void setInboxOtherSel(null);
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
