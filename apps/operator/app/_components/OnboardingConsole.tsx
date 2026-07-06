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
 * On WINDOWS the concierge runs in an EXTERNAL Windows Terminal window
 * instead of the embedded pane (WI-3033): the embedded path (pty_spawn →
 * portable_pty ConPTY → wsl.exe) wedges on legacy inbox WSL before the
 * child ever writes a byte, while a real terminal window is the
 * proven-working host (console_launch, WI-2955). This pane then shows a
 * launch panel with continue/focus controls.
 *
 * The GUI Setup Wizard is the standing fallback: a footer link here, the
 * automatic non-Tauri fallback (a browser can't spawn a pty), and the
 * spec-missing fallback all route to `/setup?force=1`.
 */
import { useCallback, useEffect, useState } from 'react';
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

/**
 * Exact title of the external onboarding terminal window — shared contract
 * with the Rust side: external_console_run titles the window with it and
 * focus_window_by_title finds it by exact match.
 */
export const EXTERNAL_CONSOLE_TITLE = 'Papercusp Onboarding';

/**
 * True when the onboarding concierge must run in an EXTERNAL terminal
 * window instead of the embedded pane.
 *
 *  - Windows (WI-3033): the embedded path (pty_spawn → ConPTY → wsl.exe)
 *    wedges on legacy inbox WSL; a real terminal window is the proven host.
 *  - Linux (owner directive 2026-07-05): the tutorial runs in a real native
 *    terminal window (the desktop's bundled ghostty), not an embedded
 *    webview pane — external_console_run has a Linux spawner.
 *  - macOS keeps the embedded pane (SwiftTerm works and stays the UX).
 *
 * Detection is the WEBVIEW's user agent: the operator (and
 * `process.platform`) run inside the WSL distro and always say linux, so
 * only the client knows what OS it's rendering on. A WebKitGTK desktop
 * webview says "X11; Linux" / "Wayland; Linux"; a macOS WKWebView says
 * "Macintosh" (never "Linux"). Pure + exported for unit tests.
 */
export function shouldRouteExternalConsole(isTauri: boolean, ua: string): boolean {
  return isTauri && (ua.includes('Windows NT') || ua.includes('Linux'));
}

/**
 * WI-3092: one poll of setup-wizard-state, returning whether the tutor has
 * graduated (`finished_at` stamped). Pure + exported so the external-console
 * auto-nav condition is unit-testable without mounting the full component
 * (which needs a live Tauri webview/pty — see OnboardingConsole.test.tsx).
 */
export async function pollGraduationOnce(
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const r = await fetchImpl('/api/desktop/setup-wizard-state', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = (await r.json()) as { finished_at?: string };
    return Boolean(j.finished_at);
  } catch {
    return false; // transient network hiccup — the next poll retries
  }
}

/**
 * WI-2902: fetch the onboarding concierge spawn spec, RETRYING transient failures
 * past operator boot instead of the old one-shot fetch.
 *
 * The mount fetch used to give up after a single failure → setSpec(null) → the
 * permanent "onboarding console is unavailable — use the setup wizard" fallback.
 * But on a fast/warm boot the SPA renders (served from disk via custom_protocol —
 * WI-2902 Fix B) BEFORE the operator's HTTP endpoint is listening, so that fetch
 * hits connection-refused and a brand-new user is stranded on the wizard fallback
 * until they manually reload — even though the concierge is available seconds later
 * (confirmed on the clean-room VM 2026-07-06: a reload made the console appear).
 *
 * A SUCCESSFUL (2xx) response is authoritative: a present `onboardConcierge` → its
 * spec; an explicit `null` → genuinely no concierge (fall back). Only a THROWN fetch
 * / non-2xx is transient — retry with backoff until the operator is up, bounded by
 * `deadlineMs` (defaults past a cold-seed first boot, ~minutes) so a truly dead
 * endpoint eventually shows the explicit fallback instead of spinning forever. Pure +
 * exported for unit tests (the component render paths need a live Tauri webview).
 */
export async function loadOnboardConcierge(
  fetchImpl: typeof fetch = fetch,
  opts: {
    deadlineMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    shouldContinue?: () => boolean;
  } = {},
): Promise<SpawnSpec | null> {
  const deadlineMs = opts.deadlineMs ?? 240_000;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldContinue = opts.shouldContinue ?? (() => true);
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    if (!shouldContinue()) return null;
    try {
      const r = await fetchImpl('/api/desktop/setup-pty-commands', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { onboardConcierge?: SpawnSpec | null };
      return j.onboardConcierge ?? null; // a 2xx is authoritative (spec, or definitively none)
    } catch {
      // Transient — the operator/endpoint isn't listening yet (fast boot races the
      // disk-served SPA). Keep the component in 'loading' and retry until it's up.
      if (Date.now() - start >= deadlineMs) return null; // deadline → explicit wizard fallback
      attempt += 1;
      await sleep(Math.min(2000, 250 * attempt));
    }
  }
}

type ExternalState = 'idle' | 'launching' | 'running' | 'error';

interface WindowWithTauriInvoke extends Window {
  // Raw invoke: tauri-bindings.ts is specta-GENERATED ("do not edit") and
  // stale — it predates external_console_run / focus_window_by_title. Raw
  // invoke returns the command's Ok value directly and rejects with the Err.
  __TAURI_INTERNALS__?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
}

export function OnboardingConsole() {
  const [tauri, setTauri] = useState<boolean | null>(null);
  const [spec, setSpec] = useState<SpawnSpec | null | 'loading'>('loading');
  const [exited, setExited] = useState<number | null>(null);
  const [external, setExternal] = useState<ExternalState>('idle');
  const [externalError, setExternalError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauriNative());
    let cancelled = false;
    void (async () => {
      // Retry past operator boot instead of one-shot (WI-2902): on a fast/warm boot
      // the SPA renders (disk-served — Fix B) BEFORE the operator endpoint is up, so a
      // single fetch hit connection-refused and stranded a new user on the "console
      // unavailable — use the wizard" fallback until a manual reload. While retrying we
      // stay 'loading' → "Starting onboarding…" (footer wizard link stays as escape).
      const s = await loadOnboardConcierge(fetch, { shouldContinue: () => !cancelled });
      if (!cancelled) setSpec(s);
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

  const routeExternal =
    tauri === true &&
    typeof navigator !== 'undefined' &&
    shouldRouteExternalConsole(true, navigator.userAgent);

  const launchExternal = useCallback(async (s: SpawnSpec) => {
    setExternal('launching');
    setExternalError(null);
    try {
      const invoke = (window as WindowWithTauriInvoke).__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke unavailable');
      await invoke('external_console_run', {
        spec: {
          command: s.command,
          args: s.args,
          cwd: s.cwd,
          env: s.env,
          title: EXTERNAL_CONSOLE_TITLE,
        },
      });
      setExternal('running');
    } catch (e) {
      setExternalError(String((e as Error)?.message ?? e));
      setExternal('error');
    }
  }, []);

  // Auto-launch the external window ONCE when routing external and the
  // spawn spec has arrived. Re-launch only via the explicit Try-again.
  useEffect(() => {
    if (!routeExternal || external !== 'idle') return;
    if (spec === 'loading' || spec === null) return;
    void launchExternal(spec);
  }, [routeExternal, external, spec, launchExternal]);

  // External path (Windows/Linux, WI-3092): unlike the embedded pane, the
  // webview CANNOT observe the external terminal window's process exit — so
  // the exited→home effect above never fires for it, and until now the ONLY
  // way home was the manual "I've finished — continue" button. Mirror that
  // auto-nav here by POLLING setup-wizard-state (the tutor's setup:complete
  // call stamps `finished_at`) while the external console is running, and
  // navigate home the moment graduation lands. The manual button stays as
  // the escape hatch for a user who quits the terminal without graduating
  // (finished_at never gets set, so polling alone would never advance).
  useEffect(() => {
    if (!routeExternal || external !== 'running') return;
    let cancelled = false;
    const checkGraduated = async () => {
      const graduated = await pollGraduationOnce();
      if (!cancelled && graduated) window.location.href = '/';
    };
    void checkGraduated(); // don't wait a full interval if already graduated
    const id = setInterval(() => void checkGraduated(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [routeExternal, external]);

  // USER-INITIATED focus (button click) — mirrors focus_window_by_title's
  // no-focus-steal contract; never call from an automated driver.
  const focusExternal = useCallback(() => {
    const invoke = (window as WindowWithTauriInvoke).__TAURI_INTERNALS__?.invoke;
    void invoke?.('focus_window_by_title', { title: EXTERNAL_CONSOLE_TITLE });
  }, []);

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
        ) : routeExternal ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 360 }}>
            <div style={{ maxWidth: 560, textAlign: 'center' }}>
              <h1 style={{ fontSize: 20, marginBottom: 8 }}>Welcome to Papercusp</h1>
              {external === 'error' ? (
                <>
                  <p style={{ opacity: 0.8, marginBottom: 16 }}>
                    Couldn&apos;t open the onboarding terminal
                    {externalError ? `: ${externalError}` : '.'}
                  </p>
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    onClick={() => void launchExternal(spec)}
                  >
                    Try again
                  </button>
                </>
              ) : external === 'running' ? (
                <>
                  <p style={{ opacity: 0.8, marginBottom: 16 }}>
                    Onboarding is running in the &ldquo;{EXTERNAL_CONSOLE_TITLE}&rdquo; terminal
                    window — finish the conversation there, then continue here.
                  </p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button
                      type="button"
                      className="pc-btn pc-btn--primary"
                      onClick={async () => {
                        // This is the ESCAPE HATCH for a user who quits the
                        // terminal WITHOUT the tutor calling setup:complete — so
                        // `finished_at` is unset. Navigating straight to `/`
                        // bounced right back here: app/page.tsx redirects `/` →
                        // `/setup` whenever `finished_at` is unset, an infinite
                        // reload loop (owner-reported 2026-07-06). Stamp
                        // finished_at ourselves (best-effort) BEFORE navigating so
                        // `/` actually loads the app. Mirrors SetupWizard's
                        // markFinished; the tutor's own setup:complete path is
                        // unaffected.
                        try {
                          await fetch('/api/desktop/setup-wizard-state', {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ finished_at: new Date().toISOString() }),
                          });
                        } catch {
                          // best-effort — navigate regardless; page.tsx re-checks
                        }
                        window.location.href = '/';
                      }}
                    >
                      I&apos;ve finished — continue
                    </button>
                    <button type="button" className="pc-btn" onClick={focusExternal}>
                      Bring console to front
                    </button>
                  </div>
                </>
              ) : (
                <p style={{ opacity: 0.8 }}>Opening the onboarding terminal window…</p>
              )}
            </div>
          </div>
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
