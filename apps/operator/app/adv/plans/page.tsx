import PlansClient from '../../admin/plans/PlansClient';
import 'react-diff-view/style/index.css';
import '../../admin/plans/plans.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Advanced · Plans · Papercusp' };

// Plans surface, relocated from the hidden /admin/plans (Batch B of
// plans-admin-ui continuation). Reuses the existing PlansClient and
// sibling components in app/admin/plans/ unchanged — the inner-tab
// refactor (clicking a plan opens it as a new tab; search submission
// focuses a Search tab) ships in B.2.
export default function AdvPlansPage() {
  return <PlansClient />;
}
