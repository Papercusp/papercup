import { redirect } from 'next/navigation';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Papercusp' };

export default async function AdminIndexPage() {
  // Admin page intentionally NOT flag-gated. Reachable by URL only.
  // (Nav link removed in ChromeShell so users won't discover it.)
  redirect('/admin/run');
}
