import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/brainstorm')({
  component: AdvBrainstormPage,
});

function AdvBrainstormPage() {
  return <AdvHarnessPanelPage panel="brainstorm" />;
}
