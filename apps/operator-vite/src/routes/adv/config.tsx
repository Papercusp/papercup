import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/config')({
  component: AdvConfigPage,
});

function AdvConfigPage() {
  return <AdvHarnessPanelPage panel="config" />;
}
