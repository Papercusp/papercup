'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

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
  excludedCount: number;
  pluginsCount: number;
  partial: boolean;
  license: string;
  redactions: { blockedSecretsTier: string; verifiedHits: number; highRecallHits: number };
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

export default function MarketplaceSnapshotsPage() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const publishedCount = useMemo(() => rows.filter((row) => row.publishes.length > 0).length, [rows]);
  const totalBytes = useMemo(() => rows.reduce((sum, row) => sum + row.bytes, 0), [rows]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/snapshots', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setRows(d.snapshots ?? []);
    } catch (e: unknown) {
      toast.error(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onInstantiate = async (row: SnapshotRow) => {
    const proposed = `${row.harnessSlug}-fork-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
    const name = window.prompt('Name for the new harness? Cancel to use the auto-generated name.', proposed);
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}/instantiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name?.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Instantiated as ${d.newSlug}`, {
        description: 'Open the Harnesses tab to find it.',
        action: { label: 'Open', onClick: () => { window.location.href = `/harness?slug=${d.newSlug}`; } },
        duration: 8000,
      });
    } catch (e: unknown) {
      toast.error(`instantiate failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onPublish = async (row: SnapshotRow) => {
    if (!confirm(`Publish “${row.name}” (${formatBytes(row.bytes)}) to the marketplace?`)) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Published ${d.slug}@${d.version}`, {
        action: { label: 'Open marketplace', onClick: () => { window.open(d.browseUrl, '_blank'); } },
        duration: 10000,
      });
    } catch (e: unknown) {
      toast.error(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (row: SnapshotRow) => {
    if (!confirm(`Delete local snapshot ${row.id}? Published copies are unaffected.`)) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success(`Deleted ${row.id}`);
      await load();
    } catch (e: unknown) {
      toast.error(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Snapshots</p>
          <h1>Forkable harness state, ready to publish.</h1>
          <p>
            Snapshots freeze project files, database state, plugin enablement, and redaction metadata so a harness can be restored, forked, or shared through the marketplace.
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Snapshot status">
          <div><strong>{rows.length}</strong><span>local snapshots</span></div>
          <div><strong>{publishedCount}</strong><span>published</span></div>
          <div><strong>{formatBytes(totalBytes)}</strong><span>stored locally</span></div>
        </div>
      </section>

      <div className="pc-marketplace-snapshot-toolbar">
        <div>
          <strong>{loading ? 'Loading snapshots…' : `${rows.length} snapshot${rows.length === 1 ? '' : 's'} available`}</strong>
          <span>Instantiate to fork, publish to share, or delete local tarballs.</span>
        </div>
        <button type="button" className="pc-button ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!loading && rows.length === 0 && (
        <div className="pc-card pc-marketplace-empty">
          <strong>No snapshots yet.</strong>
          <span>Open a harness and click Save snapshot to create your first forkable artifact.</span>
          <a href="/harness" className="pc-button">Open harnesses</a>
        </div>
      )}

      {rows.length > 0 && (
        <div className="pc-marketplace-snapshot-grid">
          {rows.map((row) => {
            const busy = busyId === row.id;
            const clean = row.redactions.verifiedHits === 0 && row.redactions.highRecallHits === 0;
            return (
              <article key={row.id} className="pc-card pc-marketplace-snapshot-card">
                <div className="pc-marketplace-snapshot-head">
                  <div>
                    <span>{row.template.name}@{row.template.version}</span>
                    <h2>{row.name}</h2>
                  </div>
                  <em>{row.partial ? 'partial' : 'complete'}</em>
                </div>
                {row.description && <p>{row.description}</p>}
                <div className="pc-marketplace-snapshot-meta">
                  <span><strong>Harness</strong><code>{row.harnessSlug}</code></span>
                  <span><strong>Created</strong>{formatDate(row.createdAtMs)}</span>
                  <span><strong>Size</strong>{formatBytes(row.bytes)}</span>
                  <span><strong>Files</strong>{row.filesCount}</span>
                  <span><strong>Plugins</strong>{row.pluginsCount}</span>
                  <span><strong>Redactions</strong>{clean ? 'clean' : `${row.redactions.verifiedHits} verified · ${row.redactions.highRecallHits} warnings`}</span>
                </div>
                {row.publishes.length > 0 && (
                  <div className="pc-marketplace-publishes">
                    <strong>Published</strong>
                    {row.publishes.map((pub) => <a key={`${pub.slug}-${pub.version}`} href={pub.browseUrl} target="_blank" rel="noreferrer">{pub.slug}@{pub.version}</a>)}
                  </div>
                )}
                <div className="pc-marketplace-card-actions">
                  <button type="button" className="pc-button" disabled={busy} onClick={() => void onInstantiate(row)}>{busy ? '…' : 'Instantiate'}</button>
                  <button type="button" className="pc-button ghost" disabled={busy} onClick={() => void onPublish(row)}>Publish</button>
                  <button type="button" className="pc-button danger" disabled={busy} onClick={() => void onDelete(row)}>Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}