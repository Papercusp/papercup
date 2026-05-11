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
  readSleepUntilMs,
  writeSleepUntilMs,
} from '@/lib/operator-converse-tags';

const MODE_CHANGE_EVENT = 'papercusp:operatorMode';
const SLEEP_CHANGE_EVENT = 'papercusp:operatorSleep';

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
    // Flipping TO active wakes the operator. Without this the chip
    // says "Active" but the silence-timer effect stays parked because
    // sleepUntilMs is still in the future from a prior <sleep> tag.
    if (next === 'active') writeSleepUntilMs(0);
    setModeLocal(next);
    try {
      window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: { mode: next } }));
    } catch { /* ignore */ }
  }, []);

  return [mode, setMode];
}

/** Subscribe to sleep-until-ms changes. Returns the current value (0 = awake). */
function useOperatorSleepUntil(): number {
  const [sleepUntil, setSleepUntil] = useState(0);
  useEffect(() => {
    const refresh = () => setSleepUntil(readSleepUntilMs());
    refresh();
    window.addEventListener(SLEEP_CHANGE_EVENT, refresh);
    // When the deadline passes, re-render so the chip drops the
    // "(sleeping Nm)" suffix without the user having to refresh.
    const tick = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener(SLEEP_CHANGE_EVENT, refresh);
      clearInterval(tick);
    };
  }, []);
  return sleepUntil;
}

/**
 * Subscribe to the provider's `sub` state via window event. Lets the
 * chip reflect quiet_wait without pulling in React context (the
 * toggle is rendered above the provider tree in the navbar).
 */
const SUB_CHANGE_EVENT = 'papercusp:operatorSub';
function useOperatorSub(): string {
  const [sub, setSub] = useState<string>('ready');
  useEffect(() => {
    const onSub = (e: Event) => {
      const detail = (e as CustomEvent<{ sub: string }>).detail;
      if (typeof detail?.sub === 'string') setSub(detail.sub);
    };
    window.addEventListener(SUB_CHANGE_EVENT, onSub as EventListener);
    return () => window.removeEventListener(SUB_CHANGE_EVENT, onSub as EventListener);
  }, []);
  return sub;
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
  const sleepUntil = useOperatorSleepUntil();
  const sub = useOperatorSub();
  const active = mode === 'active';
  const sleepingMs = sleepUntil > 0 ? sleepUntil - Date.now() : 0;
  const sleeping = active && sleepingMs > 0;
  // Quiet = active mode that exhausted the silence ladder. Subordinate
  // to sleeping (if both, sleep wins because it has a deadline).
  const quiet = active && !sleeping && sub === 'quiet_wait';

  const onClick = useCallback(() => {
    if (sleeping) {
      writeSleepUntilMs(0);
      return;
    }
    if (quiet) {
      // Quiet → click is a no-op for now; the user is supposed to type
      // in the chat to resume. Surfacing the state is the value.
      return;
    }
    setMode(active ? 'passive' : 'active');
  }, [active, setMode, sleeping, quiet]);

  const sleepLabel = sleeping
    ? sleepingMs < 60_000
      ? `${Math.max(1, Math.ceil(sleepingMs / 1000))}s`
      : `${Math.ceil(sleepingMs / 60_000)}m`
    : '';

  const stateClass = sleeping ? 'sleeping' : quiet ? 'quiet' : active ? 'active' : 'passive';
  const label = sleeping
    ? `Sleeping ${sleepLabel}`
    : quiet
      ? 'Quiet'
      : active ? 'Active' : 'Passive';
  const aria = sleeping
    ? `Operator sleeping for ${sleepLabel}. Click to wake.`
    : quiet
      ? 'Operator is quiet — type in the chat to pick up where you left off.'
      : active
        ? 'Operator interaction mode: active. Click to set passive.'
        : 'Operator interaction mode: passive. Click to set active.';
  const title = sleeping
    ? `Operator went quiet for ${sleepLabel} (via <sleep> tag). Click to wake immediately.`
    : quiet
      ? 'Operator went silent after the silence ladder ran out. Type in the chat to wake them.'
      : active
        ? 'Operator is active — speaks proactively. Click to make passive.'
        : 'Operator is passive — only responds when spoken to. Click to make active.';
  const dotKind = (sleeping || quiet) ? 'static' : active ? 'pulsing' : 'static';

  return (
    <>
      <style>{TOGGLE_CSS}</style>
      <button
        type="button"
        onClick={onClick}
        className={`pc-header-cta op-active-toggle op-active-toggle--${stateClass}`}
        aria-label={aria}
        title={title}
      >
        <span className={`op-active-toggle-dot op-active-toggle-dot--${dotKind}`} aria-hidden="true" />
        <span className="op-active-toggle-label">{label}</span>
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
.op-active-toggle--sleeping {
  background: rgba(148, 163, 184, 0.10);
  border-color: rgba(148, 163, 184, 0.40);
  color: var(--fg-mute, #94a3b8);
  font-style: italic;
}
.op-active-toggle--quiet {
  background: rgba(148, 163, 184, 0.06);
  border-color: rgba(148, 163, 184, 0.30);
  color: var(--fg-mute, #94a3b8);
  cursor: default;
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
