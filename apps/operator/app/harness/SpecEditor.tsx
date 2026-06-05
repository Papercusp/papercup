'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringEnum, parseAsBoolean } from 'nuqs';
import { Tooltip } from './Tooltip';
import { Modal } from './Modal';
import { useConfirmDialog } from './useConfirmDialog';
import Editor from '@monaco-editor/react';
import { MarkdownEditor, MarkdownPreview } from '../_components/MarkdownEditor';
import { BacklinksPanel } from '../_components/BacklinksPanel';
import MemoryBrowser from './MemoryBrowser';
import PromptsTab from './PromptsTab';
import { CollectionTab, type CollectionItem } from './CollectionTab';
import { useSyncQuery } from '@papercusp/sync';

type ProjectFilesRow = { harnessSlug: string; spec: string | null; agents: string | null; contract: string | null; config: string | null; updatedAt: number };
type TextArtifactRow = { harnessSlug: string; relPath: string; content: string; updatedAt: number };

type SimpleTab = 'agents' | 'config' | 'knowledge' | 'mcp' | 'supervisor' | 'claudeSettings' | 'env';
type Tab = SimpleTab | 'skills';

type TabKind = 'file' | 'collection';
type Sensitivity = 'normal' | 'warn' | 'secret';

type Section = 'settings' | 'memory' | 'prompts';

const TABS: Array<{ id: Tab; label: string; filename: string; path: (projectPath: string) => string; language: 'markdown' | 'json'; kind: TabKind; sensitivity?: Sensitivity }> = [
  { id: 'agents',          label: 'AGENTS.md',               filename: 'AGENTS.md',            path: (p) => `${p}/AGENTS.md`,                      language: 'markdown', kind: 'file' },
  { id: 'config',          label: 'config.json',             filename: 'config.json',          path: (p) => `${p}/.papercusp/config.json`,            language: 'json',    kind: 'file' },
  { id: 'mcp',             label: '.mcp.json',               filename: '.mcp.json',            path: (p) => `${p}/.mcp.json`,                       language: 'json',    kind: 'file' },
  { id: 'claudeSettings',  label: '.claude/settings.json',   filename: 'settings.json',        path: (p) => `${p}/.claude/settings.json`,           language: 'json',    kind: 'file', sensitivity: 'warn' },
  { id: 'skills',          label: 'skills',                  filename: '',                     path: (p) => `${p}/.claude/skills/`,                 language: 'markdown', kind: 'collection' },
  { id: 'supervisor',      label: 'supervisor-notes.md',     filename: 'supervisor-notes.md',  path: (p) => `${p}/.papercusp/supervisor-notes.md`,    language: 'markdown', kind: 'file' },
  { id: 'knowledge',       label: 'knowledge.md',            filename: 'knowledge.md',         path: (p) => `${p}/.papercusp/knowledge.md`,           language: 'markdown', kind: 'file' },
  { id: 'env',             label: '.env',                    filename: '.env',                 path: (p) => `${p}/.env`,                            language: 'markdown', kind: 'file', sensitivity: 'secret' },
];

const SIMPLE_TABS: readonly SimpleTab[] = ['agents', 'config', 'knowledge', 'mcp', 'supervisor', 'claudeSettings', 'env'] as const;

interface Props {
  slug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
  inline?: boolean;
}

export default function SpecEditor({ slug, projectPath, alive, onClose, inline = false }: Props) {
  const [section, setSection] = useQueryState(
    'section',
    parseAsStringEnum<Section>(['settings', 'memory', 'prompts']).withDefault('settings'),
  );
  const [tab, setTab] = useQueryState(
    'specTab',
    parseAsStringEnum<Tab>(['agents', 'config', 'knowledge', 'mcp', 'supervisor', 'claudeSettings', 'env', 'skills']).withDefault('agents'),
  );
  const [original, setOriginal] = useState<Record<SimpleTab, string | null>>({ agents: null, config: null, knowledge: null, mcp: null, supervisor: null, claudeSettings: null, env: null });
  const [draft, setDraft] = useState<Record<SimpleTab, string>>({ agents: '', config: '', knowledge: '', mcp: '', supervisor: '', claudeSettings: '', env: '' });
  const [envRevealed, setEnvRevealed] = useQueryState('showEnv', parseAsBoolean.withDefault(false));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Skills is a collection — managed by CollectionTab below.
  // Prompts are managed by PromptsTab under its own section.
  const [skills, setSkills] = useState<string[]>([]);

  // Eager: skills are mirrored to harness_shared.harness_skills by the
  // fs-watcher. Subscribe and derive the file-name list synchronously;
  // the row content is also passed to CollectionTab so selecting a skill
  // paints same-frame instead of round-tripping to /skills/<id>.md.
  const { data: skillRows } = useSyncQuery<{ name: string; content: string }>({
    queryName: 'harnessSkills.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  useEffect(() => {
    if (!Array.isArray(skillRows)) return;
    setSkills(skillRows.map((r) => r.name).sort());
  }, [skillRows]);

  const reloadSkills = useCallback(async () => {
    // Kept for back-compat with callers that invoked it after a CRUD
    // action; the Zero invalidate now keeps `skills` fresh automatically.
    return;
  }, []);

  // Eager Zero subscriptions — replaces 5 sequential REST fetches that
  // ran on mount. agents/config come from the project-files
  // table (one row per harness, four columns); knowledge/mcp/supervisor/
  // claudeSettings come from text-artifacts (one row per rel_path).
  // .env stays REST — file is sensitive, not eagerly synced.
  const { data: projectFilesRows } = useSyncQuery<ProjectFilesRow>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const projectFilesRow = useMemo(
    () => Array.isArray(projectFilesRows) ? projectFilesRows[0] : undefined,
    [projectFilesRows],
  );

  const { data: textArtifactRows } = useSyncQuery<TextArtifactRow>({
    queryName: 'harnessTextArtifact.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const textArtifactByPath = useMemo(() => {
    const m = new Map<string, string>();
    if (!Array.isArray(textArtifactRows)) return m;
    for (const r of textArtifactRows) m.set(r.relPath, r.content ?? '');
    return m;
  }, [textArtifactRows]);

  // Hydrate when subscriptions land. Some artifacts (knowledge/mcp/etc.)
  // aren't yet in PG (Phase 0d) — fall back to REST for those keys.
  useEffect(() => {
    // Wait for both subscriptions to have responded at least once.
    if (projectFilesRows === undefined || textArtifactRows === undefined) return;

    const knowledgeFromPg = textArtifactByPath.get('knowledge.md');
    const mcpFromPg = textArtifactByPath.get('mcp.json');
    const supervisorFromPg = textArtifactByPath.get('supervisor-notes.md');
    const claudeSettingsFromPg = textArtifactByPath.get('claude-settings.json');

    // For artifacts not yet PG-canonical, fall back to REST in parallel.
    const fallbacks: Promise<unknown>[] = [];
    let knowledge = knowledgeFromPg ?? null;
    let mcp = mcpFromPg ?? null;
    let supervisor = supervisorFromPg ?? null;
    let claudeSettings = claudeSettingsFromPg ?? null;
    if (knowledge == null) fallbacks.push(fetch(`/api/harness/${slug}/knowledge`).then((r) => r.json()).then((d) => { knowledge = d.content ?? ''; }));
    if (mcp == null) fallbacks.push(fetch(`/api/harness/${slug}/mcp`).then((r) => r.json()).then((d) => { mcp = d.content ?? ''; }));
    if (supervisor == null) fallbacks.push(fetch(`/api/harness/${slug}/supervisor-notes`).then((r) => r.json()).then((d) => { supervisor = d.content ?? ''; }));
    if (claudeSettings == null) fallbacks.push(fetch(`/api/harness/${slug}/claude-settings`).then((r) => r.json()).then((d) => { claudeSettings = d.content ?? ''; }));

    const apply = () => {
      const o: Record<SimpleTab, string | null> = {
        agents: projectFilesRow?.agents ?? null,
        config: projectFilesRow?.config ?? null,
        knowledge,
        mcp,
        supervisor,
        claudeSettings,
        env: null,
      };
      setOriginal(o);
      setDraft({
        agents: o.agents ?? '',
        config: o.config ?? '',
        knowledge: o.knowledge ?? '',
        mcp: o.mcp ?? '',
        supervisor: o.supervisor ?? '',
        claudeSettings: o.claudeSettings ?? '',
        env: '',
      });
      setLoading(false);
    };

    if (fallbacks.length === 0) {
      apply();
    } else {
      Promise.all(fallbacks)
        .then(apply)
        .catch((e) => { setToast(`load failed: ${e}`); setLoading(false); });
    }
    reloadSkills();
  }, [slug, projectFilesRow, projectFilesRows, textArtifactByPath, textArtifactRows, reloadSkills]);

  const dirty = useMemo(() => {
    const diffs: SimpleTab[] = [];
    for (const t of SIMPLE_TABS) {
      if ((original[t] ?? '') !== draft[t]) diffs.push(t);
    }
    return diffs;
  }, [original, draft]);

  const tabKind = TABS.find((t) => t.id === tab)?.kind ?? 'file';
  const isCollectionTab = tabKind === 'collection';
  const onSettings = section === 'settings';

  const save = useCallback(async () => {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const written: string[] = [];

      // /spec handles agents/config in one call. The SPEC.md tab was removed
      // when plans replaced SPEC.md, and the validation-contract.md tab when
      // VAL-* assertions replaced it (plans-central-harness-ux-2026-05-26).
      const specDirty = dirty.filter((t) => ['agents', 'config'].includes(t));
      if (specDirty.length > 0) {
        const body: Record<string, string> = {};
        for (const t of specDirty) body[t] = draft[t];
        const res = await fetch(`/api/harness/${slug}/spec`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const j = await res.json();
        written.push(...(j.written ?? []));
      }

      // Single-file endpoints
      const singles: Array<[SimpleTab, string, Record<string, string>?]> = [
        ['knowledge',      `/api/harness/${slug}/knowledge`],
        ['mcp',            `/api/harness/${slug}/mcp`],
        ['supervisor',     `/api/harness/${slug}/supervisor-notes`],
        ['claudeSettings', `/api/harness/${slug}/claude-settings`],
        ['env',            `/api/harness/${slug}/env`, { 'x-confirm-secrets': 'yes' }],
      ];
      for (const [t, url, extraHeaders] of singles) {
        if (!dirty.includes(t)) continue;
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
          body: JSON.stringify({ content: draft[t] }),
        });
        if (!res.ok) throw new Error(`${t}: ${res.status}: ${await res.text()}`);
        written.push(t);
      }

      setOriginal({ ...original, ...Object.fromEntries(dirty.map((t) => [t, draft[t]])) });
      setToast(`saved: ${written.join(', ')}`);
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, original, slug]);

  // Lazy-load .env only after user reveals it
  const revealEnv = useCallback(async () => {
    if (envRevealed) return;
    if (!await askConfirm({
      title: 'Show .env contents?',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>This loads plaintext secrets into the browser tab. Only do this on a machine you trust, and close the tab when done.</p>
          <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 12 }}>Type <b>REVEAL</b> to confirm.</p>
        </>
      ),
      confirmLabel: 'Reveal secrets',
      destructive: true,
      requireType: 'REVEAL',
    })) return;
    try {
      const d = await fetch(`/api/harness/${slug}/env`).then((r) => r.json());
      setOriginal((o) => ({ ...o, env: d.content ?? null }));
      setDraft((d2) => ({ ...d2, env: d.content ?? '' }));
      setEnvRevealed(true);
    } catch (e) {
      setToast(`env load failed: ${e}`);
    }
  }, [envRevealed, slug, askConfirm, setEnvRevealed]);

  const revertActive = useCallback(() => {
    if (SIMPLE_TABS.includes(tab as SimpleTab)) {
      const t = tab as SimpleTab;
      setDraft((d) => ({ ...d, [t]: original[t] ?? '' }));
    }
  }, [original, tab]);

  // Ctrl/Cmd+S to save
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

  const tabMeta = TABS.find((t) => t.id === tab)!;
  const simpleTab = SIMPLE_TABS.includes(tab as SimpleTab) ? (tab as SimpleTab) : null;
  const missing = simpleTab ? original[simpleTab] === null : false;
  const isDirtyTab = simpleTab ? dirty.includes(simpleTab) : false;
  const needsEnvReveal = tab === 'env' && !envRevealed;
  const sensitivity = tabMeta.sensitivity;

  const inner = (
    <div
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
      onClick={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {onSettings && (
            <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>{tabMeta.path(projectPath)}</span>
          )}
          {alive && (
            <span style={{ color: 'var(--warn)', fontSize: '0.8rem', marginLeft: '1rem' }}>
              ⚠ harness is running — edits take effect on the next agent invocation
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            {toast && (
              <span style={{ color: toast.startsWith('saved') ? 'var(--good)' : 'var(--bad)', fontSize: '0.8rem', alignSelf: 'center' }}>
                {toast}
              </span>
            )}
            {onSettings && !isCollectionTab && (
              <>
                <Tooltip label="Revert active tab to last-saved state">
                  <button
                    onClick={revertActive}
                    disabled={!isDirtyTab}
                    style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: isDirtyTab ? 'pointer' : 'not-allowed', opacity: isDirtyTab ? 1 : 0.5 }}
                  >
                    revert tab
                  </button>
                </Tooltip>
                <Tooltip label="Save all dirty files (⌘/Ctrl+S)">
                  <button
                    onClick={save}
                    disabled={dirty.length === 0 || saving}
                    style={{ background: dirty.length ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: dirty.length ? 'pointer' : 'not-allowed', fontWeight: 600 }}
                  >
                    {saving ? 'saving…' : `save${dirty.length ? ` (${dirty.length})` : ''}`}
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>

        {/* Section tabs: Settings / Memory / Prompts */}
        <div style={{ display: 'flex', gap: '0.35rem', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
          {(['settings', 'memory', 'prompts'] as const).map((s) => {
            const isActive = section === s;
            const label = s === 'settings' ? 'Settings' : s === 'memory' ? 'Memory' : 'Prompts';
            return (
              <button
                key={s}
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

        {/* Sub-tabs (only within Settings) */}
        {onSettings && (
          <div style={{ display: 'flex', gap: '0.25rem', padding: '0.35rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexWrap: 'wrap' }}>
            {TABS.map((t) => {
              const isActive = t.id === tab;
              const isSimple = SIMPLE_TABS.includes(t.id as SimpleTab);
              const isDirty = isSimple && dirty.includes(t.id as SimpleTab);
              const doesntExist = isSimple && original[t.id as SimpleTab] === null;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    background: isActive ? '#1f2937' : 'transparent',
                    color: isActive ? 'var(--fg)' : 'var(--fg-mute)',
                    border: '1px solid ' + (isActive ? '#374151' : 'transparent'),
                    borderRadius: 3,
                    padding: '0.3rem 0.75rem',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  {t.label}
                  {isDirty && <span style={{ color: 'var(--warn)', marginLeft: 6 }}>●</span>}
                  {doesntExist && !isDirty && <span style={{ color: 'var(--fg-mute)', marginLeft: 6, fontSize: '0.7rem' }}>(new)</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Sensitivity banner (settings only) */}
        {onSettings && sensitivity === 'warn' && (
          <div style={{ padding: '6px 16px', background: 'rgba(245, 158, 11, 0.1)', borderBottom: '1px solid rgba(245, 158, 11, 0.3)', fontSize: 11.5, color: 'var(--warn)' }}>
            ⚠ Editing {tabMeta.label} changes the agent's tool permissions and environment for this project. Malformed JSON will break the agent CLI on the next run (omp -p / claude -p) — JSON is validated before save, but semantics are on you.
          </div>
        )}
        {onSettings && sensitivity === 'secret' && (
          <div style={{ padding: '6px 16px', background: 'rgba(239, 68, 68, 0.1)', borderBottom: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 11.5, color: 'var(--bad)' }}>
            🔒 .env contains secrets. Opening this tab loads plaintext into browser memory. Close the tab when done. Saving requires a confirmation header — drive-by form submits will reject.
          </div>
        )}

        {/* Editor */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {section === 'memory' ? (
            <MemoryBrowser slug={slug} alive={alive} />
          ) : section === 'prompts' ? (
            <PromptsTab slug={slug} alive={alive} />
          ) : needsEnvReveal ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--fg-mute)' }}>
              <span style={{ fontSize: 32 }}>🔒</span>
              <div style={{ fontSize: 13 }}>.env is not loaded until you explicitly reveal it.</div>
              <button onClick={revealEnv} className="h-btn primary" style={{ padding: '6px 16px', fontSize: 12 }}>
                Reveal .env
              </button>
              <div style={{ fontSize: 10, color: 'var(--fg-mute)', maxWidth: 340, textAlign: 'center', marginTop: 4 }}>
                Secrets will load into browser memory. Close this tab when finished.
              </div>
            </div>
          ) : isCollectionTab && tab === 'skills' ? (
            <CollectionTab
              slug={slug}
              collection="skills"
              items={skills.map((f): CollectionItem => ({
                id: f.replace(/\.md$/, ''),
                label: f,
                exists: true,
              }))}
              reloadItems={reloadSkills}
              itemUrl={(id) => `/api/harness/${slug}/skills/${id}.md`}
              language="markdown"
              allowCreate
              createLabel="new skill"
              deletable={() => true}
              getEagerContent={(id) => {
                const row = (skillRows ?? []).find((r) => r.name === `${id}.md`);
                return row?.content;
              }}
            />
          ) : loading ? (
            <div style={{ padding: '2rem', color: 'var(--fg-mute)' }}>loading…</div>
          ) : simpleTab ? (
            tabMeta.language === 'markdown' && simpleTab !== 'env' ? (
              <MarkdownTabBody
                value={draft[simpleTab] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [simpleTab]: v }))}
                target={tabMeta.filename.replace(/\.md$/, '')}
                harness={slug}
              />
            ) : (
              <Editor
                height="100%"
                language={tabMeta.language}
                theme="vs-dark"
                value={draft[simpleTab]}
                onChange={(v) => setDraft((d) => ({ ...d, [simpleTab]: v ?? '' }))}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            )
          ) : null}
          {onSettings && missing && simpleTab && !dirty.includes(simpleTab) && !isCollectionTab && (
            <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'var(--bg-2)', border: '1px solid var(--border)', padding: '0.35rem 0.65rem', borderRadius: 3, fontSize: '0.75rem', color: 'var(--fg-mute)' }}>
              file doesn&apos;t exist yet — first save creates it
            </div>
          )}
        </div>
      </div>
  );

  if (inline) return <>{confirmEl}{inner}</>;

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Spec editor"
      srOnlyTitle
    >
      {confirmEl}
      {inner}
    </Modal>
  );
}

/**
 * Body of a markdown tab: edit/read toggle + Vditor + backlinks panel.
 * Edit mode mounts <MarkdownEditor>; read mode mounts <MarkdownPreview>
 * which expands [[wiki-links]] into clickable resolver routes. The toggle
 * preference is persisted via nuqs so navigating away/back keeps the view.
 */
function MarkdownTabBody({
  value, onChange, target, harness,
}: {
  value: string;
  onChange: (v: string) => void;
  target: string;
  harness: string;
}) {
  const [view, setView] = useQueryState(
    'specView',
    parseAsStringEnum<'edit' | 'read'>(['edit', 'read']).withDefault('edit'),
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', gap: 4, padding: '6px 12px',
        borderBottom: '1px solid var(--border, #2a2a2a)',
        background: 'var(--bg-2, #15181c)',
      }}>
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
