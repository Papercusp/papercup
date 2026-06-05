/**
 * DockOnboarding — one-time intro toast for first-time dock users.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §10 Phase 6.5
 *
 * Renders a small dismissable bubble in the dock chrome on first
 * mount only. localStorage flag `papercusp:dock-onboarded` flips after
 * dismiss; subsequent mounts render nothing.
 *
 * Mount inside HarnessDockShell + dock-preview alongside the dock
 * toolbar. Designed to NOT block the dock — sits in the toolbar row,
 * not as an overlay.
 */

'use client';

import { useEffect, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { X, MousePointer2 } from 'lucide-react';

const STORAGE_KEY = 'papercusp:dock-onboarded';

export function DockOnboarding() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (!window.localStorage.getItem(wsLocalKey(STORAGE_KEY))) {
        setVisible(true);
      }
    } catch {
      /* private-mode etc */
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(wsLocalKey(STORAGE_KEY), '1');
    } catch {
      /* ignore */
    }
  };

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="Dock onboarding"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px 4px 10px',
        background: 'var(--accent, #1f2937)',
        color: 'var(--fg)',
        border: '1px solid var(--border, #3a4554)',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      <MousePointer2 size={12} aria-hidden style={{ flexShrink: 0 }} />
      <span>
        <strong>Drag tabs</strong> to split, drag outside group to float.{' '}
        <strong>Right-click</strong> rows for "Pin as panel".{' '}
        <kbd
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10,
            padding: '0 4px',
            background: 'var(--bg-2)',
            borderRadius: 2,
          }}
        >
          ⌘[
        </kbd>{' '}
        /{' '}
        <kbd
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10,
            padding: '0 4px',
            background: 'var(--bg-2)',
            borderRadius: 2,
          }}
        >
          ⌘]
        </kbd>{' '}
        for back/forward.
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss onboarding"
        title="Got it"
        style={{
          display: 'inline-flex',
          padding: 2,
          marginLeft: 4,
          background: 'transparent',
          border: 0,
          color: 'var(--fg-mute)',
          cursor: 'pointer',
        }}
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

/** For tests — clear the dismiss flag. */
export function _resetDockOnboardingForTests(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(wsLocalKey(STORAGE_KEY));
  } catch {
    /* ignore */
  }
}
