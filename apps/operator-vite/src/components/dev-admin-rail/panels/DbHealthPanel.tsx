/**
 * DB health peek (P-007) — pool usage + the currently-running queries, to catch
 * the leaked-lock / idle-in-transaction wedge class before it bites. Reads two
 * sync queries: `dev.pgHealth` (snapshot → data[0]) and `dev.pgActiveQueries`
 * (flat rows, oldest first). Manual refresh re-reads both.
 */
import { useSyncQuery } from '@papercusp/sync';
import { PanelBar, PanelState } from '../panel-kit';

interface PgHealth {
  version: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}
interface PgActiveQuery {
  pid: number;
  state: string | null;
  query: string;
  duration_seconds: number;
  application_name: string | null;
  client_addr: string | null;
}

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}

export default function DbHealthPanel({ active }: { active: boolean }) {
  const health = useSyncQuery<PgHealth>({
    queryName: 'dev.pgHealth',
    enabled: active,
    staleTime: 10_000,
  });
  const queries = useSyncQuery<PgActiveQuery>({
    queryName: 'dev.pgActiveQueries',
    args: { limit: 50 },
    enabled: active,
    staleTime: 10_000,
  });
  const h = health.data?.[0];
  const rows = queries.data ?? [];

  const refresh = () => {
    health.invalidate();
    queries.invalidate();
  };

  return (
    <div className="pc-dev-panel">
      <PanelBar
        label="DB health"
        fetching={health.fetching || queries.fetching}
        onRefresh={refresh}
      />
      <PanelState loading={health.loading && !h} error={health.error ?? queries.error} />
      {h && (
        <div className="pc-dev-kv">
          <span className="pc-dev-kv__k">connections</span>
          <span className="pc-dev-kv__v">
            {h.totalConnections} total · {h.activeConnections} active · {h.idleConnections} idle
          </span>
          <span className="pc-dev-kv__k">version</span>
          <span className="pc-dev-kv__v" title={h.version}>
            {h.version.replace(/^PostgreSQL ([\d.]+).*$/, '$1') || h.version}
          </span>
        </div>
      )}
      <div className="pc-dev-panel__bar" style={{ marginTop: 4 }}>
        <span className="pc-dev-panel__bar-label">Active queries ({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <div className="pc-dev-panel__empty">No active queries.</div>
      ) : (
        rows.map((q) => {
          const idleInTx = q.state === 'idle in transaction';
          const slow = q.duration_seconds > 5;
          return (
            <div key={q.pid} className="pc-dev-row">
              <span
                className={`pc-dev-dot ${idleInTx ? 'is-down' : slow ? '' : 'is-up'}`}
                aria-hidden="true"
              />
              <div className="pc-dev-row__main">
                <div className="pc-dev-row__sub" title={q.query}>
                  {q.query.replace(/\s+/g, ' ').slice(0, 80)}
                </div>
                <div className="pc-dev-row__sub" style={{ fontFamily: 'inherit' }}>
                  pid {q.pid} · {q.state ?? '?'} · {fmtDur(q.duration_seconds)}
                  {q.application_name ? ` · ${q.application_name}` : ''}
                </div>
              </div>
              {idleInTx ? (
                <span className="pc-dev-pill is-bad">idle-in-tx</span>
              ) : slow ? (
                <span className="pc-dev-pill is-warn">slow</span>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
