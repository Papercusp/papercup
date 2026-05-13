import { redirect } from 'next/navigation';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Papercusp' };

export default async function AdminIndexPage() {
  await requireFlag(FLAGS.ADMIN);
  redirect('/admin/run');
}
