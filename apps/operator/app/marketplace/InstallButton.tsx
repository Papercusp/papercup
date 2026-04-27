'use client';

import { useState } from 'react';
import { toast } from 'sonner';

interface Props {
  slug: string;
  alreadyInstalled?: boolean;
}

export default function InstallButton({ slug, alreadyInstalled }: Props) {
  const [busy, setBusy] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [name, setName] = useState(slug);

  async function doInstall(projectName: string) {
    setBusy(true);
    try {
      const r = await fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, projectName }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        if (r.status === 409) {
          toast.error(d.error ?? 'name already exists');
          setShowRename(true);
          return;
        }
        toast.error(d.error ?? 'install failed', { description: d.log?.slice(-500) });
        return;
      }
      toast.success(`✓ ${d.projectSlug} installed`, {
        description: `at ${d.projectPath}`,
        action: { label: 'Open harness', onClick: () => (window.location.href = `/harness/${d.projectSlug}`) },
        duration: 8000,
      });
      setShowRename(false);
    } catch (e: any) {
      toast.error(`install failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  function onPrimaryClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (showRename) doInstall(name);
    else doInstall(slug);
  }

  function onRenameClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setShowRename(true);
  }

  if (alreadyInstalled) {
    return (
      <button
        className="pc-button"
        onClick={onRenameClick}
        disabled={busy}
        style={{ background: 'var(--bg-1)', color: 'var(--fg-mute)' }}
      >
        Install again as…
      </button>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {showRename && (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="project name"
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 12,
            width: 140,
          }}
        />
      )}
      <button className="pc-button" onClick={onPrimaryClick} disabled={busy}>
        {busy ? 'Installing…' : showRename ? 'Install' : 'Install'}
      </button>
    </div>
  );
}
