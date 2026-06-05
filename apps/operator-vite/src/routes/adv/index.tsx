import { createFileRoute } from '@tanstack/react-router';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import AdvShell, { ADV_TABS, type AdvTabId } from '../../components/adv/AdvShell';
import AdvOverviewTab from '../../components/adv/AdvOverviewTab';
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
    parseAsStringEnum<AdvTabId>(ADV_TAB_IDS).withDefault('brainstorm'),
  );
  const title = getAdvTitle(activeTab);

  return <AdvShell title={title}>{renderAdvTab(activeTab)}</AdvShell>;
}

function getAdvTitle(tab: AdvTabId): string {
  if (tab === 'overview') return 'Overview';
  if (tab === 'harnesses') return 'Harness';
  if (tab in ADV_HARNESS_PANEL_LABELS) {
    return ADV_HARNESS_PANEL_LABELS[tab as keyof typeof ADV_HARNESS_PANEL_LABELS];
  }
  return 'Create';
}

function renderAdvTab(tab: AdvTabId) {
  switch (tab) {
    case 'overview':
      return <AdvOverviewTab />;
    case 'harnesses':
      return <HarnessesWorkspace />;
    case 'brainstorm':
    case 'prs':
    case 'insights':
    case 'config':
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
