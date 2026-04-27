'use client';

/**
 * ProjectsList — list view of all projects in this harness.
 *
 * Mounted at /harness/<slug>/projects. Cross-cutting: a project may live
 * in multiple harnesses (org/dept), but this page only shows the slice
 * present in <slug>.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, ArrowRight, FolderKanban } from 'lucide-react';
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

export default function ProjectsList({ slug }: { slug: string }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map((p) => {
            const passed = p.feature_counts.passed;
            const total = p.feature_counts.total;
            const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
            const lastSpec = p.spec_updated_at
              ? new Date(p.spec_updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : null;
            return (
              <Link
                key={p.id}
                href={`/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(p.id)}`}
                style={{ textDecoration: 'none' }}
              >
                <div style={{
                  padding: 14,
                  background: COLORS.surfaceRaised,
                  border: `1px solid ${COLORS.borderSubtle}`,
                  borderRadius: RADIUS.md,
                  display: 'flex', alignItems: 'center', gap: 14,
                  cursor: 'pointer',
                  transition: 'border-color 120ms, transform 120ms',
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLORS.accent; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.borderSubtle; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.textDim,
                        padding: '1px 6px', background: COLORS.bg, borderRadius: 3,
                      }}>{p.id}</span>
                      <span style={{ fontSize: SIZES.md, fontWeight: 600 }}>{p.name}</span>
                      <span style={{
                        fontSize: SIZES.xs, padding: '1px 7px', borderRadius: 3,
                        background: 'rgba(255,255,255,0.06)', color: COLORS.textDim,
                      }}>{p.status}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: SIZES.xs, color: COLORS.textDim, fontFamily: FONTS.mono }}>
                      <span>{passed}/{total} passed ({pct}%)</span>
                      {p.feature_counts.failing > 0 && (
                        <span style={{ color: STATUS.failing.text }}>{p.feature_counts.failing} failing</span>
                      )}
                      {p.feature_counts.blocked > 0 && (
                        <span style={{ color: STATUS.blocked.text }}>{p.feature_counts.blocked} blocked</span>
                      )}
                      {p.spec ? (
                        <span title={lastSpec ? `last curated ${lastSpec}` : undefined}>
                          spec · {Math.round(p.spec.length / 100) / 10}KB
                          {p.spec_manually_edited_at && <span style={{ marginLeft: 4, opacity: 0.7 }}>(edited)</span>}
                        </span>
                      ) : (
                        <span style={{ opacity: 0.6 }}>no spec yet</span>
                      )}
                    </div>
                  </div>
                  <ArrowRight size={16} color={COLORS.textDim} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
