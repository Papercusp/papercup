'use client';

import RouteLink from '../../_components/RouteLink';
import * as Lucide from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import { usePromptDialog } from '../../harness/usePromptDialog';

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

interface CatalogSnapshot {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage?: string | null;
  icon?: string | null;
  retracted?: string;
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

export default function MarketplaceSnapshotsClient() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const publishedCount = useMemo(() => rows.filter((row) => row.publishes.length > 0).length, [rows]);
  const totalBytes = useMemo(() => rows.reduce((sum, row) => sum + row.bytes, 0), [rows]);

  const load = async () => {
    setLoading(true);
    try {
      const [snapsR, catalogR] = await Promise.all([
        fetch('/api/snapshots', { cache: 'no-store' }),
        fetch('/api/marketplace/catalog', { cache: 'no-store' }),
      ]);
      if (!snapsR.ok) throw new Error(`HTTP ${snapsR.status}`);
      const snaps = await snapsR.json();
      setRows(snaps.snapshots ?? []);
      if (catalogR.ok) {
        const cat = await catalogR.json();
        const snapshots = (cat.catalog ?? []).filter((e: { kind?: string }) => e.kind === 'snapshot');
        setCatalog(snapshots);
      }
    } catch (e: unknown) {
      toast.error(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onInstantiate = async (row: SnapshotRow) => {
    // Probe the snapshot's shape — if it has stripped fields, redirect
    // to the rich fork-completion page; otherwise fast-path with prompt.
    try {
      const sR = await fetch(`/api/snapshots/${row.id}/shape`);
      if (sR.ok) {
        const s = await sR.json();
        const hasStripped = (s.plugins ?? []).some((p: { shape?: { fields?: Record<string, unknown> } }) =>
          p.shape && Object.keys(p.shape.fields ?? {}).length > 0,
        );
        if (hasStripped) {
          window.location.href = `/snapshots/${row.id}/fork`;
          return;
        }
      }
    } catch {
      // fall through to fast path
    }
    const proposed = `${row.harnessSlug}-fork-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
    const name = await askPrompt({
      title: 'Instantiate snapshot',
      body: 'Pick a name for the new harness, or submit blank to use the auto-generated name.',
      label: 'New harness slug',
      defaultValue: proposed,
      allowEmpty: true,
      submitLabel: 'Instantiate',
    });
    if (name === null) return;
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
    const ok = await askConfirm({
      title: `Publish "${row.name}"?`,
      body: `Snapshot size: ${formatBytes(row.bytes)}.`,
      confirmLabel: 'Publish',
    });
    if (!ok) return;
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
    const ok = await askConfirm({
      title: `Delete local snapshot ${row.id}?`,
      body: 'Published copies are unaffected.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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
      {confirmEl}
      {promptEl}
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Snapshots</p>
          <h1>Fork someone else&rsquo;s working setup.</h1>
          <p>
            A snapshot is a frozen copy of a workflow that already runs. Fork one to start with that state instead of from scratch — files, database, plugin choices, all preserved.
          </p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Snapshot status">
          <div><strong>{catalog.length}</strong><span>available</span></div>
          {rows.length > 0 && <div><strong>{rows.length}</strong><span>on your machine</span></div>}
          {publishedCount > 0 && <div><strong>{publishedCount}</strong><span>published</span></div>}
        </div>
      </section>

      {!loading && catalog.length > 0 && (
        <section className="pc-marketplace-catalog-section" style={{ marginBottom: 32 }}>
          <div className="pc-marketplace-grid">
            {catalog.map((s) => {
              const Icon: React.ComponentType<{ size?: number }> = (s.icon && (Lucide as Record<string, unknown>)[s.icon] as React.ComponentType<{ size?: number }>) || Lucide.Layers;
              return (
                <article key={s.slug} className="pc-card pc-marketplace-card">
                  <div className="pc-marketplace-card-head">
                    <span className="pc-marketplace-card-icon snapshot"><Icon size={18} /></span>
                    <div>
                      <RouteLink href={`/marketplace/${encodeURIComponent(s.slug)}`} className="pc-marketplace-card-title">{s.name}</RouteLink>
                      <span>{s.slug}</span>
                    </div>
                  </div>
                  <p>{s.description}</p>
                  <div className="pc-marketplace-meta">
                    <span>v{s.version}</span>
                    <span>{s.license}</span>
                    {s.author && <span>{s.author}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {(rows.length > 0 || (!loading && catalog.length === 0)) && (
        <div className="pc-marketplace-snapshot-toolbar">
          <div>
            <strong>{loading ? 'Loading…' : rows.length > 0 ? `Your snapshots (${rows.length})` : 'Your snapshots'}</strong>
            <span>Captured on this machine. Fork to clone the state, publish to share, delete to clear local copies.</span>
          </div>
          <button type="button" className="pc-button ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}

      {!loading && rows.length === 0 && catalog.length === 0 && (
        <div className="pc-card pc-marketplace-empty">
          <strong>No snapshots yet.</strong>
          <span>Run a workflow, then click <em>Save snapshot</em> from any harness to capture forkable state. Or browse templates to install your first workflow.</span>
          <RouteLink href="/marketplace/templates" className="pc-button primary">Browse templates</RouteLink>
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