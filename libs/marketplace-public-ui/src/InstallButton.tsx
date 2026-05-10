'use client';

import { useState } from 'react';

interface Subproject {
  suffix: string;
  kind: string;
  department_slug?: string;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  log?: string;
  projectSlug?: string;
  projectPath?: string;
  attachedToExisting?: boolean;
  /** Stable error code from the API — used by the UI to special-case
   * recovery affordances. Currently 'project_name_taken' surfaces a
   * one-click "use suggestedName" button; other codes fall through to
   * the generic error toast.
   */
  code?: string;
  /** When ok=false + code='project_name_taken', the API includes the
   * first free <name>-N suggestion the UI can offer.
   */
  suggestedName?: string | null;
}

interface Props {
  slug: string;
  alreadyInstalled?: boolean;
  topology?: 'single' | 'multi';
  subprojects?: Subproject[];
  onInstall?: (slug: string, opts: { projectName: string; targetPath?: string }) => Promise<InstallResult>;
  onSuccess?: (result: InstallResult) => void;
  notify?: (level: 'success' | 'error', msg: string, detail?: string) => void;
  detailHref?: string;
}

type Mode = 'idle' | 'fresh' | 'attach';

export function InstallButton({
  slug,
  alreadyInstalled,
  topology,
  subprojects,
  onInstall,
  onSuccess,
  notify,
  detailHref,
}: Props) {
  const isMulti = topology === 'multi' && Array.isArray(subprojects) && subprojects.length > 0;
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(slug);
  const [path, setPath] = useState('');

  if (!onInstall) {
    return (
      <a
        className="pc-button primary"
        href={detailHref ?? `/marketplace/${encodeURIComponent(slug)}`}
        onClick={(e) => e.stopPropagation()}
      >
        View details
      </a>
    );
  }

  async function doInstall(opts: { projectName: string; targetPath?: string }) {
    if (!onInstall) return;
    setBusy(true);
    try {
      const d = await onInstall(slug, opts);
      if (!d.ok) {
        // Slug-collision recovery: if the API tells us the name is
        // taken AND offers a free suggestion, prompt the user once. On
        // confirm, retry with the suggestion. Saves the user the trip
        // back to the form.
        if (d.code === 'project_name_taken' && d.suggestedName) {
          const useSuggested = confirm(
            `${opts.projectName} already exists.\n\nUse "${d.suggestedName}" instead?`,
          );
          if (useSuggested) {
            setName(d.suggestedName);
            // Retry inline — no recursive call to keep the busy spinner consistent.
            const retry = await onInstall(slug, { ...opts, projectName: d.suggestedName });
            if (!retry.ok) {
              notify?.('error', retry.error ?? 'install failed', retry.log?.slice(-500));
              return;
            }
            notify?.(
              'success',
              `✓ ${retry.projectSlug} installed`,
              retry.attachedToExisting ? `attached to ${retry.projectPath}` : `at ${retry.projectPath}`,
            );
            onSuccess?.(retry);
            setMode('idle');
            setPath('');
            return;
          }
        }
        notify?.('error', d.error ?? 'install failed', d.log?.slice(-500));
        return;
      }
      const where = d.attachedToExisting ? `attached to ${d.projectPath}` : `at ${d.projectPath}`;
      const multiBlurb = isMulti && subprojects ? ` · ${subprojects.length} sub-harnesses created` : '';
      notify?.('success', `✓ ${d.projectSlug} installed${multiBlurb}`, where);
      onSuccess?.(d);
      setMode('idle');
      setPath('');
    } catch (e: any) {
      notify?.('error', `install failed: ${e?.message ?? e}`);
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
