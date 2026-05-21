'use client';

import { useCallback, useEffect, useState } from 'react';
import { isTauriNative } from '@/lib/pty-tauri';
import { InlinePtyTerminal } from './InlinePtyTerminal';

interface Provider {
  readonly id: 'claude' | 'omp';
  readonly title: string;
  readonly summary: string;
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'claude',
    title: 'Claude account',
    summary:
      "If you have a Claude Pro or Max plan, sign in once and your subscription covers Claude Code usage — no per-token API charges. Meridian routes the traffic so you don't need to configure anything else.",
  },
  {
    id: 'omp',
    title: 'oh-my-pi account',
    summary:
      'Sign in to your oh-my-pi account. Required for omp-driven agent runs.',
  },
];

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  loginClaude: SpawnSpec;
  loginOmp: SpawnSpec;
}

interface AuthStatus {
  claude: boolean;
  omp: boolean;
}

export function StepLogins() {
  const [tauri, setTauri] = useState(false);
  const [active, setActive] = useState<Provider['id'] | null>(null);
  const [exited, setExited] = useState<Provider['id'] | null>(null);
  const [specs, setSpecs] = useState<PtyCommands | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ claude: false, omp: false });
  // Bumped on every sign-in click so the pty terminal remounts fresh.
  // Without this, re-sign-in reuses the same spec object → the pty's
  // useEffect deps are unchanged → no respawn.
  const [attempt, setAttempt] = useState(0);
  // Non-Tauri (browser-dev) only: which card showed the "use the
  // desktop app" note. Never set inside the real desktop app.
  const [deskNote, setDeskNote] = useState<Provider['id'] | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      const r = await fetch('/api/desktop/agent-auth-status', { cache: 'no-store' });
      if (r.ok) setAuthStatus((await r.json()) as AuthStatus);
    } catch {
      /* leave previous state */
    }
  }, []);

  useEffect(() => {
    setTauri(isTauriNative());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
        if (r.ok) setSpecs((await r.json()) as PtyCommands);
      } catch {
        /* button stays disabled until specs resolve */
      }
    })();
    void refreshAuth();
    const id = setInterval(() => void refreshAuth(), 5000);
    return () => clearInterval(id);
  }, [refreshAuth]);

  const specFor = (id: Provider['id']): SpawnSpec | undefined =>
    id === 'claude' ? specs?.loginClaude : specs?.loginOmp;

  const signedIn = (id: Provider['id']): boolean =>
    id === 'claude' ? authStatus.claude : authStatus.omp;

  const startLogin = (id: Provider['id']) => {
    if (!tauri) {
      // Browser-dev: no native pty. Surface a note rather than a
      // stuck "Running…" button. The desktop app never hits this.
      setDeskNote(id);
      return;
    }
    setExited(null);
    setAttempt((n) => n + 1);
    setActive(id);
  };

  const handleExit = () => {
    // Keep the terminal mounted so the user sees the OAuth result;
    // flip `exited` so the card shows a Done button. Refresh auth
    // detection immediately rather than waiting for the 5s poll.
    setExited(active);
    setActive(null);
    void refreshAuth();
  };

  const dismiss = () => setExited(null);

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Sign in to your accounts. Clicking a button opens that provider's OAuth flow in a terminal
        right here — the CLI prints a link, you sign in in your browser, and it captures the token
        automatically.
      </p>
      <div className="pc-provider-grid">
        {PROVIDERS.map((p) => {
          const isActive = active === p.id;
          const isExited = exited === p.id;
          const done = signedIn(p.id);
          const label = p.title.replace(' account', '');
          return (
            <div key={p.id} className="pc-provider-card">
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
              >
                <h3 className="pc-provider-card__title">{p.title}</h3>
                {done && (
                  <span
                    className="pc-provider-card__badge"
                    data-status="ok"
                    style={{ fontSize: 12, color: 'var(--pc-color-success, #2a8)' }}
                  >
                    ✓ Signed in
                  </span>
                )}
              </div>
              <p className="pc-provider-card__summary">{p.summary}</p>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                disabled={active !== null || !specs}
                onClick={() => startLogin(p.id)}
              >
                {isActive
                  ? 'Running…'
                  : done
                    ? `Re-sign in to ${label}`
                    : `Sign in to ${label}`}
              </button>
              {deskNote === p.id && !tauri && (
                <p className="pc-provider-card__instructions">
                  Terminal sign-in runs inside the Papercusp desktop app.
                </p>
              )}
              {(isActive || isExited) && tauri && specFor(p.id) && (
                <>
                  <InlinePtyTerminal
                    key={`${p.id}-${attempt}`}
                    command={specFor(p.id)!.command}
                    args={specFor(p.id)!.args}
                    cwd={specFor(p.id)!.cwd}
                    env={specFor(p.id)!.env}
                    rows={14}
                    onExit={handleExit}
                  />
                  {isExited && (
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
        })}
      </div>
    </div>
  );
}
