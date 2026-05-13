'use client';

import { useCallback, useEffect, useState } from 'react';
import RouteLink from '../../_components/RouteLink';
import { Layers, ExternalLink, Loader2, Pencil, Trash2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import { usePromptDialog } from '../../harness/usePromptDialog';

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl?: string;
  publishedAtMs?: number;
}

interface VersionSummary {
  version: string;
  savedAtMs: number;
  publishedSlugs: Array<{ slug: string; version: string; browseUrl?: string; publishedAtMs?: number }>;
}

interface TemplateRow {
  slug: string;
  version: string;
  path: string;
  versions?: VersionSummary[];
  manifest: {
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    license?: string;
    icon?: string;
    plugins?: Array<string | { slug: string; version?: string; autoEnable?: boolean }>;
    models?: Record<string, { preferred?: string }>;
    configFiles?: Array<{ path: string }>;
    forkedFrom?: { harness?: string; at?: string };
  };
  publishedSlugs: PublishRecord[];
  savedAtMs: number;
}

function formatDate(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function InstalledTemplatesClient() {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/templates', { cache: 'no-store' });
      const d = r.ok ? await r.json() : { templates: [] };
      setRows(Array.isArray(d?.templates) ? d.templates : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onDelete = async (row: TemplateRow) => {
    const key = `${row.slug}@${row.version}`;
    const ok = await askConfirm({
      title: `Delete local template ${key}?`,
      body: (
        <div>
          {row.publishedSlugs.length > 0 ? (
            <p style={{ marginTop: 0 }}>Note: this will not retract the published version on the marketplace.</p>
          ) : null}
          <p style={{ marginBottom: 0 }}>This removes <code>{row.path}</code>.</p>
        </div>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setDeleting(key);
    try {
      const r = await fetch(
        `/api/templates/${encodeURIComponent(row.slug)}/${encodeURIComponent(row.version)}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `delete failed (${r.status})`);
        return;
      }
      toast.success(`Deleted ${key}`);
      await load();
    } catch (e: unknown) {
      toast.error(`delete error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(null);
    }
  };

  const onInstall = async (row: TemplateRow) => {
    const key = `${row.slug}@${row.version}`;
    const proposed = `${row.slug.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')}-test`;
    const projectSlug = await askPrompt({
      title: 'Install template into a new harness',
      body: `This materialises ${row.slug}@${row.version} into a fresh harness so you can test the recipe locally before publishing.`,
      label: 'New harness slug',
      defaultValue: proposed,
      submitLabel: 'Install',
    });
    if (!projectSlug) return;
    setInstalling(key);
    try {
      const r = await fetch(
        `/api/templates/${encodeURIComponent(row.slug)}/${encodeURIComponent(row.version)}/install`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectSlug }),
        },
      );
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `install failed (${r.status})`);
        return;
      }
      toast.success(`Installed as ${j.projectSlug}`, {
        description: j.targetPath,
        duration: 8000,
        action: j.operatorUrl ? {
          label: 'open',
          onClick: () => window.open(j.operatorUrl, '_blank', 'noopener'),
        } : undefined,
      });
    } catch (e) {
      toast.error(`install error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  };

  const onPublish = async (row: TemplateRow) => {
    const key = `${row.slug}@${row.version}`;
    setPublishing(key);
    try {
      const r = await fetch(
        `/api/templates/${encodeURIComponent(row.slug)}/${encodeURIComponent(row.version)}/publish`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const j = await r.json() as {
        ok?: boolean;
        slug?: string;
        version?: string;
        browseUrl?: string;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `publish failed (${r.status})`);
        return;
      }
      toast.success(`Published ${j.slug}@${j.version}`, {
        description: j.browseUrl,
        duration: 8000,
        action: j.browseUrl ? {
          label: 'open',
          onClick: () => window.open(j.browseUrl, '_blank', 'noopener'),
        } : undefined,
      });
      await load();
    } catch (e: unknown) {
      toast.error(`publish error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPublishing(null);
    }
  };

  const published = rows.filter((r) => r.publishedSlugs.length > 0).length;

  return (
    <div className="pc-shell pc-marketplace-shell">
      {confirmEl}
      {promptEl}
      {/* Toaster mounted globally in app/layout.tsx. */}
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Installed templates</p>
          <h1>Templates on this machine.</h1>
          <p>Saved recipes from the &ldquo;Save template&rdquo; flow on each harness. Publish one to make it installable from the marketplace.</p>
        </div>
        <div className="pc-marketplace-mini-stats" aria-label="Template stats">
          <div><strong>{rows.length}</strong><span>local</span></div>
          {published > 0 && <div><strong>{published}</strong><span>published</span></div>}
        </div>
      </section>

      {loading ? (
        <div className="pc-card pc-marketplace-loading">Loading templates…</div>
      ) : rows.length === 0 ? (
        <div className="pc-card pc-marketplace-empty">
          <strong>No templates yet.</strong>
          <span>Click &ldquo;Save template&rdquo; on any running harness to fork its recipe into one.</span>
        </div>
      ) : (
        <div className="pc-installed-template-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => {
            const key = `${row.slug}@${row.version}`;
            const isPublishing = publishing === key;
            const pluginsCount = row.manifest.plugins?.length ?? 0;
            const modelRoles = Object.keys(row.manifest.models ?? {}).length;
            const configFilesCount = row.manifest.configFiles?.length ?? 0;
            return (
              <div key={key} className="pc-card pc-installed-template-card" style={{ padding: 16 }}>
                <div className="pc-installed-template-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <Layers size={16} className="pc-installed-template-head-icon" style={{ color: 'var(--fg-dim)' }} />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{row.slug}</h3>
                  <code style={{ fontSize: 12, color: 'var(--fg-dim)' }}>v{row.version}</code>
                  {row.manifest.forkedFrom?.harness ? (
                    <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                      forked from <code>{row.manifest.forkedFrom.harness}</code>
                    </span>
                  ) : null}
                  {(row.versions?.length ?? 0) > 1 ? (
                    <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {row.versions!.length} versions
                    </span>
                  ) : null}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)' }}>
                    saved {formatDate(row.savedAtMs)}
                  </span>
                </div>

                {row.manifest.description ? (
                  <p className="pc-installed-template-description" style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--fg-muted)' }}>
                    {row.manifest.description}
                  </p>
                ) : null}

                <div className="pc-installed-template-meta" style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--fg-dim)' }}>
                  <span>{pluginsCount} plugin{pluginsCount === 1 ? '' : 's'}</span>
                  <span>{modelRoles} role{modelRoles === 1 ? '' : 's'}</span>
                  <span>{configFilesCount} config file{configFilesCount === 1 ? '' : 's'}</span>
                  {row.manifest.author ? <span>by {row.manifest.author}</span> : null}
                  {row.manifest.license ? <span>{row.manifest.license}</span> : null}
                </div>

                <div className="pc-installed-template-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <RouteLink
                    href={`/installed/templates/${encodeURIComponent(row.slug)}/edit?version=${encodeURIComponent(row.version)}`}
                    className="pc-installed-template-link"
                    style={{
                      padding: '6px 12px',
                      background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
                      color: 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Pencil size={12} /> edit
                  </RouteLink>
                  <button
                    onClick={() => onInstall(row)}
                    disabled={installing === key}
                    className="pc-installed-template-button pc-installed-template-button--install"
                    style={{
                      padding: '6px 12px',
                      background: 'transparent',
                      color: 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: installing === key ? 'default' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    title="Materialise this template into a new harness for testing"
                  >
                    {installing === key ? <Loader2 size={12} className="pc-spin" /> : <Play size={12} />}
                    install locally
                  </button>
                  <button
                    onClick={() => onPublish(row)}
                    disabled={isPublishing}
                    className="pc-installed-template-button pc-installed-template-button--publish"
                    style={{
                      padding: '6px 12px',
                      background: 'var(--accent, #3b82f6)',
                      color: 'white',
                      border: 'none',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isPublishing ? 'default' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {isPublishing ? (
                      <><Loader2 size={12} className="pc-spin" /> publishing…</>
                    ) : row.publishedSlugs.length > 0 ? 'republish' : 'publish to marketplace'}
                  </button>
                  <button
                    onClick={() => onDelete(row)}
                    disabled={deleting === key}
                    className="pc-installed-template-button pc-installed-template-button--delete"
                    style={{
                      padding: '6px 10px',
                      background: 'transparent',
                      color: '#f87171',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: deleting === key ? 'default' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    title="Delete local template"
                  >
                    {deleting === key ? <Loader2 size={12} className="pc-spin" /> : <Trash2 size={12} />}
                  </button>

                  {row.publishedSlugs.length > 0 ? (
                    <div className="pc-installed-template-publishes" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {row.publishedSlugs.slice(-3).reverse().map((p) => (
                        <a
                          key={`${p.slug}@${p.version}`}
                          href={p.browseUrl}
                          target="_blank"
                          rel="noopener"
                          className="pc-installed-template-publish-link"
                          style={{
                            fontSize: 11,
                            color: 'var(--fg-dim)',
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            border: '1px solid var(--border)',
                            borderRadius: 3,
                          }}
                        >
                          <ExternalLink size={11} />
                          {p.slug}@{p.version}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  <code className="pc-installed-template-path" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)' }}>
                    {row.path}
                  </code>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
