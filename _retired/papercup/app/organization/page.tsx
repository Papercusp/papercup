/**
 * /organization — list of department harnesses.
 *
 * In the new format, departments are themselves harnesses (kind='department').
 * This page reads the harness registry from operator's /api/harness/projects
 * (the only source of truth for harness kind metadata) and renders department
 * harnesses linking to /harness/<slug>.
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

export default async function OrganizationPage() {
  const all = await fetchHarnesses();
  // Show only papercup-* harnesses (the new format). Hide legacy ~/.restart-org
  // entries (slug 'org', 'org-*'). The migration plan converged on those.
  const newFormat = all.filter((p) => p.slug.startsWith('papercup-'));

  const orgs = newFormat.filter((p) => p.harness_kind === 'org');
  const depts = newFormat.filter((p) => p.harness_kind === 'department');

  return (
    <div className="pc-page pc-organization-page pc-view-readonly">
      <header className="pc-hero" aria-labelledby="org-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Org harness graph</div>
          <h1 id="org-title">Departments, mandates, and message contracts.</h1>
          <p className="pc-lede">
            Every department is its own harness. The org-root harness coordinates them; each
            department harness owns its inbox, outbox, charter, and director config.
          </p>
        </div>
      </header>

      {orgs.length > 0 && (
        <section className="pc-org-section" aria-labelledby="org-roots">
          <h2 id="org-roots">Org root</h2>
          <ul className="pc-org-cards" role="list">
            {orgs.map((p) => (
              <li key={p.slug}>
                <Link href={`/harness/${p.slug}`} className="pc-org-card">
                  <strong>{p.slug}</strong>
                  <span className="pc-org-card-meta">
                    {p.hasState ? 'live' : 'no state'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pc-org-section" aria-labelledby="depts">
        <h2 id="depts">Departments</h2>
        {depts.length === 0 ? (
          <p className="pc-empty">No department harnesses registered.</p>
        ) : (
          <ul className="pc-org-cards" role="list">
            {depts.map((p) => (
              <li key={p.slug}>
                <Link href={`/harness/${p.slug}`} className="pc-org-card">
                  <strong>{p.department_slug ?? p.slug}</strong>
                  <span className="pc-org-card-slug">{p.slug}</span>
                  <span className="pc-org-card-meta">
                    {p.hasState ? 'live' : 'no state'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
