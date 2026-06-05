'use client';

/**
 * AgentLauncherButton — the "Launch agent" button in the global chrome,
 * sibling to ConsoleLauncherButton.
 *
 * Where ConsoleLauncherButton opens a plain superuser shell, this opens
 * an agent session scoped to the active workspace, pre-seeded with
 * the Papercusp engineer-collaborator playbook (the @papercusp/omp
 * power-user path). See
 * apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md §4.4.
 *
 * Q-G1 resolved: this is a *visible* sibling button, not a hidden
 * right-click affordance — discoverability wins for a power-user
 * feature most users won't expect behind a context menu.
 *
 * When OMP / @papercusp/omp aren't installed, the launch returns
 * `omp_not_installed` and we surface a small modal with the one-line
 * install command and a Retry button (transient lifecycle state —
 * useState is correct here, not nuqs).
 */

import { useState } from 'react';
import { usePathname } from '@/lib/router-compat/navigation';
import { toast } from 'sonner';

import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';

const DEFAULT_INSTALL_CMD = 'npm i -g @oh-my-pi/cli @papercusp/omp';

function extractHarnessSlug(pathname: string): string | null {
  const m = pathname.match(/^\/harness\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function AgentLauncherButton() {
  const [busy, setBusy] = useState(false);
  const [installCmd, setInstallCmd] = useState<string | null>(null);
  const pathname = usePathname();
  const harnessSlug = extractHarnessSlug(pathname ?? '');

  const tooltip = harnessSlug
    ? `Launch agent in ${harnessSlug}`
    : 'Launch agent in workspace root';

  async function attempt(): Promise<void> {
    setBusy(true);
    try {
      const result = await launchAgent({ slug: harnessSlug });
      if (result.ok) {
        setInstallCmd(null);
        toast.success('Agent launched.', { duration: 4000 });
      } else if (result.installCmd) {
        setInstallCmd(result.installCmd ?? DEFAULT_INSTALL_CMD);
      } else {
        toast.error(`Agent launch failed: ${result.error ?? 'unknown error'}`, {
          duration: 10000,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      toast.error(`Agent launch failed: ${msg}`, { duration: 10000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`pc-console-btn${busy ? ' is-busy' : ''}`}
        aria-label="Launch agent"
        title={tooltip}
        disabled={busy}
        onClick={attempt}
      >
        <AgentIcon />
      </button>

      {installCmd !== null && (
        <OmpInstallHintModal
          installCmd={installCmd}
          busy={busy}
          onRetry={attempt}
          onClose={() => setInstallCmd(null)}
        />
      )}
    </>
  );
}

/**
 * Modal shown when OMP / @papercusp/omp aren't on PATH. Copy-pasteable
 * install command + a Retry that re-runs the launch.
 */
function OmpInstallHintModal(props: {
  installCmd: string;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { installCmd, busy, onRetry, onClose } = props;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Install OMP"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'color-mix(in srgb, var(--bg-deeper), transparent 38%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, var(--bg))',
          border: '1px solid var(--border, #1e2a3a)',
          borderRadius: 10,
          padding: '20px 22px',
          maxWidth: 460,
          width: '90%',
          color: 'var(--text, #d7e2ee)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700 }}>
          OMP isn’t installed
        </h2>
        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
          Launching an agent needs the OMP runtime and the{' '}
          <code>@papercusp/omp</code> plugin. Install both, then retry:
        </p>
        <pre
          style={{
            background: 'var(--bg-deeper)',
            border: '1px solid var(--border, #1e2a3a)',
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12.5,
            overflowX: 'auto',
            margin: '0 0 14px',
            userSelect: 'all',
          }}
        >
          {installCmd}
        </pre>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(installCmd).then(
                () => toast.success('Copied install command.'),
                () => {/* clipboard unavailable — the <pre> is select-all */},
              );
            }}
            style={btnStyle(false)}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={onClose}
            style={btnStyle(false)}
          >
            Close
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            style={btnStyle(true)}
          >
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--border, #1e2a3a)',
    background: primary ? 'var(--accent, #2f81f7)' : 'transparent',
    color: primary ? 'var(--bg-deep)' : 'var(--text, #d7e2ee)',
  };
}

function AgentIcon() {
  // A simple robot/agent head — distinct from ConsoleLauncherButton's
  // terminal glyph so the two buttons read as different actions.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Antenna */}
      <line x1="9" y1="1.6" x2="9" y2="3.6" />
      <circle cx="9" cy="1.4" r="0.9" fill="currentColor" stroke="none" />
      {/* Head */}
      <rect x="2.8" y="3.8" width="12.4" height="9.4" rx="2.4" />
      {/* Eyes */}
      <circle cx="6.4" cy="8.2" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="8.2" r="1.15" fill="currentColor" stroke="none" />
      {/* Mouth */}
      <line x1="6.6" y1="10.9" x2="11.4" y2="10.9" />
      {/* Ears */}
      <line x1="2.8" y1="7.2" x2="1.4" y2="7.2" />
      <line x1="15.2" y1="7.2" x2="16.6" y2="7.2" />
    </svg>
  );
}
