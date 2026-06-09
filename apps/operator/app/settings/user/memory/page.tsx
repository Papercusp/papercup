'use client';

import { useEffect, useState, useCallback, useMemo, type ReactElement } from 'react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
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
  created_at?: string | null;
  updated_at?: string | null;
  audit?: AuditFields;
}

// Styling hints only — never a filter source (the kind taxonomy is
// backend-defined and has already changed once; chips are derived from
// the data, memory-settings-page-refresh D-001). Unknown kinds get the
// gray fallback.
const KIND_COLORS: Record<string, string> = {
  // Claude-file / hybrid taxonomy (the live store)
  user:       '#a78bfa',
  feedback:   '#34d399',
  reference:  '#60a5fa',
  project:    '#fbbf24',
  // Legacy mem0 taxonomy (older rows)
  identity:   '#a78bfa',
  preference: '#34d399',
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

/** Compact relative timestamp — '3d ago', 'just now'. */
function timeAgo(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Bodies longer than this render collapsed until the row is expanded. */
const COLLAPSE_OVER = 280;
const COLLAPSED_PREVIEW = 240;

interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
  learning_instructions: string | null;
}

interface ClaudeHygiene {
  activeCount: number;
  overflowCount: number;
  indexBytes: number;
}

/** Kind suggestions for the add form — the unified taxonomy
 * (memory-taxonomy-and-debt-followups D-001); free text also accepted. */
const KIND_SUGGESTIONS = ['user', 'feedback', 'project', 'reference'];

export default function MemoryPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [reason, setReason] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<string | null>(null);
  const [availableBackends, setAvailableBackends] = useState<string[]>([]);
  const [currentBackend, setCurrentBackend] = useState<string>('');
  const [switchingBackend, setSwitchingBackend] = useState(false);
  // URL-backed view state (nuqs) so agents can read + drive the page and
  // the view survives reloads. Lifecycle/edit-draft state stays useState.
  const [filter, setFilter] = useQueryState('kind', parseAsString.withDefault('all'));
  const [flaggedOnly, setFlaggedOnly] = useQueryState('flagged', parseAsBoolean.withDefault(false));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [expandedId, setExpandedId] = useQueryState('mem', parseAsString);
  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [semantic, setSemantic] = useQueryState('sem', parseAsBoolean.withDefault(false));
  const [auditBusy, setAuditBusy] = useState<boolean>(false);
  const [harnesses, setHarnesses] = useState<string[]>([]);
  const [hygiene, setHygiene] = useState<ClaudeHygiene | null>(null);
  // Add-form drafts — mid-edit state, stays useState per the nuqs rules.
  const [draftText, setDraftText] = useState('');
  const [draftKind, setDraftKind] = useState('');
  const [draftScope, setDraftScope] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  // Semantic hits: memory id → relevance score (null = not in semantic mode).
  const [semHits, setSemHits] = useState<Map<string, number> | null>(null);

  // Envelope meta (backend selection + availability + session user) is a
  // one-shot REST fetch; the ROWS ride the audited @papercusp/sync path
  // below (P-007) and refresh themselves on server-side invalidates.
  const refreshMeta = useCallback(async () => {
    try {
      const [r, fs] = await Promise.all([
        fetch('/api/user/memory/backend'),
        fetch('/api/user/memory/feedback'),
      ]);
      if (r.ok) {
        const j = await r.json();
        setUserId(typeof j.userId === 'string' ? j.userId : null);
        setReason(j.reason ?? null);
        setBackendName(j.backend ?? null);
        setAvailableBackends(Array.isArray(j.availableBackends) ? j.availableBackends : []);
        setCurrentBackend(j.currentBackend ?? j.backend ?? '');
        setHarnesses(Array.isArray(j.harnesses) ? j.harnesses : []);
        setHygiene(j.hygiene ?? null);
      }
      if (fs.ok) setStats(await fs.json());
    } finally {
      setMetaLoaded(true);
    }
  }, []);

  useEffect(() => { void refreshMeta(); }, [refreshMeta]);

  // The row set — server writes (REST routes AND the memory:* MCP verbs)
  // fire notifySyncInvalidate('userMemory.list'), so agent-side edits
  // appear here live without manual refresh (P-008).
  const { data: rows, loading: rowsLoading } = useSyncQuery<MemoryRow>({
    queryName: 'userMemory.list',
    args: { userId: userId ?? '' },
    enabled: !!userId,
  });
  const loading = !metaLoaded || (!!userId && rowsLoading);

  const switchBackend = useCallback(async (choice: string) => {
    if (!choice || choice === currentBackend) return;
    setSwitchingBackend(true);
    try {
      const r = await fetch('/api/user/memory/backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: choice }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(`Switch failed: ${j.error ?? r.status}`);
        return;
      }
      setCurrentBackend(choice);
      if (j.availability && j.availability.ok === false) {
        toast.warning(`Switched to ${choice}, but it's unavailable: ${j.availability.reason}`);
      } else {
        toast.success(`Memory backend → ${choice}`);
      }
      await refreshMeta();
    } finally {
      setSwitchingBackend(false);
    }
  }, [currentBackend, refreshMeta]);

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
      setEditingId(null);
      // Rows refresh via the server's userMemory.list invalidate.
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
      // Rows refresh via the server's invalidate; stats changed too.
      void refreshMeta();
    } else {
      toast.error('Delete failed');
    }
  }, [askConfirm, refreshMeta]);

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
      await refreshMeta();
    }
  }, [refreshMeta, askConfirm]);

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
        await refreshMeta();
      } else {
        toast.error(`Re-embed failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Re-embed failed: ${(err as Error).message}`);
    } finally {
      setReembedBusy(null);
    }
  }, [refreshMeta, askConfirm]);

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
        // Badge changes arrive via the audit route's invalidate.
      } else {
        toast.error(`Audit failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Audit failed: ${(err as Error).message}`);
    } finally {
      setAuditBusy(false);
    }
  }, [askConfirm]);

  // Chips are derived from the kinds actually present (D-001) — the
  // taxonomy is the backend's, not the page's. Counts over ALL rows so
  // a chip doesn't vanish while it's the active filter.
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r.kind ?? 'untagged';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const kindChips = useMemo(
    () => [...kindCounts.keys()].sort((a, b) => (kindCounts.get(b)! - kindCounts.get(a)!) || a.localeCompare(b)),
    [kindCounts],
  );

  const query = q.trim().toLowerCase();

  // Semantic mode (P-011): rank rows by the backend's hybrid search
  // relevance instead of substring match. Debounced; rides the existing
  // /api/user/search endpoint (same path as memory:search).
  useEffect(() => {
    if (!semantic || !query) { setSemHits(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/user/search?q=${encodeURIComponent(query)}&limit=20`);
          if (!r.ok || cancelled) return;
          const j = await r.json();
          const m = new Map<string, number>();
          for (const h of j.memories ?? []) {
            m.set(h.id as string, typeof h.score === 'number' ? h.score : 0);
          }
          if (!cancelled) setSemHits(m);
        } catch { /* leave previous hits */ }
      })();
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [semantic, query]);

  const filtered = useMemo(() => {
    let out = rows.filter((r) => {
      if (filter !== 'all' && (r.kind ?? 'untagged') !== filter) return false;
      if (flaggedOnly && !isFlagged(r)) return false;
      return true;
    });
    if (query) {
      if (semantic && semHits) {
        out = out
          .filter((r) => semHits.has(r.id))
          .sort((a, b) => (semHits.get(b.id) ?? 0) - (semHits.get(a.id) ?? 0));
      } else {
        out = out.filter((r) => {
          const desc = String((r.metadata as Record<string, unknown> | undefined)?.description ?? '');
          return `${r.id}\n${desc}\n${r.text}`.toLowerCase().includes(query);
        });
      }
    }
    return out;
  }, [rows, filter, flaggedOnly, query, semantic, semHits]);
  const flaggedCount = useMemo(() => rows.filter(isFlagged).length, [rows]);

  const onAddSave = useCallback(async () => {
    const text = draftText.trim();
    if (!text) return;
    setDraftSaving(true);
    try {
      const r = await fetch('/api/user/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          kind: draftKind.trim() || undefined,
          harness_slug: draftScope || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast.success('Memory saved');
        setDraftText('');
        void setAddOpen(false);
        void refreshMeta();
      } else {
        toast.error(`Save failed: ${j.error ?? r.status}`);
      }
    } finally {
      setDraftSaving(false);
    }
  }, [draftText, draftKind, draftScope, setAddOpen, refreshMeta]);

  const renderRow = useCallback((row: MemoryRow): ReactElement => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const kind = row.kind ?? 'untagged';
    const color = KIND_COLORS[kind] ?? '#6b7280';
    const state = row.audit?.state ?? 'active';
    const stateBadge = STATE_BADGES[state];
    const brokenAnchors = row.audit?.broken_anchors ?? [];
    const description = typeof meta.description === 'string' ? meta.description : null;
    const rowDate = row.updated_at ?? row.created_at ?? null;
    const semScore = semHits?.get(row.id);
    const expanded = expandedId === row.id;
    const collapsible = row.text.length > COLLAPSE_OVER;
    const bodyText = collapsible && !expanded
      ? `${row.text.slice(0, COLLAPSED_PREVIEW).trimEnd()}…`
      : row.text;
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
            {rowDate && (
              <span title={new Date(rowDate).toLocaleString()} style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                {timeAgo(rowDate)}
              </span>
            )}
            {semScore !== undefined && (
              <span title="Semantic relevance to your search" style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--bg-3)', fontSize: 11, fontWeight: 600 }}>
                {Math.round(semScore * 100)}% match
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
            <>
              {description && (
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{description}</div>
              )}
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {bodyText}
                {collapsible && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => void setExpandedId(expanded ? null : row.id)}
                      style={{ border: 'none', background: 'transparent', color: 'var(--fg-mute)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                    >
                      {expanded ? 'show less' : 'show more'}
                    </button>
                  </>
                )}
              </div>
            </>
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
  }, [editingId, editingDraft, onSaveEdit, onDelete, expandedId, setExpandedId, semHits]);

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

      {availableBackends.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}>
          <label htmlFor="memory-backend-select" style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
            Active store:
          </label>
          <select
            id="memory-backend-select"
            value={currentBackend}
            disabled={switchingBackend}
            onChange={(e) => void switchBackend(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg)', fontSize: 13, cursor: switchingBackend ? 'wait' : 'pointer' }}
          >
            {availableBackends.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
            <code>claude-file</code> = your real Claude Code memory; <code>mem0</code> = the semantic store. Applies live, no restart.
          </span>
        </div>
      )}

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

      {hygiene && hygiene.overflowCount > 0 && (
        <div style={{ padding: 12, border: '1px solid #f59e0b', borderRadius: 6, background: '#fffbeb', fontSize: 13 }}>
          <strong>⚠ Memory index over capacity.</strong>{' '}
          {hygiene.overflowCount} of {hygiene.activeCount + hygiene.overflowCount} Claude
          file-memories are paged out of the always-loaded index
          (<code>MEMORY-overflow.md</code>) — they&rsquo;re reachable on demand but not
          auto-loaded each session. Curate to bring them back: merge near-duplicates,
          retire obsolete facts, and tighten long descriptions in the topic files
          (the index itself is regenerated, never hand-edited).
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => void setQ(e.target.value || null)}
          placeholder={`Search ${rows.length} memories…`}
          aria-label="Search memories"
          style={{
            padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-2)',
            color: 'var(--fg)', fontSize: 13, flex: 1,
          }}
        />
        <button
          type="button"
          onClick={() => void setSemantic(!semantic)}
          title="Rank by semantic relevance (the same hybrid search agents use) instead of substring match."
          style={{
            padding: '8px 12px', borderRadius: 6,
            border: semantic ? '2px solid var(--fg)' : '1px solid var(--border)',
            background: semantic ? 'var(--bg-3)' : 'var(--bg-2)',
            cursor: 'pointer', fontSize: 13, fontWeight: semantic ? 600 : 400,
            whiteSpace: 'nowrap',
          }}
        >
          ✨ semantic
        </button>
        <button
          type="button"
          onClick={() => void setAddOpen(!addOpen)}
          style={{
            padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--border)',
            background: addOpen ? 'var(--bg-3)' : 'var(--bg-2)',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          ＋ Add memory
        </button>
      </div>

      {addOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={3}
            placeholder="The fact to remember — durable, one fact per memory."
            style={{ width: '100%', padding: 8, fontFamily: 'inherit', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--fg)' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              list="memory-kind-suggestions"
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value)}
              placeholder="kind (optional)"
              aria-label="Memory kind"
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', color: 'var(--fg)', fontSize: 13, width: 160 }}
            />
            <datalist id="memory-kind-suggestions">
              {[...new Set([...KIND_SUGGESTIONS, ...kindChips])].map((k) => <option key={k} value={k} />)}
            </datalist>
            <select
              value={draftScope}
              onChange={(e) => setDraftScope(e.target.value)}
              aria-label="Memory scope"
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', color: 'var(--fg)', fontSize: 13 }}
            >
              <option value="">Personal</option>
              {harnesses.map((h) => <option key={h} value={h}>harness: {h}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void onAddSave()}
              disabled={draftSaving || !draftText.trim()}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: draftSaving || !draftText.trim() ? 0.5 : 1 }}
            >
              {draftSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => void setAddOpen(false)}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['all', ...kindChips].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void setFilter(f)}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: filter === f ? '2px solid var(--fg)' : '1px solid var(--border)',
                background: filter === f ? 'var(--bg-3)' : 'var(--bg-2)',
                cursor: 'pointer', fontSize: 13,
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f} {f !== 'all' && `(${kindCounts.get(f) ?? 0})`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void setFlaggedOnly(!flaggedOnly)}
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
              {rows.length === 0
                ? 'No memories stored yet.'
                : query
                  ? `No memories matching “${q.trim()}”.`
                  : `No memories matching '${filter}'.`}
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
