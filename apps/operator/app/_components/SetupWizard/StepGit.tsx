'use client';

import { useEffect, useState } from 'react';
import { isTauriNative } from '@/lib/pty-tauri';
import { InlinePtyTerminal } from './InlinePtyTerminal';

interface GitIdentity {
  name?: string;
  email?: string;
  source?: 'global' | 'system' | 'none';
}

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  loginGithub?: SpawnSpec;
}

interface AuthStatus {
  claude?: boolean;
  omp?: boolean;
  github?: boolean;
}

export function StepGit() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [tauri, setTauri] = useState(false);
  const [ghInstalled, setGhInstalled] = useState<boolean | null>(null);
  const [spec, setSpec] = useState<SpawnSpec | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({});
  const [active, setActive] = useState(false);
  const [exited, setExited] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const refreshAuth = async () => {
    try {
      const r = await fetch('/api/desktop/agent-auth-status', { cache: 'no-store' });
      if (r.ok) setAuthStatus((await r.json()) as AuthStatus);
    } catch { /* leave previous */ }
  };

  useEffect(() => {
    setTauri(isTauriNative());
    void (async () => {
      try {
        const [identRes, pfRes, specsRes] = await Promise.all([
          fetch('/api/desktop/git-identity', { cache: 'no-store' }),
          fetch('/api/desktop/preflight', { cache: 'no-store' }),
          fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' }),
        ]);
        if (identRes.ok) {
          const j = (await identRes.json()) as GitIdentity;
          setIdentity(j);
        } else {
          setIdentity({ source: 'none' });
        }
        if (pfRes.ok) {
          const pf = (await pfRes.json()) as { checks: Array<{ name: string; status: string }> };
          const gh = pf.checks?.find((c) => c.name === 'gh');
          setGhInstalled(gh?.status === 'ok');
        }
        if (specsRes.ok) {
          const j = (await specsRes.json()) as PtyCommands;
          if (j.loginGithub) setSpec(j.loginGithub);
        }
      } catch {
        setIdentity({ source: 'none' });
      } finally {
        setLoading(false);
      }
    })();
    void refreshAuth();
    const id = setInterval(() => void refreshAuth(), 5000);
    return () => clearInterval(id);
  }, []);

  const configured = Boolean(identity?.name && identity?.email);
  const ghSignedIn = authStatus.github === true;

  const startGithubLogin = () => {
    setExited(false);
    setAttempt((n) => n + 1);
    setActive(true);
  };

  const handleExit = () => {
    setExited(true);
    setActive(false);
    void refreshAuth();
  };

  const dismiss = () => {
    setExited(false);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Every commit Papercusp makes — on your behalf or via an agent — needs a name and email. We
        read these from your existing <code>git config</code>; nothing to set up if you've used git
        before.
      </p>
      <div className="pc-step__progress" data-status={loading ? 'loading' : configured ? 'ok' : 'missing'}>
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          {loading && <span>Checking…</span>}
          {!loading && configured && (
            <>
              <strong>Ready.</strong>
              <span>
                {identity?.name} &lt;{identity?.email}&gt; (from {identity?.source ?? 'config'})
              </span>
            </>
          )}
          {!loading && !configured && (
            <>
              <strong>Not configured.</strong>
              <span>Run the commands below in a terminal.</span>
            </>
          )}
        </div>
      </div>
      {!configured && !loading && (
        <pre className="pc-code">{`git config --global user.name "Your Name"
git config --global user.email "you@example.com"`}</pre>
      )}

      <div className="pc-divider" />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 className="pc-consent__heading" style={{ margin: 0 }}>GitHub (optional)</h3>
        {ghSignedIn && (
          <span
            className="pc-provider-card__badge"
            data-status="ok"
            style={{ fontSize: 12, color: 'var(--pc-color-success, #2a8)' }}
          >
            ✓ Signed in
          </span>
        )}
      </div>
      <p className="pc-step__hint">
        Pushing to private repos + opening PRs needs a GitHub auth. The simplest path is the
        GitHub CLI — <code>gh auth login</code> stores a token in your system keychain that{' '}
        <code>git</code> picks up automatically.
      </p>
      {tauri && spec ? (
        <div className="pc-step__actions">
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={startGithubLogin}
            disabled={active || ghInstalled === false}
            title={ghInstalled === false ? 'Install the GitHub CLI first (see hint below)' : undefined}
          >
            {active
              ? 'Running…'
              : ghSignedIn
                ? 'Re-sign in to GitHub'
                : 'Sign in to GitHub'}
          </button>
          {ghInstalled === false && (
            <span className="pc-field__hint pc-field__hint--err" style={{ marginLeft: 8 }}>
              ⚠ GitHub CLI not detected. Install it first:{' '}
              <a href="https://cli.github.com/" target="_blank" rel="noreferrer">cli.github.com</a>
            </span>
          )}
        </div>
      ) : (
        <pre className="pc-code">gh auth login</pre>
      )}
      {(active || exited) && spec && (
        <>
          <InlinePtyTerminal
            key={`github-${attempt}`}
            command={spec.command}
            args={spec.args}
            cwd={spec.cwd}
            env={spec.env}
            rows={14}
            onExit={handleExit}
          />
          {exited && (
            <div className="pc-step__actions" style={{ marginTop: 8 }}>
              <button type="button" className="pc-btn" onClick={dismiss}>
                Done
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
