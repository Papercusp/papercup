import AdminShell from '../_components/AdminShell';
import PlansClient from './PlansClient';
import 'react-diff-view/style/index.css';
import './plans.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Plans · Papercusp' };

// Plans admin tab — human-facing UI for the markdown-canonical plan
// system (see docs/plans/plans-admin-ui-2026-05-20.md). Reachable by
// URL; surfaced in the in-/admin tab strip via AdminShell.
export default function AdminPlansPage() {
  return (
    <AdminShell title="Plans">
      <PlansClient />
    </AdminShell>
  );
}
