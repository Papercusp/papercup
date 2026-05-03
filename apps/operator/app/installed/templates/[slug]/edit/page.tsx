'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useFormWith, FormField as RhfFormField, SubmitButton } from '@/lib/forms';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowLeft, Save, Loader2, Plus, X, Code2, Sliders } from 'lucide-react';
import { Toaster, toast } from 'sonner';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface ConfigFileSpec {
  path: string;
  label?: string;
  language?: 'markdown' | 'json' | 'yaml' | 'text';
  description?: string;
  sensitivity?: 'normal' | 'warn' | 'secret';
}

interface VersionSummary {
  version: string;
  savedAtMs: number;
  publishedSlugs: Array<{ slug: string; version: string; browseUrl?: string }>;
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
  versions?: VersionSummary[];
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
  const [allRows, setAllRows] = useState<TemplateRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvedVersion, setResolvedVersion] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string>('');
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [manifestRawMode, setManifestRawMode] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);

  // Two-step load: hit /api/templates for the version list (so the
  // dropdown can show every version of this slug), then fetch the
  // specific version requested via ?version=. Falls back to the newest
  // version when the query string is missing.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await fetch('/api/templates', { cache: 'no-store' });
        const ld = list.ok ? await list.json() as { templates: TemplateRow[] } : { templates: [] };
        if (cancelled) return;
        const matches = ld.templates.filter((t) => t.slug === slug);
        if (matches.length === 0) {
          setLoadError(`template "${slug}" not found`);
          return;
        }
        setAllRows(matches);

        const versionsList: VersionSummary[] = matches[0]!.versions
          ?? [{ version: matches[0]!.version, savedAtMs: 0, publishedSlugs: matches[0]!.publishedSlugs }];
        const wantedVersion = version || versionsList[0]!.version;

        // Fetch the chosen version's full record (manifest + path) so
        // we render its actual configFiles, not the newest version's.
        const detail = await fetch(
          `/api/templates/${encodeURIComponent(slug)}/${encodeURIComponent(wantedVersion)}`,
          { cache: 'no-store' },
        );
        const dd = detail.ok ? await detail.json() as { template: TemplateRow } : null;
        if (cancelled) return;
        if (!dd?.template) {
          setLoadError(`version "${wantedVersion}" not found`);
          return;
        }
        const picked: TemplateRow = { ...dd.template, versions: versionsList };
        setTpl(picked);
        setResolvedVersion(picked.version);
        // Reset per-file caches when version changes — the file content
        // for v0.1.0's SPEC.md is not v0.2.0's.
        setOriginal({});
        setDraft({});
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

  const onAddFile = useCallback(async (spec: ConfigFileSpec, initialContent: string) => {
    if (!tpl || !resolvedVersion) return;
    if (!spec.path.trim()) {
      toast.error('path is required');
      return;
    }
    if (spec.path.includes('..') || spec.path.startsWith('/')) {
      toast.error('path must be relative and inside the template');
      return;
    }
    // Reject duplicates upfront so the structured form keeps invariants.
    if ((tpl.manifest.configFiles ?? []).some((cf) => cf.path === spec.path)) {
      toast.error(`"${spec.path}" is already declared`);
      return;
    }
    setSaving(true);
    try {
      // Step 1: update papercusp.json with the new entry (this goes
      // through the same allowlist + write path as any other manifest
      // edit; configFiles[] is mutable, the allowlist regrows on the
      // next read).
      const nextManifest = {
        ...tpl.manifest,
        configFiles: [...(tpl.manifest.configFiles ?? []), spec],
      };
      const manifestText = JSON.stringify(nextManifest, null, 2) + '\n';
      const r1 = await fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'papercusp.json', content: manifestText }),
      });
      const j1 = await r1.json();
      if (!r1.ok || !j1.ok) {
        toast.error(`failed to update manifest: ${j1.error ?? r1.status}`);
        return;
      }
      // Step 2: write the new file (allowlist now includes it).
      const r2 = await fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: spec.path, content: initialContent }),
      });
      const j2 = await r2.json();
      if (!r2.ok || !j2.ok) {
        toast.error(`manifest saved, but creating file failed: ${j2.error ?? r2.status}`);
        // Don't roll back manifest — the user can save again or remove
        // the row. Rolling back partial state would surprise them more.
      }
      // Step 3: refetch local state so the sidebar + draft caches see
      // the new file. Cleaner than splicing client-side state.
      const detail = await fetch(`/api/templates/${encodeURIComponent(tpl.slug)}/${encodeURIComponent(resolvedVersion)}`, { cache: 'no-store' });
      const dd = detail.ok ? await detail.json() as { template: TemplateRow } : null;
      if (dd?.template) {
        setTpl((prev) => prev ? { ...dd.template, versions: prev.versions } : dd.template);
        // Reset draft for the new file so the editor opens to the
        // initial content rather than an empty Monaco buffer.
        setOriginal((prev) => ({ ...prev, [spec.path]: initialContent, 'papercusp.json': manifestText }));
        setDraft((prev) => ({ ...prev, [spec.path]: initialContent, 'papercusp.json': manifestText }));
        setActivePath(spec.path);
      }
      toast.success(`Added ${spec.path}`);
      setAddFileOpen(false);
    } finally {
      setSaving(false);
    }
  }, [tpl, resolvedVersion]);

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
      {addFileOpen && (
        <AddFileDialog
          existingPaths={(tpl.manifest.configFiles ?? []).map((cf) => cf.path)}
          onCancel={() => setAddFileOpen(false)}
          onSubmit={onAddFile}
          busy={saving}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <Link href="/installed/templates" style={{ fontSize: 13, color: 'var(--fg-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowLeft size={13} /> back
        </Link>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{tpl.slug}</h1>
        {(tpl.versions?.length ?? 0) > 1 ? (
          <select
            value={resolvedVersion ?? ''}
            onChange={(e) => {
              const next = e.target.value;
              if (next && next !== resolvedVersion) {
                if (Object.keys(draft).some((k) => draft[k] !== original[k])) {
                  if (!confirm('Discard unsaved changes and switch versions?')) return;
                }
                window.location.search = `?version=${encodeURIComponent(next)}`;
              }
            }}
            style={{
              fontSize: 12, padding: '4px 8px', background: 'var(--bg-elevated, rgba(255,255,255,0.05))',
              color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4,
            }}
          >
            {tpl.versions!.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}{v.publishedSlugs.length > 0 ? ' (published)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <code style={{ fontSize: 12, color: 'var(--fg-dim)' }}>v{resolvedVersion}</code>
        )}
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
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-dim)' }}>
              Files
            </span>
            <button
              onClick={() => setAddFileOpen(true)}
              style={{ marginLeft: 'auto', padding: '2px 6px', fontSize: 11, background: 'transparent', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}
              title="Add a new config file to this template"
            >
              <Plus size={11} /> new
            </button>
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
          {activePath === 'papercusp.json' ? (
            <div style={{ marginBottom: 6, display: 'flex', gap: 6 }}>
              <button
                onClick={() => setManifestRawMode(false)}
                style={tabBtnStyle(!manifestRawMode)}
              >
                <Sliders size={11} /> structured
              </button>
              <button
                onClick={() => setManifestRawMode(true)}
                style={tabBtnStyle(manifestRawMode)}
              >
                <Code2 size={11} /> raw JSON
              </button>
            </div>
          ) : null}
          <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            {loadingFile ? (
              <div style={{ padding: 24, color: 'var(--fg-dim)' }}>Loading {activePath}…</div>
            ) : activePath === 'papercusp.json' && !manifestRawMode ? (
              <ManifestStructuredEditor
                jsonText={draft[activePath] ?? ''}
                onChange={(next) => setDraft((prev) => ({ ...prev, [activePath]: next }))}
              />
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

const AddFileSchema = z.object({
  path: z.string()
    .min(1, 'Required')
    .refine((p) => !p.includes('..'), { message: 'Cannot contain ".."' })
    .refine((p) => !p.startsWith('/'), { message: 'Must be relative (no leading /)' }),
  label: z.string().optional().default(''),
  language: z.enum(['markdown', 'json', 'yaml', 'text']),
  description: z.string().optional().default(''),
  sensitivity: z.enum(['normal', 'warn', 'secret']),
});
type AddFileFormData = z.infer<typeof AddFileSchema>;

function AddFileDialog({
  existingPaths,
  onCancel,
  onSubmit,
  busy,
}: {
  existingPaths: string[];
  onCancel: () => void;
  onSubmit: (spec: ConfigFileSpec, initialContent: string) => void;
  busy: boolean;
}) {
  const { register, submit, watch, setValue, errors, isSubmitting } = useFormWith(AddFileSchema, {
    defaultValues: { path: '', label: '', language: 'markdown', description: '', sensitivity: 'normal' },
  });
  const path = watch('path');
  const label = watch('label');
  const language = watch('language');

  // Auto-pick a sensible language from the extension as the user types.
  useEffect(() => {
    if (!path) return;
    if (path.endsWith('.json')) setValue('language', 'json');
    else if (path.endsWith('.yaml') || path.endsWith('.yml')) setValue('language', 'yaml');
    else if (path.endsWith('.md')) setValue('language', 'markdown');
  }, [path, setValue]);

  const conflict = existingPaths.includes((path ?? '').trim());

  const handleSubmit = (data: AddFileFormData) => {
    const initialContent = data.language === 'json'
      ? '{\n}\n'
      : data.language === 'markdown'
        ? `# ${(data.label ?? '').trim() || data.path}\n`
        : '';
    onSubmit({
      path: data.path.trim(),
      label: (data.label ?? '').trim() || undefined,
      language: data.language,
      description: (data.description ?? '').trim() || undefined,
      sensitivity: data.sensitivity === 'normal' ? undefined : data.sensitivity,
    }, initialContent);
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{ background: 'var(--bg, #0c0d10)', border: '1px solid var(--border)', borderRadius: 6, padding: 20, width: 480, maxWidth: '90vw' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>Add config file</h2>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--fg-dim)' }}>
          Creates the file under the template root and registers it in
          <code> configFiles[]</code> so it shows in the operator&apos;s Config tab post-install.
        </p>
        <form
          onSubmit={submit(handleSubmit)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <RhfFormField label="path" required error={errors.path}>
            <input
              type="text"
              {...register('path')}
              style={{
                width: '100%', padding: '4px 8px',
                background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--fg)',
                border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
                fontFamily: "'SF Mono', monospace",
              }}
            />
          </RhfFormField>
          <RhfFormField label="label (optional)" error={errors.label}>
            <input type="text" {...register('label')} style={inputStyleSmall} />
          </RhfFormField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <RhfFormField label="language" error={errors.language}>
              <select {...register('language')} style={{ ...inputStyleSmall, padding: '4px 6px' }}>
                <option value="markdown">markdown</option>
                <option value="json">json</option>
                <option value="yaml">yaml</option>
                <option value="text">text</option>
              </select>
            </RhfFormField>
            <RhfFormField label="sensitivity" error={errors.sensitivity}>
              <select {...register('sensitivity')} style={{ ...inputStyleSmall, padding: '4px 6px' }}>
                <option value="normal">normal</option>
                <option value="warn">warn</option>
                <option value="secret">secret</option>
              </select>
            </RhfFormField>
          </div>
          <RhfFormField label="description" error={errors.description}>
            <textarea {...register('description')} style={{
              ...inputStyleSmall, padding: '6px 8px', minHeight: 60, resize: 'vertical',
            }} />
          </RhfFormField>
          {conflict ? (
            <div style={{ marginTop: 8, fontSize: 12, color: '#fbbf24' }}>
              &ldquo;{path}&rdquo; is already declared.
            </div>
          ) : null}
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} disabled={busy || isSubmitting} style={btnStyle('muted')}>Cancel</button>
            <SubmitButton pending={busy || isSubmitting} aria-disabled={conflict ? 'true' : 'false'}>
              <Plus size={12} /> Add file
            </SubmitButton>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputStyleSmall: React.CSSProperties = {
  width: '100%', padding: '4px 8px',
  background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
};

function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: active ? 'var(--bg-elevated, rgba(255,255,255,0.06))' : 'transparent',
    color: active ? 'var(--fg)' : 'var(--fg-dim)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  };
}

interface PluginEntry { slug: string; version?: string; autoEnable?: boolean }
type PluginField = string | PluginEntry;

function pluginToEntry(p: PluginField): PluginEntry {
  return typeof p === 'string' ? { slug: p } : { ...p };
}

function ManifestStructuredEditor({ jsonText, onChange }: { jsonText: string; onChange: (next: string) => void }) {
  // Parse defensively — if the user has just typed and the JSON is
  // mid-edit and broken, we surface the error instead of crashing the
  // form. Falling back to raw JSON mode is one click away.
  let parsed: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(jsonText || '{}');
  } catch (e) {
    parseError = (e as Error).message;
  }
  if (parseError) {
    return (
      <div style={{ padding: 24, color: '#f87171', fontSize: 13 }}>
        <strong>Manifest is not valid JSON:</strong>
        <pre style={{ marginTop: 8, fontSize: 11 }}>{parseError}</pre>
        <p style={{ color: 'var(--fg-dim)' }}>Switch to raw JSON to fix it.</p>
      </div>
    );
  }

  const plugins = (parsed.plugins as PluginField[] | undefined) ?? [];
  const models = (parsed.models as Record<string, { preferred?: string } | string> | undefined) ?? {};
  const configFiles = (parsed.configFiles as ConfigFileSpec[] | undefined) ?? [];

  const writeBack = (next: Record<string, unknown>) => {
    onChange(JSON.stringify(next, null, 2) + '\n');
  };

  const updatePlugins = (next: PluginField[]) => {
    const merged = { ...parsed };
    if (next.length === 0) delete merged.plugins;
    else merged.plugins = next;
    writeBack(merged);
  };

  const updateModels = (next: Record<string, { preferred?: string }>) => {
    const merged = { ...parsed };
    if (Object.keys(next).length === 0) delete merged.models;
    else merged.models = next;
    writeBack(merged);
  };

  const updateConfigFiles = (next: ConfigFileSpec[]) => {
    const merged = { ...parsed };
    if (next.length === 0) delete merged.configFiles;
    else merged.configFiles = next;
    writeBack(merged);
  };

  const updateField = (key: string, value: unknown) => {
    const merged = { ...parsed };
    if (value == null || value === '') delete merged[key];
    else merged[key] = value;
    writeBack(merged);
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: 'var(--bg, #0c0d10)' }}>
      <section style={{ marginBottom: 24 }}>
        <h3 style={sectionHeading}>Identity</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
          <Field label="name" value={String(parsed.name ?? '')} onChange={(v) => updateField('name', v)} mono />
          <Field label="version" value={String(parsed.version ?? '')} onChange={(v) => updateField('version', v)} mono />
          <Field label="author" value={String(parsed.author ?? '')} onChange={(v) => updateField('author', v)} />
          <Field label="license" value={String(parsed.license ?? '')} onChange={(v) => updateField('license', v)} />
        </div>
        <Field label="description" value={String(parsed.description ?? '')} onChange={(v) => updateField('description', v)} multiline />
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <h3 style={sectionHeading}>Models</h3>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>per-role preferred model</span>
          <button
            onClick={() => updateModels({ ...modelsToObj(models), '': { preferred: '' } })}
            style={addBtnStyle}
          >
            <Plus size={10} /> add role
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Object.entries(modelsToObj(models)).map(([role, conf], i) => (
            <div key={`${i}-${role}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={role}
                placeholder="role (worker, validator, …)"
                onChange={(e) => {
                  const obj = modelsToObj(models);
                  const next: Record<string, { preferred?: string }> = {};
                  for (const [k, v] of Object.entries(obj)) next[k === role ? e.target.value : k] = v;
                  updateModels(next);
                }}
                style={inputStyle(180)}
              />
              <input
                type="text"
                value={conf.preferred ?? ''}
                placeholder="claude-sonnet-4-6"
                onChange={(e) => {
                  const next = { ...modelsToObj(models), [role]: { ...conf, preferred: e.target.value } };
                  updateModels(next);
                }}
                style={inputStyle(280)}
              />
              <button
                onClick={() => {
                  const next = { ...modelsToObj(models) };
                  delete next[role];
                  updateModels(next);
                }}
                style={removeBtnStyle}
                title="Remove role"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <h3 style={sectionHeading}>Plugins</h3>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>recommended + auto-enable</span>
          <button
            onClick={() => updatePlugins([...plugins.map(pluginToEntry), { slug: '', autoEnable: true }])}
            style={addBtnStyle}
          >
            <Plus size={10} /> add plugin
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {plugins.map(pluginToEntry).map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={p.slug}
                placeholder="@papercupai/plugin-name"
                onChange={(e) => {
                  const next = plugins.map(pluginToEntry);
                  next[i] = { ...next[i]!, slug: e.target.value };
                  updatePlugins(next);
                }}
                style={inputStyle(280)}
              />
              <input
                type="text"
                value={p.version ?? ''}
                placeholder="version (optional)"
                onChange={(e) => {
                  const next = plugins.map(pluginToEntry);
                  const v = e.target.value.trim();
                  next[i] = { ...next[i]!, version: v || undefined };
                  updatePlugins(next);
                }}
                style={inputStyle(140)}
              />
              <label style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={!!p.autoEnable}
                  onChange={(e) => {
                    const next = plugins.map(pluginToEntry);
                    next[i] = { ...next[i]!, autoEnable: e.target.checked };
                    updatePlugins(next);
                  }}
                />
                auto-enable
              </label>
              <button
                onClick={() => {
                  const next = plugins.map(pluginToEntry);
                  next.splice(i, 1);
                  updatePlugins(next);
                }}
                style={removeBtnStyle}
                title="Remove plugin"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <h3 style={sectionHeading}>Config files</h3>
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>files surfaced in the operator&apos;s Config tab post-install</span>
          <button
            onClick={() => updateConfigFiles([...configFiles, { path: '', language: 'markdown' }])}
            style={addBtnStyle}
          >
            <Plus size={10} /> add file
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {configFiles.map((cf, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  value={cf.path}
                  placeholder="path (e.g. SPEC.md, .harness/config.json)"
                  onChange={(e) => {
                    const next = [...configFiles];
                    next[i] = { ...next[i]!, path: e.target.value };
                    updateConfigFiles(next);
                  }}
                  style={inputStyle(280)}
                />
                <input
                  type="text"
                  value={cf.label ?? ''}
                  placeholder="label (optional)"
                  onChange={(e) => {
                    const next = [...configFiles];
                    const v = e.target.value.trim();
                    next[i] = { ...next[i]!, label: v || undefined };
                    updateConfigFiles(next);
                  }}
                  style={inputStyle(180)}
                />
                <select
                  value={cf.language ?? 'markdown'}
                  onChange={(e) => {
                    const next = [...configFiles];
                    next[i] = { ...next[i]!, language: e.target.value as ConfigFileSpec['language'] };
                    updateConfigFiles(next);
                  }}
                  style={{ ...inputStyle(110), padding: '4px 6px' }}
                >
                  <option value="markdown">markdown</option>
                  <option value="json">json</option>
                  <option value="yaml">yaml</option>
                  <option value="text">text</option>
                </select>
                <select
                  value={cf.sensitivity ?? 'normal'}
                  onChange={(e) => {
                    const next = [...configFiles];
                    const v = e.target.value as ConfigFileSpec['sensitivity'];
                    next[i] = { ...next[i]!, sensitivity: v === 'normal' ? undefined : v };
                    updateConfigFiles(next);
                  }}
                  style={{ ...inputStyle(100), padding: '4px 6px' }}
                  title="Sensitivity"
                >
                  <option value="normal">normal</option>
                  <option value="warn">warn</option>
                  <option value="secret">secret</option>
                </select>
                <button
                  onClick={() => {
                    const next = [...configFiles];
                    next.splice(i, 1);
                    updateConfigFiles(next);
                  }}
                  style={removeBtnStyle}
                  title="Remove file"
                >
                  <X size={11} />
                </button>
              </div>
              <input
                type="text"
                value={cf.description ?? ''}
                placeholder="description (shown in the Config tab)"
                onChange={(e) => {
                  const next = [...configFiles];
                  const v = e.target.value;
                  next[i] = { ...next[i]!, description: v || undefined };
                  updateConfigFiles(next);
                }}
                style={{ ...inputStyle(0), width: '100%' }}
              />
            </div>
          ))}
        </div>
      </section>

      <p style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
        Other manifest fields (papercusp version pin, kind, forkedFrom) are edit-only via raw JSON.
      </p>
    </div>
  );
}

function modelsToObj(models: Record<string, { preferred?: string } | string>): Record<string, { preferred?: string }> {
  const out: Record<string, { preferred?: string }> = {};
  for (const [k, v] of Object.entries(models)) {
    if (typeof v === 'string') out[k] = { preferred: v };
    else if (v && typeof v === 'object') out[k] = v;
  }
  return out;
}

const sectionHeading: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--fg-dim)',
};

const addBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '3px 8px',
  background: 'transparent',
  color: 'var(--fg-muted)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  fontSize: 11,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const removeBtnStyle: React.CSSProperties = {
  padding: '2px 6px',
  background: 'transparent',
  color: '#f87171',
  border: '1px solid var(--border)',
  borderRadius: 3,
  cursor: 'pointer',
};

function inputStyle(width: number): React.CSSProperties {
  return {
    padding: '4px 8px',
    background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 12,
    width,
    fontFamily: width <= 200 ? "'SF Mono', monospace" : undefined,
  };
}

function Field({ label, value, onChange, mono, multiline }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; multiline?: boolean }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%', padding: '6px 8px', minHeight: 60,
            background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 3, fontSize: 12, resize: 'vertical',
          }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%', padding: '4px 8px',
            background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
            fontFamily: mono ? "'SF Mono', monospace" : undefined,
          }}
        />
      )}
    </label>
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
