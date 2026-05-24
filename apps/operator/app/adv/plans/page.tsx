import PlansClient from '../../admin/plans/PlansClient';
import AdvPlansTabs from './AdvPlansTabs';
import 'react-diff-view/style/index.css';
import '../../admin/plans/plans.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Advanced · Plans · Papercusp' };

// Plans surface, relocated from the hidden /admin/plans (Batch B of
// plans-admin-ui continuation). PlansClient comes over unchanged from
// app/admin/plans/; AdvPlansTabs wraps it with a VSCode-style tab
// strip that observes (slug, q) for the active highlight and persists
// the open-plan stack via `?tabs=` so reloads restore it.
export default function AdvPlansPage() {
  return (
    <AdvPlansTabs>
      <PlansClient />
    </AdvPlansTabs>
  );
}
