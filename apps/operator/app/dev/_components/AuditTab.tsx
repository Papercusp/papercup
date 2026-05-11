'use client';

import { useEffect, useState } from 'react';

interface Entry {
  id: string;
  ts: number;
  workspace_id: string;
  actor: string | null;
  action: string;
  subject: string | null;
  details: unknown;
}

interface Props {
  workspaceIds: string[] | null;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function AuditTab({ workspaceIds }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);

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
    fetch(`/api/agent-tools/dev/audit?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, hours, limit: 200 }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setEntries(parsed.entries ?? []);
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
  }, [workspaceIds, hours]);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Audit log</h2>
        <label className="pc-dev-muted">
          window
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="pc-dev-input pc-dev-input-inline"
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={168}>7d</option>
            <option value={720}>30d</option>
          </select>
        </label>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <table className="pc-dev-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Workspace</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="pc-dev-muted">{fmtTs(e.ts)}</td>
                <td className="pc-dev-muted">{e.workspace_id}</td>
                <td>{e.actor ?? '—'}</td>
                <td className="pc-dev-slug">{e.action}</td>
                <td>{e.subject ?? '—'}</td>
                <td className="pc-dev-muted pc-dev-details">
                  {e.details ? JSON.stringify(e.details).slice(0, 100) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
