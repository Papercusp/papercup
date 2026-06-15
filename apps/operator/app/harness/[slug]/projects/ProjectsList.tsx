'use client';

/**
 * ProjectsList — list view of all projects in this harness.
 *
 * Mounted at /harness/<slug>/projects. Cross-cutting: a project may live
 * in multiple harnesses (org/dept), but this page only shows the slice
 * present in <slug>.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from '@/lib/router-compat/navigation';
import { Loader2, FolderKanban } from 'lucide-react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { COLORS, FONTS, RADIUS, SIZES, STATUS } from '../../theme';

interface FeatureCounts {
  todo: number; in_progress: number; validating: number; failing: number;
  blocked: number; passed: number; rejected: number; total: number;
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  spec: string | null;
  spec_updated_at: string | null;
  spec_manually_edited_at: string | null;
  feature_counts: FeatureCounts;
}

/** Passed-of-total percent for a project's feature counts (0 when no features —
 *  never NaN). Pure so the progress-cell math is testable. */
export function projectProgressPct(counts: Pick<FeatureCounts, 'passed' | 'total'>): number {
  return counts.total > 0 ? Math.round((counts.passed / counts.total) * 100) : 0;
}

/** Spec size as a one-decimal KB number (chars/1000, rounded to 0.1). */
export function specSizeKb(spec: string): number {
  return Math.round(spec.length / 100) / 10;
}

export default function ProjectsList({ slug }: { slug: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const columns = useMemo<ColumnDef<ProjectRow>[]>(() => [
    {
      key: 'id',
      header: 'ID',
      width: 1,
      sortKey: 'id',
      render: ({ row }) => (
        <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.textDim, padding: '1px 6px', background: COLORS.bg, borderRadius: 3 }}>
          {row.id}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      width: 2.5,
      sortKey: 'name',
      render: ({ row }) => <span style={{ fontWeight: 600 }}>{row.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 0.8,
      sortKey: 'status',
      render: ({ row }) => (
        <span style={{ fontSize: SIZES.xs, padding: '1px 7px', borderRadius: 3, background: 'var(--bg-3)', color: COLORS.textDim }}>
          {row.status}
        </span>
      ),
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 1.4,
      align: 'right',
      // sortKey expects a string in the new ColumnDef contract; computed sort dropped here.
      render: ({ row }) => {
        const { passed, total, failing, blocked } = row.feature_counts;
        const pct = projectProgressPct(row.feature_counts);
        return (
          <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.textDim }}>
            {passed}/{total} ({pct}%)
            {failing > 0 && <span style={{ color: STATUS.failing.text, marginLeft: 6 }}>{failing}f</span>}
            {blocked > 0 && <span style={{ color: STATUS.blocked.text, marginLeft: 6 }}>{blocked}b</span>}
          </span>
        );
      },
    },
    {
      key: 'spec',
      header: 'Spec',
      width: 1.4,
      sortKey: 'spec_updated_at',
      render: ({ row }) => {
        if (!row.spec) return <span style={{ fontSize: SIZES.xs, color: COLORS.textDim, opacity: 0.6 }}>none</span>;
        const lastSpec = row.spec_updated_at
          ? new Date(row.spec_updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : null;
        return (
          <span title={lastSpec ?? ''} style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.textDim }}>
            {specSizeKb(row.spec)}KB
            {row.spec_manually_edited_at && <span style={{ marginLeft: 4, opacity: 0.7 }}>(edited)</span>}
          </span>
        );
      },
    },
  ], []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/projects`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = await r.json();
      setProjects(data.projects ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{
      maxWidth: 1100, margin: '0 auto', padding: '24px 24px 48px',
      color: COLORS.text, fontFamily: 'inherit',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <FolderKanban size={18} color={COLORS.accent} />
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Projects</h1>
      </div>
      <div style={{ fontSize: SIZES.sm, color: COLORS.textDim, marginBottom: 20 }}>
        Harness <code style={{ fontFamily: FONTS.mono }}>{slug}</code> · projects with at least one feature
      </div>

      {error && (
        <div style={{
          padding: 12, background: COLORS.dangerBg, color: COLORS.dangerText,
          border: `1px solid ${COLORS.dangerText}`, borderRadius: RADIUS.sm, marginBottom: 12,
          fontSize: SIZES.sm,
        }}>
          Failed to load: {error}
        </div>
      )}

      {!projects && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.textDim, fontSize: SIZES.sm }}>
          <Loader2 size={14} className="op-note-spin" /> loading…
        </div>
      )}

      {projects && projects.length === 0 && (
        <div style={{
          padding: '32px 16px', textAlign: 'center',
          background: COLORS.bg, border: `1px solid ${COLORS.borderSubtle}`,
          borderRadius: RADIUS.sm, color: COLORS.textDim, fontSize: SIZES.sm,
        }}>
          <FolderKanban size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>No projects yet for harness <code style={{ fontFamily: FONTS.mono }}>{slug}</code>.</div>
          <div style={{ marginTop: 6, fontSize: SIZES.xs, opacity: 0.7 }}>
            Projects appear here once features are tagged with a <code>project_id</code>.
          </div>
        </div>
      )}

      {projects && projects.length > 0 && (
        <RichGrid<ProjectRow>
          rows={projects}
          columns={columns}
          getRowId={(p) => p.id}
          onRowClick={(p) => router.push(`/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(p.id)}`)}
          inline
        />
      )}
    </div>
  );
}
