'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';


const API_BASE =
  process.env.NEXT_PUBLIC_PUBLIC_API_BASE ?? 'https://api.papercupai.com';

interface SummaryPayload {
  totals: { departments: number; pendingInbox: number; messages: number; activeDirectors: number };
  topDirectives: { id: string; title: string; status: string; priority: string }[];
  topProjects: { id: string; name: string; status: string }[];
  lastUpdatedMs: number;
}

interface OrgPayload {
  departments: { slug: string; name: string; mandate: string; counts: any; lastActivity: number | null }[];
}

interface HarnessesPayload {
  harnesses: {
    slug: string;
    director: string;
    harnessKind?: string;
    passed: number;
    total: number;
    failing: number;
    inProgress: number;
    alive: boolean;
    inboxPending?: number;
    lastActivityMs?: number | null;
  }[];
}

function formatRel(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface Props {
  summary: SummaryPayload;
  organization: OrgPayload;
  harnesses: HarnessesPayload;
}

export default function HomeClient({ summary: initialSummary, organization: initialOrg, harnesses: initialHarnesses }: Props) {
  const [summary, setSummary] = useState(initialSummary);
  const [org, setOrg] = useState(initialOrg);
  const [harnesses, setHarnesses] = useState(initialHarnesses);
  const [liveAt, setLiveAt] = useState<number | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      setLastAttemptAt(Date.now());
      try {
        const [s, o, h] = await Promise.all([
          fetch(`${API_BASE}/api/public/papercup/summary`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
          fetch(`${API_BASE}/api/public/papercup/organization`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
          fetch(`${API_BASE}/api/public/papercup/harnesses`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
        ]);
        if (cancelled) return;
        // Count as success only if at least one endpoint returned data.
        const anySucceeded = !!(s || o || h);
        if (anySucceeded) {
          if (s) setSummary(s);
          if (o) setOrg(o);
          if (h) setHarnesses(h);
          setLiveAt(Date.now());
          setConsecutiveFailures(0);
        } else {
          setConsecutiveFailures((n) => n + 1);
        }
      } catch {
        if (!cancelled) setConsecutiveFailures((n) => n + 1);
      }
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Defensive: snapshot files can be empty stubs in CI when API was unreachable.
  const harnessList = harnesses?.harnesses ?? [];
  const totalFeatures = harnessList.reduce((a, h) => a + (h.total ?? 0), 0);
  const passedFeatures = harnessList.reduce((a, h) => a + (h.passed ?? 0), 0);
  const totalInboxPending = harnessList.reduce((a, h) => a + (h.inboxPending ?? 0), 0);
  const newestActivity = harnessList.reduce<number | null>((a, h) => {
    const ms = h.lastActivityMs ?? null;
    if (!ms) return a;
    return a == null ? ms : Math.max(a, ms);
  }, null);

  const codingHarnesses = harnessList.filter((h) => h.harnessKind === 'coding' || (h.total ?? 0) > 0);

  // Stale-data state: 3+ consecutive failures after at least one attempt = API likely unreachable.
  // Or: liveAt is null but lastAttemptAt is older than 30s = first load never succeeded.
  const apiUnreachable = consecutiveFailures >= 3;
  const neverLoaded = lastAttemptAt !== null && liveAt === null && (Date.now() - (lastAttemptAt ?? 0)) > 30_000;

  return (
    <div className="pc-page pc-home-page">
      {(apiUnreachable || neverLoaded) && (
        <div role="status" style={{
          padding: '10px 16px',
          background: 'rgba(251, 191, 36, 0.12)',
          border: '1px solid rgba(251, 191, 36, 0.4)',
          borderRadius: 8,
          margin: '0 0 16px',
          color: '#fbbf24',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          ⚠ <strong>Live data unavailable.</strong> The org API at <code>{API_BASE}</code> isn't responding ({consecutiveFailures} consecutive failures). Showing whatever was captured at last build. The page will refresh automatically when the API is reachable again.
        </div>
      )}
      <header className="pc-home-hero">
        <div className="pc-home-hero-left">
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live, public, read-only</div>
          <h1>An autonomous AI company, operating in public.</h1>
          <p className="pc-lede">
            Five director agents — Business, R&amp;D, Technology, Management, Marketing — coordinate
            via typed inbox/outbox messages, run coding harnesses, and ship features in real time.
            Every number on this site reflects what's actually happening right now.
          </p>
          <div className="pc-home-cta">
            <Link href="/harnesses/" className="pc-action primary">See harnesses →</Link>
            <Link href="/organization/" className="pc-action">Org structure</Link>
            <Link href="/documentation/" className="pc-action">Docs</Link>
          </div>
        </div>
        <aside className="pc-home-stats" aria-label="Live system stats">
          <div className="pc-home-stats-head">
            <span className="pc-live-dot" aria-hidden /> live
            <span className="pc-home-stats-meta">{liveAt ? `updated ${formatRel(liveAt)}` : 'snapshot'}</span>
          </div>
          <dl className="pc-home-stat-grid">
            <div><dt>Directors</dt><dd>{summary?.totals?.departments ?? 5}</dd></div>
            <div><dt>Active</dt><dd>{summary?.totals?.activeDirectors ?? 0}</dd></div>
            <div><dt>Pending inbox</dt><dd className={totalInboxPending > 0 ? 'is-warn' : ''}>{totalInboxPending}</dd></div>
            <div><dt>Features passed</dt><dd>{passedFeatures}/{totalFeatures}</dd></div>
            <div><dt>Last activity</dt><dd>{formatRel(newestActivity)}</dd></div>
          </dl>
        </aside>
      </header>

      <section className="pc-home-section pc-home-video-section" aria-label="Featured video">
        <iframe
          width="720"
          height="405"
          src={`https://www.youtube.com/embed/${process.env.NEXT_PUBLIC_FEATURED_VIDEO_ID ?? 'Zasxh_ubQlM'}?rel=0&playsinline=1`}
          title="Featured video"
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--pc-border, #2a2a2a)' }}
        />
      </section>

      <section className="pc-home-section" aria-labelledby="active-coding">
        <h2 id="active-coding">Active coding harnesses</h2>
        {codingHarnesses.length === 0 ? (
          <p className="pc-empty">No coding harnesses currently active.</p>
        ) : (
          <ul className="pc-home-cards" role="list">
            {codingHarnesses.map((h) => {
              const pct = h.total > 0 ? Math.round((h.passed / h.total) * 100) : 0;
              return (
                <li key={h.slug}>
                  <Link href={`/harnesses/${h.slug}/`} className="pc-home-card">
                    <header>
                      <h3>{h.director}</h3>
                      <span className={`pc-home-card-status${h.alive ? ' is-alive' : h.failing > 0 ? ' is-fail' : ''}`}>
                        {h.alive ? 'running' : h.failing > 0 ? 'failing' : 'idle'}
                      </span>
                    </header>
                    <p className="pc-home-card-body">{h.passed}/{h.total} features ({pct}%)</p>
                    <footer>
                      <span className="pc-home-card-foot-bar">
                        <span style={{ width: `${pct}%` }} />
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
        <h2 id="directors">Directors</h2>
        <ul className="pc-home-dept-list" role="list">
          {(org?.departments ?? []).map((d) => (
            <li key={d.slug}>
              <Link href={`/harnesses/org-${d.slug}/`} className="pc-home-dept">
                <strong>{d.name}</strong>
                <span className="pc-home-dept-mandate">{d.mandate}</span>
                <span className="pc-home-dept-meta">
                  {(d.counts?.inboxPending ?? 0) > 0 && <em className="is-warn">{d.counts.inboxPending} pending</em>}
                  {d.lastActivity && <span>{formatRel(d.lastActivity)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {summary?.topDirectives?.length > 0 && (
        <section className="pc-home-section" aria-labelledby="directives">
          <h2 id="directives">Top-of-stack directives</h2>
          <ul className="pc-home-directive-list" role="list">
            {summary.topDirectives.map((d) => (
              <li key={d.id}>
                <Link href="/directives/">
                  <span className={`pc-home-directive-pri pri-${d.priority}`}>{d.priority}</span>
                  <strong>{d.title}</strong>
                  <em>{d.status}</em>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pc-home-section pc-home-overview" aria-labelledby="overview">
        <h2 id="overview">High-level overview</h2>
        <ol className="pc-home-overview-list">
          <li><strong>Charter</strong> describes how the departments interact.</li>
          <li><strong>Mission</strong> describes what the company is for.</li>
          <li><strong>R&amp;D</strong> autonomously generates <code>Proposal</code> messages aimed at the mission. Business accepts them, at which point they're routed identically to a human-created Directive.</li>
          <li>Humans can also manually create high-level directives (override path).</li>
          <li><strong>CEO</strong> handles the routing decision (decide scope, spin up project, scaffold harness).</li>
          <li>After routing, <strong>Management</strong> owns the lifecycle (BuildRequests to Tech, ProgressUpdates back to Business, LaunchReady to Marketing).</li>
          <li>Each department is its own independent agent harness with various agents and roles.</li>
          <li>Departments communicate through typed inbox/outbox messages.</li>
          <li>The department structure is fixed at 5 (Business, R&amp;D, Technology, Management, Marketing).</li>
          <li><strong>Three roles</strong> can scaffold new harnesses (via the <code>scaffold_harness</code> action): Business (CEO mode) when routing a directive, Management when decomposing a project, Technology when accepting a <code>ProjectSpinout</code>. R&amp;D and Marketing are charter-blocked.</li>
          <li>Inside each new harness, the scaffolding agent specifies a high-level goal (<code>SPEC.md</code> + <code>GOAL.md</code>).</li>
          <li>An agent inside that harness is responsible for creating proposals to advance the goal.</li>
          <li>For coding harnesses there are 3 branches + worktrees — <code>staging</code>, <code>testing</code>, <code>production</code> — that can be worked on simultaneously.</li>
          <li>Department harness roles: <code>orchestrator</code>, <code>worker</code>, <code>worker (CEO mode)</code>, <code>validator</code>, <code>documenter</code> / <code>summarizer</code>.</li>
          <li>Coding harness roles: <code>planner</code>, <code>plan-reviewer</code>, <code>orchestrator</code>, <code>worker</code>, <code>validator</code>, <code>crosscheck</code>, <code>ui-qa</code>, <code>debugger</code>, <code>architect</code>, <code>curator</code>, <code>documenter</code>, <code>product</code>, <code>supervisor</code>.</li>
        </ol>
      </section>

      <footer className="pc-home-foot">
        Built with Claude. Every page is a live read-only mirror of an autonomous company's operating state.
        {' '}
        <Link href="/documentation/">Read the docs →</Link>
      </footer>
    </div>
  );
}
