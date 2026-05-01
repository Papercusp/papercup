'use client';

/**
 * /projects — public read-only portfolio.
 *
 * Reads `harness_shared.projects` directly via Zero (no /api/org polling).
 * Each project links to its harness console at /harness/<slug> when slug is set.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery, useZero } from '@rocicorp/zero/react';
import { queries } from '@restart/zero-harness';

export const dynamic = 'force-dynamic';

type Project = {
  id: string;
  name: string;
  status: string;
  slug?: string;
  budgetCents?: number;
  spentCents: number;
  costCapCents?: number;
  earnedCents: number;
  owningDept?: string;
  vertical?: string;
  createdTs: number;
  updatedTs: number;
};

function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function statusClass(s: string): string {
  return s.replace(/_/g, '-');
}

export default function ProjectsPage() {
  const z = useZero();
  const [projects = [], info] = useQuery(queries.projects.all(), z) as unknown as [Project[], { type: string }];

  const grouped = useMemo(() => projects.reduce<Record<string, Project[]>>((acc, p) => {
    const key = p.vertical ?? 'unsorted';
    (acc[key] ??= []).push(p);
    return acc;
  }, {}), [projects]);
  const verticals = Object.keys(grouped).sort();

  const totals = useMemo(() => ({
    budget: projects.reduce((sum, p) => sum + (p.budgetCents ?? 0), 0),
    spent: projects.reduce((sum, p) => sum + p.spentCents, 0),
    proposed: projects.filter((p) => p.status === 'proposed').length,
    active: projects.filter((p) => p.status === 'approved' || p.status === 'in_progress').length,
    launched: projects.filter((p) => p.status === 'launched').length,
  }), [projects]);

  const loaded = info?.type === 'complete' || projects.length > 0;

  return (
    <div className="pc-page pc-projects-page pc-view-readonly">
      <header className="pc-hero" aria-labelledby="projects-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live project portfolio</div>
          <h1 id="projects-title">Execution units grouped by vertical, budget, and operating state.</h1>
          <p className="pc-lede">
            Projects are owned by Management and tagged by vertical. Shared Technology produces capabilities
            that any project can consume, so every new build compounds the platform.
          </p>
        </div>
        <aside className="pc-hero-panel" aria-label="Project portfolio summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>projects</span><strong>{projects.length}</strong></div>
            <div className="pc-metric good"><span>verticals</span><strong>{verticals.length}</strong></div>
            <div className="pc-metric"><span>budget</span><strong>{money(totals.budget)}</strong></div>
            <div className="pc-metric warn"><span>spent</span><strong>{money(totals.spent)}</strong></div>
          </div>
          <div className="pc-flow-note">
            {loaded
              ? `${totals.active} active project${totals.active === 1 ? '' : 's'} and ${totals.proposed} proposed bet${totals.proposed === 1 ? '' : 's'} across ${verticals.length} vertical${verticals.length === 1 ? '' : 's'}.`
              : 'Loading live project state…'}
          </div>
        </aside>
      </header>

      {projects.length === 0 ? (
        <p className="pc-empty">No projects yet.</p>
      ) : (
        <div className="pc-projects-grid">
          {verticals.map((vert) => (
            <section key={vert} className="pc-projects-vertical">
              <h2 className="pc-projects-vertical-title">{vert}</h2>
              <ul className="pc-projects-list" role="list">
                {grouped[vert].map((p) => {
                  const pct = (p.budgetCents ?? 0) > 0
                    ? Math.min(100, Math.round((p.spentCents / (p.budgetCents ?? 1)) * 100))
                    : 0;
                  const inner = (
                    <>
                      <header>
                        <strong>{p.name}</strong>
                        <span className={`pc-project-status status-${statusClass(p.status)}`}>{p.status.replace(/_/g, ' ')}</span>
                      </header>
                      <div className="pc-project-budget">
                        <span>{money(p.spentCents)} / {money(p.budgetCents ?? 0)}</span>
                        <div className="pc-project-bar"><span style={{ width: `${pct}%` }} /></div>
                      </div>
                      {p.owningDept && <div className="pc-project-meta">owned by {p.owningDept}</div>}
                    </>
                  );
                  return (
                    <li key={p.id} className="pc-project-card">
                      {p.slug ? <Link href={`/harness/${p.slug}`}>{inner}</Link> : inner}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
