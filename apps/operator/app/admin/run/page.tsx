import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';
import AdminShell from '../_components/AdminShell';
import AdminOps from '../_components/AdminOps';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Run · Papercusp' };

export default async function AdminRunPage() {
  await requireFlag(FLAGS.ADMIN);
  return (
    <AdminShell>
      <AdminOps />
    </AdminShell>
  );
}
