'use client';

/**
 * SetActiveButton — Phase 6 P-038a pure UI.
 *
 * Per-row "Start working" / "Working" toggle. When active it reads
 * "Working" (filled); inactive reads "Start working". Disabled +
 * "Taken" when someone ELSE is the active worker (the orchestrator
 * eligibility rule means only one active human at a time is the
 * common case, but the UI surfaces the contested state honestly).
 *
 * Pure UI. The client wrapper owns optimistic flip + POST.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface SetActiveButtonProps {
  active: boolean;
  /** Someone else is the active worker — show a disabled "Taken" state. */
  takenByOther?: boolean;
  onToggle?: () => void;
  pending?: boolean;
  hidden?: boolean;
}

function style(active: boolean, taken: boolean, pending: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid var(--border, #2a2a2a)',
    cursor: pending ? 'progress' : taken ? 'not-allowed' : 'pointer',
    opacity: pending ? 0.6 : taken ? 0.5 : 1,
    background: active ? 'rgba(40,140,80,0.18)' : 'transparent',
    color: active ? '#6ec98c' : taken ? 'var(--fg-dim, #888)' : 'var(--fg-dim, #aaa)',
    fontWeight: active ? 600 : 400,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
}

export function SetActiveButton(props: SetActiveButtonProps): ReactNode {
  if (props.hidden) return null;
  const active = props.active;
  const taken = !active && !!props.takenByOther;
  const pending = !!props.pending;
  const label = active ? 'Working' : taken ? 'Taken' : 'Start working';
  return (
    <button
      type="button"
      data-testid="set-active-btn"
      data-active={active ? '1' : '0'}
      data-taken={taken ? '1' : '0'}
      aria-pressed={active}
      disabled={pending || taken}
      onClick={props.onToggle}
      style={style(active, taken, pending)}
      title={
        active
          ? 'You are actively working this — click to stop'
          : taken
            ? 'Another contributor is actively working this'
            : 'Mark yourself as actively working this (the orchestrator will not pick it up)'
      }
    >
      {label}
    </button>
  );
}
