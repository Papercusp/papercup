'use client';

/**
 * OperatorActiveToggle — navbar button that flips operator interaction
 * mode between active and passive.
 *
 * - Active = operator owns the conversation flow, speaks proactively
 *            (continuous turn-taking, silence prompts, etc.)
 * - Passive = operator only responds when spoken to.
 *
 * Either the user OR the operator (via <set_mode> tags) can flip the
 * mode; both writes go through the same sessionStorage hook in
 * lib/operator-converse-tags.ts. This component just owns the navbar
 * button + visual state.
 *
 * Mode persistence is sessionStorage (resets per app open). Default on
 * first read is 'active' (matches the user's intent: "active mode by
 * default any time the user opens the app"). The /settings/voice
 * `activeOnStartup` toggle controls the seed; that lands in a later
 * commit.
 *
 * The button lives in the chrome header next to OperatorButton +
 * VoiceButton (see ChromeShell.tsx, .pc-header-center). It is NOT
 * the operator-panel toggle — that one stays as is.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type OperatorMode,
  readOperatorModeFromSession,
  writeOperatorModeToSession,
} from '@/lib/operator-converse-tags';

const MODE_CHANGE_EVENT = 'papercusp:operatorMode';

/** Subscribe to mode changes (cross-component fanout via window event). */
function useOperatorMode(): [OperatorMode, (next: OperatorMode) => void] {
  // SSR-safe initial: 'active'. Hydration mounts and reads the actual
  // session value; the toggle visual flips on the first effect.
  const [mode, setModeLocal] = useState<OperatorMode>('active');

  useEffect(() => {
    const seeded = readOperatorModeFromSession() ?? 'active';
    setModeLocal(seeded);
    writeOperatorModeToSession(seeded);

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: OperatorMode }>).detail;
      if (detail?.mode === 'active' || detail?.mode === 'passive') {
        setModeLocal(detail.mode);
      }
    };
    window.addEventListener(MODE_CHANGE_EVENT, onChange as EventListener);
    return () => window.removeEventListener(MODE_CHANGE_EVENT, onChange as EventListener);
  }, []);

  const setMode = useCallback((next: OperatorMode) => {
    writeOperatorModeToSession(next);
    setModeLocal(next);
    try {
      window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: { mode: next } }));
    } catch { /* ignore */ }
  }, []);

  return [mode, setMode];
}

/**
 * Public hook other components (state machine, voice path, set_mode tag
 * dispatcher) use to read / write operator mode with cross-component fanout.
 */
export function useOperatorModeState() {
  return useOperatorMode();
}

/** Imperative setter usable from outside React (tag dispatcher, voice). */
export function setOperatorMode(next: OperatorMode): void {
  if (typeof window === 'undefined') return;
  writeOperatorModeToSession(next);
  try {
    window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: { mode: next } }));
  } catch { /* ignore */ }
}

export function OperatorActiveToggle() {
  const [mode, setMode] = useOperatorMode();
  const active = mode === 'active';

  const onClick = useCallback(() => {
    setMode(active ? 'passive' : 'active');
  }, [active, setMode]);

  return (
    <>
      <style>{TOGGLE_CSS}</style>
      <button
        type="button"
        onClick={onClick}
        className={`pc-header-cta op-active-toggle op-active-toggle--${active ? 'active' : 'passive'}`}
        aria-label={active ? 'Operator interaction mode: active. Click to set passive.' : 'Operator interaction mode: passive. Click to set active.'}
        title={active ? 'Operator is active — speaks proactively. Click to make passive.' : 'Operator is passive — only responds when spoken to. Click to make active.'}
      >
        <span className={`op-active-toggle-dot op-active-toggle-dot--${active ? 'pulsing' : 'static'}`} aria-hidden="true" />
        <span className="op-active-toggle-label">{active ? 'Active' : 'Passive'}</span>
      </button>
    </>
  );
}

const TOGGLE_CSS = `
.op-active-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border, rgba(125, 211, 252, 0.20));
  color: var(--fg-mute, #94a3b8);
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.op-active-toggle:hover {
  background: rgba(125, 211, 252, 0.10);
  color: var(--fg, #e7eef7);
}
.op-active-toggle--active {
  background: rgba(56, 189, 248, 0.14);
  border-color: rgba(56, 189, 248, 0.50);
  color: var(--accent-strong, #7dd3fc);
}
.op-active-toggle--passive {
  /* default look */
}

.op-active-toggle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}
.op-active-toggle-dot--pulsing {
  animation: op-active-pulse 1.25s ease-in-out infinite;
  box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.6);
}
@keyframes op-active-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55); transform: scale(1); }
  60%  { box-shadow: 0 0 0 6px rgba(56, 189, 248, 0);  transform: scale(1.06); }
  100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0);    transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .op-active-toggle-dot--pulsing { animation: none; }
}
`;
