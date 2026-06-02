import { createFileRoute } from '@tanstack/react-router';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import AdvShell, { ADV_TABS, type AdvTabId } from '../../components/adv/AdvShell';
import AdvHarnessPanelPage, { ADV_HARNESS_PANEL_LABELS } from '../../components/adv/AdvHarnessPanelPage';
import HarnessesWorkspace from '@/app/adv/harnesses/HarnessesWorkspace';
import PlansClient from '@/app/admin/plans/PlansClient';
import AdvPlansTabs from '@/app/adv/plans/AdvPlansTabs';
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
  if (tab === 'harnesses') return 'Harness';
  if (tab in ADV_HARNESS_PANEL_LABELS) {
    return ADV_HARNESS_PANEL_LABELS[tab as keyof typeof ADV_HARNESS_PANEL_LABELS];
  }
  return 'Create';
}

function renderAdvTab(tab: AdvTabId) {
  switch (tab) {
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
      return (
        <AdvPlansTabs>
          <PlansClient />
        </AdvPlansTabs>
      );
  }
}
