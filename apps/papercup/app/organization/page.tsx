import { OrganizationView, type Department } from '@restart/papercup-shared';

async function fetchDepartments(): Promise<Department[]> {
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/api/org/departments`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return data.departments ?? [];
  } catch {
    return [];
  }
}

export const dynamic = 'force-dynamic';

export default async function OrganizationPage() {
  const departments = await fetchDepartments();
  return <OrganizationView data={{ departments }} basePath="/papercup" />;
}
