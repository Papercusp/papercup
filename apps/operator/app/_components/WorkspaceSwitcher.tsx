'use client';

// Workspace switcher dropdown. Renders in both desktop and webapp modes:
// the underlying wrapper falls back to /api/workspaces HTTP endpoints
// when there's no Tauri runtime. Lists workspaces, lets the user pick
// one (write to registry.json + reload), and surfaces create / rename /
// delete actions.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { useProgress } from '@bprogress/react';
import {
  Workspace,
  WorkspaceRegistry,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  openWorkspaceWindow,
  renameWorkspace,
  switchWorkspace,
} from '@papercusp/operator-core/lib/workspaces-tauri';
import { useConfirmDialog } from '../harness/useConfirmDialog';
import { usePromptDialog } from '../harness/usePromptDialog';
import { Tooltip } from '../harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import { getBrowserWorkspaceId, resolveActiveWorkspaceId } from '@papercusp/operator-core/lib/browser-workspace';

export default function WorkspaceSwitcher() {
  const t = useLexicon();
  const [reg, setReg] = useState<WorkspaceRegistry | null>(null);
  const [open, setOpen] = useQueryState('wsSwitch', parseAsBoolean.withDefault(false));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  const [, setWsParam] = useQueryState('ws', parseAsString);
  const progress = useProgress();

  useEffect(() => {
    listWorkspaces()
      .then((r) => {
        setReg(r);
        // Mirror THIS WINDOW's active workspace into the URL so refreshes /
        // share-links surface which workspace this view belongs to. Resolved
        // from getBrowserWorkspaceId() (__PAPERCUSP_WS__ / ?ws=), NEVER the
        // process-global reg.current — on a shared dev sidecar that one value
        // drives every window, and writing it here flipped a window that
        // opened a different workspace to whatever the global pointed at (the
        // P-030 reload-flip). reg.current is only the new-window default (D-005).
        const active = resolveActiveWorkspaceId(r, getBrowserWorkspaceId());
        if (active && active !== 'default') void setWsParam(active);
      })
      .catch((e) => toast.error(`workspaces: ${e?.message ?? e}`));
  }, [setWsParam]);

  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // The rename input handles its own Escape (cancel rename) — keep the menu open.
      const target = ev.target as HTMLElement | null;
      if (target && menuRef.current?.contains(target) && target.tagName === 'INPUT') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Anchor the portaled menu to the trigger button. Recompute on resize/scroll
  // so the dropdown tracks the button if the layout shifts.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  if (!reg || reg.workspaces.length === 0) return null;

  // The workspace THIS WINDOW is active in (P-030 / D-005) — resolved from the
  // window's own id, not the process-global reg.current. Drives the trigger
  // label, the "active" highlight, and the switch/delete guards. A row is
  // undeletable if the window is operating in it (activeId) or it's the
  // new-window default (reg.current) — removing either pulls a rug out.
  const activeId = resolveActiveWorkspaceId(reg, getBrowserWorkspaceId());
  const current = reg.workspaces.find((w) => w.id === activeId) ?? reg.workspaces[0];
  const undeletable = (id: string) => id === activeId || id === reg.current;

  const refresh = () => listWorkspaces().then(setReg).catch(() => {});

  const onCreate = async () => {
    const name = await askPrompt({
      title: 'New workspace',
      label: 'Workspace name',
      placeholder: 'my-workspace',
      submitLabel: 'Create',
      validate: (v) => v.length > 64 ? 'Max 64 characters' : null,
    });
    if (!name) return;
    try {
      await createWorkspace(name);
      await refresh();
      toast.success(`workspace "${name}" created`);
    } catch (e: any) {
      toast.error(`create failed: ${e?.message ?? e}`);
    }
  };

  const onSwitch = async (id: string) => {
    if (id === activeId) return setOpen(false);
    const target = reg.workspaces.find((w) => w.id === id)?.name ?? id;
    if (!await askConfirm({
      title: `Switch to "${target}"?`,
      body: 'This window will reload into the selected workspace.',
      confirmLabel: 'Switch',
    })) return;
    progress.start(0.08, 0, true);
    try {
      // Phase E (P-050): no longer a restart. switchWorkspace persists the
      // registry default then navigates THIS window to ?ws=<id> (other windows
      // are untouched, P-031); the navigation reloads the view under us.
      await switchWorkspace(id, { resetTo: `/harness?ws=${encodeURIComponent(id)}` });
    } catch (e: any) {
      toast.error(`switch failed: ${e?.message ?? e}`);
      progress.stop(120);
    }
  };

  // Phase E (P-053): open the workspace in a SEPARATE window against the one
  // shared sidecar (desktop) / a new tab (webapp). Leaves this window as-is.
  const onOpenWindow = async (id: string) => {
    setOpen(false);
    try {
      await openWorkspaceWindow(id);
    } catch (e: any) {
      toast.error(`open window failed: ${e?.message ?? e}`);
    }
  };

  const startRename = (ws: Workspace) => {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await renameWorkspace(renamingId, trimmed);
      await refresh();
    } catch (e: any) {
      toast.error(`rename failed: ${e?.message ?? e}`);
    } finally {
      setRenamingId(null);
    }
  };

  const onDelete = async (ws: Workspace) => {
    if (ws.id === activeId) {
      toast.error('switch to another workspace before deleting this one');
      return;
    }
    if (ws.id === reg.current) {
      toast.error('this is the default workspace new windows open into — set another default first');
      return;
    }
    if (!await askConfirm({
      title: `Delete workspace "${ws.name}"?`,
      body: `Its database, ${t('pot', { plural: true })}, snapshots, and credentials are removed permanently. Type the workspace name to confirm.`,
      confirmLabel: 'Delete workspace',
      destructive: true,
      requireType: ws.name,
    })) return;
    try {
      await deleteWorkspace(ws.id);
      await refresh();
      toast.success(`deleted "${ws.name}"`);
    } catch (e: any) {
      toast.error(`delete failed: ${e?.message ?? e}`);
    }
  };

  return (
    <span ref={wrapRef} className="pc-workspace-switcher" style={{ position: 'relative', fontSize: 13 }}>
      {confirmEl}
      {promptEl}
      <Tooltip label="Switch or manage workspaces">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="pc-workspace-trigger"
          style={{
            background: 'transparent',
            border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--fg-dim, #aaa)',
            padding: '3px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch or manage workspaces"
        >
          {current?.name ?? 'workspace'} <span className="pc-workspace-trigger-caret" style={{ opacity: 0.6 }}>▾</span>
        </button>
      </Tooltip>
      {open && menuPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="pc-workspace-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
            minWidth: 240,
            // Solid hex + backdrop-filter:none. Portaled to <body> so the
            // dropdown escapes `.pc-header`'s sticky stacking context (z:50)
            // — otherwise the OracleDock (z:80) paints over it. zIndex sits
            // above the dock and above the harness modal default (100).
            background: '#0f1319',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
            border: '1px solid #2a3344',
            borderRadius: 6,
            padding: 4,
            zIndex: 200,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04)',
          }}
        >
          <div className="pc-workspace-menu-title" style={{ padding: '4px 8px', color: 'var(--fg-mute, #777)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Workspaces
          </div>
          {reg.workspaces.map((ws) => {
            const isCurrent = ws.id === activeId;
            const isRenaming = ws.id === renamingId;
            return (
              <div
                key={ws.id}
                className={`pc-workspace-menu-row${isCurrent ? ' is-current' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 3,
                  background: isCurrent ? 'var(--accent)' : 'transparent',
                }}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="pc-workspace-menu-input"
                    style={{ flex: 1, font: 'inherit', background: 'var(--bg, #111)', border: '1px solid var(--border, #2a2a2a)', color: 'inherit', padding: '2px 6px', borderRadius: 3 }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onSwitch(ws.id)}
                    className="pc-workspace-menu-target"
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: isCurrent ? 'default' : 'pointer',
                      font: 'inherit',
                      padding: 0,
                    }}
                    title={isCurrent ? 'current workspace' : `switch to ${ws.name}`}
                  >
                    {ws.name}
                    {isCurrent && (
                      <span className="pc-workspace-menu-current" style={{ marginLeft: 6, color: 'var(--fg-mute, #777)', fontSize: 11 }}>
                        active
                      </span>
                    )}
                  </button>
                )}
                {!isRenaming && (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpenWindow(ws.id)}
                      title={`Open "${ws.name}" in a new window`}
                      aria-label={`Open ${ws.name} in a new window`}
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute, #777)', cursor: 'pointer', padding: '0 4px' }}
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      onClick={() => startRename(ws)}
                      title="Rename"
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute, #777)', cursor: 'pointer', padding: '0 4px' }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(ws)}
                      title="Delete"
                      disabled={undeletable(ws.id) || reg.workspaces.length <= 1}
                      className="pc-workspace-menu-action"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute, #777)', cursor: undeletable(ws.id) || reg.workspaces.length <= 1 ? 'not-allowed' : 'pointer', padding: '0 4px', opacity: undeletable(ws.id) || reg.workspaces.length <= 1 ? 0.3 : 1 }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <div className="pc-workspace-menu-divider" style={{ height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={onCreate}
            className="pc-workspace-menu-create"
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
              padding: '4px 8px',
              borderRadius: 3,
            }}
          >
            + New workspace…
          </button>
        </div>,
        document.body,
      )}
    </span>
  );
}
