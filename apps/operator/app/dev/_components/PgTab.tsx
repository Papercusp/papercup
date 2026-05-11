'use client';

import { useEffect, useState } from 'react';

interface Health {
  version: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}

interface Query {
  pid: number;
  state: string | null;
  query: string;
  duration_seconds: number;
  application_name: string | null;
  client_addr: string | null;
}

interface Table {
  schema: string;
  table: string;
  total_bytes: number;
  index_bytes: number;
  rows_estimate: number | null;
}

const CTX_PARAMS = new URLSearchParams({
  workspace: 'default',
  role: 'architect',
  run: 'dev-page',
  spawn: 'dev-page',
});

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function fmtDuration(s: number): string {
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h`;
}

async function postTool<T>(name: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/agent-tools/dev/${name}?${CTX_PARAMS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return JSON.parse(d.content[0].text);
}

export default function PgTab() {
  const [health, setHealth] = useState<Health | null>(null);
  const [queries, setQueries] = useState<Query[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [h, q, t] = await Promise.all([
          postTool<Health>('pg_health', {}),
          postTool<{ queries: Query[] }>('pg_active_queries', { limit: 50 }),
          postTool<{ tables: Table[] }>('pg_table_sizes', { limit: 25 }),
        ]);
        if (cancelled) return;
        setHealth(h);
        setQueries(q.queries);
        setTables(t.tables);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>PostgreSQL</h2>
        <span className="pc-dev-muted">{health?.version.split(' on ')[0] ?? '…'}</span>
      </header>

      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}

      {!loading && !error && health && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Connections</h3>
          <div className="pc-dev-rail-stats">
            <div>
              <span className="pc-dev-muted">total</span>
              <strong>{health.totalConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">active</span>
              <strong>{health.activeConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">idle</span>
              <strong className="pc-dev-muted">{health.idleConnections}</strong>
            </div>
          </div>
        </section>
      )}

      {!loading && !error && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Active queries ({queries.length})</h3>
          <table className="pc-dev-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>State</th>
                <th>Duration</th>
                <th>App</th>
                <th>Query</th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => (
                <tr key={q.pid}>
                  <td className="pc-dev-muted">{q.pid}</td>
                  <td className={q.state === 'active' ? 'pc-dev-ok' : 'pc-dev-muted'}>
                    {q.state}
                  </td>
                  <td className="pc-dev-muted">{fmtDuration(q.duration_seconds)}</td>
                  <td className="pc-dev-muted">{q.application_name || '—'}</td>
                  <td className="pc-dev-query" title={q.query}>
                    {q.query.replace(/\s+/g, ' ').slice(0, 120)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!loading && !error && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Largest tables (harness_shared)</h3>
          <table className="pc-dev-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Total</th>
                <th>Indexes</th>
                <th>Rows (est.)</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={`${t.schema}.${t.table}`}>
                  <td className="pc-dev-slug">{t.table}</td>
                  <td>{fmtBytes(t.total_bytes)}</td>
                  <td className="pc-dev-muted">{fmtBytes(t.index_bytes)}</td>
                  <td className="pc-dev-muted">
                    {t.rows_estimate?.toLocaleString() ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
