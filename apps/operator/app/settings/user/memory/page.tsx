'use client';

import { useEffect, useState, useCallback, type ReactElement } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface BrokenAnchor {
  kind: string;
  value: string;
  reason: string | null;
}

interface AuditFields {
  state: string;
  last_validated_at: string | null;
  last_surfaced_at: string | null;
  broken_anchors: BrokenAnchor[];
}

// The neutral memory entry shape served by /api/user/memory
// (generalize-memory-backend-swappable D-003) — backend-agnostic:
// text/kind at the top level, never a mem0 row.
interface MemoryRow {
  id: string;
  text: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
  audit?: AuditFields;
}

const KIND_COLORS: Record<string, string> = {
  identity:   '#a78bfa',
  preference: '#34d399',
  project:    '#fbbf24',
  correction: '#f87171',
  ephemeral:  '#9ca3af',
};

const STATE_BADGES: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  active:        { label: 'verified',           icon: '✓', color: '#065f46', bg: '#d1fae5' },
  broken_anchor: { label: 'broken anchor',      icon: '⚠', color: '#92400e', bg: '#fef3c7' },
  superseded:    { label: 'superseded',         icon: '🔄', color: '#1e40af', bg: '#dbeafe' },
  contradicted: { label: 'contradicted',       icon: '❌', color: '#991b1b', bg: '#fee2e2' },
  forgotten:     { label: 'forgotten',          icon: '🗑', color: '#374151', bg: '#e5e7eb' },
};

function isFlagged(row: MemoryRow): boolean {
  const state = row.audit?.state ?? 'active';
  return state !== 'active';
}

interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
  learning_instructions: string | null;
}

export default function MemoryPage() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [reason, setReason] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [flaggedOnly, setFlaggedOnly] = useState<boolean>(false);
  const [auditBusy, setAuditBusy] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [r, fs] = await Promise.all([
        fetch('/api/user/memory'),
        fetch('/api/user/memory/feedback'),
      ]);
      if (!r.ok) { setRows([]); return; }
      const j = await r.json();
      setRows(j.results ?? []);
      setReason(j.reason ?? null);
      setBackendName(j.backend ?? null);
      if (fs.ok) setStats(await fs.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const onSaveEdit = useCallback(async (id: string) => {
    const r = await fetch('/api/user/memory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text: editingDraft }),
    });
    if (r.ok) {
      toast.success('Updated');
      setRows((rs) => rs.map((x) => (x.id === id ? { ...x, text: editingDraft } : x)));
      setEditingId(null);
    } else {
      toast.error('Update failed');
    }
  }, [editingDraft]);

  const onDelete = useCallback(async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this memory?',
      body: 'This memory will be removed and a feedback entry recorded so the extractor learns to skip similar memories.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/user/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.ok) {
      toast.success('Deleted');
      setRows((rs) => rs.filter((x) => x.id !== id));
    } else {
      toast.error('Delete failed');
    }
  }, [askConfirm]);

  const onForgetAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Delete ALL of your memories?',
      body: 'Workspace-shared entries are not affected. Type FORGET to confirm.',
      confirmLabel: 'Forget all',
      destructive: true,
      requireType: 'FORGET',
    });
    if (!ok) return;
    const r = await fetch('/api/user/memory?all=1', { method: 'DELETE' });
    if (r.ok) {
      const j = await r.json();
      toast.success(`Deleted ${j.deleted} memories`);
      await refresh();
    }
  }, [refresh, askConfirm]);

  const [reembedBusy, setReembedBusy] = useState<null | 'openai-to-local' | 'local-to-openai'>(null);
  const onReembed = useCallback(async (from: 'openai' | 'local', to: 'openai' | 'local') => {
    const ok = await askConfirm({
      title: `Re-embed memories from "${from}" → "${to}"?`,
      body: `This may take 30s-5min depending on size. Existing "${to}" memories with the same id will be overwritten.`,
      confirmLabel: 'Re-embed',
    });
    if (!ok) return;
    setReembedBusy(`${from}-to-${to}` as typeof reembedBusy);
    try {
      const r = await fetch('/api/user/memory/reembed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const j = await r.json();
      if (r.ok) {
        toast.success(`Re-embedded ${j.reembedded} of ${j.totalSource} (${j.skipped} skipped, ${j.errors} errors) in ${Math.round(j.durationMs / 100) / 10}s`);
        await refresh();
      } else {
        toast.error(`Re-embed failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Re-embed failed: ${(err as Error).message}`);
    } finally {
      setReembedBusy(null);
    }
  }, [refresh, askConfirm]);

  const onAuditAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Audit all memories?',
      body: 'Runs the structural anchor check (Layer 1). Free and fast — checks that files / plans / migrations referenced by your memories still exist. Results land as status badges below.',
      confirmLabel: 'Audit',
    });
    if (!ok) return;
    setAuditBusy(true);
    try {
      const r = await fetch('/api/user/memory/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (r.ok) {
        if (j.skipped) {
          toast.warning(`Audit skipped: ${j.reason}`);
        } else {
          toast.success(`Audit complete: ${j.summary ?? 'done'}`);
        }
        await refresh();
      } else {
        toast.error(`Audit failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Audit failed: ${(err as Error).message}`);
    } finally {
      setAuditBusy(false);
    }
  }, [askConfirm, refresh]);

  const filteredByKind = filter === 'all'
    ? rows
    : rows.filter((r) => r.kind === filter);
  const filtered = flaggedOnly
    ? filteredByKind.filter(isFlagged)
    : filteredByKind;
  const flaggedCount = rows.filter(isFlagged).length;

  const renderRow = useCallback((row: MemoryRow): ReactElement => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const kind = row.kind ?? 'unknown';
    const color = KIND_COLORS[kind] ?? '#6b7280';
    const state = row.audit?.state ?? 'active';
    const stateBadge = STATE_BADGES[state];
    const brokenAnchors = row.audit?.broken_anchors ?? [];
    return (
      <li
        key={row.id}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: 12, gap: 12,
          borderRadius: 6,
          border: state !== 'active' ? '1px solid #f59e0b' : '1px solid var(--border)',
          background: 'var(--bg-2)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ padding: '2px 8px', borderRadius: 4, background: color, color: '#fff', fontSize: 11, fontWeight: 600 }}>{kind}</span>
            {stateBadge && state !== 'active' && (
              <span
                title={brokenAnchors.length > 0
                  ? `Broken anchors:\n${brokenAnchors.map((a) => `• ${a.kind}:${a.value}${a.reason ? ` (${a.reason})` : ''}`).join('\n')}`
                  : `State: ${state}`}
                style={{
                  padding: '2px 8px', borderRadius: 4,
                  background: stateBadge.bg, color: stateBadge.color,
                  fontSize: 11, fontWeight: 600,
                  cursor: brokenAnchors.length > 0 ? 'help' : 'default',
                }}
              >
                {stateBadge.icon} {stateBadge.label}
              </span>
            )}
            {meta.expires_at !== undefined && (
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>expires {new Date(meta.expires_at as string).toLocaleString()}</span>
            )}
            {row.audit?.last_validated_at && (
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                audited {new Date(row.audit.last_validated_at).toLocaleString()}
              </span>
            )}
          </div>
          {brokenAnchors.length > 0 && (
            <div style={{ marginBottom: 4, fontSize: 12, color: '#92400e' }}>
              {brokenAnchors.map((a, i) => (
                <div key={`${a.kind}-${a.value}-${i}`}>
                  <code style={{ background: 'transparent', color: '#92400e' }}>{a.kind}:{a.value}</code>
                  {a.reason && <> — {a.reason}</>}
                </div>
              ))}
            </div>
          )}
          {editingId === row.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={editingDraft}
                onChange={(e) => setEditingDraft(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: 6, fontFamily: 'inherit', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--fg)' }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => onSaveEdit(row.id)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', fontSize: 12 }}>Save</button>
                <button type="button" onClick={() => setEditingId(null)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.text}</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setEditingId(row.id);
              setEditingDraft(row.text);
            }}
            disabled={editingId !== null && editingId !== row.id}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer' }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(row.id)}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid #f87171', color: '#f87171', cursor: 'pointer' }}
          >
            Delete
          </button>
        </div>
      </li>
    );
  }, [editingId, editingDraft, onSaveEdit, onDelete]);

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;

  return (
    <div style={{ padding: 32, maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {confirmEl}
      <header>
        <h1>Papercusp memory</h1>
        <p className="pc-settings-intro">
          Everything Papercusp remembers, organized by who can see it.
          Personal entries are private to you; per-harness entries are
          shared with anyone working on that project; the deprecated
          workspace tier is shown only if you have legacy entries to
          clean up. Edits and deletes are recorded as feedback for
          future tuning.
        </p>
        {stats && (stats.total_edits > 0 || stats.total_deletes > 0) && (
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '8px 0 0' }}>
            Lifetime feedback: <strong>{stats.total_edits}</strong> edits, <strong>{stats.total_deletes}</strong> deletes
          </p>
        )}
        {stats?.learning_instructions && (
          <details style={{ marginTop: 12, padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--fg-mute)' }}>
              Active extraction-prompt adaptation (from your feedback)
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, marginTop: 8, color: 'var(--fg)' }}>
              {stats.learning_instructions}
            </pre>
          </details>
        )}
      </header>

      {reason && (
        <div style={{ padding: 12, border: '1px solid #f59e0b', borderRadius: 6, background: '#fffbeb' }}>
          Memory backend{backendName ? <> (<code>{backendName}</code>)</> : null} unavailable: <code>{reason}</code>.
          {reason === 'mem0_unavailable' && (
            <> Run <code>npm install</code> in <code>apps/operator</code> to enable.</>
          )}
          {reason === 'memory_backend_disabled' && (
            <> The store is deliberately off (<code>PAPERCUSP_MEMORY_BACKEND=noop</code>); flip the env var to re-enable.</>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* `ephemeral` retired (docs-and-memory-as-projections D-006); legacy
              rows still render via the KIND_COLORS fallback but get no chip. */}
          {['all', 'identity', 'preference', 'project', 'correction'].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: filter === f ? '2px solid var(--fg)' : '1px solid var(--border)',
                background: filter === f ? 'var(--bg-3)' : 'var(--bg-2)',
                cursor: 'pointer', fontSize: 13,
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f} {f !== 'all' && `(${rows.filter((r) => r.kind === f).length})`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFlaggedOnly((v) => !v)}
            title="Show only memories with broken anchors / contradictions / etc."
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: flaggedOnly ? '2px solid #f59e0b' : '1px solid var(--border)',
              background: flaggedOnly ? '#fef3c7' : 'var(--bg-2)',
              color: flaggedOnly ? '#92400e' : 'var(--fg)',
              cursor: 'pointer', fontSize: 13,
              fontWeight: flaggedOnly ? 600 : 400,
            }}
          >
            ⚠ flagged only ({flaggedCount})
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onAuditAll}
            disabled={auditBusy || rows.length === 0}
            title="Run the Layer 1 structural anchor audit — checks that every file / plan / migration referenced by a memory still exists. Free and fast."
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: '1px solid var(--border)',
              background: auditBusy ? 'var(--bg-2)' : 'var(--bg-3)',
              cursor: auditBusy ? 'wait' : 'pointer',
              fontSize: 13, fontWeight: 600,
              opacity: auditBusy ? 0.5 : 1,
            }}
          >
            {auditBusy ? 'Auditing…' : 'Audit all'}
          </button>
          <button
            type="button"
            onClick={() => onReembed('openai', 'local')}
            disabled={reembedBusy !== null}
            title="Re-embed openai-collection memories into the local-collection so they're visible after switching memoryEmbedderMode to local."
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'openai-to-local' ? 'Re-embedding…' : 'openai → local'}
          </button>
          <button
            type="button"
            onClick={() => onReembed('local', 'openai')}
            disabled={reembedBusy !== null}
            title="Re-embed local-collection memories into the openai-collection so they're visible after switching memoryEmbedderMode to openai."
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'local-to-openai' ? 'Re-embedding…' : 'local → openai'}
          </button>
          <button
            type="button"
            onClick={onForgetAll}
            disabled={rows.length === 0}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #f87171', color: '#f87171', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
          >
            Forget all my memories
          </button>
        </div>
      </div>

      {(() => {
        const userRows = filtered.filter((r) => r.scope === 'user');
        const harnessRows = filtered.filter((r) => r.scope === 'harness');
        const workspaceRows = filtered.filter((r) => r.scope === 'workspace');

        if (filtered.length === 0) {
          return (
            <p style={{ color: 'var(--fg-mute)' }}>
              {rows.length === 0 ? 'No memories stored yet.' : `No memories matching '${filter}'.`}
            </p>
          );
        }

        // Group harness rows by slug
        const bySlug = new Map<string, MemoryRow[]>();
        for (const r of harnessRows) {
          const slug = r.harness_slug ?? (r.metadata as Record<string, unknown> | undefined)?.harness_slug as string ?? 'unknown';
          if (!bySlug.has(slug)) bySlug.set(slug, []);
          bySlug.get(slug)!.push(r);
        }

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Section
              title="My memory"
              description="Personal facts about you. Private — only you see these. Carried across every project."
              rows={userRows}
              renderRow={renderRow}
              empty="No personal memories yet. Tell Papercusp something to remember — &ldquo;remember I prefer terse replies&rdquo; — and it&rsquo;ll land here."
            />
            <Section
              title="Per-harness memory"
              description="Project-specific facts shared with anyone who has access to that harness. Use these for team conventions, project context, or anything an agent working on this project should know."
              rows={harnessRows}
              renderRow={renderRow}
              groupedBySlug={bySlug}
              empty="No per-harness memories yet. Ask Papercusp to remember a project fact and tag a harness — &ldquo;for the sheets harness, we use BigQuery&rdquo;."
            />
            {workspaceRows.length > 0 && (
              <Section
                title="Deprecated — workspace memory"
                description="Older shared memories from before per-harness scope existed. Move important ones into the right harness (delete here, then ask Papercusp to remember with a harness_slug), or just delete."
                rows={workspaceRows}
                renderRow={renderRow}
                deprecated
              />
            )}
          </div>
        );
      })()}
    </div>
  );
}

function Section(props: {
  title: string;
  description: string;
  rows: MemoryRow[];
  renderRow: (row: MemoryRow) => ReactElement;
  empty?: string;
  groupedBySlug?: Map<string, MemoryRow[]>;
  deprecated?: boolean;
}) {
  const { title, description, rows, renderRow, empty, groupedBySlug, deprecated } = props;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, opacity: deprecated ? 0.7 : 1 }}>{title}</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-mute)' }}>{description}</p>
      </div>
      {rows.length === 0 ? (
        empty ? <p style={{ color: 'var(--fg-mute)', fontSize: 13, fontStyle: 'italic', margin: 0 }}>{empty}</p> : null
      ) : groupedBySlug ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[...groupedBySlug.entries()].map(([slug, slugRows]) => (
            <div key={slug} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 13, color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{slug}</h3>
              <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {slugRows.map(renderRow)}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(renderRow)}
        </ul>
      )}
    </section>
  );
}
