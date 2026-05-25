import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/insights')({
  component: AdvInsightsPage,
});

function AdvInsightsPage() {
  return <AdvHarnessPanelPage panel="insights" />;
}
