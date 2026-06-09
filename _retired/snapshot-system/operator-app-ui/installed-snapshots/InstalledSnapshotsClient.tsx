'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import { usePromptDialog } from '../../harness/usePromptDialog';

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

/**
 * Bump the patch component of a semver string. Falls back to suffixing
 * `-r2`/`-r3`/... on values we can't parse so republish never gets stuck.
 */
export function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
  if (!m) {
    const rm = /-r(\d+)$/.exec(v);
    if (rm) return v.replace(/-r\d+$/, `-r${Number(rm[1]) + 1}`);
    return `${v}-r2`;
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * Pick the publish whose version sorts highest (semver-ish — purely
 * lexical with numeric components, which is good enough for the
 * "what's the latest version I shipped" question).
 */
function latestPublish(publishes: PublishRecord[]): PublishRecord | null {
  if (publishes.length === 0) return null;
  return [...publishes].sort((a, b) => {
    const pa = a.version.split(/[.\-+]/).map((s) => /^\d+$/.test(s) ? Number(s) : s);
    const pb = b.version.split(/[.\-+]/).map((s) => /^\d+$/.test(s) ? Number(s) : s);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i], y = pb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (typeof x === 'number' && typeof y === 'number') {
        if (x !== y) return x - y;
      } else if (String(x) !== String(y)) {
        return String(x) < String(y) ? -1 : 1;
      }
    }
    return 0;
  }).pop() ?? null;
}

export default function InstalledSnapshotsClient() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

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
    const ok = await askConfirm({
      title: `Delete snapshot ${s.id}?`,
      body: has
        ? 'This will not retract the published version on the marketplace — use Retract first if you also want it gone there.'
        : 'The local snapshot tarball will be removed.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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

  const onPublish = async (s: SnapshotRow) => {
    const prev = latestPublish(s.publishes);
    const defaultSlug = prev?.slug ?? `${s.harnessSlug}-snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const defaultVersion = prev ? bumpPatch(prev.version) : '1.0.0';
    const isRepublish = !!prev;
    const slug = await askPrompt({
      title: isRepublish ? `Republish ${s.id}` : `Publish ${s.id}`,
      body: isRepublish
        ? `The last publish was ${prev.slug}@${prev.version}. Pick a marketplace slug.`
        : 'Pick a marketplace slug.',
      label: 'Slug',
      defaultValue: defaultSlug,
      submitLabel: 'Next',
    });
    if (!slug) return;
    const version = await askPrompt({
      title: `Version for ${slug}`,
      label: 'Version',
      defaultValue: defaultVersion,
      validate: (v) => /^\d+\.\d+\.\d+/.test(v) ? null : 'Use semver (e.g. 1.0.0)',
      submitLabel: 'Publish',
    });
    if (!version) return;
    setBusy(`publish:${s.id}`);
    try {
      const r = await fetch(`/api/snapshots/${encodeURIComponent(s.id)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marketplaceSlug: slug, marketplaceVersion: version }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `publish failed (${r.status})`);
        return;
      }
      toast.success(isRepublish ? `Republished as ${slug}@${version}` : `Published ${slug}@${version}`);
      await load();
    } catch (e) {
      toast.error(`publish error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRetract = async (s: SnapshotRow, marketplaceSlug: string) => {
    const ok = await askConfirm({
      title: `Retract ${marketplaceSlug}?`,
      body: 'Marks the published version as withdrawn. The local snapshot stays intact.',
      confirmLabel: 'Retract',
      destructive: true,
    });
    if (!ok) return;
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
      {confirmEl}
      {promptEl}
      {/* Toaster mounted globally in app/layout.tsx. */}
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
                <div className="pc-installed-snapshot-publishes">
                  <strong>Published as</strong>
                  {s.publishes.map((p) => (
                    <span key={`${p.slug}@${p.version}`} className="pc-installed-snapshot-publish-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <a href={p.browseUrl} target="_blank" rel="noreferrer"><code>{p.slug}@{p.version}</code></a>
                      <button
                        onClick={() => onRetract(s, p.slug)}
                        disabled={busy === `${s.id}:${p.slug}`}
                        title="Retract this published version from the marketplace"
                        className="pc-installed-snapshot-retract"
                        style={{
                          padding: '2px 6px', fontSize: 10, background: 'transparent',
                          border: '1px solid var(--border)', color: 'var(--warn)', borderRadius: 3,
                          cursor: busy === `${s.id}:${p.slug}` ? 'default' : 'pointer',
                        }}
                      >
                        retract
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="pc-installed-snapshot-actions" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => onPublish(s)}
                  disabled={busy === `publish:${s.id}`}
                  className="pc-installed-snapshot-publish-btn"
                  style={{
                    padding: '4px 10px', background: 'transparent', color: 'var(--accent)',
                    border: '1px solid var(--border)', borderRadius: 4, fontSize: 11,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    cursor: busy === `publish:${s.id}` ? 'default' : 'pointer',
                  }}
                  title={s.publishes.length > 0
                    ? `Last published ${latestPublish(s.publishes)?.slug}@${latestPublish(s.publishes)?.version} — bumps patch by default`
                    : 'Publish this snapshot to the marketplace'}
                >
                  <Lucide.UploadCloud size={11} />
                  {s.publishes.length > 0
                    ? `republish v${bumpPatch(latestPublish(s.publishes)!.version)}`
                    : 'publish'}
                </button>
                <button
                  onClick={() => onDelete(s)}
                  disabled={busy === s.id}
                  className="pc-installed-snapshot-delete"
                  style={{
                    padding: '4px 10px', background: 'transparent', color: 'var(--bad)',
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
