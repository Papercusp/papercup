'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface MemoryRow {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  scope: 'user' | 'workspace';
}

const KIND_COLORS: Record<string, string> = {
  identity:   '#a78bfa',
  preference: '#34d399',
  project:    '#fbbf24',
  correction: '#f87171',
  ephemeral:  '#9ca3af',
};

interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
  learning_instructions: string | null;
}

export default function MemoryPage() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { askConfirm, confirmEl } = useConfirmDialog();
  const [reason, setReason] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

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
      body: JSON.stringify({ id, memory: editingDraft }),
    });
    if (r.ok) {
      toast.success('Updated');
      setRows((rs) => rs.map((x) => (x.id === id ? { ...x, memory: editingDraft } : x)));
      setEditingId(null);
    } else {
      toast.error('Update failed');
    }
  }, [editingDraft]);

  const onDelete = useCallback(async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this memory?',
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
      description: 'Workspace-shared entries are not affected. Type FORGET to confirm.',
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
      description: `This may take 30s-5min depending on size. Existing "${to}" memories with the same id will be overwritten.`,
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

  const filtered = filter === 'all'
    ? rows
    : rows.filter((r) => (r.metadata as Record<string, unknown>)?.kind === filter);

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;

  return (
    <div style={{ padding: 32, maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {confirmEl}
      <header>
        <h1 style={{ marginBottom: 8 }}>Operator memory</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Facts the operator has stored about you. Inspect, edit, or delete
          per entry. Edits and deletes are recorded as feedback signal for
          future tuning. Workspace-shared entries (visible to other users in
          this workspace) are marked with a badge.
        </p>
        {stats && (stats.total_edits > 0 || stats.total_deletes > 0) && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
            Lifetime feedback: <strong>{stats.total_edits}</strong> edits, <strong>{stats.total_deletes}</strong> deletes
          </p>
        )}
        {stats?.learning_instructions && (
          <details style={{ marginTop: 12, padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
              Active extraction-prompt adaptation (from your feedback)
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, marginTop: 8, color: 'var(--text)' }}>
              {stats.learning_instructions}
            </pre>
          </details>
        )}
      </header>

      {reason && (
        <div style={{ padding: 12, border: '1px solid #f59e0b', borderRadius: 6, background: '#fffbeb' }}>
          Memory backend unavailable: <code>{reason}</code>.
          {reason === 'mem0_unavailable' && (
            <> Run <code>npm install</code> in <code>apps/operator</code> to enable.</>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {['all', 'identity', 'preference', 'project', 'correction', 'ephemeral'].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: filter === f ? '2px solid var(--text)' : '1px solid var(--border)',
                background: filter === f ? 'var(--surface-hover)' : 'var(--surface)',
                cursor: 'pointer', fontSize: 13,
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f} {f !== 'all' && `(${rows.filter((r) => (r.metadata as Record<string, unknown>)?.kind === f).length})`}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          {rows.length === 0 ? 'No memories stored yet.' : `No memories matching '${filter}'.`}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((row) => {
            const meta = (row.metadata ?? {}) as Record<string, unknown>;
            const kind = (meta.kind as string) ?? 'unknown';
            const color = KIND_COLORS[kind] ?? '#6b7280';
            return (
              <li
                key={row.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  padding: 12, gap: 12,
                  borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--surface)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: color, color: '#fff', fontSize: 11, fontWeight: 600 }}>{kind}</span>
                    {row.scope === 'workspace' && (
                      <span style={{ padding: '2px 8px', borderRadius: 4, background: '#3b82f6', color: '#fff', fontSize: 11 }}>shared</span>
                    )}
                    {meta.harness_slug && (
                      <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--surface-hover)', fontSize: 11 }}>{meta.harness_slug as string}</span>
                    )}
                    {meta.expires_at && (
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>expires {new Date(meta.expires_at as string).toLocaleString()}</span>
                    )}
                  </div>
                  {editingId === row.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        rows={3}
                        style={{ width: '100%', padding: 6, fontFamily: 'inherit', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface-hover)', color: 'var(--text)' }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => onSaveEdit(row.id)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-hover)', cursor: 'pointer', fontSize: 12 }}>Save</button>
                        <button type="button" onClick={() => setEditingId(null)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.memory}</div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(row.id);
                      setEditingDraft(row.memory);
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
          })}
        </ul>
      )}
    </div>
  );
}
