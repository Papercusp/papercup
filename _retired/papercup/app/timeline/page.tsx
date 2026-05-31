'use client';

/**
 * /timeline — cross-harness audit log feed.
 *
 * Reads `harness_shared.audit_log` via Zero. Every harness emits actor/action/subject
 * events here, so this is the canonical "what's happening across the company" surface.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useZero } from '@rocicorp/zero/react';
import { queries } from '@papercusp/zero-harness';

export const dynamic = 'force-dynamic';

type AuditRow = {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  details?: Record<string, unknown> | null;
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function TimelinePage() {
  const z = useZero();
  const [rows = []] = useQuery(queries.auditLog.recent({ limit: 200 }), z) as unknown as [AuditRow[], unknown];

  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');

  const actors = useMemo(() => Array.from(new Set(rows.map((r) => r.actor))).sort(), [rows]);
  const actions = useMemo(() => Array.from(new Set(rows.map((r) => r.action))).sort(), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (actor && r.actor !== actor) return false;
    if (action && r.action !== action) return false;
    if (q && !`${r.subject} ${r.action} ${r.actor}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, actor, action, q]);

  return (
    <div className="pc-page pc-timeline-page pc-view-readonly">
      <header className="pc-hero" aria-labelledby="timeline-title">
        <div>
          <div className="pc-eyebrow"><span className="pc-eyebrow-dot" /> Live activity feed</div>
          <h1 id="timeline-title">Timeline makes every company handoff inspectable.</h1>
          <p className="pc-lede">
            A chronological view of what every harness is doing — directives accepted, projects spun up,
            features moved through the queue. Every line is sourced from the harness audit log.
          </p>
        </div>
        <aside className="pc-hero-panel" aria-label="Timeline summary">
          <div className="pc-metric-grid">
            <div className="pc-metric accent"><span>events</span><strong>{rows.length}</strong></div>
            <div className="pc-metric good"><span>visible</span><strong>{filtered.length}</strong></div>
            <div className="pc-metric"><span>actors</span><strong>{actors.length}</strong></div>
            <div className="pc-metric warn"><span>actions</span><strong>{actions.length}</strong></div>
          </div>
        </aside>
      </header>

      <section className="pc-filters" aria-label="Filter timeline">
        <label>
          <span>Search</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="match subject, action, actor…"
          />
        </label>
        <label>
          <span>Actor</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">all actors</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>
          <span>Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">all actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </section>

      {filtered.length === 0 ? (
        <p className="pc-empty">No events match.</p>
      ) : (
        <ol className="pc-timeline-list" role="list">
          {filtered.map((r) => (
            <li key={r.id} className="pc-timeline-row">
              <time>{relativeTime(r.ts)}</time>
              <span className="pc-timeline-actor">{r.actor}</span>
              <span className="pc-timeline-action">{r.action}</span>
              <span className="pc-timeline-subject">{r.subject}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
