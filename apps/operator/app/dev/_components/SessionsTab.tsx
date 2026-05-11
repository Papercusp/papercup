'use client';

import { useEffect, useState } from 'react';

interface Entry {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  harness_slug: string | null;
  role: string | null;
  run_id: string | null;
  started_at: string;
  ended_at: string;
  tool_count: number;
  error_count: number;
  total_duration_ms: number;
}

interface Props {
  workspaceIds: string[] | null;
}

function fmtRelTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export default function SessionsTab({ workspaceIds }: Props) {
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
    fetch(`/api/agent-tools/dev/sessions?${params}`, {
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
        <h2>Sessions</h2>
        <span className="pc-dev-muted">{entries.length} spawns</span>
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
              <th>Spawn</th>
              <th>Started</th>
              <th>Workspace</th>
              <th>Harness</th>
              <th>Role</th>
              <th>Tools</th>
              <th>Errors</th>
              <th>Duration</th>
              <th>Parent</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.spawn_id}>
                <td className="pc-dev-slug" title={e.spawn_id}>
                  {e.spawn_id.slice(0, 12)}…
                </td>
                <td className="pc-dev-muted" title={e.started_at}>
                  {fmtRelTime(e.started_at)}
                </td>
                <td className="pc-dev-muted">{e.workspace_id}</td>
                <td>{e.harness_slug ?? '—'}</td>
                <td className="pc-dev-muted">{e.role ?? '—'}</td>
                <td>{e.tool_count}</td>
                <td className={e.error_count ? 'pc-dev-api-err' : ''}>
                  {e.error_count > 0 ? e.error_count : ''}
                </td>
                <td className="pc-dev-muted">{fmtDuration(e.total_duration_ms)}</td>
                <td className="pc-dev-muted" title={e.parent_spawn_id ?? ''}>
                  {e.parent_spawn_id ? `${e.parent_spawn_id.slice(0, 8)}…` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
