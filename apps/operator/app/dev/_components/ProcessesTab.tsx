'use client';

import { useEffect, useMemo, useState } from 'react';

interface Process {
  pid: number;
  kind: string;
  cmdline: string;
  cwd: string | null;
  started_seconds_ago: number;
  harness_slug: string | null;
  workspace_id: string | null;
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const KIND_ORDER: Record<string, number> = {
  'run.sh': 0,
  omp: 1,
  claude: 2,
  paperclip: 3,
  pty: 4,
  next: 5,
};

const ALL_KINDS = ['run.sh', 'omp', 'claude', 'paperclip', 'pty', 'next'] as const;

export default function ProcessesTab() {
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<string>>(new Set(ALL_KINDS));

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const params = new URLSearchParams({
        workspace: 'default',
        role: 'architect',
        run: 'dev-page',
        spawn: 'dev-page',
      });
      try {
        const r = await fetch(`/api/agent-tools/dev/processes?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setProcesses(parsed.processes ?? []);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(
    () => processes.filter((p) => kinds.has(p.kind)),
    [processes, kinds],
  );

  const byKind = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of processes) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    return counts;
  }, [processes]);

  function toggleKind(k: string) {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKinds(next);
  }

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Processes</h2>
        <span className="pc-dev-muted">
          {filtered.length} of {processes.length} · refreshes every 5s
        </span>
      </header>

      <div className="pc-dev-toggles" style={{ marginBottom: 12 }}>
        {ALL_KINDS.map((k) => (
          <label key={k} className="pc-dev-toggle">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={() => toggleKind(k)}
            />
            <span>
              {k} <span className="pc-dev-muted">{byKind[k] ?? 0}</span>
            </span>
          </label>
        ))}
      </div>

      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <table className="pc-dev-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>Kind</th>
              <th>Age</th>
              <th>Harness</th>
              <th>Workspace</th>
              <th>CWD</th>
              <th>Cmdline</th>
            </tr>
          </thead>
          <tbody>
            {[...filtered]
              .sort(
                (a, b) =>
                  (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
                  a.started_seconds_ago - b.started_seconds_ago,
              )
              .map((p) => (
                <tr key={p.pid}>
                  <td className="pc-dev-muted">{p.pid}</td>
                  <td className="pc-dev-slug">{p.kind}</td>
                  <td className="pc-dev-muted">{fmtAge(p.started_seconds_ago)}</td>
                  <td>{p.harness_slug ?? '—'}</td>
                  <td className="pc-dev-muted">{p.workspace_id ?? '—'}</td>
                  <td className="pc-dev-muted pc-dev-details" title={p.cwd ?? ''}>
                    {p.cwd ?? '—'}
                  </td>
                  <td className="pc-dev-query" title={p.cmdline}>
                    {p.cmdline}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
