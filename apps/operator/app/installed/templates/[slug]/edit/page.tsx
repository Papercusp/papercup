'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { Toaster, toast } from 'sonner';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface ConfigFileSpec {
  path: string;
  label?: string;
  language?: 'markdown' | 'json' | 'yaml' | 'text';
  description?: string;
  sensitivity?: 'normal' | 'warn' | 'secret';
}

interface TemplateRow {
  slug: string;
  version: string;
  path: string;
  manifest: {
    name?: string;
    version?: string;
    description?: string;
    configFiles?: ConfigFileSpec[];
    plugins?: Array<string | { slug: string; version?: string; autoEnable?: boolean }>;
    models?: Record<string, unknown>;
  };
  publishedSlugs: Array<{ slug: string; version: string; browseUrl?: string }>;
}

function languageFor(spec: ConfigFileSpec): string {
  return spec.language ?? (spec.path.endsWith('.json') ? 'json'
    : spec.path.endsWith('.md') ? 'markdown'
    : spec.path.endsWith('.yaml') || spec.path.endsWith('.yml') ? 'yaml'
    : 'plaintext');
}

export default function EditTemplatePage() {
  const routeParams = useParams<{ slug: string }>();
  const search = useSearchParams();
  const slug = decodeURIComponent(routeParams.slug);
  const version = search.get('version') ?? '';

  const [tpl, setTpl] = useState<TemplateRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvedVersion, setResolvedVersion] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string>('');
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Resolve the template + version (the listing is keyed by slug; the
  // version comes from the query string, otherwise we pick the newest).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/templates', { cache: 'no-store' });
        const d = r.ok ? await r.json() as { templates: TemplateRow[] } : { templates: [] };
        if (cancelled) return;
        const matches = d.templates.filter((t) => t.slug === slug);
        if (matches.length === 0) {
          setLoadError(`template "${slug}" not found`);
          return;
        }
        const picked = version
          ? matches.find((t) => t.version === version) ?? matches[0]!
          : matches[0]!;
        setTpl(picked);
        setResolvedVersion(picked.version);
        const firstFile = picked.manifest.configFiles?.[0]?.path ?? 'papercusp.json';
        setActivePath(firstFile);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [slug, version]);

  const allFiles: ConfigFileSpec[] = useMemo(() => {
    if (!tpl) return [];
    const decl = tpl.manifest.configFiles ?? [];
    const extras: ConfigFileSpec[] = [
      { path: 'papercusp.json', label: 'papercusp.json', language: 'json', description: 'Template manifest — plugins, models, configFiles list, metadata.' },
    ];
    // README is shown only if it's already on disk; we don't auto-create it.
    return [...decl, ...extras];
  }, [tpl]);

  // Lazy-load file content the first time a tab is selected.
  useEffect(() => {
    if (!tpl || !resolvedVersion || !activePath) return;
    if (activePath in original) return;
    let cancelled = false;
    setLoadingFile(true);
    fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}/file?path=${encodeURIComponent(activePath)}`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.resolve({ content: '' }))
      .then((d: { content: string | null }) => {
        if (cancelled) return;
        const content = typeof d.content === 'string' ? d.content : '';
        setOriginal((prev) => ({ ...prev, [activePath]: content }));
        setDraft((prev) => activePath in prev ? prev : { ...prev, [activePath]: content });
      })
      .finally(() => { if (!cancelled) setLoadingFile(false); });
    return () => { cancelled = true; };
  }, [tpl, resolvedVersion, activePath, original]);

  const dirty = useMemo(() => {
    return Object.keys(draft).filter((k) => draft[k] !== original[k]);
  }, [draft, original]);

  const onSave = useCallback(async () => {
    if (!tpl || !resolvedVersion || dirty.length === 0) return;
    setSaving(true);
    try {
      const results = await Promise.all(
        dirty.map(async (path) => {
          const r = await fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}/file`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, content: draft[path] }),
          });
          return { path, ok: r.ok, json: await r.json().catch(() => ({})) };
        }),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(`${failed.length} file(s) failed`, {
          description: failed.map((f) => `${f.path}: ${(f.json as { error?: string }).error ?? 'unknown'}`).join('\n'),
        });
        return;
      }
      toast.success(`Saved ${dirty.length} file${dirty.length === 1 ? '' : 's'}`);
      setOriginal((prev) => {
        const next = { ...prev };
        for (const p of dirty) next[p] = draft[p]!;
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [tpl, resolvedVersion, dirty, draft]);

  const onPublish = useCallback(async () => {
    if (!tpl || !resolvedVersion) return;
    if (dirty.length > 0) {
      toast.error('Save changes before publishing.');
      return;
    }
    setPublishing(true);
    try {
      const r = await fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json() as { ok?: boolean; slug?: string; version?: string; browseUrl?: string; error?: string };
      if (!r.ok || !j.ok) {
        toast.error(j.error ?? `publish failed (${r.status})`);
        return;
      }
      toast.success(`Published ${j.slug}@${j.version}`, {
        description: j.browseUrl,
        action: j.browseUrl ? { label: 'open', onClick: () => window.open(j.browseUrl, '_blank', 'noopener') } : undefined,
        duration: 8000,
      });
    } finally {
      setPublishing(false);
    }
  }, [tpl, resolvedVersion, dirty]);

  if (loadError) {
    return (
      <div className="pc-shell" style={{ padding: 24 }}>
        <Toaster position="bottom-right" richColors />
        <Link href="/installed/templates" style={{ fontSize: 13 }}>← back to templates</Link>
        <div style={{ marginTop: 16, color: '#f87171' }}>Could not load template: {loadError}</div>
      </div>
    );
  }
  if (!tpl) {
    return <div className="pc-shell" style={{ padding: 24 }}>Loading…</div>;
  }

  const activeSpec = allFiles.find((f) => f.path === activePath);
  const language = activeSpec ? languageFor(activeSpec) : 'plaintext';

  return (
    <div className="pc-shell" style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Toaster position="bottom-right" richColors />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <Link href="/installed/templates" style={{ fontSize: 13, color: 'var(--fg-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowLeft size={13} /> back
        </Link>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{tpl.slug}</h1>
        <code style={{ fontSize: 12, color: 'var(--fg-dim)' }}>v{resolvedVersion}</code>
        {tpl.publishedSlugs.length > 0 ? (
          <span style={{ fontSize: 11, color: '#34d399' }}>
            published × {tpl.publishedSlugs.length}
          </span>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={onSave}
            disabled={saving || dirty.length === 0}
            style={btnStyle(dirty.length > 0 && !saving ? 'primary' : 'muted')}
          >
            {saving ? <Loader2 size={12} className="pc-spin" /> : <Save size={12} />}
            {dirty.length > 0 ? `Save (${dirty.length})` : 'Saved'}
          </button>
          <button onClick={onPublish} disabled={publishing || dirty.length > 0} style={btnStyle(dirty.length === 0 && !publishing ? 'accent' : 'muted')}>
            {publishing ? 'publishing…' : tpl.publishedSlugs.length > 0 ? 'Republish' : 'Publish'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        <aside style={{ width: 240, borderRight: '1px solid var(--border)', paddingRight: 12, overflow: 'auto' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-dim)', marginBottom: 8 }}>
            Files
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {allFiles.map((f) => {
              const isDirty = f.path in draft && draft[f.path] !== original[f.path];
              const isActive = f.path === activePath;
              return (
                <li key={f.path}>
                  <button
                    onClick={() => setActivePath(f.path)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      background: isActive ? 'var(--bg-elevated, rgba(255,255,255,0.04))' : 'transparent',
                      border: 'none',
                      borderLeft: isActive ? '2px solid var(--accent, #3b82f6)' : '2px solid transparent',
                      color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ fontSize: 12, fontWeight: isActive ? 600 : 400 }}>
                        {f.label ?? f.path}
                      </code>
                      {isDirty ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24' }} /> : null}
                    </div>
                    {f.description ? (
                      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 2 }}>
                        {f.description}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>
            <code>{tpl.path}/{activePath}</code>
          </div>
          <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            {loadingFile ? (
              <div style={{ padding: 24, color: 'var(--fg-dim)' }}>Loading {activePath}…</div>
            ) : (
              <Editor
                height="100%"
                language={language}
                value={draft[activePath] ?? ''}
                theme="vs-dark"
                onChange={(v) => setDraft((prev) => ({ ...prev, [activePath]: v ?? '' }))}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function btnStyle(variant: 'primary' | 'accent' | 'muted'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 12px',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: variant === 'muted' ? 'default' : 'pointer',
  };
  if (variant === 'primary') return { ...base, background: 'var(--accent, #3b82f6)', color: 'white' };
  if (variant === 'accent') return { ...base, background: '#34d399', color: '#062c1c' };
  return { ...base, background: 'var(--bg-elevated, rgba(255,255,255,0.05))', color: 'var(--fg-dim)' };
}
