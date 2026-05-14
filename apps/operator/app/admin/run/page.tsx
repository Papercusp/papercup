import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';
import AdminShell from '../_components/AdminShell';
import AdminOps from '../_components/AdminOps';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Run · Papercusp' };

export default async function AdminRunPage() {
  // Admin runs page intentionally NOT flag-gated. Reachable by URL only.
  return (
    <AdminShell title="Run">
      <AdminOps />
    </AdminShell>
  );
}
