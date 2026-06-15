import { createFileRoute } from '@tanstack/react-router';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import AdvShell, { ADV_TABS, type AdvTabId } from '../../components/adv/AdvShell';
import AdvOverviewTab from '../../components/adv/AdvOverviewTab';
import AdvConversationsTab from '../../components/adv/AdvConversationsTab';
import LearningTab from '../../components/adv/LearningTab';
import AdvFramesTab from '../../components/adv/AdvFramesTab';
import AdvEvalsTab from '../../components/adv/AdvEvalsTab';
import HealthTab from '../../components/adv/HealthTab';
import AdvHarnessPanelPage, { ADV_HARNESS_PANEL_LABELS } from '../../components/adv/AdvHarnessPanelPage';
import HarnessesWorkspace from '@/app/adv/harnesses/HarnessesWorkspace';
import AdvCreateDock from '@/app/adv/create/AdvCreateDock';
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
  const title = getAdvTitle(activeTab);

  return <AdvShell title={title}>{renderAdvTab(activeTab)}</AdvShell>;
}

function getAdvTitle(tab: AdvTabId): string {
  if (tab === 'overview') return 'Overview';
  if (tab === 'conversations') return 'Conversations';
  if (tab === 'learning') return 'Learning';
  if (tab === 'harnesses') return 'Working';
  if (tab === 'health') return 'Health';
  if (tab === 'frames') return 'Frames';
  if (tab === 'evals') return 'Evaluation';
  if (tab in ADV_HARNESS_PANEL_LABELS) {
    return ADV_HARNESS_PANEL_LABELS[tab as keyof typeof ADV_HARNESS_PANEL_LABELS];
  }
  return 'Create';
}

function renderAdvTab(tab: AdvTabId) {
  switch (tab) {
    case 'overview':
      return <AdvOverviewTab />;
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
    case 'brainstorm':
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
