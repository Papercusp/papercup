'use client';

/**
 * AdvCreateDock — the dockview shell for the /adv "Create" tab (?tab=plans),
 * option-B free panels. Mirrors AdvGitDock/HarnessesDock but simpler: the
 * Create panels are workspace/scope-driven via URL params (?slug/?scope/?h),
 * so there's no per-slug param rebind. Seed: defaultAdvCreateLayout
 * (inbox/plans/sessions tabs left, preview right); the plan editor opens on
 * demand via openPlanEditor (PreviewPanel).
 *
 * NOT YET wired into the route — operator-vite still mounts <PlansClient/>.
 * The route swap is gated on live-desktop verification (see the spec).
 */

import { useEffect } from 'react';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import InboxPanel from './InboxPanel';
import PreviewPanel from './PreviewPanel';
import PlansListPanel from './PlansListPanel';
import SessionsPanel from './SessionsPanel';
import PlanEditorPanel from './PlanEditorPanel';

let registered = false;
export function ensureCreatePanelsRegistered(): void {
  if (registered) return;
  panelRegistry.register('create:inbox', InboxPanel, { title: 'Inbox' });
  panelRegistry.register('create:preview', PreviewPanel, { title: 'Detail' });
  panelRegistry.register('create:plans-list', PlansListPanel, { title: 'Plans' });
  // keepAlive: sessions keeps polling its roster; the editor keeps its
  // unsaved-edit state when its tab is inactive.
  panelRegistry.register('create:sessions', SessionsPanel, { title: 'Sessions', keepAlive: true });
  panelRegistry.register('create:plan-editor', PlanEditorPanel, { title: 'Plan', keepAlive: true });
  registered = true;
}

export default function AdvCreateDock() {
  useEffect(() => {
    ensureCreatePanelsRegistered();
  }, []);

  // Absolute fill (see HarnessesDock note): a height:100% chain collapses to 0
  // in WebKitGTK when an ancestor's height comes from flex:1.
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HarnessDock layoutName="adv-create" />
    </div>
  );
}
