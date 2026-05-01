'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast, Toaster } from 'sonner';

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

interface SnapshotRow {
  id: string;
  harnessSlug: string;
  bytes: number;
  createdAtMs: number;
  name: string;
  description: string | null;
  template: { name: string; version: string };
  filesCount: number;
  pluginsCount: number;
  partial: boolean;
  publishes: PublishRecord[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function InstalledSnapshotsPage() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/snapshots', { cache: 'no-store' });
      const d = r.ok ? await r.json() : { snapshots: [] };
      setRows(Array.isArray(d?.snapshots) ? d.snapshots : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onDelete = async (s: SnapshotRow) => {
    const has = s.publishes.length > 0;
    const note = has
      ? '\n\nThis will not retract the published version on the marketplace — use Retract first if you also want it gone there.'
      : '';
    if (!confirm(`Delete snapshot ${s.id}?${note}`)) return;
    setBusy(s.id);
    try {
      const r = await fetch(`/api/snapshots/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `delete failed (${r.status})`);
        return;
      }
      toast.success(`Deleted ${s.id}`);
      await load();
    } catch (e) {
      toast.error(`delete error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRetract = async (s: SnapshotRow, marketplaceSlug: string) => {
    if (!confirm(`Retract ${marketplaceSlug} from the marketplace?\n\nMarks the published version as withdrawn. The local snapshot stays intact.`)) return;
    setBusy(`${s.id}:${marketplaceSlug}`);
    try {
      const r = await fetch(`/api/snapshots/${encodeURIComponent(s.id)}/retract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marketplaceSlug, reason: 'retracted from operator listing' }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `retract failed (${r.status})`);
        return;
      }
      toast.success(`Retracted ${marketplaceSlug}`);
      await load();
    } catch (e) {
      toast.error(`retract error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const published = rows.filter((r) => r.publishes.length > 0).length;

  return (
    <div className="pc-shell pc-marketplace-shell">
      <Toaster position="bottom-right" richColors />
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Installed snapshots</p>
          <h1>Snapshots on this machine.</h1>
          <p>Frozen copies of harness state you've taken locally. Publish one to share it on the marketplace.</p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Snapshot stats">
          <div><strong>{rows.length}</strong><span>local</span></div>
          {published > 0 && <div><strong>{published}</strong><span>published</span></div>}
        </div>
      </section>
      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading snapshots…</div>
      ) : rows.length === 0 ? (
        <div className="pc-card pc-marketplace-empty">
          <strong>No snapshots yet.</strong>
          <span>Take a snapshot from a harness to capture its state.</span>
        </div>
      ) : (
        <div className="pc-marketplace-grid">
          {rows.map((s) => (
            <article key={s.id} className="pc-card pc-marketplace-card installed">
              <div className="pc-marketplace-card-head">
                <span className="pc-marketplace-card-icon snapshot"><Lucide.Layers size={18} /></span>
                <div>
                  <span className="pc-marketplace-card-title">{s.name}</span>
                  <span>{s.harnessSlug}</span>
                </div>
                {s.publishes.length > 0 && <em>Published</em>}
              </div>
              {s.description && <p>{s.description}</p>}
              <div className="pc-marketplace-meta">
                <span>{formatDate(s.createdAtMs)}</span>
                <span>{formatBytes(s.bytes)}</span>
                <span>{s.filesCount} files</span>
                {s.pluginsCount > 0 && <span>{s.pluginsCount} plugins</span>}
                <span>{s.template.name} v{s.template.version}</span>
                {s.partial && <span className="accent">partial</span>}
              </div>
              {s.publishes.length > 0 && (
                <div className="pc-marketplace-enabled">
                  <strong>Published as</strong>
                  {s.publishes.map((p) => (
                    <span key={`${p.slug}@${p.version}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <a href={p.browseUrl} target="_blank" rel="noreferrer"><code>{p.slug}@{p.version}</code></a>
                      <button
                        onClick={() => onRetract(s, p.slug)}
                        disabled={busy === `${s.id}:${p.slug}`}
                        title="Retract this published version from the marketplace"
                        style={{
                          padding: '2px 6px', fontSize: 10, background: 'transparent',
                          border: '1px solid var(--border)', color: '#fbbf24', borderRadius: 3,
                          cursor: busy === `${s.id}:${p.slug}` ? 'default' : 'pointer',
                        }}
                      >
                        retract
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => onDelete(s)}
                  disabled={busy === s.id}
                  style={{
                    padding: '4px 10px', background: 'transparent', color: '#f87171',
                    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    cursor: busy === s.id ? 'default' : 'pointer',
                  }}
                >
                  <Lucide.Trash2 size={11} /> delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
