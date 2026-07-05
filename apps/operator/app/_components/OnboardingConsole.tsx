'use client';

/**
 * OnboardingConsole — the agent-chat-first first-run surface
 * (plan agent-first-onboarding-2026-07-03, P-003).
 *
 * A FULL-WINDOW terminal running the onboarding concierge
 * (`scripts/onboard-launcher.mjs`): framework pick → guided install →
 * sign-in → embeddings key → exec of the chosen agent CLI with the tutor
 * prompt, all in this one pane, so the user's very first experience is the
 * daily one — a conversation, not a wizard.
 *
 * The GUI Setup Wizard is the standing fallback: a footer link here, the
 * automatic non-Tauri fallback (a browser can't spawn a pty), and the
 * spec-missing fallback all route to `/setup?force=1`.
 */
import { useEffect, useState } from 'react';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';
import { InlinePtyTerminal } from './SetupWizard/InlinePtyTerminal';

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Rows that comfortably fill a desktop window; xterm scrolls beyond them. */
const CONSOLE_ROWS = 40;

export function OnboardingConsole() {
  const [tauri, setTauri] = useState<boolean | null>(null);
  const [spec, setSpec] = useState<SpawnSpec | null | 'loading'>('loading');
  const [exited, setExited] = useState<number | null>(null);

  useEffect(() => {
    setTauri(isTauriNative());
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { onboardConcierge?: SpawnSpec | null };
        if (!cancelled) setSpec(j.onboardConcierge ?? null);
      } catch {
        if (!cancelled) setSpec(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fallbackToWizard = () => {
    // Full navigation (not SPA push): the wizard route re-runs its own gating.
    window.location.href = '/setup?force=1';
  };

  // Concierge finished: either graduation (the tutor called setup:complete) or
  // the user quit. Root re-gateways correctly in both cases (stateless
  // re-detection), so simply go home.
  useEffect(() => {
    if (exited !== null && exited === 0) window.location.href = '/';
  }, [exited]);

  if (tauri === false || spec === null) {
    return (
      <div className="pc-shell" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Welcome to Papercusp</h1>
          <p style={{ opacity: 0.8, marginBottom: 16 }}>
            {tauri === false
              ? 'The chat-first onboarding runs inside the desktop app. In a browser, use the classic setup wizard instead.'
              : 'The onboarding console is unavailable on this install — use the classic setup wizard instead.'}
          </p>
          <button type="button" className="pc-btn pc-btn--primary" onClick={fallbackToWizard}>
            Open the setup wizard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pc-onboarding-console"
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', padding: 12 }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        {spec === 'loading' ? (
          <p style={{ opacity: 0.7, padding: 24 }}>Starting onboarding…</p>
        ) : (
          <InlinePtyTerminal
            command={spec.command}
            args={spec.args}
            cwd={spec.cwd}
            env={spec.env}
            rows={CONSOLE_ROWS}
            placeholder="Starting onboarding…"
            onExit={(code) => setExited(code)}
            onSpawnError={() => setSpec(null)}
          />
        )}
      </div>
      <p style={{ fontSize: 12, opacity: 0.55, textAlign: 'center', marginTop: 8 }}>
        {exited !== null && exited !== 0 ? (
          <>
            Onboarding ended unexpectedly (exit {exited}).{' '}
            <button type="button" className="pc-link-btn" onClick={() => window.location.reload()}>
              Restart it
            </button>
            {' · '}
          </>
        ) : null}
        Prefer clicking through a GUI?{' '}
        <button type="button" className="pc-link-btn" onClick={fallbackToWizard}>
          Use the classic setup wizard
        </button>
      </p>
    </div>
  );
}
