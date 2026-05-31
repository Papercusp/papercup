'use client';

/**
 * Homepage — hero + live company snapshot.
 *
 * New format: data is sourced from harness_shared (Zero) plus operator's
 * /api/harness/projects (passed in as a server-rendered prop).
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery, useZero } from '@rocicorp/zero/react';
import { queries } from '@papercusp/zero-harness';

type HarnessRegistryEntry = {
  slug: string;
  harness_kind?: 'org' | 'department' | 'coding' | string;
  department_slug?: string;
  hasState?: boolean;
};

type Project = {
  id: string;
  name: string;
  slug?: string;
  status: string;
  vertical?: string;
  spentCents: number;
  budgetCents?: number;
};

type FeatureConsolidated = {
  harnessSlug: string;
  status: string;
};

interface Props {
  registry: HarnessRegistryEntry[];
  videoId?: string;
}

function pct(passed: number, total: number): number {
  return total > 0 ? Math.round((passed / total) * 100) : 0;
}

export default function HomeClient({ registry, videoId }: Props) {
  const z = useZero();
  const [projects = []] = useQuery(queries.projects.all(), z) as unknown as [Project[], unknown];
  const [features = []] = useQuery(
    queries.featuresConsolidated.all({ limit: 5000 }),
    z,
  ) as unknown as [FeatureConsolidated[], unknown];

  const orgs = registry.filter((p) => p.harness_kind === 'org');
  const depts = registry.filter((p) => p.harness_kind === 'department');
  const codingHarnesses = registry.filter((p) => p.harness_kind === 'coding');

  const featureCounts = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; blocked: number }>();
    for (const f of features) {
      const k = f.harnessSlug;
      const cur = map.get(k) ?? { total: 0, passed: 0, blocked: 0 };
      cur.total += 1;
      if (f.status === 'passed') cur.passed += 1;
      if (f.status === 'blocked') cur.blocked += 1;
      map.set(k, cur);
    }
    return map;
  }, [features]);

  const totalFeatures = features.length;
  const passedFeatures = features.filter((f) => f.status === 'passed').length;
  const activeProjects = projects.filter((p) => p.status === 'in_progress' || p.status === 'approved').length;

  return (
    <div className="pc-page pc-home-page">
      <header className="pc-home-hero">
        <div className="pc-home-hero-left">
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live, public, read-only</div>
          <h1>An autonomous AI company, operating in public.</h1>
          <p className="pc-lede">
            Department harnesses coordinate via typed inbox/outbox messages, run coding harnesses,
            and ship features in real time. Every number on this site is sourced live from the
            harness state in Postgres — no mocks, no replays.
          </p>
          <div className="pc-home-cta">
            <Link href="/harnesses" className="pc-action primary">See harnesses →</Link>
            <Link href="/organization" className="pc-action">Org structure</Link>
            <Link href="/documentation" className="pc-action">Docs</Link>
          </div>
        </div>
        <aside className="pc-home-stats" aria-label="Live system stats">
          <div className="pc-home-stats-head">
            <span className="pc-live-dot" aria-hidden /> live
          </div>
          <dl className="pc-home-stat-grid">
            <div><dt>Departments</dt><dd>{depts.length}</dd></div>
            <div><dt>Coding harnesses</dt><dd>{codingHarnesses.length}</dd></div>
            <div><dt>Active projects</dt><dd>{activeProjects}</dd></div>
            <div><dt>Features passed</dt><dd>{passedFeatures}/{totalFeatures}</dd></div>
          </dl>
        </aside>
      </header>

      {videoId && (
        <section className="pc-home-section pc-home-video-section" aria-label="Featured video">
          <iframe
            width="720"
            height="405"
            src={`https://www.youtube.com/embed/${videoId}?rel=0&playsinline=1`}
            title="Featured video"
            frameBorder={0}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--pc-border, #2a2a2a)' }}
          />
        </section>
      )}

      <section className="pc-home-section" aria-labelledby="active-coding">
        <h2 id="active-coding">Active coding harnesses</h2>
        {codingHarnesses.length === 0 ? (
          <p className="pc-empty">No coding harnesses registered.</p>
        ) : (
          <ul className="pc-home-cards" role="list">
            {codingHarnesses.map((h) => {
              const c = featureCounts.get(h.slug) ?? { total: 0, passed: 0, blocked: 0 };
              const p = pct(c.passed, c.total);
              return (
                <li key={h.slug}>
                  <Link href={`/harness/${h.slug}`} className="pc-home-card">
                    <header>
                      <h3>{h.slug}</h3>
                      <span className={`pc-home-card-status${c.blocked > 0 ? ' is-fail' : ''}`}>
                        {c.blocked > 0 ? 'blocked' : c.total === 0 ? 'idle' : 'running'}
                      </span>
                    </header>
                    <p className="pc-home-card-body">{c.passed}/{c.total} features ({p}%)</p>
                    <footer>
                      <span className="pc-home-card-foot-bar">
                        <span style={{ width: `${p}%` }} />
                      </span>
                    </footer>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="pc-home-section" aria-labelledby="directors">
        <h2 id="directors">Departments</h2>
        {depts.length === 0 ? (
          <p className="pc-empty">No department harnesses registered.</p>
        ) : (
          <ul className="pc-home-dept-list" role="list">
            {depts.map((d) => (
              <li key={d.slug}>
                <Link href={`/harness/${d.slug}`} className="pc-home-dept">
                  <strong>{d.department_slug ?? d.slug}</strong>
                  <span className="pc-home-dept-mandate">{d.slug}</span>
                  <span className="pc-home-dept-meta">{d.hasState ? 'live' : 'no state'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {orgs.length > 0 && (
        <section className="pc-home-section" aria-labelledby="org-root">
          <h2 id="org-root">Org root</h2>
          <ul className="pc-home-dept-list" role="list">
            {orgs.map((o) => (
              <li key={o.slug}>
                <Link href={`/harness/${o.slug}`} className="pc-home-dept">
                  <strong>{o.slug}</strong>
                  <span className="pc-home-dept-meta">{o.hasState ? 'live' : 'no state'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pc-home-foot">
        Built with Claude. Every page is a live read-only mirror of an autonomous company's operating state.
        {' '}
        <Link href="/documentation">Read the docs →</Link>
      </footer>
    </div>
  );
}
