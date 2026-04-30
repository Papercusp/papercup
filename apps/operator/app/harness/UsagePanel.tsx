'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

interface Usage {
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface RoleSummary extends Usage {
  role: string;
  avgCostUsd: number;
  avgDurationMs: number;
}

interface RecentRun {
  runId: string;
  role: string;
  featureId?: string | null;
  ts: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface FeatureSummary {
  featureId: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  avgCostUsd: number;
  byRole: Record<string, number>;
}

interface Props {
  slug: string;
  onClose: () => void;
}

const ROLE_COLOR: Record<string, string> = {
  planner: '#3b82f6',
  worker: '#10b981',
  validator: '#a855f7',
  orchestrator: '#f59e0b',
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export default function UsagePanel({ slug, onClose }: Props) {
  const [data, setData] = useState<{ totals: Usage; byRole: RoleSummary[]; byFeature?: FeatureSummary[]; recent: RecentRun[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/usage`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch (e) {
      setError(String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Usage`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '80vw', maxWidth: 1100, height: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Usage — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>aggregated from .harness/logs/*.jsonl</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>auto-refresh 5s</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        {error && <div style={{ padding: '1rem', color: '#ef4444' }}>error: {error}</div>}

        {!data ? (
          <div style={{ padding: '2rem', color: '#9ca3af' }}>loading…</div>
        ) : (
          <div style={{ padding: '1rem', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Totals */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>Totals</div>
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                <Stat label="runs" value={data.totals.runs.toLocaleString()} />
                <Stat label="cost" value={fmtCost(data.totals.costUsd)} />
                <Stat label="input tokens" value={data.totals.inputTokens.toLocaleString()} />
                <Stat label="output tokens" value={data.totals.outputTokens.toLocaleString()} />
                <Stat label="total duration" value={fmtDuration(data.totals.durationMs)} />
              </div>
            </div>

            {/* Per-role table */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                Per-role breakdown — {data.byRole.length === 0 ? 'no runs yet' : `${data.byRole.length} roles`}
              </div>
              {data.byRole.length > 0 && <ByRoleGrid rows={data.byRole} />}
            </div>

            {/* Per-feature breakdown */}
            {data.byFeature && data.byFeature.length > 0 && (
              <div>
                <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                  Per-feature breakdown — {data.byFeature.length} features
                  <span style={{ textTransform: 'none', marginLeft: '0.5rem', color: '#6b7280', letterSpacing: 0 }}>
                    (only includes runs invoked with FEATURE_ID; older untagged runs roll up under Per-role only)
                  </span>
                </div>
                <ByFeatureGrid rows={data.byFeature} />
              </div>
            )}

            {/* Recent runs */}
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                Recent runs — {data.recent.length === 0 ? 'none' : `last ${data.recent.length}`}
              </div>
              {data.recent.length > 0 && <RecentRunsGrid rows={data.recent} />}
            </div>
          </div>
        )}
      </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <span style={{ fontSize: '0.65rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '1.25rem', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function ByRoleGrid({ rows }: { rows: RoleSummary[] }) {
  const columns: ColumnDef<RoleSummary>[] = useMemo(() => [
    { key: 'role', header: 'Role', width: 1.2, sortKey: 'role',
      render: ({ row }) => <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.55rem', borderRadius: 3, background: ROLE_COLOR[row.role] ?? '#374151', color: 'white', fontWeight: 600 }}>{row.role}</span> },
    { key: 'runs', header: 'Runs', width: 0.6, align: 'right', sortKey: 'runs', render: ({ row }) => <span>{row.runs}</span> },
    { key: 'cost', header: 'Total cost', width: 0.9, align: 'right', sortKey: 'costUsd',
      render: ({ row }) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(row.costUsd)}</span> },
    { key: 'avgCost', header: 'Avg cost', width: 0.8, align: 'right', sortKey: 'avgCostUsd',
      render: ({ row }) => <span style={{ fontFamily: 'monospace', color: '#9ca3af' }}>{fmtCost(row.avgCostUsd)}</span> },
    { key: 'inTok', header: 'Input tok', width: 0.9, align: 'right', sortKey: 'inputTokens',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{row.inputTokens.toLocaleString()}</span> },
    { key: 'outTok', header: 'Output tok', width: 0.9, align: 'right', sortKey: 'outputTokens',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{row.outputTokens.toLocaleString()}</span> },
    { key: 'dur', header: 'Total dur', width: 0.8, align: 'right', sortKey: 'durationMs',
      render: ({ row }) => <span>{fmtDuration(row.durationMs)}</span> },
    { key: 'avgDur', header: 'Avg dur', width: 0.8, align: 'right', sortKey: 'avgDurationMs',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{fmtDuration(row.avgDurationMs)}</span> },
  ], []);
  return <RichGrid<RoleSummary> rows={rows} columns={columns} getRowId={(r) => r.role} inline />;
}

function ByFeatureGrid({ rows }: { rows: FeatureSummary[] }) {
  const columns: ColumnDef<FeatureSummary>[] = useMemo(() => [
    { key: 'feat', header: 'Feature', width: 1.5, sortKey: 'featureId',
      render: ({ row }) => <span style={{ fontFamily: 'ui-monospace, monospace' }}>{row.featureId}</span> },
    { key: 'runs', header: 'Runs', width: 0.5, align: 'right', sortKey: 'runs',
      render: ({ row }) => <span>{row.runs}</span> },
    { key: 'cost', header: 'Total cost', width: 0.9, align: 'right', sortKey: 'costUsd',
      render: ({ row }) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmtCost(row.costUsd)}</span> },
    { key: 'avgCost', header: 'Avg cost', width: 0.9, align: 'right', sortKey: 'avgCostUsd',
      render: ({ row }) => <span style={{ fontFamily: 'monospace', color: '#9ca3af' }}>{fmtCost(row.avgCostUsd)}</span> },
    { key: 'perRole', header: 'Per-role cost', width: 3,
      render: ({ row }) => (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {Object.entries(row.byRole).sort((a, b) => b[1] - a[1]).map(([role, cost]) => (
            <span key={role} style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: ROLE_COLOR[role] ?? '#374151', color: 'white' }}>
              {role.slice(0, 4)} {fmtCost(cost)}
            </span>
          ))}
        </div>
      ) },
  ], []);
  return <RichGrid<FeatureSummary> rows={rows} columns={columns} getRowId={(f) => f.featureId} inline />;
}

function RecentRunsGrid({ rows }: { rows: RecentRun[] }) {
  const columns: ColumnDef<RecentRun>[] = useMemo(() => [
    { key: 'when', header: 'When', width: 1, sortKey: 'ts', defaultSortDir: 'desc',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{fmtTs(row.ts)}</span> },
    { key: 'role', header: 'Role', width: 0.9, sortKey: 'role',
      render: ({ row }) => <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: ROLE_COLOR[row.role] ?? '#374151', color: 'white' }}>{row.role}</span> },
    { key: 'runId', header: 'Run ID', width: 1.5,
      render: ({ row }) => <span style={{ fontFamily: 'monospace', color: '#6b7280' }}>{row.runId}</span> },
    { key: 'cost', header: 'Cost', width: 0.7, align: 'right', sortKey: 'costUsd',
      render: ({ row }) => <span style={{ fontFamily: 'monospace' }}>{fmtCost(row.costUsd)}</span> },
    { key: 'in', header: 'In', width: 0.7, align: 'right', sortKey: 'inputTokens',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{row.inputTokens.toLocaleString()}</span> },
    { key: 'out', header: 'Out', width: 0.7, align: 'right', sortKey: 'outputTokens',
      render: ({ row }) => <span style={{ color: '#9ca3af' }}>{row.outputTokens.toLocaleString()}</span> },
    { key: 'dur', header: 'Duration', width: 0.8, align: 'right', sortKey: 'durationMs',
      render: ({ row }) => <span>{fmtDuration(row.durationMs)}</span> },
  ], []);
  return <RichGrid<RecentRun> rows={rows} columns={columns} getRowId={(r) => r.runId} inline />;
}
