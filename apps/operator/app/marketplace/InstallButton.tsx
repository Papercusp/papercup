'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { navigateClient } from '../../lib/client-navigation';

interface Subproject {
  suffix: string;
  kind: string;
  department_slug?: string;
}

interface Props {
  slug: string;
  alreadyInstalled?: boolean;
  topology?: 'single' | 'multi';
  subprojects?: Subproject[];
}

type Mode = 'idle' | 'fresh' | 'attach';

export default function InstallButton({ slug, alreadyInstalled, topology, subprojects }: Props) {
  const isMulti = topology === 'multi' && Array.isArray(subprojects) && subprojects.length > 0;
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(slug);
  const [path, setPath] = useState('');

  async function doInstall(opts: { projectName: string; targetPath?: string }) {
    setBusy(true);
    try {
      const r = await fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, ...opts }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(d.error ?? 'install failed', { description: d.log?.slice(-500) });
        return;
      }
      const where = d.attachedToExisting ? `attached to ${d.projectPath}` : `at ${d.projectPath}`;
      const multiBlurb = isMulti && subprojects ? ` · ${subprojects.length} sub-harnesses created` : '';
      toast.success(`✓ ${d.projectSlug} installed${multiBlurb}`, {
        description: where,
        action: { label: 'Open harness', onClick: () => navigateClient(`/harness/${d.projectSlug}`) },
        duration: 8000,
      });
      setMode('idle');
      setPath('');
    } catch (e: any) {
      toast.error(`install failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  if (alreadyInstalled && mode === 'idle') {
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8 }}>
        <button
          className="pc-button"
          onClick={stop(() => setMode('fresh'))}
          disabled={busy}
          style={{ background: 'var(--bg-1)', color: 'var(--fg-mute)' }}
        >
          Install again as…
        </button>
      </div>
    );
  }

  if (mode === 'idle') {
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8 }}>
        <button
          className="pc-button primary"
          onClick={stop(() => setMode('fresh'))}
          disabled={busy}
          title={isMulti ? `Will create ${subprojects!.length} workflows` : 'Install a fresh copy of this template'}
        >
          {isMulti ? `Install (${subprojects!.length} workflows)` : 'Install'}
        </button>
        {!isMulti && (
          <button
            className="pc-button ghost"
            onClick={stop(() => setMode('attach'))}
            disabled={busy}
            title="Attach this template to an existing repo on disk (advanced)"
          >
            Attach to repo…
          </button>
        )}
      </div>
    );
  }

  if (mode === 'fresh') {
    const previewLabel = isMulti && subprojects
      ? `${name}, ${subprojects.filter((s) => s.suffix).map((s) => name + s.suffix).join(', ')}`
      : null;
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="project name"
          style={fieldStyle}
        />
        <button className="pc-button" onClick={stop(() => doInstall({ projectName: name }))} disabled={busy}>
          {busy ? 'Installing…' : 'Install'}
        </button>
        <button className="pc-button" onClick={stop(() => setMode('idle'))} disabled={busy} style={cancelStyle}>
          ✕
        </button>
        {previewLabel && (
          <div style={{ flexBasis: '100%', fontSize: 10, color: 'var(--fg-mute)', marginTop: 4 }}>
            will create: <code style={{ fontSize: 10 }}>{previewLabel}</code>
          </div>
        )}
      </div>
    );
  }

  // mode === 'attach'
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="/absolute/path/to/repo"
        style={{ ...fieldStyle, width: 200 }}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="project name"
        style={fieldStyle}
      />
      <button
        className="pc-button"
        onClick={stop(() => doInstall({ projectName: name, targetPath: path }))}
        disabled={busy || !path.trim()}
      >
        {busy ? 'Installing…' : 'Attach'}
      </button>
      <button className="pc-button" onClick={stop(() => setMode('idle'))} disabled={busy} style={cancelStyle}>
        ✕
      </button>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  background: 'var(--bg-1)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
  width: 140,
};

const cancelStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--fg-mute)',
  border: '1px solid var(--border)',
  padding: '4px 8px',
};
