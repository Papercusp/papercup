'use client';

import { useEffect, useState } from 'react';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';
import { InlinePtyTerminal } from './InlinePtyTerminal';

interface AgentRuntime {
  claude: boolean;
  codex: boolean;
  omp: boolean;
  meridian: boolean;
}

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  installRuntime: SpawnSpec;
}

export function StepAgents() {
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installSpec, setInstallSpec] = useState<SpawnSpec | null>(null);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [tauri, setTauri] = useState(false);
  // Bumped per install attempt so the pty terminal remounts cleanly
  // on Retry rather than relying on spec-object reference churn.
  const [attempt, setAttempt] = useState(0);

  // Detection comes from /api/desktop/setup-status — the SAME source
  // the wizard sidebar uses, so the card and the badge never disagree.
  const refreshRuntime = async () => {
    try {
      const r = await fetch('/api/desktop/setup-status', { cache: 'no-store' });
      if (r.ok) {
        const j = (await r.json()) as { agentRuntime?: AgentRuntime };
        if (j.agentRuntime) setRuntime(j.agentRuntime);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTauri(isTauriNative());
    void refreshRuntime();
    const id = setInterval(() => void refreshRuntime(), 5000);
    return () => clearInterval(id);
  }, []);

  const claudeOk = runtime?.claude ?? false;
  const codexOk = runtime?.codex ?? false;
  const ompOk = runtime?.omp ?? false;
  const meridianOk = runtime?.meridian ?? false;
  // A complete backend is EITHER a standalone CLI agent (Claude Code or
  // Codex — the orchestrator drives the CLI directly) OR oh-my-pi +
  // Meridian (the multi-provider path).
  const ompPathOk = ompOk && meridianOk;
  const allOk = claudeOk || codexOk || ompPathOk;

  const startInstall = async () => {
    setLastExitCode(null);
    setStartError(null);
    try {
      const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PtyCommands;
      if (!j.installRuntime?.command) throw new Error('malformed install command');
      setAttempt((n) => n + 1);
      setInstallSpec(j.installRuntime);
      setInstalling(true);
    } catch (e: any) {
      setInstallSpec(null);
      setInstalling(false);
      setStartError(
        `Couldn't start the installer: ${e?.message ?? e}. Use the manual commands below.`,
      );
    }
  };

  const handleExit = (code: number) => {
    setLastExitCode(code);
    setInstalling(false);
    void refreshRuntime();
    // installSpec stays set on failure so the terminal pane (with the
    // exit log) remains visible. Clicking Retry blows it away.
    if (code === 0) setInstallSpec(null);
  };

  const dismissPanel = () => {
    setInstallSpec(null);
    setLastExitCode(null);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp needs an <strong>agent backend</strong>. The simplest is{' '}
        <strong>Claude Code</strong> — just the <code>claude</code> CLI signed into
        your Claude subscription; the orchestrator drives it and background calls go
        straight to Anthropic. <strong>Codex</strong> (the <code>codex</code> CLI,
        OpenAI) works the same way. Or use <strong>oh-my-pi + Meridian</strong> to
        route through other providers. You need <em>one</em> complete path, not all
        of them.
      </p>

      {!loading && (
        <div className="pc-step__progress" data-status={allOk ? 'ok' : 'missing'}>
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            {allOk ? (
              <>
                <strong>Ready.</strong>
                <span>
                  {[
                    claudeOk && 'Claude Code',
                    codexOk && 'Codex',
                    ompPathOk && 'oh-my-pi + Meridian',
                  ]
                    .filter(Boolean)
                    .join(', ')}{' '}
                  installed.
                </span>
              </>
            ) : (
              <>
                <strong>No agent backend yet.</strong>
                <span>
                  Install <strong>Claude Code</strong> (the <code>claude</code> CLI),{' '}
                  <strong>Codex</strong> (the <code>codex</code> CLI) — or oh-my-pi +
                  Meridian. Click Install to run the commands here in the wizard.
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {tauri && (
        <div
          className="pc-step__actions"
          style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={() => void startInstall()}
            disabled={loading || installing || allOk}
          >
            {loading
              ? 'Checking…'
              : installing
                ? 'Installing…'
                : allOk
                  ? 'Installed'
                  : lastExitCode !== null && lastExitCode !== 0
                    ? 'Retry install'
                    : 'Install Agent Runtime'}
          </button>
          {installSpec && !installing && (
            <button type="button" className="pc-btn" onClick={dismissPanel}>
              Dismiss log
            </button>
          )}
        </div>
      )}

      {startError && (
        <p style={{ marginTop: 8, color: 'var(--pc-color-danger, #d33)', fontSize: 13 }}>
          {startError}
        </p>
      )}

      {installSpec && (
        <InlinePtyTerminal
          key={attempt}
          command={installSpec.command}
          args={installSpec.args}
          cwd={installSpec.cwd}
          env={installSpec.env}
          rows={20}
          readOnly
          onExit={handleExit}
          onSpawnError={(msg) => {
            // Without this the button sticks on "Installing…" forever
            // when the pty never comes up (found live 2026-06-12).
            setInstalling(false);
            setLastExitCode(-1);
            setStartError(`Installer terminal failed to start: ${msg}. Use the manual commands below.`);
          }}
        />
      )}

      {!tauri && !loading && (
        <div
          className="pc-step__progress"
          data-status="missing"
          style={{ marginTop: 16 }}
        >
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Open this in the desktop app to install.</strong>
            <span>The wizard's install button runs commands locally; that needs Tauri.</span>
          </div>
        </div>
      )}

      <p className="pc-step__hint" style={{ marginTop: 16 }}>
        <button type="button" className="pc-link-btn" onClick={() => setShowManual((v) => !v)}>
          {showManual ? 'Hide manual install commands' : 'Or install manually ↓'}
        </button>
      </p>
      {showManual && (
        <div className="pc-agent-card" style={{ marginTop: 8 }}>
          <p className="pc-agent-card__install-label">From a terminal:</p>
          <pre className="pc-code">
            {`# Claude Code
curl -fsSL https://claude.ai/install.sh | bash   # macOS/Linux
iwr https://claude.ai/install.ps1 | iex          # Windows PowerShell

# Codex (OpenAI)
npm install -g @openai/codex

# Meridian (per-workspace install root; oh-my-pi ships bundled
# with the desktop app — it has no npm package)
mkdir -p ~/.papercusp/runtime
cd ~/.papercusp/runtime && npm init -y
npm install @rynfar/meridian
`}
          </pre>
          <p className="pc-agent-card__link">
            <a href="https://docs.anthropic.com/claude/docs/claude-code" target="_blank" rel="noreferrer">
              Claude Code docs ↗
            </a>{' '}
            ·{' '}
            <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
              Codex docs ↗
            </a>{' '}
            ·{' '}
            <a href="https://github.com/can1357/oh-my-pi" target="_blank" rel="noreferrer">
              oh-my-pi docs ↗
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
