'use client';

import { useEffect, useState } from 'react';

interface Entry {
  tool_name: string;
  call_count: number;
  error_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  workspaces: string[];
}

import type { RerunContext } from '../page';

interface Props {
  workspaceIds: string[] | null;
  onRerun: (ctx: RerunContext) => void;
}

export default function TelemetryTab({ workspaceIds, onRerun }: Props) {
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
    fetch(`/api/agent-tools/dev/telemetry?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, hours, limit: 100 }),
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
        <h2>Telemetry</h2>
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
            <option value={72}>3d</option>
            <option value={168}>7d</option>
          </select>
        </label>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <table className="pc-dev-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Calls</th>
              <th>Errors</th>
              <th>Err %</th>
              <th>p50</th>
              <th>p95</th>
              <th>Workspaces</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const errPct = e.call_count > 0 ? (e.error_count / e.call_count) * 100 : 0;
              return (
                <tr key={e.tool_name}>
                  <td className="pc-dev-slug">{e.tool_name}</td>
                  <td>{e.call_count}</td>
                  <td className={e.error_count ? 'pc-dev-api-err' : ''}>{e.error_count}</td>
                  <td className={errPct > 10 ? 'pc-dev-api-err' : 'pc-dev-muted'}>
                    {errPct.toFixed(0)}%
                  </td>
                  <td className="pc-dev-muted">{e.p50_ms ?? '—'}ms</td>
                  <td className="pc-dev-muted">{e.p95_ms ?? '—'}ms</td>
                  <td className="pc-dev-muted">{e.workspaces.join(', ')}</td>
                  <td>
                    <button
                      type="button"
                      className="pc-dev-btn-mini"
                      title="Open in API tab with this tool selected"
                      onClick={() =>
                        onRerun({
                          toolName: e.tool_name,
                          workspace: e.workspaces[0],
                        })
                      }
                    >
                      ↗
                    </button>
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
