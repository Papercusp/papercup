import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/settings')({
  component: AdvSettingsPage,
});

function AdvSettingsPage() {
  return <AdvHarnessPanelPage panel="settings" />;
}
