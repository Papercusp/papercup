'use client';

import { useEffect, useState } from 'react';

interface HarnessRow {
  slug: string;
  path: string;
  workspaceId: string;
  workspaceName: string;
  harness_kind?: string;
  health?: {
    ok: boolean;
    alive: boolean;
    escalated: boolean;
    features: { total: number; passed: number; failing: number; inProgress: number; blocked: number };
    lastRunAgeSeconds: number | null;
    ghostRate: number;
  } | null;
  healthError?: string;
}

interface Props {
  workspaceIds: string[] | null;
}

function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function HarnessesTab({ workspaceIds }: Props) {
  const [rows, setRows] = useState<HarnessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      workspace: 'default',
      role: 'architect',
      run: 'dev-page',
      spawn: 'dev-page',
    });
    fetch(`/api/agent-tools/dev/harnesses?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const text = d?.content?.[0]?.text;
        const parsed = JSON.parse(text);
        if (cancelled) return;
        setRows(parsed.harnesses ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceIds]);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Harnesses</h2>
        <span className="pc-dev-muted">{rows.length} across selected workspaces</span>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <table className="pc-dev-table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Workspace</th>
              <th>Kind</th>
              <th>Alive</th>
              <th>Esc</th>
              <th>Total</th>
              <th>Passed</th>
              <th>Failing</th>
              <th>In progress</th>
              <th>Blocked</th>
              <th>Last run</th>
              <th>Ghost</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const h = r.health;
              return (
                <tr key={`${r.workspaceId}::${r.slug}`}>
                  <td>
                    <a href={`/harness/${r.slug}`} className="pc-dev-slug">
                      {r.slug}
                    </a>
                  </td>
                  <td className="pc-dev-muted">{r.workspaceName}</td>
                  <td className="pc-dev-muted">{r.harness_kind ?? '—'}</td>
                  <td>{h ? (h.alive ? <span className="pc-dev-ok">●</span> : <span className="pc-dev-muted">○</span>) : '—'}</td>
                  <td>{h?.escalated ? <span className="pc-dev-api-err">!</span> : ''}</td>
                  <td>{h?.features.total ?? '—'}</td>
                  <td>{h?.features.passed ?? '—'}</td>
                  <td className={h?.features.failing ? 'pc-dev-api-err' : ''}>
                    {h?.features.failing ?? '—'}
                  </td>
                  <td>{h?.features.inProgress ?? '—'}</td>
                  <td>{h?.features.blocked ?? '—'}</td>
                  <td className="pc-dev-muted">{fmtAge(h?.lastRunAgeSeconds)}</td>
                  <td className="pc-dev-muted">
                    {h?.ghostRate == null ? '—' : `${(h.ghostRate * 100).toFixed(0)}%`}
                  </td>
                  <td>
                    {!h ? <span className="pc-dev-muted">{r.healthError ?? '—'}</span> : h.ok ? (
                      <span className="pc-dev-ok">OK</span>
                    ) : (
                      <span className="pc-dev-api-err">FAIL</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
