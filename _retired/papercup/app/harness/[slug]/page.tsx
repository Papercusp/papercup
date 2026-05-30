'use client';
/**
 * Per-harness detail page.
 *
 * Reads /api/harness/{slug}/features for the work queue (rewritten to
 * operator on the docker network). Audit is per-feature only post-migration;
 * the cross-feature audit feed is deferred until we add a Zero-backed reader.
 * Polls every 10s.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  RichGrid,
  applySort,
  type ColumnDef,
  type RichGridSortState,
} from '@restart/grid-core';

interface FeatureRow {
  harness_slug: string;
  feature_id: string;
  title: string;
  status: string;
  attempts: number;
  project_id: string | null;
  expected_cost_cents: number | null;
  needs_human_review: boolean;
  created_ts: number;
  updated_ts: number;
  taken_by: string | null;
}

interface AuditRow {
  id: number;
  ts: number;
  harness_slug: string;
  feature_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string | null;
}

interface FeaturesPayload {
  rows: FeatureRow[];
  counts: Array<{ status: string; n: number }>;
}

interface AuditPayload {
  rows: AuditRow[];
}

const STATUS_COLORS: Record<string, string> = {
  todo: '#64748b',
  in_progress: '#3b82f6',
  passed: '#10b981',
  blocked: '#ef4444',
  paused: '#f59e0b',
  proposed: '#a855f7',
};

function StatusPill({ value }: { value: string }) {
  const color = STATUS_COLORS[value] ?? '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 999,
        background: `color-mix(in oklab, ${color} 18%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 50%, transparent)`,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
      }}
    >
      {value}
    </span>
  );
}

function ago(ts: number): string {
  const ms = Date.now() - ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtCents(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—';
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

interface StatTileProps {
  label: string;
  value: string;
  active?: boolean;
  onClick?: () => void;
}

function StatTile({ label, value, active, onClick }: StatTileProps) {
  const interactive = !!onClick;
  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      style={{
        flex: '1 1 120px',
        padding: '12px 14px',
        background: active
          ? 'linear-gradient(180deg, rgba(96,165,250,0.16) 0%, rgba(15,23,42,0.5) 100%)'
          : 'rgba(15,23,42,0.5)',
        border: `1px solid ${active ? 'rgba(96,165,250,0.55)' : 'rgba(148,163,184,0.18)'}`,
        borderRadius: 10,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: active ? '#93c5fd' : '#94a3b8',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 2, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  );
}

export default function HarnessSlugPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [features, setFeatures] = useState<FeaturesPayload | null>(null);
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [featuresSort, setFeaturesSort] = useState<RichGridSortState | null>({ column: 'updated_ts', dir: 'desc' });
  const [auditSort, setAuditSort] = useState<RichGridSortState | null>({ column: 'ts', dir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // /:slug/status returns { features: [{id, title, status, attempts, ...}], counts, ... }
        // — flatten to the FeatureRow shape this page expects.
        const fres = await fetch(`/api/harness/${encodeURIComponent(slug)}/status`);
        if (!fres.ok) throw new Error(`status HTTP ${fres.status}`);
        const raw = (await fres.json()) as {
          features?: Array<{
            id: string;
            title?: string;
            status?: string;
            attempts?: number;
            project_id?: string | null;
            expected_cost_cents?: number | null;
            needs_human_review?: boolean;
            created_ts?: number;
            updated_ts?: number;
            taken_by?: string | null;
            ts?: number;
          }>;
        };
        let rows: FeatureRow[] = (raw.features ?? []).map((f) => ({
          harness_slug: slug,
          feature_id: f.id,
          title: f.title ?? '',
          status: f.status ?? 'todo',
          attempts: f.attempts ?? 0,
          project_id: f.project_id ?? null,
          expected_cost_cents: f.expected_cost_cents ?? null,
          needs_human_review: !!f.needs_human_review,
          created_ts: f.created_ts ?? f.ts ?? 0,
          updated_ts: f.updated_ts ?? f.ts ?? 0,
          taken_by: f.taken_by ?? null,
        }));
        if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
        if (reviewOnly) rows = rows.filter((r) => r.needs_human_review);
        if (!cancelled) {
          setFeatures({ rows });
          setAudit({ rows: [] });
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [slug, statusFilter, reviewOnly]);

  const sortedFeatures = useMemo(
    () => applySort(features?.rows ?? [], featuresSort),
    [features?.rows, featuresSort],
  );
  const sortedAudit = useMemo(
    () => applySort(audit?.rows ?? [], auditSort),
    [audit?.rows, auditSort],
  );

  const featureColumns: ColumnDef<FeatureRow>[] = [
    {
      key: 'feature_id',
      header: 'ID',
      width: 1.2,
      sortKey: 'feature_id',
      render: ({ row }) => (
        <a
          href={`/harness/${slug}/${encodeURIComponent(row.feature_id)}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            color: '#7dd3fc',
            textDecoration: 'none',
          }}
        >
          {row.feature_id}
        </a>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      width: 4,
      sortKey: 'title',
      render: ({ row }) => (
        <span title={row.title} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {row.needs_human_review && (
            <span
              title="needs human review"
              style={{
                display: 'inline-block',
                padding: '1px 6px',
                fontSize: 9.5,
                fontWeight: 700,
                borderRadius: 999,
                background: 'rgba(245,158,11,0.20)',
                color: '#fbbf24',
                border: '1px solid rgba(245,158,11,0.45)',
                letterSpacing: '0.06em',
              }}
            >
              REVIEW
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.title}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 1,
      sortKey: 'status',
      render: ({ row }) => <StatusPill value={row.status} />,
    },
    {
      key: 'project',
      header: 'Project',
      width: 1.2,
      render: ({ row }) =>
        row.project_id ? (
          <a
            href={`/projects/${row.project_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: '#93c5fd', textDecoration: 'none', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          >
            {row.project_id.slice(0, 8)}…
          </a>
        ) : (
          <span style={{ color: '#475569' }}>—</span>
        ),
    },
    {
      key: 'budget',
      header: 'Budget',
      width: 1,
      align: 'right',
      sortKey: 'expected_cost_cents',
      render: ({ row }) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCents(row.expected_cost_cents)}</span>
      ),
    },
    {
      key: 'attempts',
      header: 'Try',
      width: 0.5,
      align: 'right',
      sortKey: 'attempts',
      render: ({ row }) => (
        <span
          style={{
            color: row.attempts > 1 ? '#fbbf24' : '#64748b',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: row.attempts > 1 ? 600 : 400,
          }}
        >
          {row.attempts || 0}
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      width: 1,
      align: 'right',
      sortKey: 'updated_ts',
      defaultSortDir: 'desc',
      render: ({ row }) => {
        const ts = typeof row.updated_ts === 'number' ? row.updated_ts : Number(row.updated_ts);
        const valid = Number.isFinite(ts);
        return (
          <span title={valid ? new Date(ts).toISOString() : ''} style={{ color: '#94a3b8', fontSize: 12 }}>
            {valid ? ago(ts) : '—'}
          </span>
        );
      },
    },
  ];

  const auditColumns: ColumnDef<AuditRow>[] = [
    {
      key: 'ts',
      header: 'When',
      width: 1,
      align: 'left',
      sortKey: 'ts',
      defaultSortDir: 'desc',
      render: ({ row }) => {
        const ts = typeof row.ts === 'number' ? row.ts : Number(row.ts);
        const valid = Number.isFinite(ts);
        return (
          <span title={valid ? new Date(ts).toISOString() : ''} style={{ color: '#94a3b8', fontSize: 12 }}>
            {valid ? ago(ts) : '—'}
          </span>
        );
      },
    },
    {
      key: 'feature_id',
      header: 'Feature',
      width: 1.2,
      sortKey: 'feature_id',
      render: ({ row }) => (
        <a
          href={`/harness/${slug}/${encodeURIComponent(row.feature_id)}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            color: '#7dd3fc',
            textDecoration: 'none',
          }}
        >
          {row.feature_id}
        </a>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      width: 1,
      sortKey: 'actor',
      render: ({ row }) => (
        <span
          style={{
            display: 'inline-block',
            padding: '1px 7px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            background: 'rgba(96,165,250,0.16)',
            color: '#93c5fd',
            border: '1px solid rgba(96,165,250,0.3)',
          }}
        >
          {row.actor || '—'}
        </span>
      ),
    },
    {
      key: 'field',
      header: 'Field',
      width: 1.2,
      sortKey: 'field',
      render: ({ row }) => (
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#cbd5e1' }}>
          {row.field}
        </span>
      ),
    },
    {
      key: 'old_value',
      header: 'Old',
      width: 2,
      render: ({ row }) => (
        <span title={row.old_value ?? ''} style={{ color: '#64748b', fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {truncate(row.old_value, 80)}
        </span>
      ),
    },
    {
      key: 'new_value',
      header: 'New',
      width: 2,
      render: ({ row }) => (
        <span title={row.new_value ?? ''} style={{ color: '#cbd5e1', fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {truncate(row.new_value, 80)}
        </span>
      ),
    },
  ];

  const totalAll = features?.rows.length ?? 0;
  const reviewCount = useMemo(
    () => (features?.rows ?? []).filter((r) => r.needs_human_review).length,
    [features],
  );

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <a
            href="/features"
            style={{ color: '#94a3b8', textDecoration: 'none', fontSize: 12 }}
          >
            ← all features
          </a>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0, marginBottom: 4 }}>
          Harness <span style={{ color: '#7dd3fc', fontFamily: 'ui-monospace, monospace' }}>{slug}</span>
          <span style={{ color: '#64748b', fontWeight: 500, fontSize: 14 }}> · features + audit</span>
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          Per-harness work queue + recent change feed. Polls every 10s.
        </p>
      </header>

      {error && (
        <div
          style={{
            padding: 12,
            background: 'rgba(239,68,68,0.10)',
            border: '1px solid rgba(239,68,68,0.30)',
            borderRadius: 8,
            color: '#fca5a5',
            marginBottom: 16,
          }}
        >
          load error: {error}
        </div>
      )}

      {/* Stat tiles */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        <StatTile label="Total" value={String(totalAll)} />
        {(features?.counts ?? []).map((c) => (
          <StatTile
            key={c.status}
            label={c.status}
            value={String(c.n)}
            active={statusFilter === c.status}
            onClick={() => setStatusFilter(statusFilter === c.status ? null : c.status)}
          />
        ))}
        <StatTile
          label="Needs review"
          value={String(reviewCount)}
          active={reviewOnly}
          onClick={() => setReviewOnly(!reviewOnly)}
        />
      </div>

      {(statusFilter || reviewOnly) && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#94a3b8' }}>
          filtered to {statusFilter || ''}{reviewOnly ? (statusFilter ? ' + needs_review' : 'needs_review') : ''} ·{' '}
          <button
            type="button"
            onClick={() => {
              setStatusFilter(null);
              setReviewOnly(false);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#93c5fd',
              cursor: 'pointer',
              padding: 0,
              fontSize: 12,
              textDecoration: 'underline',
            }}
          >
            clear
          </button>
        </div>
      )}

      <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '4px 0 10px 0' }}>
        Features ({sortedFeatures.length})
      </h2>
      <RichGrid<FeatureRow>
        rows={sortedFeatures}
        columns={featureColumns}
        getRowId={(r) => r.feature_id}
        sortState={featuresSort}
        onSortChange={setFeaturesSort}
      />

      <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '24px 0 10px 0' }}>
        Recent activity ({sortedAudit.length})
      </h2>
      <RichGrid<AuditRow>
        rows={sortedAudit}
        columns={auditColumns}
        getRowId={(r) => String(r.id)}
        sortState={auditSort}
        onSortChange={setAuditSort}
      />
    </div>
  );
}
