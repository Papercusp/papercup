'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tooltip } from './Tooltip';
import { useConfirmDialog } from './useConfirmDialog';
import { MarkdownEditor } from '../_components/MarkdownEditor';
import { RotateCcw, Loader2, Globe, User } from 'lucide-react';
import { toast } from 'sonner';
import { useShortcut } from '../../lib/hotkeys';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

type TextArtifactRow = { harnessSlug: string; relPath: string; content: string; updatedAt: number };

interface Props {
  slug: string;
  alive: boolean;
}

type Scope = 'global' | 'override';

interface RoleData {
  content: string;          // project override (may be empty)
  globalContent: string;    // global base (read-only)
  overrideExists: boolean;
}

/**
 * Build the role→override-content map from the harness text-artifact rows. Only
 * rows keyed `prompts/<role>.md` are prompt overrides; the role is the captured
 * group. Pure so the (slightly fiddly) regex keying is testable on its own.
 */
export function overrideMapFromArtifacts(
  rows: unknown,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!Array.isArray(rows)) return m;
  for (const r of rows as Array<{ relPath?: string; content?: string }>) {
    const match = /^prompts\/(.+)\.md$/.exec(r.relPath ?? '');
    if (match) m.set(match[1], r.content ?? '');
  }
  return m;
}

export default function PromptsTab({ slug, alive }: Props) {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [roles, setRoles] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ role: string; scope: Scope } | null>(null);

  const [data, setData] = useState<RoleData | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [originalOverride, setOriginalOverride] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const reloadList = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/prompts`).then((r) => r.json());
      setRoles(r.roles ?? []);
      setOverrides(r.overrides ?? []);
    } catch {}
  }, [slug]);

  useEffect(() => { reloadList(); }, [reloadList]);

  // Default selection: orchestrator / global (most common starting point)
  useEffect(() => {
    if (!selected && roles.length > 0) {
      const first = roles.includes('orchestrator') ? 'orchestrator' : roles[0];
      setSelected({ role: first, scope: 'global' });
    }
  }, [roles, selected]);

  // Eager Zero subscription — pulls all prompt overrides for this
  // harness in one shot. The override content lives in
  // harness_text_artifacts at rel_path = `prompts/<role>.md`. We still
  // hit REST for `globalContent` (the orchestrator default lives in the
  // harness runtime dir, not per-harness PG).
  const { data: textArtifactRows } = useSyncQuery<TextArtifactRow>({
    queryName: 'harnessTextArtifact.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });
  const overrideByRole = useMemo(() => overrideMapFromArtifacts(textArtifactRows), [textArtifactRows]);

  // Hydrate the panel when the selected role changes. Override content
  // is available synchronously from the Zero subscription Map; render
  // immediately, then enrich with globalContent when REST returns.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const overrideContent = overrideByRole.get(selected.role) ?? '';
    // Render immediately with the cached override (no loading flash).
    setData({ content: overrideContent, globalContent: '', overrideExists: overrideContent.length > 0 });
    setDraft(overrideContent);
    setOriginalOverride(overrideContent);
    setLoading(false);
    // Fetch globalContent in the background; merge when it lands.
    fetch(`/api/harness/${slug}/prompts/${selected.role}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const globalContent = typeof d.globalContent === 'string' ? d.globalContent : '';
        const overrideFromRest = typeof d.content === 'string' ? d.content : '';
        // Subscription wins for override; REST only fills global.
        setData((prev) => ({
          content: prev?.content ?? overrideFromRest,
          globalContent,
          overrideExists: prev?.overrideExists || !!d.overrideExists,
        }));
      })
      .catch((e) => toast.error(`load global failed: ${e.message ?? e}`));
    return () => { cancelled = true; };
  }, [slug, selected?.role, overrideByRole]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = selected?.scope === 'override' && draft !== originalOverride;

  const saveOverride = useCallback(async () => {
    if (!selected || selected.scope !== 'override' || !dirty) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/harness/${slug}/prompts/${selected.role}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOriginalOverride(draft);
      setData((d) => d ? { ...d, content: draft, overrideExists: true } : d);
      toast.success(`saved ${selected.role} override`);
      reloadList();
    } catch (e: any) {
      toast.error(`save failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }, [slug, selected, dirty, draft, reloadList]);

  const deleteOverride = useCallback(async () => {
    if (!selected || selected.scope !== 'override' || !data?.overrideExists) return;
    if (!await askConfirm({
      title: `Reset ${selected.role} to default?`,
      body: 'Reverts this role to the global base prompt for this harness (clears the project override).',
      confirmLabel: 'Reset to default',
      destructive: true,
    })) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/harness/${slug}/prompts/${selected.role}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      toast.success(`reset ${selected.role} to default`);
      setData((d) => d ? { ...d, content: '', overrideExists: false } : d);
      setDraft('');
      setOriginalOverride('');
      reloadList();
    } catch (e: any) {
      toast.error(`reset failed: ${e.message ?? e}`);
    } finally {
      setDeleting(false);
    }
  }, [slug, selected, data, reloadList, askConfirm]);

  // D-6: per-group "reset all to default" — clears every project override for
  // this harness in the active workspace, reverting all roles to their global
  // base. Wired to POST /prompts/reset-all (workspace-owned PG store).
  const resetAll = useCallback(async () => {
    if (overrides.length === 0) return;
    if (!await askConfirm({
      title: `Reset all ${overrides.length} override${overrides.length === 1 ? '' : 's'} to default?`,
      body: 'Reverts every role in this harness to its global base prompt, clearing all project overrides for the active workspace. This cannot be undone.',
      confirmLabel: 'Reset all to default',
      destructive: true,
    })) return;
    setResettingAll(true);
    try {
      const r = await fetch(`/api/harness/${slug}/prompts/reset-all`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json().catch(() => ({} as { cleared?: number }));
      toast.success(`reset ${j.cleared ?? overrides.length} override${(j.cleared ?? overrides.length) === 1 ? '' : 's'} to default`);
      // Clear the open editor if it was showing an override.
      setData((d) => (d ? { ...d, content: '', overrideExists: false } : d));
      setDraft('');
      setOriginalOverride('');
      reloadList();
    } catch (e: any) {
      toast.error(`reset all failed: ${e.message ?? e}`);
    } finally {
      setResettingAll(false);
    }
  }, [slug, overrides.length, reloadList, askConfirm]);

  // Ctrl/Cmd+S saves when on override scope. Sourced from the registry
  // so /settings/shortcuts can rebind it.
  useShortcut('editor.save', () => {
    if (selected?.scope === 'override' && dirty) saveOverride();
  }, {}, [selected, dirty, saveOverride]);

  const scope = selected?.scope ?? 'global';
  const editorValue = !data
    ? ''
    : scope === 'global'
      ? data.globalContent
      : draft;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {confirmEl}
      {/* ─── Sidebar: two grouped sections ─── */}
      <div style={{
        width: 240, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column',
        overflow: 'auto',
      }}>
        <SidebarSection
          title="Global (read-only)"
          icon={<Globe size={11} />}
          roles={roles}
          selected={selected}
          scope="global"
          overrides={overrides}
          onSelect={(role) => setSelected({ role, scope: 'global' })}
        />
        <SidebarSection
          title={`Project overrides · ${overrides.length}`}
          icon={<User size={11} />}
          roles={roles}
          selected={selected}
          scope="override"
          overrides={overrides}
          onSelect={(role) => setSelected({ role, scope: 'override' })}
          headerAction={
            overrides.length > 0 ? (
              <Tooltip label="Reset every role in this harness to its global base prompt">
                <button
                  className="h-btn ghost"
                  onClick={resetAll}
                  disabled={resettingAll}
                  style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <RotateCcw size={10} /> {resettingAll ? 'resetting…' : 'reset all'}
                </button>
              </Tooltip>
            ) : null
          }
        />
      </div>

      {/* ─── Editor ─── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!selected ? (
          <div className="h-empty">select a role on the left</div>
        ) : (
          <>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8,
              flexShrink: 0, background: 'var(--bg-2)',
            }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {selected.role}
              </span>
              <span style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 3,
                background: scope === 'global' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                color: scope === 'global' ? '#60a5fa' : '#34d399',
                border: `1px solid ${scope === 'global' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
              }}>
                {scope === 'global' ? 'global · read-only' : 'project override'}
              </span>
              {dirty && <span style={{ color: 'var(--warn)', fontSize: 16, lineHeight: 1 }}>●</span>}
              {loading && <Loader2 size={12} className="h-spin" />}
              {scope === 'override' && !data?.overrideExists && !dirty && (
                <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                  (no override yet — type to create one)
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {scope === 'override' && data?.overrideExists && (
                  <Tooltip label="Reset this role to the global base prompt (clears its override)">
                    <button className="h-btn ghost" onClick={deleteOverride} disabled={deleting}>
                      <RotateCcw size={11} /> reset to default
                    </button>
                  </Tooltip>
                )}
                {scope === 'override' && (
                  <button className="h-btn primary" onClick={saveOverride} disabled={!dirty || saving}>
                    {saving ? 'saving…' : 'save'}
                  </button>
                )}
              </div>
            </div>
            {scope === 'global' && (
              <div style={{
                padding: '6px 16px',
                background: 'rgba(59, 130, 246, 0.08)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.2)',
                fontSize: 11.5, color: '#93c5fd',
              }}>
                Base prompt at <code style={{ fontFamily: 'ui-monospace, monospace' }}>~/autonomous-harness/prompts/{selected.role}.md</code>.
                Read-only from the UI because changes apply to every project — edit the file directly if that is what you intend.
              </div>
            )}
            {alive && scope === 'override' && (
              <div style={{
                padding: '6px 16px',
                background: 'rgba(245, 158, 11, 0.08)',
                borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
                fontSize: 11.5, color: 'var(--warn)',
              }}>
                ⚠ harness is running — edits take effect on the next agent invocation
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <MarkdownEditor
                value={editorValue ?? ''}
                onChange={setDraft}
                mode="ir"
                outline="left"
                readOnly={scope === 'global'}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SidebarSection({
  title, icon, roles, selected, scope, overrides, onSelect, headerAction,
}: {
  title: string;
  icon: React.ReactNode;
  roles: string[];
  selected: { role: string; scope: Scope } | null;
  scope: Scope;
  overrides: string[];
  onSelect: (role: string) => void;
  headerAction?: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div style={{
        padding: '8px 10px',
        fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase',
        color: 'var(--fg-dim)', fontWeight: 600,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {icon} {title}
        {headerAction}
      </div>
      {roles.map((role) => {
        const isActive = selected?.role === role && selected?.scope === scope;
        const hasOverride = overrides.includes(role);
        return (
          <button
            key={`${scope}-${role}`}
            onClick={() => onSelect(role)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              width: '100%', textAlign: 'left',
              padding: '7px 10px 7px 22px',
              background: isActive ? 'var(--bg-3)' : 'transparent',
              color: scope === 'override' && !hasOverride ? 'var(--fg-dim)' : 'var(--fg)',
              border: 'none',
              borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 60%)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            <span>{role}</span>
            {scope === 'override' && hasOverride && (
              <span style={{ color: 'var(--good)', fontSize: 9, marginLeft: 'auto' }}>●</span>
            )}
            {scope === 'override' && !hasOverride && (
              <span style={{ color: 'var(--fg-dim)', fontSize: 9, marginLeft: 'auto' }}>—</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
