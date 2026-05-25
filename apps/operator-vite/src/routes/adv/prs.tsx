import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/prs')({
  component: AdvPrsPage,
});

function AdvPrsPage() {
  return <AdvHarnessPanelPage panel="prs" />;
}
