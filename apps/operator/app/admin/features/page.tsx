import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';
import AdminShell from '../_components/AdminShell';
import FeaturesAdmin from './FeaturesAdmin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Features · Papercusp' };

export default async function AdminFeaturesPage() {
  await requireFlag(FLAGS.ADMIN);
  return (
    <AdminShell>
      <FeaturesAdmin />
    </AdminShell>
  );
}
