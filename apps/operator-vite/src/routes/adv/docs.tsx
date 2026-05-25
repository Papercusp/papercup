import { createFileRoute } from '@tanstack/react-router';
import AdvHarnessPanelPage from '../../components/adv/AdvHarnessPanelPage';

export const Route = createFileRoute('/adv/docs')({
  component: AdvDocsPage,
});

function AdvDocsPage() {
  return <AdvHarnessPanelPage panel="docs" />;
}
