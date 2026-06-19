'use client';

/**
 * ProjectDetail — three tabs: Roadmap / History / Spec.
 *
 * Roadmap = features in this project with status in (todo, in_progress,
 * validating, failing, blocked) — the work ahead.
 * History = features with status in (passed, rejected, withdrawn) — the
 * work behind.
 * Spec = the project's curated operating context. Markdown viewer + manual
 * edit (PUT .../spec) + revisions browser. (The automatic "Regenerate (PM)"
 * button was retired with the project_manager PM feature — D-020 / P-015.)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirmDialog } from '../../../useConfirmDialog';
import { useQueryState, parseAsStringEnum, parseAsBoolean } from 'nuqs';
import {
  ArrowLeft, Loader2, AlertTriangle, Save, X, Pencil,
  Coins, Clock, Hammer, History as HistoryIcon, FileText,
} from 'lucide-react';
import { MarkdownView } from '@papercusp/ui-primitives';
import { MarkdownEditor } from '../../../../_components/MarkdownEditor';
import Link from '@/lib/router-compat/link';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { COLORS, FONTS, RADIUS, SIZES, STATUS } from '../../../theme';
import { useSyncQuery } from '@papercusp/sync';

interface FeatureCounts {
  todo: number; in_progress: number; validating: number; failing: number;
  blocked: number; passed: number; rejected: number; total: number;
}

interface FeatureLockState { taken_by: string | null; active: boolean }

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  spec: string | null;
  spec_updated_at: string | null;
  spec_manually_edited_at: string | null;
  feature_counts: FeatureCounts;
  last_spec_revision: { id: number; summary: string | null; author_role: string; ts: string } | null;
}

interface FeatureRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  summary?: string;
  ts?: number;
  updated_ts?: number;
}

interface RevisionRow {
  id: number;
  summary: string | null;
  author_role: string;
  author: string | null;
  ts: string;
  include_decisions: Array<{ feature_id: string; action: 'include' | 'exclude'; reason: string }> | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd_cents: number;
}

type Tab = 'roadmap' | 'history' | 'spec';

const ROADMAP_STATUSES = new Set(['todo', 'in_progress', 'validating', 'failing', 'blocked']);
const HISTORY_STATUSES = new Set(['passed', 'rejected', 'withdrawn']);

export default function ProjectDetail({ slug, projectId }: { slug: string; projectId: string }) {
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [features, setFeatures] = useState<FeatureRow[] | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useQueryState(
    'projectTab',
    parseAsStringEnum<Tab>(['roadmap', 'history', 'spec']).withDefault('roadmap'),
  );

  // Spec edit state
  const [editing, setEditing] = useState(false);
  const [draftSpec, setDraftSpec] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | { error: string }>('idle');
  const [showRevisions, setShowRevisions] = useQueryState('revisions', parseAsBoolean.withDefault(false));
  const [activeRevision, setActiveRevision] = useState<{ id: number; spec: string } | null>(null);
  const { element: confirmEl } = useConfirmDialog();

  const loadProject = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setLoadError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as ProjectRow;
      setProject(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [slug, projectId]);

  const loadFeatures = useCallback(async () => {
    try {
      // Reuse the harness-status endpoint and filter by project_id client-side
      // (the existing API doesn't have a per-project feature-list endpoint;
      // this page is small + cached so client-side filter is fine).
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/status`);
      if (!r.ok) return;
      const data = await r.json();
      const all = (data.features ?? []) as FeatureRow[];
      setFeatures(all.filter((f) => (f as { project_id?: string }).project_id === projectId));
    } catch { /* best-effort */ }
  }, [slug, projectId]);

  // Eager via Zero — projectSpecRevisions.byProject mirrors PG's
  // harness_shared.project_spec_revisions table. History tab paints
  // same-frame on tab open instead of round-tripping when user clicks.
  // Map Zero's camelCase + epoch-ms to the existing RevisionRow shape.
  const { data: zeroRevisions } = useSyncQuery<{
    id: number;
    summary?: string | null;
    authorRole: string;
    author?: string | null;
    ts: number;
    includeDecisions?: Array<{ feature_id: string; action: 'include' | 'exclude'; reason: string }> | null;
    tokensIn: number;
    tokensOut: number;
    costUsdCents: number;
  }>({
    queryName: 'projectSpecRevisions.byProject',
    args: { projectId, limit: 50 },
    enabled: !!projectId,
  });
  useEffect(() => {
    if (!Array.isArray(zeroRevisions)) return;
    setRevisions(zeroRevisions.map((r) => ({
      id: r.id,
      summary: r.summary ?? null,
      author_role: r.authorRole,
      author: r.author ?? null,
      ts: new Date(r.ts).toISOString(),
      include_decisions: r.includeDecisions ?? null,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      cost_usd_cents: r.costUsdCents,
    })));
  }, [zeroRevisions]);
  const loadRevisions = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}/spec/revisions?limit=50`);
      if (!r.ok) return;
      const data = await r.json();
      setRevisions(data.revisions ?? []);
    } catch { /* best-effort */ }
  }, [slug, projectId]);

  useEffect(() => { void loadProject(); void loadFeatures(); }, [loadProject, loadFeatures]);

  const startEdit = useCallback(() => {
    setDraftSpec(project?.spec ?? '');
    setEditing(true);
  }, [project?.spec]);

  const saveEdit = useCallback(async () => {
    setSaveState('saving');
    try {
      const r = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}/spec`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec: draftSpec, summary: 'Manual edit by operator' }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setSaveState({ error: body.error ?? `HTTP ${r.status}` });
        return;
      }
      setSaveState('saved');
      setEditing(false);
      await Promise.all([loadProject(), loadRevisions()]);
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch (e) {
      setSaveState({ error: (e as Error).message });
    }
  }, [slug, projectId, draftSpec, loadProject, loadRevisions]);

  const loadRevision = useCallback(async (revId: number) => {
    try {
      const r = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}/spec/revisions/${revId}`,
      );
      if (!r.ok) return;
      const data = await r.json();
      setActiveRevision({ id: revId, spec: data.spec ?? '' });
    } catch { /* best-effort */ }
  }, [slug, projectId]);

  const roadmap = useMemo(() => (features ?? []).filter((f) => ROADMAP_STATUSES.has(f.status)), [features]);
  const history = useMemo(() => (features ?? []).filter((f) => HISTORY_STATUSES.has(f.status)), [features]);

  if (loadError) {
    return (
      <div style={{ padding: 24, color: COLORS.dangerText }}>
        <AlertTriangle size={14} /> {loadError}
      </div>
    );
  }
  if (!project) {
    return (
      <div style={{ padding: 24, color: COLORS.textDim, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Loader2 size={14} className="op-note-spin" /> loading project…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px 48px', color: COLORS.text }}>
      {confirmEl}
      {/* Header */}
      <Link href={`/harness/${encodeURIComponent(slug)}/projects`} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: SIZES.xs, color: COLORS.textDim, textDecoration: 'none', marginBottom: 12,
      }}>
        <ArrowLeft size={12} /> all projects
      </Link>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.textDim, padding: '2px 8px', background: COLORS.bg, borderRadius: 3 }}>{project.id}</span>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{project.name}</h1>
        <span style={{ fontSize: SIZES.xs, padding: '2px 7px', borderRadius: 3, background: 'var(--bg-3)', color: COLORS.textDim }}>{project.status}</span>
      </div>

      <div style={{ display: 'flex', gap: 14, fontSize: SIZES.xs, color: COLORS.textDim, fontFamily: FONTS.mono, marginBottom: 18 }}>
        <span>{project.feature_counts.total} features · {project.feature_counts.passed} passed</span>
        {project.last_spec_revision && (
          <span title={project.last_spec_revision.summary ?? ''}>
            spec last curated {new Date(project.last_spec_revision.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {' '}by <span style={{ color: COLORS.accent }}>{project.last_spec_revision.author_role}</span>
          </span>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${COLORS.borderSubtle}`, marginBottom: 18 }}>
        {([
          { id: 'roadmap' as Tab, label: 'Roadmap', icon: <Hammer size={13} />, count: roadmap.length },
          { id: 'history' as Tab, label: 'History', icon: <HistoryIcon size={13} />, count: history.length },
          { id: 'spec' as Tab, label: 'Spec', icon: <FileText size={13} /> },
        ]).map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                color: active ? COLORS.text : COLORS.textDim,
                border: 'none',
                borderBottom: `2px solid ${active ? COLORS.accent : 'transparent'}`,
                cursor: 'pointer',
                fontSize: SIZES.sm,
                fontWeight: active ? 600 : 400,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {t.icon}
              <span>{t.label}</span>
              {typeof t.count === 'number' && (
                <span style={{ fontFamily: FONTS.mono, fontSize: '0.65rem', color: COLORS.textDim }}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === 'roadmap' && <FeatureTable features={roadmap} emptyText="No work in flight for this project." />}
      {tab === 'history' && <FeatureTable features={history} emptyText="No completed work yet." />}
      {tab === 'spec' && (
        <div>
          {/* Spec actions */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {!editing ? (
              <>
                <button onClick={startEdit} style={btnSecondary}>
                  <Pencil size={12} /> Edit
                </button>
                <button onClick={() => setShowRevisions((v) => !v)} style={btnSecondary}>
                  <Clock size={12} /> {showRevisions ? 'Hide revisions' : 'Show revisions'} ({revisions.length})
                </button>
              </>
            ) : (
              <>
                <button onClick={saveEdit} disabled={saveState === 'saving'} style={btnPrimary}>
                  {saveState === 'saving' ? <Loader2 size={12} className="op-note-spin" /> : <Save size={12} />}
                  Save manual edit
                </button>
                <button onClick={() => { setEditing(false); setDraftSpec(''); }} style={btnSecondary}>
                  <X size={12} /> Cancel
                </button>
              </>
            )}
          </div>

          {/* Status indicators */}
          {typeof saveState === 'object' && 'error' in saveState && (
            <div style={statusBox('error')}><AlertTriangle size={12} /> Save failed: {saveState.error}</div>
          )}

          {/* Revisions list (collapsible) */}
          {showRevisions && (
            <div style={{
              marginBottom: 14, padding: 12,
              background: COLORS.bg, border: `1px solid ${COLORS.borderSubtle}`, borderRadius: RADIUS.sm,
              maxHeight: 320, overflowY: 'auto',
            }}>
              <div style={{ fontSize: SIZES.xs, fontWeight: 600, color: COLORS.textDim, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Revisions ({revisions.length})
              </div>
              {revisions.length === 0 ? (
                <div style={{ fontSize: SIZES.xs, color: COLORS.textDim, fontStyle: 'italic' }}>No revisions yet — run PM to create the first one.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {revisions.map((rev) => {
                    const isActive = activeRevision?.id === rev.id;
                    return (
                      <button
                        key={rev.id}
                        onClick={() => loadRevision(rev.id)}
                        style={{
                          textAlign: 'left',
                          padding: '8px 10px',
                          background: isActive ? 'rgba(94,106,210,0.12)' : 'transparent',
                          border: `1px solid ${isActive ? COLORS.accent : 'transparent'}`,
                          borderRadius: RADIUS.sm,
                          cursor: 'pointer',
                          color: COLORS.text,
                          fontSize: SIZES.xs,
                          display: 'flex', flexDirection: 'column', gap: 4,
                        }}
                      >
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontFamily: FONTS.mono, color: COLORS.accent }}>r{rev.id}</span>
                          <span style={{ color: COLORS.textDim, fontFamily: FONTS.mono }}>
                            {new Date(rev.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span style={{ fontFamily: FONTS.mono, padding: '0 5px', borderRadius: 2, background: 'var(--bg-2)' }}>
                            {rev.author_role}
                          </span>
                          {(rev.tokens_in > 0 || rev.tokens_out > 0) && (
                            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, color: COLORS.textDim }}>
                              <Coins size={10} /> {((rev.cost_usd_cents ?? 0) / 100).toFixed(4)}
                            </span>
                          )}
                        </div>
                        {rev.summary && <div style={{ color: COLORS.text }}>{rev.summary}</div>}
                        {rev.include_decisions && rev.include_decisions.length > 0 && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {rev.include_decisions.map((d, i) => (
                              <span key={i} style={{
                                fontSize: '0.65rem', padding: '1px 5px', borderRadius: 2,
                                background: d.action === 'include' ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.10)',
                                color: d.action === 'include' ? '#a7f3d0' : '#d8b4fe',
                                fontFamily: FONTS.mono,
                              }} title={d.reason}>
                                {d.action === 'include' ? '+' : '−'}{d.feature_id}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Spec viewer / editor / revision-viewer */}
          {activeRevision && !editing ? (
            <div style={{ marginBottom: 8, padding: 8, background: 'rgba(94,106,210,0.08)', border: `1px solid ${COLORS.accent}`, borderRadius: RADIUS.sm, display: 'flex', alignItems: 'center', gap: 8, fontSize: SIZES.xs }}>
              <span style={{ fontFamily: FONTS.mono, color: COLORS.accent }}>Viewing revision r{activeRevision.id}</span>
              <button onClick={() => setActiveRevision(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: COLORS.accent, cursor: 'pointer' }}>
                back to current
              </button>
            </div>
          ) : null}

          {editing ? (
            <div style={{ minHeight: 500, border: `1px solid ${COLORS.borderSubtle}`, borderRadius: RADIUS.sm, overflow: 'hidden' }}>
              <MarkdownEditor
                value={draftSpec}
                onChange={setDraftSpec}
                mode="ir"
                outline="left"
                minHeight={500}
                placeholder="Markdown spec body — architectural decisions, invariants, conventions, gotchas, external dependencies."
              />
            </div>
          ) : (
            <SpecBody spec={activeRevision ? activeRevision.spec : project.spec} />
          )}
        </div>
      )}
    </div>
  );
}

function SpecBody({ spec }: { spec: string | null }) {
  if (!spec || !spec.trim()) {
    return (
      <div style={{
        padding: '32px 16px', textAlign: 'center',
        background: COLORS.bg, border: `1px dashed ${COLORS.borderSubtle}`,
        borderRadius: RADIUS.sm, color: COLORS.textDim, fontSize: SIZES.sm,
      }}>
        <FileText size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
        <div>No spec yet — run Project Manager to curate one.</div>
      </div>
    );
  }
  return (
    <div style={{
      padding: '14px 18px', background: COLORS.bg,
      border: `1px solid ${COLORS.borderSubtle}`, borderRadius: RADIUS.sm,
    }}>
      <MarkdownView source={spec} />
    </div>
  );
}

function FeatureTable({ features, emptyText }: { features: FeatureRow[]; emptyText: string }) {
  const columns = useMemo<ColumnDef<FeatureRow>[]>(() => [
    {
      key: 'dot',
      header: '',
      width: 0.15,
      render: ({ row }) => {
        const s = STATUS[row.status as keyof typeof STATUS] ?? STATUS.todo;
        return <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: s.solid }} />;
      },
    },
    {
      key: 'id',
      header: 'ID',
      width: 1,
      sortKey: 'id',
      render: ({ row }) => <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.textDim }}>{row.id}</span>,
    },
    {
      key: 'title',
      header: 'Title',
      width: 4,
      render: ({ row }) => (
        <span style={{ color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.summary ?? row.title}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 0.8,
      sortKey: 'status',
      render: ({ row }) => {
        const s = STATUS[row.status as keyof typeof STATUS] ?? STATUS.todo;
        return <span style={{ fontSize: SIZES.xs, color: s.text, padding: '1px 6px', background: s.bg, borderRadius: 3 }}>{s.label}</span>;
      },
    },
    {
      key: 'attempts',
      header: 'Attempts',
      width: 0.5,
      align: 'right',
      sortKey: 'attempts',
      render: ({ row }) => row.attempts > 0
        ? <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: row.attempts >= 3 ? STATUS.failing.text : COLORS.textDim }}>×{row.attempts}</span>
        : null,
    },
  ], []);

  if (features.length === 0) {
    return (
      <div style={{ padding: 24, color: COLORS.textDim, fontSize: SIZES.sm, textAlign: 'center' }}>
        {emptyText}
      </div>
    );
  }

  return (
    <RichGrid<FeatureRow>
      rows={features}
      columns={columns}
      getRowId={(f) => f.id}
      inline
    />
  );
}

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '6px 12px', fontSize: SIZES.xs,
  background: COLORS.accent, color: '#fff',
  border: `1px solid ${COLORS.accent}`, borderRadius: RADIUS.sm,
  cursor: 'pointer',
} as const;
const btnSecondary = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '6px 12px', fontSize: SIZES.xs,
  background: COLORS.surfaceRaised, color: COLORS.text,
  border: `1px solid ${COLORS.borderSubtle}`, borderRadius: RADIUS.sm,
  cursor: 'pointer',
} as const;

function statusBox(kind: 'success' | 'error') {
  const isErr = kind === 'error';
  return {
    padding: '10px 12px', marginBottom: 12,
    background: isErr ? COLORS.dangerBg : 'rgba(16,185,129,0.12)',
    color: isErr ? COLORS.dangerText : COLORS.successText,
    border: `1px solid ${isErr ? COLORS.dangerText : 'var(--good)'}`,
    borderRadius: RADIUS.sm,
    fontSize: SIZES.xs,
    display: 'flex', alignItems: 'center', gap: 6,
    flexWrap: 'wrap' as const,
  };
}
