'use client';

/**
 * create:main — the right MAIN region of the Create dock. Renders the active
 * `?view` (the buttons in the create:filter sidebar set it):
 *
 *   - plans    → the FULL plan editor (PlanDetail: the plan's markdown in the
 *                vditor, frontmatter card, and the action strip). Entering
 *                Plans always lands on a plan — when none is selected it
 *                auto-opens the first plan in the (scoped) list, so the pane
 *                is the editor and never an item list (that is the Inbox
 *                view's job). The create:filter sidebar list is the picker;
 *                a ?q search swaps in PlanSearchResults to find another plan.
 *   - inbox    → split: InboxPanel (items) | PreviewPanel (detail).
 *   - sessions → the live roster (SessionsPanel is its own 2-pane).
 *
 * State is nuqs (?view/?plan/?q/…) shared with create:filter and the child
 * panels; the shared useSyncQuery cache dedupes fetches across them. An open
 * ?plan fills the region full-width (single pane) regardless of how it was
 * opened; Sessions ignores ?plan (matches the original Plans tab).
 */

import { useEffect, useRef } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanDetail from '@/app/admin/plans/PlanDetail';
import PlanSearchResults from '@/app/admin/plans/PlanSearchResults';
import TwoPaneShell from '@/app/_components/layout/TwoPaneShell';
import InboxPanel from './InboxPanel';
import PreviewPanel from './PreviewPanel';
import SessionsPanel from './SessionsPanel';
import { useCreateScope, usePlanListMaps, useCreateView } from './use-create-data';

export default function MainViewPanel(_props?: PanelComponentProps) {
  const [view] = useCreateView();
  const [plan, setPlan] = useQueryState('plan', parseAsString);
  const [q] = useQueryState('q', parseAsString.withDefault(''));
  const dirtyRef = useRef(false);

  // Plans view always shows a full plan. Auto-open the first plan in the
  // (scoped) list when none is selected and no search is active, so entering
  // Plans lands in the editor rather than an empty pane. The sidebar list is
  // the picker; clicking another plan swaps ?plan.
  const scope = useCreateScope();
  const maps = usePlanListMaps(scope);
  const firstSlug = maps.visiblePlans[0]?.slug ?? null;
  const searching = q.trim().length > 0;
  useEffect(() => {
    if (view === 'plans' && !plan && !searching && firstSlug) {
      void setPlan(firstSlug);
    }
  }, [view, plan, searching, firstSlug, setPlan]);

  // A loaded plan fills the whole region (single pane) — only in Plans view:
  // Inbox/Sessions render their own panes even while ?plan is set (the param
  // persists so flipping back to Plans restores the open plan). Every
  // open-plan affordance outside Plans view (e.g. PreviewPanel) sets
  // view='plans' explicitly. No "← All plans" back button: the sidebar list
  // is the always-visible picker, so there is no list view to go back to.
  //
  // Wrap in `.pc-plans__main` (the standalone /admin/plans scroller) so the
  // plan editor has its own overflow:auto. PlanDetail itself is overflow:
  // visible and sizes its read-mode preview to content height; standalone it
  // relies on PlansClient's `.pc-plans__main` grid track to scroll the spill.
  // The dock's dockview content box is overflow:hidden, so without this the
  // editor's lower/right content is clipped with no scrollbar ("cut off").
  if (view === 'plans' && plan) {
    return (
      <div className="pc-plans__main" style={{ height: '100%' }}>
      <PlanDetail
        key={plan}
        slug={plan}
        showBack={false}
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
      </div>
    );
  }
  if (view === 'sessions') return <SessionsPanel />;
  if (view === 'queue') return <TwoPaneShell list={<InboxPanel />} detail={<PreviewPanel />} />;
  // view === 'plans': a search finds another plan; otherwise we're between the
  // list loading and the auto-open effect firing (or there are no plans).
  if (searching) return <PlanSearchResults query={q} onPick={(s) => void setPlan(s)} />;
  return (
    <div className="pc-plans__placeholder" style={{ padding: 24, color: 'var(--fg-mute)' }}>
      {maps.planList.loading
        ? 'Loading plans…'
        : 'No plans in this view yet — use “New plan” in the sidebar to start one.'}
    </div>
  );
}
