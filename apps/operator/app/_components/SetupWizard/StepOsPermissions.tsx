'use client';

import { useCallback, useEffect, useState } from 'react';
import { isTauri, wslStatus, type WslStatus } from '@/lib/wsl-tauri';

type PermState = 'unknown' | 'granted' | 'denied' | 'prompt' | 'unsupported';

interface PermDef {
  readonly id: 'microphone' | 'notifications' | 'accessibility';
  readonly title: string;
  readonly why: string;
  readonly platforms: ReadonlyArray<'mac' | 'linux' | 'windows'>;
  readonly request: () => Promise<PermState>;
  readonly probe: () => Promise<PermState>;
}

async function probeMicrophone(): Promise<PermState> {
  if (typeof navigator === 'undefined' || !navigator.permissions) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unknown';
  }
}
async function requestMicrophone(): Promise<PermState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

async function probeNotifications(): Promise<PermState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const p = Notification.permission;
  if (p === 'granted') return 'granted';
  if (p === 'denied') return 'denied';
  return 'prompt';
}
async function requestNotifications(): Promise<PermState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') return 'granted';
    if (result === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'denied';
  }
}

// Accessibility can only be granted from the macOS System Settings UI;
// there is no browser/Tauri API to request it programmatically. The
// best we can do is open a link to the system pane.
async function probeAccessibility(): Promise<PermState> {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (!/Mac/i.test(navigator.platform)) return 'unsupported';
  return 'unknown';
}
async function requestAccessibility(): Promise<PermState> {
  if (typeof window !== 'undefined') {
    window.open(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      '_blank',
    );
  }
  return 'unknown';
}

const PERMS: readonly PermDef[] = [
  {
    id: 'microphone',
    title: 'Microphone',
    why: "Required for any voice mode (continuous, hybrid, or single-utterance). Skip if you don't plan to use voice.",
    platforms: ['mac', 'linux', 'windows'],
    request: requestMicrophone,
    probe: probeMicrophone,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    why: 'Lets Papercusp alert you when an agent run finishes, hits an error, or needs your input.',
    platforms: ['mac', 'linux', 'windows'],
    request: requestNotifications,
    probe: probeNotifications,
  },
  {
    id: 'accessibility',
    title: 'Accessibility (macOS only)',
    why: 'Required if you want global keyboard shortcuts to work outside the app window.',
    platforms: ['mac'],
    request: requestAccessibility,
    probe: probeAccessibility,
  },
];

export function StepOsPermissions() {
  const [states, setStates] = useState<Record<string, PermState>>({});
  const [wsl, setWsl] = useState<WslStatus | null>(null);

  const probeAll = useCallback(async () => {
    const next: Record<string, PermState> = {};
    await Promise.all(
      PERMS.map(async (p) => {
        next[p.id] = await p.probe();
      }),
    );
    setStates(next);
    // WSL probe — only meaningful inside the Tauri shell. The
    // WslOnboardingGate in the root layout owns the install flow; we
    // just surface the resolved state for visibility.
    if (isTauri()) {
      try {
        const s = await wslStatus();
        if (s) setWsl(s);
      } catch { /* leave null */ }
    }
  }, []);

  useEffect(() => {
    void probeAll();
  }, [probeAll]);

  const onRequest = async (p: PermDef) => {
    const result = await p.request();
    setStates((prev) => ({ ...prev, [p.id]: result }));
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp asks your operating system for these on first use. You can grant any of them now
        or skip and grant later.
      </p>
      {wsl && wsl.state.kind !== 'NotSupported' && (
        <div className="pc-perm" data-state={wsl.state.kind === 'Ready' ? 'granted' : 'denied'}>
          <div className="pc-perm__head">
            <span className="pc-perm__title">WSL2 environment (Windows only)</span>
            <span className="pc-perm__platforms">
              <span
                className="pc-perm__badge"
                data-state={wsl.state.kind === 'Ready' ? 'granted' : 'denied'}
              >
                {wsl.state.kind === 'Ready' ? '✓ ready' : `⚠ ${wsl.state.kind}`}
              </span>
              <span>windows</span>
            </span>
          </div>
          <p className="pc-perm__why">
            Papercusp's harness runs inside a WSL2 distro on Windows because the toolchain assumes
            POSIX. {wsl.state.kind === 'Ready'
              ? `Distro is set up and ready (WSL version ${wsl.defaultVersion || 2}).`
              : 'Set up by the install gate before the wizard loads — if you see this in a non-ready state, restart the app.'}
          </p>
        </div>
      )}
      <div className="pc-perm-list">
        {PERMS.map((p) => {
          const state = states[p.id] ?? 'unknown';
          return (
            <div key={p.id} className="pc-perm" data-state={state}>
              <div className="pc-perm__head">
                <span className="pc-perm__title">{p.title}</span>
                <span className="pc-perm__platforms">
                  <PermBadge state={state} />
                  <span>{p.platforms.join(' · ')}</span>
                </span>
              </div>
              <p className="pc-perm__why">{p.why}</p>
              <div className="pc-perm__actions">
                {state === 'granted' && (
                  <span className="pc-perm__hint">Already granted — nothing to do.</span>
                )}
                {state === 'denied' && (
                  <span className="pc-perm__hint">
                    Denied. Grant via your system settings if you change your mind.
                  </span>
                )}
                {(state === 'prompt' || state === 'unknown') && (
                  <button
                    type="button"
                    className="pc-btn"
                    onClick={() => void onRequest(p)}
                  >
                    {p.id === 'accessibility' ? 'Open system settings' : 'Request now'}
                  </button>
                )}
                {state === 'unsupported' && (
                  <span className="pc-perm__hint">Not applicable on this platform.</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermBadge({ state }: { state: PermState }) {
  const label = {
    granted: '✓ granted',
    denied: '⚠ denied',
    prompt: '? not granted',
    unknown: '? unknown',
    unsupported: '— n/a',
  }[state];
  return <span className="pc-perm__badge" data-state={state}>{label}</span>;
}
