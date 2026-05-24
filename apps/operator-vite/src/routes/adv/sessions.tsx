import { createFileRoute } from '@tanstack/react-router';
import AdvShell from '../../components/adv/AdvShell';
import AdvSessionsClient from '@/app/adv/sessions/AdvSessionsClient';

/**
 * /adv/sessions — list of launched agent terminal sessions with focus
 * + resume controls. Mirrors apps/operator/app/adv/sessions/page.tsx
 * in TSR.
 */
export const Route = createFileRoute('/adv/sessions')({
  component: AdvSessionsPage,
});

function AdvSessionsPage() {
  return (
    <AdvShell title="Sessions">
      <AdvSessionsClient />
    </AdvShell>
  );
}
