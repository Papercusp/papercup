import { createFileRoute } from '@tanstack/react-router';
import AdvShell from '../../components/adv/AdvShell';
import PlansClient from '@/app/admin/plans/PlansClient';
import AdvPlansTabs from '@/app/adv/plans/AdvPlansTabs';
import '@/app/admin/plans/plans.css';

/**
 * /adv/plans — Advanced > Plans surface. Mirrors
 * apps/operator/app/adv/plans/page.tsx but wired into TSR.
 *
 * Like /admin/plans, PlansClient is reused unchanged via the @/ alias
 * (no `next/*` imports inside). AdvPlansTabs wraps it with the
 * VSCode-style inner tab strip.
 */
export const Route = createFileRoute('/adv/plans')({
  component: AdvPlansPage,
});

function AdvPlansPage() {
  return (
    <AdvShell title="Plans">
      <AdvPlansTabs>
        <PlansClient />
      </AdvPlansTabs>
    </AdvShell>
  );
}
