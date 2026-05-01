/**
 * /harnesses — public read-only list of all harnesses.
 *
 * On the operator (admin) site this slot embeds HarnessDashboard. On the
 * public site we don't want operator dependencies pulled in and rendered,
 * so we render a simple linked list driven by the same /api/harness/projects
 * registry used by the homepage.
 */

import Link from 'next/link';

export const dynamic = 'force-dynamic';

type Project = {
  slug: string;
  path: string;
  harness_kind?: 'org' | 'department' | 'coding' | string;
  department_slug?: string;
  hasState?: boolean;
};

async function fetchHarnesses(): Promise<Project[]> {
  const operator = process.env.PAPERCUP_PAPERCUSP_UPSTREAM ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${operator}/api/harness/projects`, { cache: 'no-store' });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.projects ?? []) as Project[];
  } catch {
    return [];
  }
}

function group(projects: Project[]): { kind: string; items: Project[] }[] {
  const buckets = new Map<string, Project[]>();
  for (const p of projects) {
    const k = p.harness_kind ?? 'other';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  const order = ['org', 'department', 'coding', 'other'];
  return order
    .filter((k) => buckets.has(k))
    .map((k) => ({ kind: k, items: buckets.get(k)! }));
}

export default async function HarnessesPage() {
  const all = await fetchHarnesses();
  const visible = all.filter((p) => p.harness_kind === 'coding' || p.slug.startsWith('papercup-'));
  const groups = group(visible);

  return (
    <div className="pc-page">
      <header className="pc-home-hero">
        <div className="pc-home-hero-left">
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live, public, read-only</div>
          <h1>Harnesses</h1>
          <p className="pc-lede">
            Every harness in the company. Department harnesses (kind=department) coordinate
            via inbox/outbox messages. Coding harnesses (kind=coding) ship features. Org
            harnesses (kind=org) are the org root.
          </p>
        </div>
      </header>

      {groups.length === 0 ? (
        <p className="pc-empty">No harnesses registered.</p>
      ) : (
        groups.map(({ kind, items }) => (
          <section key={kind} className="pc-home-section" aria-label={`${kind} harnesses`}>
            <h2>{kind === 'org' ? 'Org root' : kind === 'department' ? 'Departments' : kind === 'coding' ? 'Coding harnesses' : kind}</h2>
            <ul className="pc-home-dept-list" role="list">
              {items.map((h) => (
                <li key={h.slug}>
                  <Link href={`/harness/${h.slug}`} className="pc-home-dept">
                    <strong>{h.department_slug ?? h.slug}</strong>
                    <span className="pc-home-dept-mandate">{h.slug}</span>
                    <span className="pc-home-dept-meta">{h.hasState ? 'live' : 'no state'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
