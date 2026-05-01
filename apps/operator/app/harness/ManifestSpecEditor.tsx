'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import Editor from '@monaco-editor/react';
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
      onClick={(e) => e.stopPropagation()}
      style={{
        background: '#0b0e14',
        border: inline ? 'none' : '1px solid #374151',
        borderRadius: inline ? 0 : 6,
        width: inline ? '100%' : '90vw',
        height: inline ? '100%' : '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <strong style={{ color: '#e5e7eb' }}>Edit config — {slug}</strong>
        <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>
          {projectPath}/{activePath}
        </span>
        {alive && (
          <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}>
            ⚠ harness is running — edits take effect on the next agent invocation
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          {toast && (
            <span style={{ color: toast.startsWith('saved') ? '#10b981' : '#ef4444', fontSize: '0.8rem', alignSelf: 'center' }}>{toast}</span>
          )}
          <Tooltip label="Revert active tab to last-saved state">
            <button
              onClick={() => setDraft((d) => ({ ...d, [activePath]: original[activePath] ?? '' }))}
              disabled={!activeDirty}
              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: activeDirty ? 'pointer' : 'not-allowed', opacity: activeDirty ? 1 : 0.5 }}
            >revert tab</button>
          </Tooltip>
          <Tooltip label="Save all dirty files (⌘/Ctrl+S)">
            <button
              onClick={save}
              disabled={dirty.length === 0 || saving}
              style={{ background: dirty.length ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: dirty.length ? 'pointer' : 'not-allowed', fontWeight: 600 }}
            >{saving ? 'saving…' : `save${dirty.length ? ` (${dirty.length})` : ''}`}</button>
          </Tooltip>
          <button onClick={onClose} style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}>close</button>
        </div>
      </div>

      {/* Section tabs: Settings / Memory / Prompts.
          Restored 2026-05-01: Memory + Prompts disappeared when this template-driven
          editor took over from <SpecEditor> for harnesses that ship configFiles. The
          underlying state files (.harness/memory/*, .harness/prompts/<role>.md) are
          still actively read/written by the substrate; only the UI was missing. */}
      <div style={{ display: 'flex', gap: '0.35rem', padding: '0.5rem 1rem', borderBottom: '1px solid #1f2937', background: '#0b1018' }}>
        {SECTIONS.map((s) => {
          const isActive = section === s;
          const label = s === 'settings' ? 'Settings' : s === 'memory' ? 'Memory' : 'Prompts';
          return (
            <button
              key={s}
              onClick={() => setSection(s)}
              style={{
                background: isActive ? '#1f2937' : 'transparent',
                color: isActive ? '#e5e7eb' : '#9ca3af',
                border: '1px solid ' + (isActive ? '#4b5563' : 'transparent'),
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0.5rem 1rem', borderBottom: '1px solid #1f2937', background: '#0b1018' }}>
        {configFiles.map((cf) => {
          const isActive = cf.path === activePath;
          const cfDirty = dirty.includes(cf.path);
          const cfMissing = original[cf.path] === null;
          return (
            <Tooltip key={cf.path} label={cf.description ?? cf.path}>
              <button
                onClick={() => setActivePath(cf.path)}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? '#e5e7eb' : (cfMissing ? '#6b7280' : '#9ca3af'),
                  border: '1px solid ' + (isActive ? '#4b5563' : 'transparent'),
                  borderRadius: 4, padding: '0.35rem 0.7rem',
                  fontSize: 12, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {cfDirty && <span style={{ color: '#fbbf24', fontSize: 10 }}>●</span>}
                <span>{cf.label ?? cf.path}</span>
                {cf.sensitivity === 'secret' && <span style={{ color: '#fca5a5', fontSize: 10 }}>🔒</span>}
                {cf.sensitivity === 'warn' && <span style={{ color: '#fbbf24', fontSize: 10 }}>⚠</span>}
                {cfMissing && <span style={{ color: '#6b7280', fontSize: 10 }}>(missing)</span>}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {activeSpec?.description && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid #1f2937', fontSize: 12, color: '#9ca3af', background: '#0b1018' }}>
          {activeSpec.description}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading ? (
          <div style={{ padding: 24, color: '#9ca3af' }}>Loading…</div>
        ) : activeMissing ? (
          <div style={{ padding: 24, color: '#9ca3af' }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong style={{ color: '#e5e7eb' }}>{activePath}</strong> doesn&rsquo;t exist on disk yet.
            </p>
            <p style={{ marginTop: 8, fontSize: 12 }}>
              Type below — saving will create it.
            </p>
            <div style={{ marginTop: 12, height: 'calc(100% - 80px)', minHeight: 300 }}>
              <Editor
                height="100%"
                language={activeSpec?.language ?? 'text'}
                theme="vs-dark"
                value={activeContent}
                onChange={(v) => setDraft((d) => ({ ...d, [activePath]: v ?? '' }))}
                options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' }}
              />
            </div>
          </div>
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
