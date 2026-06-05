'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import Editor from '@monaco-editor/react';
import { MarkdownEditor, MarkdownPreview } from '../_components/MarkdownEditor';
import { BacklinksPanel } from '../_components/BacklinksPanel';
import { Tooltip } from './Tooltip';
import MemoryBrowser from './MemoryBrowser';
import PromptsTab from './PromptsTab';

const SECTIONS = ['settings', 'memory', 'prompts'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Template-driven config editor — reads the harness's manifest.configFiles
 * declaration and renders one tab per declared file. Fetches and writes
 * via the unified /api/harness/:slug/file endpoint, so adding a new
 * config file to a template only requires updating the template's
 * manifest, not the substrate code.
 *
 * Used when the harness's manifest declares `configFiles`. Legacy
 * harnesses without configFiles fall through to the original
 * <SpecEditor> with its hardcoded 9-tab list.
 */
export interface ConfigFileSpec {
  path: string;
  label?: string;
  language?: 'markdown' | 'json' | 'yaml' | 'text';
  description?: string;
  sensitivity?: 'normal' | 'warn' | 'secret';
}

interface Props {
  slug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
  configFiles: ConfigFileSpec[];
  inline?: boolean;
}

export default function ManifestSpecEditor({
  slug, projectPath, alive, onClose, configFiles, inline = false,
}: Props) {
  const [section, setSection] = useQueryState(
    'configSection',
    parseAsStringLiteral(SECTIONS).withDefault('settings'),
  );
  const [activePath, setActivePath] = useState<string>(configFiles[0]?.path ?? '');
  const [original, setOriginal] = useState<Record<string, string | null>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Load every declared file in parallel on mount.
  useEffect(() => {
    setLoading(true);
    Promise.all(
      configFiles.map((cf) =>
        fetch(`/api/harness/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(cf.path)}`, { cache: 'no-store' })
          .then((r) => r.ok ? r.json() : Promise.resolve({ path: cf.path, content: null }))
          .then((d) => ({ path: cf.path, content: d.content as string | null }))
          .catch(() => ({ path: cf.path, content: null })),
      ),
    )
      .then((results) => {
        const orig: Record<string, string | null> = {};
        const drf: Record<string, string> = {};
        for (const r of results) {
          orig[r.path] = r.content;
          drf[r.path] = r.content ?? '';
        }
        setOriginal(orig);
        setDraft(drf);
      })
      .finally(() => setLoading(false));
  }, [slug, configFiles]);

  const dirty = useMemo(() => {
    const ds: string[] = [];
    for (const cf of configFiles) {
      if ((original[cf.path] ?? '') !== draft[cf.path]) ds.push(cf.path);
    }
    return ds;
  }, [original, draft, configFiles]);

  const save = useCallback(async () => {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const written: string[] = [];
      for (const path of dirty) {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/file`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, content: draft[path] }),
        });
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        written.push(path);
      }
      setOriginal((o) => ({ ...o, ...Object.fromEntries(written.map((p) => [p, draft[p]])) }));
      setToast(`saved: ${written.length} file${written.length === 1 ? '' : 's'}`);
      setTimeout(() => setToast(null), 2500);
    } catch (e: any) {
      setToast(`save failed: ${e?.message ?? e}`);
    } finally { setSaving(false); }
  }, [dirty, draft, slug]);

  // Cmd/Ctrl+S
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  const activeSpec = configFiles.find((cf) => cf.path === activePath);
  const activeContent = draft[activePath] ?? '';
  const activeMissing = original[activePath] === null;
  const activeDirty = dirty.includes(activePath);

  return (
    <div
      className="h-manifest-editor"
      onClick={(e) => e.stopPropagation()}
      style={{
        background: 'var(--bg)',
        border: inline ? 'none' : '1px solid var(--border)',
        borderRadius: inline ? 0 : 6,
        width: inline ? '100%' : '90vw',
        // Inline: use flex:1 + align-self:stretch so we fill the parent
        // (.h-config-body) regardless of its flex direction. `height: 100%`
        // doesn't resolve reliably when the parent's height comes from
        // `flex: 1 1 0%` rather than an explicit value.
        ...(inline ? { flex: 1, alignSelf: 'stretch', minHeight: 0 } : { height: '90vh' }),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div className="h-manifest-editor-head" style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {/* Section tabs: Settings / Memory / Prompts.
            Restored 2026-05-01: Memory + Prompts disappeared when this template-driven
            editor took over from <SpecEditor> for harnesses that ship configFiles. The
            underlying state files (.papercusp/memory/*, .papercusp/prompts/<role>.md) are
            still actively read/written by the substrate; only the UI was missing. */}
        <div className="h-manifest-section-tabs" style={{ display: 'flex', gap: '0.35rem', padding: 0, borderBottom: 'none', background: 'transparent' }}>
          {SECTIONS.map((s) => {
            const isActive = section === s;
            const label = s === 'settings' ? 'Settings' : s === 'memory' ? 'Memory' : 'Prompts';
            return (
              <button
                key={s}
                className={`h-manifest-section-tab${isActive ? ' is-active' : ''}`}
                onClick={() => setSection(s)}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? 'var(--fg)' : 'var(--fg-mute)',
                  border: '1px solid ' + (isActive ? 'var(--fg-mute)' : 'transparent'),
                  borderRadius: 4,
                  padding: '0.4rem 0.9rem',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="h-manifest-path" style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>
          {projectPath}/{activePath}
        </span>
        {alive && (
          <span className="h-manifest-live-note" style={{ color: 'var(--warn)', fontSize: '0.8rem' }}>
            ⚠ harness is running — edits take effect on the next agent invocation
          </span>
        )}
        <div className="h-manifest-actions" style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          {toast && (
            <span style={{ color: toast.startsWith('saved') ? 'var(--good)' : 'var(--bad)', fontSize: '0.8rem', alignSelf: 'center' }}>{toast}</span>
          )}
          <Tooltip label="Revert active tab to last-saved state">
            <button
              className="h-manifest-action"
              onClick={() => setDraft((d) => ({ ...d, [activePath]: original[activePath] ?? '' }))}
              disabled={!activeDirty}
              style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: activeDirty ? 'pointer' : 'not-allowed', opacity: activeDirty ? 1 : 0.5 }}
            >revert tab</button>
          </Tooltip>
          <Tooltip label="Save all dirty files (⌘/Ctrl+S)">
            <button
              className="h-manifest-action h-manifest-action-primary"
              onClick={save}
              disabled={dirty.length === 0 || saving}
              style={{ background: dirty.length ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: dirty.length ? 'pointer' : 'not-allowed', fontWeight: 600 }}
            >{saving ? 'saving…' : `save${dirty.length ? ` (${dirty.length})` : ''}`}</button>
          </Tooltip>
        </div>
      </div>


      {section === 'memory' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <MemoryBrowser slug={slug} alive={alive} />
        </div>
      ) : section === 'prompts' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <PromptsTab slug={slug} alive={alive} />
        </div>
      ) : (
        <>
      <div className="h-manifest-file-tabs" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        {configFiles.map((cf) => {
          const isActive = cf.path === activePath;
          const cfDirty = dirty.includes(cf.path);
          const cfMissing = original[cf.path] === null;
          return (
            <Tooltip key={cf.path} label={cf.description ?? cf.path}>
              <button
                onClick={() => setActivePath(cf.path)}
                className={`h-manifest-file-tab${isActive ? ' is-active' : ''}${cfDirty ? ' is-dirty' : ''}${cfMissing ? ' is-missing' : ''}`}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? 'var(--fg)' : (cfMissing ? 'var(--fg-mute)' : 'var(--fg-mute)'),
                  border: '1px solid ' + (isActive ? 'var(--fg-mute)' : 'transparent'),
                  borderRadius: 4, padding: '0.35rem 0.7rem',
                  fontSize: 12, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {cfDirty && <span style={{ color: 'var(--warn)', fontSize: 10 }}>●</span>}
                <span>{cf.label ?? cf.path}</span>
                {cf.sensitivity === 'secret' && <span style={{ color: 'var(--bad)', fontSize: 10 }}>🔒</span>}
                {cf.sensitivity === 'warn' && <span style={{ color: 'var(--warn)', fontSize: 10 }}>⚠</span>}
                {cfMissing && <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}>(missing)</span>}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {activeSpec?.description && activeSpec.language !== 'markdown' && (
        <div className="h-manifest-description" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--fg-mute)', background: 'var(--bg)' }}>
          {activeSpec.description}
        </div>
      )}

      <div className="h-manifest-editor-body" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Loading…</div>
        ) : activeMissing ? (
          <div style={{ padding: 24, color: 'var(--fg-mute)' }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong style={{ color: 'var(--fg)' }}>{activePath}</strong> doesn&rsquo;t exist on disk yet.
            </p>
            <p style={{ marginTop: 8, fontSize: 12 }}>
              Type below — saving will create it.
            </p>
            <div style={{ marginTop: 12, height: 'calc(100% - 80px)', minHeight: 300 }}>
              {activeSpec?.language === 'markdown' ? (
                <MarkdownEditor
                  value={activeContent ?? ''}
                  onChange={(v) => setDraft((d) => ({ ...d, [activePath]: v }))}
                  mode="ir"
                  outline="left"
                />
              ) : (
                <Editor
                  height="100%"
                  language={activeSpec?.language ?? 'text'}
                  theme="vs-dark"
                  value={activeContent}
                  onChange={(v) => setDraft((d) => ({ ...d, [activePath]: v ?? '' }))}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' }}
                />
              )}
            </div>
          </div>
        ) : activeSpec?.language === 'markdown' ? (
          <ManifestMarkdownBody
            value={activeContent ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, [activePath]: v }))}
            target={(activePath.split('/').pop() ?? activePath).replace(/\.md$/, '')}
            harness={slug}
            description={activeSpec.description}
          />
        ) : (
          <Editor
            height="100%"
            language={activeSpec?.language ?? 'text'}
            theme="vs-dark"
            value={activeContent}
            onChange={(v) => setDraft((d) => ({ ...d, [activePath]: v ?? '' }))}
            options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' }}
          />
        )}
      </div>
        </>
      )}
    </div>
  );
}

/** Edit/read toggle + Vditor + backlinks panel for a manifest-driven markdown tab. */
function ManifestMarkdownBody({
  value, onChange, target, harness, description,
}: {
  value: string;
  onChange: (v: string) => void;
  target: string;
  harness: string;
  description?: string;
}) {
  const [view, setView] = useQueryState(
    'specView',
    parseAsStringLiteral(['edit', 'read'] as const).withDefault('edit'),
  );
  return (
    <div className="h-manifest-markdown-body" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="h-manifest-view-bar" style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        borderBottom: '1px solid var(--border, #2a2a2a)',
        background: 'var(--bg-2, #15181c)',
      }}>
        <div className="h-manifest-view-toggle" style={{ display: 'flex', gap: 4 }}>
          {(['edit', 'read'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => void setView(m)}
              style={{
                background: view === m ? 'var(--bg, #0b0d10)' : 'transparent',
                border: '1px solid ' + (view === m ? '#4a90e2' : 'transparent'),
                color: view === m ? '#fff' : 'var(--fg-dim)',
                padding: '3px 10px',
                borderRadius: 3,
                fontSize: 11,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
              title={m === 'read' ? 'Reading view (resolves [[wiki-links]])' : 'Editing view'}
            >
              {m === 'edit' ? '✎ Edit' : '👁 Read'}
            </button>
          ))}
        </div>
        {description && (
          <div className="h-manifest-view-description" style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: view === 'read' ? 'auto' : 'visible' }}>
        {view === 'read' ? (
          <div style={{ padding: 16 }}>
            <MarkdownPreview value={value} outline="left" />
          </div>
        ) : (
          <MarkdownEditor value={value} onChange={onChange} mode="ir" outline="left" />
        )}
      </div>
      <BacklinksPanel target={target} harness={harness} />
    </div>
  );
}
