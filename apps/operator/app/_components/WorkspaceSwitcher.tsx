'use client';

// Workspace switcher dropdown. Renders only when running inside the Tauri
// desktop shell (web mode returns null). Lists workspaces from
// `workspaces_list`, lets the user pick one (triggers `workspaces_switch`,
// which kills the sidecar and restarts the app), and surfaces create /
// rename / delete actions.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Workspace,
  WorkspaceRegistry,
  createWorkspace,
  deleteWorkspace,
  isDesktop,
  listWorkspaces,
  renameWorkspace,
  switchWorkspace,
} from '../../lib/workspaces-tauri';

export default function WorkspaceSwitcher() {
  const [desktop, setDesktop] = useState(false);
  const [reg, setReg] = useState<WorkspaceRegistry | null>(null);
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setDesktop(isDesktop());
  }, []);

  useEffect(() => {
    if (!desktop) return;
    listWorkspaces()
      .then(setReg)
      .catch((e) => toast.error(`workspaces: ${e?.message ?? e}`));
  }, [desktop]);

  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!desktop || !reg) return null;

  const current = reg.workspaces.find((w) => w.id === reg.current) ?? reg.workspaces[0];

  const refresh = () => listWorkspaces().then(setReg).catch(() => {});

  const onCreate = async () => {
    const name = window.prompt('New workspace name');
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
    if (id === reg.current) return setOpen(false);
    if (
      !window.confirm(
        `Switch to "${reg.workspaces.find((w) => w.id === id)?.name}"? The app will reload.`,
      )
    ) {
      return;
    }
    try {
      await switchWorkspace(id);
      // The promise above never actually resolves — the Tauri shell calls
      // app.restart() before responding. If we get here, the call returned
      // before the restart took effect; do nothing (the reload is coming).
    } catch (e: any) {
      toast.error(`switch failed: ${e?.message ?? e}`);
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
    if (ws.id === reg.current) {
      toast.error('switch to another workspace before deleting this one');
      return;
    }
    if (
      !window.confirm(
        `Delete workspace "${ws.name}"? Its database, harnesses, snapshots, and credentials are removed permanently.`,
      )
    ) {
      return;
    }
    try {
      await deleteWorkspace(ws.id);
      await refresh();
      toast.success(`deleted "${ws.name}"`);
    } catch (e: any) {
      toast.error(`delete failed: ${e?.message ?? e}`);
    }
  };

  return (
    <span ref={wrapRef} style={{ position: 'relative', fontSize: 13 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
        title="Switch or manage workspaces"
      >
        {current?.name ?? 'workspace'} <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 240,
            background: 'var(--bg-elev, #1a1a1a)',
            border: '1px solid var(--border, #2a2a2a)',
            borderRadius: 4,
            padding: 4,
            zIndex: 100,
            boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ padding: '4px 8px', color: 'var(--fg-mute, #777)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Workspaces
          </div>
          {reg.workspaces.map((ws) => {
            const isCurrent = ws.id === reg.current;
            const isRenaming = ws.id === renamingId;
            return (
              <div
                key={ws.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 3,
                  background: isCurrent ? 'var(--accent-bg, #1f2d3d)' : 'transparent',
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
                    style={{ flex: 1, font: 'inherit', background: 'var(--bg, #111)', border: '1px solid var(--border, #2a2a2a)', color: 'inherit', padding: '2px 6px', borderRadius: 3 }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onSwitch(ws.id)}
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
                      <span style={{ marginLeft: 6, color: 'var(--fg-mute, #777)', fontSize: 11 }}>
                        active
                      </span>
                    )}
                  </button>
                )}
                {!isRenaming && (
                  <>
                    <button
                      type="button"
                      onClick={() => startRename(ws)}
                      title="Rename"
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute, #777)', cursor: 'pointer', padding: '0 4px' }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(ws)}
                      title="Delete"
                      disabled={isCurrent || reg.workspaces.length <= 1}
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-mute, #777)', cursor: isCurrent || reg.workspaces.length <= 1 ? 'not-allowed' : 'pointer', padding: '0 4px', opacity: isCurrent || reg.workspaces.length <= 1 ? 0.3 : 1 }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <div style={{ height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={onCreate}
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
        </div>
      )}
    </span>
  );
}
