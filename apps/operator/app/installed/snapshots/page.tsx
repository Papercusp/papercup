'use client';

import { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetch('/api/snapshots', { cache: 'no-store' });
        const d = r.ok ? await r.json() : { snapshots: [] };
        if (!cancelled) setRows(Array.isArray(d?.snapshots) ? d.snapshots : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const published = rows.filter((r) => r.publishes.length > 0).length;

  return (
    <div className="pc-shell pc-marketplace-shell">
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
                    <a key={p.slug} href={p.browseUrl} target="_blank" rel="noreferrer"><code>{p.slug}@{p.version}</code></a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
