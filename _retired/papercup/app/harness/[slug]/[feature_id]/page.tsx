'use client';
/**
 * Feature detail drill-in.
 *
 * URL: /harness/{slug}/{feature_id}
 * Reads /api/org/features-all?slug=&feature_id= for the feature
 *       /api/org/feature-audit?slug=&feature_id= for the full audit timeline
 * Polls every 10s.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
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
  summary: string | null;
  status: string;
  attempts: number;
  claims: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  kind: string | null;
  project_id: string | null;
  expected_cost_cents: number | null;
  tags: string[] | null;
  needs_human_review: boolean;
  created_ts: number;
  updated_ts: number;
  parent_id: string | null;
  goal_id: string | null;
  taken_by: string | null;
  taken_at: string | null;
  expires_at: string | null;
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

const STATUS_COLORS: Record<string, string> = {
  todo: '#64748b',
  in_progress: '#3b82f6',
  passed: '#10b981',
  blocked: '#ef4444',
  paused: '#f59e0b',
  proposed: '#a855f7',
};

function StatusPill({ value, large }: { value: string; large?: boolean }) {
  const color = STATUS_COLORS[value] ?? '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: large ? '4px 12px' : '2px 8px',
        fontSize: large ? 12 : 11,
        fontWeight: 600,
        borderRadius: 999,
        background: `color-mix(in oklab, ${color} 18%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 50%, transparent)`,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
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

function parseClaims(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x));
    return [];
  } catch {
    return [];
  }
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: '1 1 200px',
        padding: '12px 14px',
        background: 'rgba(15,23,42,0.5)',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: '#94a3b8',
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 14, color: '#e2e8f0' }}>{children}</div>
    </div>
  );
}

const STATUS_OPTIONS = ['todo', 'in_progress', 'passed', 'blocked', 'paused', 'proposed'] as const;

interface EditPanelProps {
  slug: string;
  featureId: string;
  feature: FeatureRow;
  editStatus: string;
  setEditStatus: (v: string) => void;
  editReview: boolean;
  setEditReview: (v: boolean) => void;
  editProjectId: string;
  setEditProjectId: (v: string) => void;
  editBudgetDollars: string;
  setEditBudgetDollars: (v: string) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  saveMsg: string | null;
  setSaveMsg: (v: string | null) => void;
  onSaved: (updated: FeatureRow) => void;
}

function EditPanel(props: EditPanelProps) {
  const {
    slug, featureId, feature,
    editStatus, setEditStatus,
    editReview, setEditReview,
    editProjectId, setEditProjectId,
    editBudgetDollars, setEditBudgetDollars,
    saving, setSaving, saveMsg, setSaveMsg, onSaved,
  } = props;

  const dirty =
    editStatus !== feature.status ||
    editReview !== feature.needs_human_review ||
    (editProjectId.trim() || null) !== (feature.project_id ?? null) ||
    (() => {
      const cur = feature.expected_cost_cents == null ? '' : (feature.expected_cost_cents / 100).toFixed(2);
      return editBudgetDollars !== cur;
    })();

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    const body: Record<string, unknown> = {};
    if (editStatus !== feature.status) body.status = editStatus;
    if (editReview !== feature.needs_human_review) body.needs_human_review = editReview;
    const newProj = editProjectId.trim() || null;
    if (newProj !== (feature.project_id ?? null)) body.project_id = newProj;
    if (editBudgetDollars.trim() === '') {
      if (feature.expected_cost_cents != null) body.expected_cost_cents = null;
    } else {
      const dollars = Number(editBudgetDollars);
      if (Number.isFinite(dollars) && dollars >= 0) {
        const cents = Math.round(dollars * 100);
        if (cents !== feature.expected_cost_cents) body.expected_cost_cents = cents;
      } else {
        setSaveMsg(`invalid budget: ${editBudgetDollars}`);
        setSaving(false);
        return;
      }
    }

    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(featureId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-actor': 'human:features-page' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      const payload = (await res.json()) as { ok: boolean; feature: FeatureRow };
      onSaved(payload.feature);
      setSaveMsg('saved');
      setTimeout(() => setSaveMsg(null), 1500);
    } catch (e) {
      setSaveMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        marginBottom: 24,
        padding: 16,
        background: 'rgba(15,23,42,0.5)',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: '#94a3b8',
          marginBottom: 12,
        }}
      >
        Edit
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <span>STATUS</span>
          <select
            value={editStatus}
            onChange={(e) => setEditStatus(e.target.value)}
            style={{
              padding: '6px 8px',
              fontSize: 13,
              background: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(148,163,184,0.30)',
              borderRadius: 6,
              color: '#e2e8f0',
              minWidth: 130,
            }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            {!STATUS_OPTIONS.includes(editStatus as typeof STATUS_OPTIONS[number]) && editStatus && (
              <option value={editStatus}>{editStatus} (custom)</option>
            )}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <span>PROJECT</span>
          <input
            type="text"
            placeholder="—"
            value={editProjectId}
            onChange={(e) => setEditProjectId(e.target.value)}
            style={{
              padding: '6px 8px',
              fontSize: 13,
              background: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(148,163,184,0.30)',
              borderRadius: 6,
              color: '#e2e8f0',
              fontFamily: 'ui-monospace, monospace',
              minWidth: 180,
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <span>BUDGET ($)</span>
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder="—"
            value={editBudgetDollars}
            onChange={(e) => setEditBudgetDollars(e.target.value)}
            style={{
              padding: '6px 8px',
              fontSize: 13,
              background: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(148,163,184,0.30)',
              borderRadius: 6,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              minWidth: 110,
            }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#e2e8f0', paddingBottom: 6 }}>
          <input
            type="checkbox"
            checked={editReview}
            onChange={(e) => setEditReview(e.target.checked)}
          />
          needs human review
        </label>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          style={{
            padding: '7px 14px',
            fontSize: 13,
            fontWeight: 600,
            background: dirty && !saving ? '#3b82f6' : 'rgba(59,130,246,0.25)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'saving…' : 'save'}
        </button>
        {saveMsg && (
          <span
            style={{
              fontSize: 12,
              color: saveMsg.startsWith('save failed') ? '#fca5a5' : '#6ee7b7',
            }}
          >
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  );
}

export default function FeatureDetailPage() {
  const params = useParams<{ slug: string; feature_id: string }>();
  const slug = params.slug;
  const featureId = decodeURIComponent(params.feature_id);

  const [feature, setFeature] = useState<FeatureRow | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auditSort, setAuditSort] = useState<RichGridSortState | null>({
    column: 'ts',
    dir: 'desc',
  });

  // Edit form state — populated from the loaded feature, separate from
  // the live feature row so the user can stage changes without flicker
  // from the 10s poll.
  const [editStatus, setEditStatus] = useState<string>('');
  const [editReview, setEditReview] = useState(false);
  const [editProjectId, setEditProjectId] = useState<string>('');
  const [editBudgetDollars, setEditBudgetDollars] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const params = new URLSearchParams({ slug, feature_id: featureId });
        const auditParams = new URLSearchParams({ slug, feature_id: featureId, limit: '200' });
        const [fres, ares] = await Promise.all([
          fetch(`/api/org/features-all?${params}`),
          fetch(`/api/org/feature-audit?${auditParams}`),
        ]);
        if (!fres.ok) throw new Error(`features HTTP ${fres.status}`);
        if (!ares.ok) throw new Error(`audit HTTP ${ares.status}`);
        const fpayload = (await fres.json()) as { rows: FeatureRow[] };
        const apayload = (await ares.json()) as { rows: AuditRow[] };
        if (!cancelled) {
          const f = fpayload.rows[0] ?? null;
          // Initialize edit state only on the first successful load so polled
          // refreshes don't clobber in-flight user input.
          setFeature((prev) => {
            if (!prev && f) {
              setEditStatus(f.status);
              setEditReview(f.needs_human_review);
              setEditProjectId(f.project_id ?? '');
              setEditBudgetDollars(
                f.expected_cost_cents == null ? '' : (f.expected_cost_cents / 100).toFixed(2)
              );
            }
            return f;
          });
          setAuditRows(apayload.rows);
          setLoaded(true);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoaded(true);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [slug, featureId]);

  const sortedAudit = useMemo(() => applySort(auditRows, auditSort), [auditRows, auditSort]);

  const auditColumns: ColumnDef<AuditRow>[] = [
    {
      key: 'ts',
      header: 'When',
      width: 1,
      sortKey: 'ts',
      defaultSortDir: 'desc',
      render: ({ row }) => {
        const ts = typeof row.ts === 'number' ? row.ts : Number(row.ts);
        const valid = Number.isFinite(ts);
        return (
          <span
            title={valid ? new Date(ts).toISOString() : ''}
            style={{ color: '#94a3b8', fontSize: 12 }}
          >
            {valid ? ago(ts) : '—'}
          </span>
        );
      },
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
      key: 'old',
      header: 'Old',
      width: 2,
      render: ({ row }) => (
        <span
          title={row.old_value ?? ''}
          style={{
            color: '#64748b',
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {truncate(row.old_value, 100)}
        </span>
      ),
    },
    {
      key: 'new',
      header: 'New',
      width: 2,
      render: ({ row }) => (
        <span
          title={row.new_value ?? ''}
          style={{
            color: '#cbd5e1',
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {truncate(row.new_value, 100)}
        </span>
      ),
    },
  ];

  const claims = parseClaims(feature?.claims ?? null);

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
            fontSize: 12,
            color: '#94a3b8',
          }}
        >
          <a href="/features" style={{ color: '#94a3b8', textDecoration: 'none' }}>
            features
          </a>
          <span>›</span>
          <a href={`/harness/${slug}`} style={{ color: '#94a3b8', textDecoration: 'none' }}>
            {slug}
          </a>
          <span>›</span>
          <span style={{ color: '#7dd3fc', fontFamily: 'ui-monospace, monospace' }}>{featureId}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              flex: '1 1 auto',
              minWidth: 0,
            }}
          >
            {feature?.title || (error ? '—' : loaded ? `${featureId} (deleted)` : 'Loading…')}
          </h1>
          {feature && <StatusPill value={feature.status} large />}
          {!feature && loaded && !error && (
            <span
              title="this feature_id is no longer in the work queue; only audit history remains"
              style={{
                display: 'inline-block',
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 999,
                background: 'rgba(148,163,184,0.16)',
                color: '#94a3b8',
                border: '1px solid rgba(148,163,184,0.30)',
                letterSpacing: '0.06em',
              }}
            >
              DELETED
            </span>
          )}
          {feature?.needs_human_review && (
            <span
              style={{
                display: 'inline-block',
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 999,
                background: 'rgba(245,158,11,0.20)',
                color: '#fbbf24',
                border: '1px solid rgba(245,158,11,0.45)',
                letterSpacing: '0.06em',
              }}
            >
              NEEDS REVIEW
            </span>
          )}
        </div>
        {feature?.summary && (
          <p style={{ margin: '8px 0 0 0', fontSize: 13, color: '#94a3b8' }}>{feature.summary}</p>
        )}
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

      {!loaded && !error && (
        <div style={{ color: '#64748b', fontSize: 13 }}>Loading feature…</div>
      )}

      {loaded && !feature && !error && auditRows.length === 0 && (
        <div style={{ padding: 16, color: '#64748b', fontSize: 13 }}>
          No feature with id <code style={{ color: '#7dd3fc' }}>{featureId}</code> in harness{' '}
          <code style={{ color: '#7dd3fc' }}>{slug}</code>, and no audit history exists.
        </div>
      )}

      {/* If the feature is gone but the audit trail remains, render audit only. */}
      {loaded && !feature && auditRows.length > 0 && (
        <>
          <div
            style={{
              padding: 12,
              background: 'rgba(148,163,184,0.10)',
              border: '1px solid rgba(148,163,184,0.20)',
              borderRadius: 8,
              color: '#94a3b8',
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            This feature has been removed from the work queue. The audit timeline below shows its
            full lifecycle.
          </div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '4px 0 10px 0' }}>
            Audit timeline ({sortedAudit.length})
          </h2>
          <RichGrid<AuditRow>
            rows={sortedAudit}
            columns={auditColumns}
            getRowId={(r) => String(r.id)}
            sortState={auditSort}
            onSortChange={setAuditSort}
          />
        </>
      )}

      {feature && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <StatRow label="Attempts">
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: feature.attempts > 1 ? '#fbbf24' : '#e2e8f0',
                  fontWeight: feature.attempts > 1 ? 600 : 400,
                }}
              >
                {feature.attempts || 0}
              </span>
            </StatRow>
            <StatRow label="Budget">{fmtCents(feature.expected_cost_cents)}</StatRow>
            <StatRow label="Project">
              {feature.project_id ? (
                <a
                  href={`/projects/${feature.project_id}`}
                  style={{
                    color: '#93c5fd',
                    textDecoration: 'none',
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 12,
                  }}
                >
                  {feature.project_id.slice(0, 12)}…
                </a>
              ) : (
                <span style={{ color: '#475569' }}>—</span>
              )}
            </StatRow>
            <StatRow label="Created">
              <span
                title={new Date(feature.created_ts).toISOString()}
                style={{ color: '#94a3b8' }}
              >
                {ago(feature.created_ts)}
              </span>
            </StatRow>
            <StatRow label="Updated">
              <span
                title={new Date(feature.updated_ts).toISOString()}
                style={{ color: '#94a3b8' }}
              >
                {ago(feature.updated_ts)}
              </span>
            </StatRow>
            <StatRow label="Kind">
              {feature.kind ? (
                <span
                  style={{
                    display: 'inline-block',
                    padding: '1px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 999,
                    background: 'rgba(168,85,247,0.16)',
                    color: '#d8b4fe',
                    border: '1px solid rgba(168,85,247,0.3)',
                  }}
                >
                  {feature.kind}
                </span>
              ) : (
                <span style={{ color: '#475569' }}>—</span>
              )}
            </StatRow>
            <StatRow label="Taken by">{feature.taken_by ?? <span style={{ color: '#475569' }}>—</span>}</StatRow>
          </div>

          <EditPanel
            slug={slug}
            featureId={featureId}
            feature={feature}
            editStatus={editStatus}
            setEditStatus={setEditStatus}
            editReview={editReview}
            setEditReview={setEditReview}
            editProjectId={editProjectId}
            setEditProjectId={setEditProjectId}
            editBudgetDollars={editBudgetDollars}
            setEditBudgetDollars={setEditBudgetDollars}
            saving={saving}
            setSaving={setSaving}
            saveMsg={saveMsg}
            setSaveMsg={setSaveMsg}
            onSaved={(updated) => {
              setFeature(updated);
              setEditStatus(updated.status);
              setEditReview(updated.needs_human_review);
              setEditProjectId(updated.project_id ?? '');
              setEditBudgetDollars(
                updated.expected_cost_cents == null
                  ? ''
                  : (updated.expected_cost_cents / 100).toFixed(2)
              );
            }}
          />

          {claims.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '0 0 8px 0' }}>
                Claims ({claims.length})
              </h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {claims.map((c) => (
                  <code
                    key={c}
                    style={{
                      display: 'inline-block',
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 6,
                      background: 'rgba(15,23,42,0.6)',
                      border: '1px solid rgba(148,163,184,0.18)',
                      color: '#7dd3fc',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {c}
                  </code>
                ))}
              </div>
            </div>
          )}

          {feature.tags && feature.tags.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '0 0 8px 0' }}>
                Tags
              </h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {feature.tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      fontSize: 11,
                      borderRadius: 999,
                      background: 'rgba(52,211,153,0.16)',
                      color: '#6ee7b7',
                      border: '1px solid rgba(52,211,153,0.3)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {feature.notes && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '0 0 8px 0' }}>
                Notes
              </h2>
              <pre
                style={{
                  margin: 0,
                  padding: 14,
                  background: 'rgba(15,23,42,0.6)',
                  border: '1px solid rgba(148,163,184,0.18)',
                  borderRadius: 8,
                  color: '#cbd5e1',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'ui-monospace, monospace',
                  maxHeight: 320,
                  overflow: 'auto',
                }}
              >
                {feature.notes}
              </pre>
            </div>
          )}

          {feature.metadata && Object.keys(feature.metadata).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '0 0 8px 0' }}>
                Metadata
              </h2>
              <pre
                style={{
                  margin: 0,
                  padding: 14,
                  background: 'rgba(15,23,42,0.6)',
                  border: '1px solid rgba(148,163,184,0.18)',
                  borderRadius: 8,
                  color: '#cbd5e1',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                  maxHeight: 320,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(feature.metadata, null, 2)}
              </pre>
            </div>
          )}

          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8', margin: '4px 0 10px 0' }}>
            Audit timeline ({sortedAudit.length})
          </h2>
          <RichGrid<AuditRow>
            rows={sortedAudit}
            columns={auditColumns}
            getRowId={(r) => String(r.id)}
            sortState={auditSort}
            onSortChange={setAuditSort}
          />
        </>
      )}
    </div>
  );
}
