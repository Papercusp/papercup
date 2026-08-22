import { createFileRoute } from '@tanstack/react-router';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import AdvShell, { ADV_TABS, useAdvScope, type AdvScope, type AdvTabId } from '../../components/adv/AdvShell';
import AdvPotBar from '../../components/adv/AdvPotBar';
import { potBarModeForTab } from '../../components/adv/adv-pot-bar-tabs';
import AdvTabErrorBoundary from '../../components/adv/AdvTabErrorBoundary';
import AdvOverviewTab from '../../components/adv/AdvOverviewTab';
import AdvStatsTab from '../../components/adv/AdvStatsTab';
import AdvConversationsTab from '../../components/adv/AdvConversationsTab';
import LearningTab from '../../components/adv/LearningTab';
import AdvFramesTab from '../../components/adv/AdvFramesTab';
import AdvEvalsTab from '../../components/adv/AdvEvalsTab';
import ScheduledCalendarTab from '../../components/adv/ScheduledCalendarTab';
import HealthTab from '../../components/adv/HealthTab';
import AdvHistoryTab from '../../components/adv/AdvHistoryTab';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';
import HarnessesWorkspace from '@/app/adv/harnesses/HarnessesWorkspace';
import AdvCreateDock from '@/app/adv/create/AdvCreateDock';
import HudView from '@/app/adv/hud/HudView';
// plans.css is still needed: the Create dock's panels (PlansListPanel,
// PreviewPanel, …) reuse the `pc-plans__*` classes from PlansClient.
import '@/app/admin/plans/plans.css';

const ADV_TAB_IDS = ADV_TABS.map((tab) => tab.id) as [AdvTabId, ...AdvTabId[]];

export const Route = createFileRoute('/adv/')({
  component: AdvIndexPage,
});

function AdvIndexPage() {
  const [activeTab] = useQueryState(
    'tab',
    // Overview is the default landing surface (Brief 23 /
    // overview-dashboard-2026-06-05 D-001). Keep in sync with AdvShell.
    parseAsStringEnum<AdvTabId>(ADV_TAB_IDS).withDefault('overview'),
  );
  return (
    <AdvShell>
      <AdvScopedTabBody activeTab={activeTab} />
    </AdvShell>
  );
}

/**
 * This component MUST stay below AdvShell in the rendered tree. AdvShell owns
 * AdvScopeContext.Provider; reading useAdvScope in AdvIndexPage (before its
 * returned shell exists) can only see the context default, silently turning
 * every HUD query into All Pots regardless of the selector URL.
 */
function AdvScopedTabBody({ activeTab }: { activeTab: AdvTabId }) {
  // The pot cluster is a per-tab row now, not shell chrome (owner ask
  // 2026-07-27) — see AdvPotBar. `withStatus` (the running pills + start/stop) is
  // HUD only. It is rendered HERE rather than inside each tab component for two
  // reasons: HudBoard/AdvCreateDock/HarnessesWorkspace live under apps/operator/app,
  // which must not import up-layer from operator-vite/src (the same layering that
  // made QuickPanelHeaderControls a passed-in slot); and keeping it OUTSIDE the
  // error boundary means a crashed tab still leaves you a pot selector to switch
  // away with.
  const potBar = potBarModeForTab(activeTab);
  const potScope = useAdvScope();
  return (
    <>
      {potBar.show ? <AdvPotBar withStatus={potBar.withStatus} /> : null}
      {/* The tab body is wrapped in an error boundary so a render crash in ONE tab
          (e.g. a hook useMemo over a shape-changed query) can't white-screen the
          whole operator — the shell chrome (tab strip) and the pot bar sit OUTSIDE
          it and every other tab stays reachable. key={activeTab} resets it on
          navigation. */}
      <div className="pc-advshell__tabbody">
        <AdvTabErrorBoundary key={activeTab} tab={activeTab}>
          {renderAdvTab(activeTab, potScope)}
        </AdvTabErrorBoundary>
      </div>
    </>
  );
}

function renderAdvTab(tab: AdvTabId, potScope: AdvScope) {
  switch (tab) {
    case 'overview':
      return <AdvOverviewTab />;
    case 'hud':
      // HUD — the session board: every live session grouped by what it needs
      // (adv-hud-fleet-board-2026-07-25). `/adv/HUD` redirects to ?tab=hud.
      return <HudView potScope={potScope} />;
    case 'conversations':
      return <AdvConversationsTab />;
    case 'learning':
      return <LearningTab />;
    case 'harnesses':
      return <HarnessesWorkspace />;
    case 'health':
      // The read-only system Health dashboard (system-health-tab-2026-06-15).
      return <HealthTab />;
    case 'frames':
      // Swarm live view — per-agent-display thumbnails from deployed frames
      // (hive-frame-desktops-live-view P-006).
      return <AdvFramesTab />;
    case 'evals':
      // Evaluation — the impartial-benchmark surface (External benchmarks |
      // Internal trends | Report) (impartial-benchmark-suite-2026-06-15 D-007).
      return <AdvEvalsTab />;
    case 'stats':
      return <AdvStatsTab />;
    case 'calendar':
      // Calendar — the schedulable time-surface: FullCalendar over the
      // backend-computed scheduled-plan occurrences (scheduled-recurring-plans P-018/P-019).
      return <ScheduledCalendarTab />;
    case 'history':
      return <AdvHistoryTab />;
    // ('brainstorm' removed — the surface lives in the Quick Panel popup now; P-010.)
    case 'prs':
    case 'insights':
    case 'settings':
    case 'docs':
    case 'git':
    case 'testing':
      return <AdvHarnessPanelPage panel={tab} />;
    case 'plans':
      // The "Create" tab is now the dockview dock (inbox / plans / sessions /
      // preview panels), mirroring the Git tab's AdvGitWorkspace. Was the
      // <AdvPlansTabs><PlansClient/></AdvPlansTabs> tab-strip.
      return <AdvCreateDock />;
  }
}
