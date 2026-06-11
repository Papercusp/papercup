'use client';

/**
 * Cross-harness KPI dashboard. Reads /api/harness/all/kpis and surfaces
 * the substrate-level metrics: project totals, message volume, audit-log
 * breakdown, autoLoop health, parent → child relationships.
 *
 * No mutations on this page — it's a read-only operational view of the
 * multi-harness substrate. Refresh button or 30s auto-refresh.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

type AutoLoopFire = KPIs['autoloop']['recent_fires'][number];

interface KPIs {
  totals: {
    harnesses: number;
    projects: number;
    projects_by_status: Record<string, number>;
    messages_24h: number;
    executed_actions_24h: number;
  };
  parents: { slug: string; children_count: number }[];
  directives: { open: number; acknowledged: number };
  audit: { actions_24h_by_op: Record<string, number> };
  autoloop: {
    active: number;
    recent_fires: {
      harness_slug: string;
      role: string;
      last_fired_at: string;
      last_status: string | null;
      consecutive_errors: number;
    }[];
  };
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function AutoLoopGrid({ fires }: { fires: AutoLoopFire[] }) {
  const columns: ColumnDef<AutoLoopFire>[] = useMemo(() => [
    { key: 'harness', header: 'Harness', width: 2, render: ({ row }) => <span style={{ fontFamily: 'monospace' }}>{row.harness_slug}</span> },
    { key: 'role', header: 'Role', width: 1, render: ({ row }) => <>{row.role}</> },
    { key: 'fired', header: 'Last fired', width: 1, render: ({ row }) => <>{formatRel(row.last_fired_at)}</> },
    {
      key: 'status',
      header: 'Status',
      width: 1,
      render: ({ row }) => (
        <span className={`pc-kpi-autoloop-status ${row.last_status === 'ok' ? 'ok' : row.last_status?.startsWith('error') ? 'error' : 'unknown'}`} style={{ color: row.last_status === 'ok' ? 'lightgreen' : row.last_status?.startsWith('error') ? 'tomato' : 'var(--fg-mute)' }}>
          {row.last_status ?? '—'}
        </span>
      ),
    },
    {
      key: 'errs',
      header: 'Consec errs',
      width: 0.8,
      align: 'right',
      render: ({ row }) => (
        <span className={row.consecutive_errors > 0 ? 'pc-kpi-error-count active' : 'pc-kpi-error-count'} style={{ color: row.consecutive_errors > 0 ? 'tomato' : 'inherit' }}>{row.consecutive_errors}</span>
      ),
    },
  ], []);

  return (
    <div className="pc-kpi-autoloop-grid">
      <RichGrid<AutoLoopFire>
        columns={columns}
        rows={fires}
        getRowId={(f) => `${f.harness_slug}:${f.role}`}
        inline
      />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="pc-kpi-stat-card" style={{
      padding: 16,
      borderRadius: 8,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div className="pc-kpi-stat-label" style={{ fontSize: 12, color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div className="pc-kpi-stat-value" style={{ fontSize: 32, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div className="pc-kpi-stat-sub" style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="pc-kpi-bar-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
      <div className="pc-kpi-bar-label" style={{ width: 180, fontSize: 13 }}>{label}</div>
      <div className="pc-kpi-bar-track" style={{ flex: 1, height: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 4, position: 'relative' }}>
        <div className="pc-kpi-bar-fill" style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--accent)',
          borderRadius: 4,
        }} />
      </div>
      <div className="pc-kpi-bar-value" style={{ width: 60, textAlign: 'right', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

export default function KPIsPage() {
  const [data, setData] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/harness/all/kpis', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as KPIs;
      setData(j);
      setLastFetched(Date.now());
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Documented polling exception (audit P-058): cross-harness KPI
    // aggregate endpoint with no sync queryName. 30s while visible;
    // paused when hidden.
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (loading && !data) {
    return <div className="pc-installed-ops-shell pc-kpi-shell pc-kpi-loading" style={{ padding: 32 }}>Loading KPIs…</div>;
  }
  if (error && !data) {
    return <div className="pc-installed-ops-shell pc-kpi-shell pc-kpi-error" style={{ padding: 32, color: 'tomato' }}>Failed to load: {error}</div>;
  }
  if (!data) return null;

  const opEntries = Object.entries(data.audit.actions_24h_by_op).sort((a, b) => b[1] - a[1]);
  const opMax = opEntries.length > 0 ? opEntries[0][1] : 0;

  return (
    <div className="pc-installed-ops-shell pc-kpi-shell" style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div className="pc-installed-ops-header pc-kpi-topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Substrate KPIs</h1>
        <div className="pc-kpi-refresh-row" style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
          {lastFetched && <>Updated {formatRel(new Date(lastFetched).toISOString())}</>}
          <button
            className="pc-kpi-refresh-button"
            onClick={refresh}
            style={{ marginLeft: 12, padding: '4px 10px', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--fg)', cursor: 'pointer', borderRadius: 4 }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Top stats */}
      <div className="pc-kpi-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Harnesses" value={data.totals.harnesses} />
        <StatCard label="Projects" value={data.totals.projects} sub={Object.entries(data.totals.projects_by_status).map(([k, v]) => `${k}:${v}`).join(' ')} />
        <StatCard label="Messages 24h" value={data.totals.messages_24h.toLocaleString()} />
        <StatCard label="Actions 24h" value={data.totals.executed_actions_24h.toLocaleString()} />
        <StatCard label="AutoLoop active" value={data.autoloop.active} />
      </div>

      <div className="pc-kpi-lower-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Audit op breakdown */}
        <section className="pc-kpi-section pc-kpi-audit-section">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Action ops in last 24h</h2>
          <div className="pc-kpi-panel pc-kpi-audit-panel" style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 8 }}>
            {opEntries.length === 0 && <div style={{ color: 'var(--fg-mute)' }}>No actions in the last 24h.</div>}
            {opEntries.map(([op, n]) => (
              <BarRow key={op} label={op} value={n} max={opMax} />
            ))}
          </div>
        </section>

        {/* Directives + parents */}
        <section className="pc-kpi-section pc-kpi-directives-section">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Directives</h2>
          <div className="pc-kpi-panel pc-kpi-directives-panel" style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 8, marginBottom: 24 }}>
            <div className="pc-kpi-directives-grid" style={{ display: 'flex', gap: 24 }}>
              <div className="pc-kpi-directive-card">
                <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>Open</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{data.directives.open}</div>
              </div>
              <div className="pc-kpi-directive-card">
                <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>Acknowledged</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{data.directives.acknowledged}</div>
              </div>
            </div>
          </div>

          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Parent harnesses</h2>
          <div className="pc-kpi-panel pc-kpi-parents-panel" style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 8 }}>
            {data.parents.length === 0 && <div style={{ color: 'var(--fg-mute)' }}>No parent → child relationships yet.</div>}
            {data.parents.map((p) => (
              <div key={p.slug} className="pc-kpi-parent-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontFamily: 'monospace' }}>{p.slug}</span>
                <span>{p.children_count} {p.children_count === 1 ? 'child' : 'children'}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* AutoLoop fire history */}
      <section className="pc-kpi-section pc-kpi-autoloop-section" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Recent autoLoop fires</h2>
        <div className="pc-kpi-panel pc-kpi-autoloop-panel" style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 8, overflowX: 'auto' }}>
          {data.autoloop.recent_fires.length === 0 && <div style={{ color: 'var(--fg-mute)' }}>No autoLoop activity recorded yet.</div>}
          {data.autoloop.recent_fires.length > 0 && (
            <AutoLoopGrid fires={data.autoloop.recent_fires} />
          )}
        </div>
      </section>
    </div>
  );
}
