'use client';

/**
 * Cross-harness portfolio view — Zero-driven.
 *
 *   PG `papercusp.harness_shared.projects` → projects table
 *   PG `papercusp.harness_shared.audit_log` → audit timeline
 *     → publication `zero_harness`
 *     → zero-cache-harness :4849
 *     → @rocicorp/zero/react WebSocket
 *     → useQuery(queries.projects.all() / queries.auditLog.recent({limit:50}))
 *     → live re-render
 *
 * Pairs the project portfolio with its audit timeline so a viewer can see
 * what's changed in the last few hours without refreshing. Replaces the
 * setInterval+fetch cadence used in the legacy /projects view (which still
 * lives over the JSON-backed /api/org/projects). Once data parity is in
 * place, the legacy view can switch to this lib.
 */
import { useMemo, useState } from 'react';
import { useQuery, useZero } from '@rocicorp/zero/react';
import { queries } from '@restart/zero-harness';
import {
  type ProjectRow,
  type AuditLogRow,
  type DirectiveSummaryRow,
} from '@restart/zero-harness';
import { RichGrid, applySort, type ColumnDef, type RichGridSortState } from '@restart/grid-core';

function fmtMoney(cents: number | undefined | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtPct(num: number, denom: number | undefined | null): string {
  if (!denom || denom <= 0) return '—';
  return `${Math.round((num / denom) * 100)}%`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const STATUS_TONE: Record<string, string> = {
  in_progress: '#34d399',
  proposed: '#a3a3a3',
  approved: '#7aa2f7',
  launched: '#7aa2f7',
  paused: '#fbbf24',
  cancelled: '#f87171',
};

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? '#8a96ad';
  return (
    <span style={{
      fontSize: 11, fontFamily: 'ui-monospace, monospace',
      padding: '2px 8px', borderRadius: 999,
      border: `1px solid ${tone}55`,
      background: `color-mix(in oklab, ${tone}, transparent 88%)`,
      color: tone,
    }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function LiveDot({ live, label }: { live: boolean; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8a96ad' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: live ? '#34d399' : '#fbbf24',
        boxShadow: live ? '0 0 6px rgba(52, 211, 153, 0.7)' : 'none',
      }} />
      {label} <strong style={{ color: live ? '#34d399' : '#fbbf24' }}>{live ? 'live' : 'loading…'}</strong>
    </span>
  );
}

function StatTile({
  label,
  value,
  sub,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      style={{
        flex: 1, minWidth: 140,
        padding: '12px 14px',
        border: `1px solid ${active ? '#7aa2f7' : '#1f2738'}`,
        borderRadius: 6,
        background: active
          ? 'linear-gradient(180deg, rgba(122,162,247,0.18) 0%, rgba(122,162,247,0.06) 100%)'
          : 'linear-gradient(180deg, rgba(15,23,42,0.6) 0%, rgba(10,15,26,0.6) 100%)',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'border-color 120ms ease, background 120ms ease',
        outline: 'none',
        boxShadow: active ? '0 0 0 1px rgba(122,162,247,0.3)' : 'none',
      }}
    >
      <div style={{ fontSize: 10, color: active ? '#7aa2f7' : '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#8a96ad', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function PortfolioPage() {
  // Click a stat tile to filter projects by status; click again to clear.
  // Drives the projects RichGrid through `projects.byStatus` (active filter)
  // or `projects.all` (no filter). Stat-tile counts always reflect the
  // unfiltered totals (so the user can see the rollup while filtered).
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [projectSort, setProjectSort] = useState<RichGridSortState | null>(null);
  const [auditSort, setAuditSort] = useState<RichGridSortState | null>(null);
  const __z = useZero();
  const [allProjectsRaw, allProjectsInfo] = useQuery(queries.projects.all(), __z) as unknown as [any[], { type: string }];
  const allProjects = allProjectsRaw ?? [];
  const projectsLoading = allProjectsInfo?.type !== 'complete';
  const filteredProjects: any[] = [];
  const projects = statusFilter ? filteredProjects : allProjects;
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [recentAuditRaw, recentAuditInfo] = useQuery(queries.auditLog.recent({ limit: 200 }), __z) as unknown as [any[], { type: string }];
  const recentAudit = recentAuditRaw ?? [];
  const auditLoading = recentAuditInfo?.type !== 'complete';
  const filteredAudit: any[] = [];
  const audit = subjectFilter ? filteredAudit : recentAudit;
  const [summariesRaw, summariesInfo] = useQuery((queries as any).directiveSummaries?.recent ? (queries as any).directiveSummaries.recent({ limit: 50 }) : queries.auditLog.recent({ limit: 1 }), __z) as unknown as [any[], { type: string }];
  const summaries = summariesRaw ?? [];
  const summariesLoading = summariesInfo?.type !== 'complete';

  const projectsLive = !projectsLoading;
  const auditLive = !auditLoading;
  const summariesLive = !summariesLoading;

  const sortedProjects = useMemo(() => applySort(projects as ProjectRow[], projectSort), [projects, projectSort]);
  const sortedAudit = useMemo(() => applySort(audit as AuditLogRow[], auditSort), [audit, auditSort]);

  const totals = useMemo(() => {
    // Always rollup the unfiltered set so stat tiles show portfolio totals
    // regardless of which filter is active.
    const budget = allProjects.reduce((s, p) => s + (p.budgetCents ?? 0), 0);
    const spent = allProjects.reduce((s, p) => s + p.spentCents, 0);
    const counts = allProjects.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    return { budget, spent, counts, count: allProjects.length };
  }, [allProjects]);

  const projectColumns: ColumnDef<ProjectRow>[] = useMemo(() => [
    {
      key: 'name',
      header: 'Project',
      width: 4,
      align: 'left',
      sortKey: 'name',
      render: ({ row }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>{row.name}</span>
          <span style={{ fontSize: 10, color: '#8a96ad', fontFamily: 'ui-monospace, monospace' }}>
            {row.id}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 1.4,
      align: 'center',
      sortKey: 'status',
      render: ({ row }) => <StatusPill status={row.status} />,
    },
    {
      key: 'owningDept',
      header: 'Owner',
      width: 1.4,
      align: 'left',
      render: ({ row }) => (
        <span style={{ color: '#8a96ad', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
          {row.owningDept ?? '—'}
        </span>
      ),
    },
    {
      key: 'vertical',
      header: 'Vertical',
      width: 1.2,
      align: 'left',
      render: ({ row }) => (
        <span style={{ color: '#8a96ad', fontSize: 12 }}>{row.vertical ?? '—'}</span>
      ),
    },
    {
      key: 'budget',
      header: 'Budget',
      width: 1.2,
      align: 'right',
      sortKey: 'budgetCents',
      render: ({ row }) => (
        <span style={{ fontFamily: 'ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMoney(row.budgetCents)}
        </span>
      ),
    },
    {
      key: 'spent',
      header: 'Spent',
      width: 1.2,
      align: 'right',
      sortKey: 'spentCents',
      render: ({ row }) => (
        <span style={{
          fontFamily: 'ui-monospace, monospace',
          fontVariantNumeric: 'tabular-nums',
          color: row.spentCents > 0 ? '#fbbf24' : '#8a96ad',
        }}>
          {fmtMoney(row.spentCents)}
        </span>
      ),
    },
    {
      key: 'used',
      header: 'Used',
      width: 0.9,
      align: 'right',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#8a96ad', fontFamily: 'ui-monospace, monospace' }}>
          {fmtPct(row.spentCents, row.budgetCents)}
        </span>
      ),
    },
  ], []);

  const summaryColumns: ColumnDef<DirectiveSummaryRow>[] = useMemo(() => [
    {
      key: 'when',
      header: 'When',
      width: 1.0,
      align: 'left',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#8a96ad', fontFamily: 'ui-monospace, monospace' }}>
          {relativeTime(row.ts)}
        </span>
      ),
    },
    {
      key: 'directive',
      header: 'Directive',
      width: 0.9,
      align: 'left',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#7aa2f7', fontFamily: 'ui-monospace, monospace' }}>
          {row.directiveId}
        </span>
      ),
    },
    {
      key: 'author',
      header: 'Author',
      width: 0.7,
      align: 'left',
      render: ({ row }) => {
        const tone = row.author === 'ceo' ? '#7aa2f7' : '#34d399';
        return (
          <span style={{
            fontSize: 11, fontFamily: 'ui-monospace, monospace',
            padding: '2px 6px', borderRadius: 3,
            color: tone,
            background: `color-mix(in oklab, ${tone}, transparent 88%)`,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>
            {row.author}
          </span>
        );
      },
    },
    {
      key: 'body',
      header: 'Summary',
      width: 4.5,
      align: 'left',
      render: ({ row }) => (
        <span style={{ fontSize: 12, color: '#e7ecf3' }}>
          {row.body.length > 140 ? row.body.slice(0, 140) + '…' : row.body}
        </span>
      ),
    },
  ], []);

  const auditColumns: ColumnDef<AuditLogRow>[] = useMemo(() => [
    {
      key: 'when',
      header: 'When',
      width: 1.1,
      align: 'left',
      sortKey: 'ts',
      defaultSortDir: 'desc',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#8a96ad', fontFamily: 'ui-monospace, monospace' }}>
          {relativeTime(row.ts)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      width: 1.0,
      align: 'left',
      sortKey: 'actor',
      render: ({ row }) => (
        <span style={{ fontSize: 11, color: '#7aa2f7', fontFamily: 'ui-monospace, monospace' }}>
          {row.actor}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      width: 1.6,
      align: 'left',
      sortKey: 'action',
      render: ({ row }) => (
        <span style={{ fontSize: 12 }}>{row.action}</span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      width: 2.0,
      align: 'left',
      render: ({ row }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSubjectFilter(subjectFilter === row.subject ? null : row.subject);
          }}
          title="click to filter audit log to this subject"
          style={{
            fontSize: 12,
            color: subjectFilter === row.subject ? '#7aa2f7' : '#8a96ad',
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            textAlign: 'left', fontFamily: 'inherit',
            textDecoration: subjectFilter === row.subject ? 'underline' : 'none',
          }}
        >
          {row.subject}
        </button>
      ),
    },
  ], []);

  return (
    <div style={{
      padding: 24,
      fontFamily: 'system-ui, sans-serif',
      color: '#e7ecf3',
      minHeight: 'calc(100vh - 100px)',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Portfolio</h1>
        <p style={{ fontSize: 12, color: '#8a96ad', margin: '4px 0 0' }}>
          Cross-harness project + audit view, driven by the Zero harness sync. No polling — every PG change
          propagates over the WebSocket. <LiveDot live={projectsLive} label="projects" /> &nbsp;·&nbsp; <LiveDot live={auditLive} label="audit" /> &nbsp;·&nbsp; <LiveDot live={summariesLive} label="summaries" />
        </p>
      </header>

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatTile
          label="Projects"
          value={String(totals.count)}
          sub={statusFilter ? 'click to clear filter' : `${totals.counts.in_progress ?? 0} in progress`}
          active={statusFilter === null && false}
          onClick={statusFilter ? () => setStatusFilter(null) : undefined}
        />
        <StatTile label="Total budget" value={fmtMoney(totals.budget)} />
        <StatTile label="Total spent" value={fmtMoney(totals.spent)} sub={fmtPct(totals.spent, totals.budget)} />
        <StatTile
          label="In progress"
          value={String(totals.counts.in_progress ?? 0)}
          sub={statusFilter === 'in_progress' ? 'filtered' : 'click to filter'}
          active={statusFilter === 'in_progress'}
          onClick={() => setStatusFilter(statusFilter === 'in_progress' ? null : 'in_progress')}
        />
        <StatTile
          label="Launched"
          value={String(totals.counts.launched ?? 0)}
          sub={statusFilter === 'launched' ? 'filtered' : 'click to filter'}
          active={statusFilter === 'launched'}
          onClick={() => setStatusFilter(statusFilter === 'launched' ? null : 'launched')}
        />
        <StatTile
          label="Paused"
          value={String(totals.counts.paused ?? 0)}
          sub={statusFilter === 'paused' ? 'filtered' : 'click to filter'}
          active={statusFilter === 'paused'}
          onClick={() => setStatusFilter(statusFilter === 'paused' ? null : 'paused')}
        />
        <StatTile
          label="Proposed"
          value={String(totals.counts.proposed ?? 0)}
          sub={statusFilter === 'proposed' ? 'filtered' : 'click to filter'}
          active={statusFilter === 'proposed'}
          onClick={() => setStatusFilter(statusFilter === 'proposed' ? null : 'proposed')}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 280, flex: 1 }}>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          Projects ({projects.length})
          {statusFilter && (
            <span style={{ fontSize: 10, color: '#7aa2f7', textTransform: 'none', letterSpacing: 0 }}>
              · filtered to <code style={{ color: '#7aa2f7' }}>{statusFilter}</code>
              {' '}
              <button
                type="button"
                onClick={() => setStatusFilter(null)}
                style={{ background: 'transparent', border: 'none', color: '#7aa2f7', cursor: 'pointer', fontSize: 10, textDecoration: 'underline', padding: 0 }}
              >
                clear
              </button>
            </span>
          )}
        </h2>
        <div style={{ flex: 1, minHeight: 200, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<ProjectRow>
            columns={projectColumns}
            rows={sortedProjects}
            getRowId={(r) => r.id}
            sortState={projectSort}
            onSortChange={setProjectSort}
            empty={projectsLive ? 'No projects yet.' : 'Connecting…'}
          />
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 240, flex: 1 }}>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Recent CEO summaries ({summaries.length})
        </h2>
        <div style={{ flex: 1, minHeight: 160, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<DirectiveSummaryRow>
            columns={summaryColumns}
            rows={summaries as DirectiveSummaryRow[]}
            getRowId={(r) => r.id}
            empty={summariesLive ? 'No directive summaries yet.' : 'Connecting…'}
          />
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 280, flex: 1 }}>
        <h2 style={{ fontSize: 13, color: '#8a96ad', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          Recent activity ({audit.length})
          {subjectFilter && (
            <span style={{ fontSize: 10, color: '#7aa2f7', textTransform: 'none', letterSpacing: 0 }}>
              · filtered to <code style={{ color: '#7aa2f7' }}>{subjectFilter}</code>{' '}
              <button
                type="button"
                onClick={() => setSubjectFilter(null)}
                style={{ background: 'transparent', border: 'none', color: '#7aa2f7', cursor: 'pointer', fontSize: 10, textDecoration: 'underline', padding: 0 }}
              >
                clear
              </button>
            </span>
          )}
        </h2>
        <div style={{ flex: 1, minHeight: 200, border: '1px solid #1f2738', borderRadius: 6, overflow: 'hidden' }}>
          <RichGrid<AuditLogRow>
            columns={auditColumns}
            rows={sortedAudit}
            getRowId={(r) => r.id}
            sortState={auditSort}
            onSortChange={setAuditSort}
            empty={auditLive ? 'No audit events yet.' : 'Connecting…'}
          />
        </div>
      </section>
    </div>
  );
}
