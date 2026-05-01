import HomeClient from './HomeClient';

export const dynamic = 'force-dynamic';

type Project = {
  slug: string;
  harness_kind?: 'org' | 'department' | 'coding' | string;
  department_slug?: string;
  hasState?: boolean;
};

const OPERATOR = process.env.PAPERCUP_PAPERCUSP_UPSTREAM ?? 'http://localhost:3055';

async function fetchRegistry(): Promise<Project[]> {
  try {
    const r = await fetch(`${OPERATOR}/api/harness/projects`, { cache: 'no-store' });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.projects ?? []) as Project[];
  } catch {
    return [];
  }
}

export default async function PapercupRoot() {
  const all = await fetchRegistry();
  // Show only papercup-* harnesses (the new format). Hide legacy ~/.restart-org
  // entries (slug 'org', 'org-*'). Coding harnesses are not filtered.
  const registry = all.filter((p) =>
    p.harness_kind === 'coding' || p.slug.startsWith('papercup-'),
  );
  const videoId = process.env.NEXT_PUBLIC_FEATURED_VIDEO_ID ?? 'Zasxh_ubQlM';
  return <HomeClient registry={registry} videoId={videoId} />;
}
