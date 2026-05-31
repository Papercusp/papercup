'use client';
/**
 * Cross-harness Features inbox.
 *
 * Subscribes via Zero to harness_shared.harness_features_consolidated — a
 * trigger-maintained mirror of every harness_<slug>.harness_features. The
 * trigger lives in 001-shared.sql + per-harness-template.sql so adding a
 * new harness automatically wires the mirror.
 *
 * Filtering and sorting are client-side over the Zero-synced rows: dataset
 * is small (~hundreds of rows, low thousands at scale), and client-side
 * filter avoids the round-trip the polled /features-all endpoint required.
 */
import { useMemo, useState } from 'react';
import { useQuery, useZero } from '@rocicorp/zero/react';
import { queries } from '@papercusp/zero-harness';
import { type FeatureConsolidatedRow } from '@papercusp/zero-harness';
import {
  RichGrid,
  applySort,
  type ColumnDef,
  type RichGridSortState,
} from '@papercusp/grid-core';

interface FeatureRow {
  harness_slug: string;
  feature_id: string;
  title: string;
  status: string;
  attempts: number;
  project_id: string | null;
  expected_cost_cents: number | null;
  tags: string[] | null;
  needs_human_review: boolean;
  created_ts: number;
  updated_ts: number;
  taken_by: string | null;
}

interface ApiPayload {
  rows: FeatureRow[];
  slugs: Array<{ harness_slug: string; n: number }>;
  counts: Array<{ status: string; n: number }>;
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

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  active?: boolean;
  onClick?: () => void;
}

function StatTile({ label, value, sub, active, onClick }: StatTileProps) {
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
        flex: '1 1 160px',
        padding: '14px 16px',
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
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 2, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
          {interactive ? (active ? 'filtered' : 'click to filter') : sub}
        </div>
      )}
    </div>
  );
}

function rowToLegacy(r: FeatureConsolidatedRow): FeatureRow {
  return {
    harness_slug: r.harnessSlug,
    feature_id: r.featureId,
    title: r.title ?? '',
    status: r.status ?? 'todo',
    attempts: Number(r.attempts) || 0,
    project_id: r.projectId ?? null,
    expected_cost_cents: r.expectedCostCents == null ? null : Number(r.expectedCostCents),
    tags: (r.tags as string[] | null) ?? null,
    needs_human_review: r.needsHumanReview ?? false,
    created_ts: Number(r.createdTs) || 0,
    updated_ts: Number(r.updatedTs) || 0,
    taken_by: r.takenBy ?? null,
  };
}

export default function FeaturesPage() {
  const __z = useZero();
  const [zeroRowsRaw, zeroRowsInfo] = useQuery(queries.featuresConsolidated.all(), __z) as unknown as [any[], { type: string }];
  const zeroRows = zeroRowsRaw ?? [];
  const zeroLoading = zeroRowsInfo?.type !== 'complete';
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [slugFilter, setSlugFilter] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [q, setQ] = useState('');
  const [sortState, setSortState] = useState<RichGridSortState | null>({ column: 'updated_ts', dir: 'desc' });

  const allRows: FeatureRow[] = useMemo(() => {
    if (zeroLoading || !Array.isArray(zeroRows)) return [];
    return zeroRows.map(rowToLegacy);
  }, [zeroRows, zeroLoading]);

  const filteredRows: FeatureRow[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allRows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (slugFilter && r.harness_slug !== slugFilter) return false;
      if (reviewOnly && !r.needs_human_review) return false;
      if (needle) {
        const hay = `${r.title.toLowerCase()} ${r.feature_id.toLowerCase()}`;
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allRows, statusFilter, slugFilter, reviewOnly, q]);

  const slugs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of allRows) counts.set(r.harness_slug, (counts.get(r.harness_slug) ?? 0) + 1);
    return Array.from(counts, ([harness_slug, n]) => ({ harness_slug, n })).sort((a, b) =>
      a.harness_slug.localeCompare(b.harness_slug)
    );
  }, [allRows]);

  // Status counts respect the slug filter so per-slug pages show their own
  // distribution. Status filter is NOT applied — tiles always show totals
  // for the selected scope.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of allRows) {
      if (slugFilter && r.harness_slug !== slugFilter) continue;
      map.set(r.status, (map.get(r.status) ?? 0) + 1);
    }
    return Array.from(map, ([status, n]) => ({ status, n })).sort((a, b) => a.status.localeCompare(b.status));
  }, [allRows, slugFilter]);

  const data: ApiPayload | null = useMemo(() => ({ rows: filteredRows, slugs, counts }), [filteredRows, slugs, counts]);
  const error: string | null = null;

  const sortedRows = useMemo(() => applySort(data?.rows ?? [], sortState), [data?.rows, sortState]);

  const totalAll = allRows.length;
  const reviewCount = useMemo(
    () => allRows.filter((r) => r.needs_human_review).length,
    [allRows],
  );

  const columns: ColumnDef<FeatureRow>[] = [
    {
      key: 'harness',
      header: 'Harness',
      width: 1,
      sortKey: 'harness_slug',
      render: ({ row }) => (
        <a
          href={`/harness/${row.harness_slug}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            background: 'rgba(96,165,250,0.16)',
            color: '#93c5fd',
            border: '1px solid rgba(96,165,250,0.3)',
            textDecoration: 'none',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {row.harness_slug}
        </a>
      ),
    },
    {
      key: 'feature_id',
      header: 'ID',
      width: 1,
      sortKey: 'feature_id',
      render: ({ row }) => (
        <a
          href={`/harness/${row.harness_slug}/${encodeURIComponent(row.feature_id)}`}
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
      render: ({ row }) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCents(row.expected_cost_cents)}</span>,
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

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0, marginBottom: 4 }}>
          Features <span style={{ color: '#64748b', fontWeight: 500 }}>· cross-harness work queue</span>
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          Aggregates every harness's <code>harness_features</code> table. Live via Zero (trigger-mirrored).
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
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <StatTile label="Total" value={String(totalAll)} sub={statusFilter || slugFilter || reviewOnly ? 'matches filters' : 'all features'} />
        {(data?.counts ?? []).map((c) => (
          <StatTile
            key={c.status}
            label={c.status}
            value={String(c.n)}
            sub="click to filter"
            active={statusFilter === c.status}
            onClick={() => setStatusFilter(statusFilter === c.status ? null : c.status)}
          />
        ))}
        <StatTile
          label="Needs review"
          value={String(reviewCount)}
          sub="click to filter"
          active={reviewOnly}
          onClick={() => setReviewOnly(!reviewOnly)}
        />
      </div>

      {/* Slug + search row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="search title or id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: '1 1 240px',
            padding: '8px 12px',
            fontSize: 13,
            background: 'rgba(15,23,42,0.65)',
            border: '1px solid rgba(148,163,184,0.20)',
            borderRadius: 8,
            color: '#e2e8f0',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(data?.slugs ?? []).map((s) => (
            <button
              key={s.harness_slug}
              type="button"
              onClick={() => setSlugFilter(slugFilter === s.harness_slug ? null : s.harness_slug)}
              style={{
                padding: '5px 10px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 999,
                cursor: 'pointer',
                background: slugFilter === s.harness_slug ? 'rgba(96,165,250,0.25)' : 'rgba(15,23,42,0.5)',
                color: slugFilter === s.harness_slug ? '#93c5fd' : '#94a3b8',
                border: `1px solid ${
                  slugFilter === s.harness_slug ? 'rgba(96,165,250,0.55)' : 'rgba(148,163,184,0.18)'
                }`,
              }}
            >
              {s.harness_slug} ({s.n})
            </button>
          ))}
        </div>
        {(statusFilter || slugFilter || reviewOnly || q) && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter(null);
              setSlugFilter(null);
              setReviewOnly(false);
              setQ('');
            }}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              cursor: 'pointer',
              background: 'transparent',
              color: '#94a3b8',
              border: '1px solid rgba(148,163,184,0.20)',
              borderRadius: 6,
            }}
          >
            clear all
          </button>
        )}
      </div>

      <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '16px 0 10px 0' }}>
        Results ({sortedRows.length})
      </h2>
      <RichGrid<FeatureRow>
        rows={sortedRows}
        columns={columns}
        getRowId={(r) => `${r.harness_slug}::${r.feature_id}`}
        sortState={sortState}
        onSortChange={setSortState}
      />
    </div>
  );
}
