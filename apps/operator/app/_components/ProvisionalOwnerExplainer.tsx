'use client';

/**
 * ProvisionalOwnerExplainer — Phase 8 P-069d.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §15 claim/supersede + addendum-1 binding.
 *
 * Fires the first time an engineer shares a harness publicly. Explains
 * the provisional-ownership semantics: they are the first contributor,
 * which makes them the harness's provisional owner; the binding is
 * recorded immediately but the formal "Cupboard claim" happens once
 * the harness is published. Subsequent shares skip the explainer
 * (localStorage flag per machine).
 *
 * Designed for embedding in any wizard's success step OR as a standalone
 * modal — the consumer controls open/close. Pure UI.
 */

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

const FLAG_KEY = 'papercusp.provisionalOwner.shown.v1';

function hasSeenLocally(): boolean {
  try {
    return globalThis.localStorage?.getItem(wsLocalKey(FLAG_KEY)) === '1';
  } catch {
    return false;
  }
}

function markSeenLocally(): void {
  try {
    globalThis.localStorage?.setItem(wsLocalKey(FLAG_KEY), '1');
  } catch {
    // ignore — explainer just re-shows on next share, low harm
  }
}

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const DIALOG: CSSProperties = {
  background: 'var(--surface, #fff)',
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: '90%',
  boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
  fontSize: 14,
  lineHeight: 1.5,
};

const TITLE: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};

const BUTTON_ROW: CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
  marginTop: 16,
};

const PRIMARY_BUTTON: CSSProperties = {
  background: 'var(--accent, #4CAF50)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

export interface ProvisionalOwnerExplainerProps {
  open: boolean;
  /** GitHub login of the owner-to-be (typically the current viewer). */
  ownerLogin: string;
  /** Harness slug being shared. */
  harnessSlug: string;
  /** Called when the user dismisses. The dismissal is recorded so the
   * explainer doesn't re-show on the same machine. */
  onClose: () => void;
}

/**
 * Returns true if the explainer should show. Use this to gate
 * the explainer from a parent wizard: only `setOpen(true)` if
 * `shouldShowProvisionalOwnerExplainer()` is true at the moment
 * the wizard hits its share-success step.
 */
export function shouldShowProvisionalOwnerExplainer(): boolean {
  return !hasSeenLocally();
}

export function ProvisionalOwnerExplainer(props: ProvisionalOwnerExplainerProps): ReactNode {
  const { open, ownerLogin, harnessSlug, onClose } = props;

  useEffect(() => {
    if (open) {
      markSeenLocally();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={OVERLAY}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provisional-owner-title"
      data-testid="provisional-owner-explainer"
      onClick={onClose}
    >
      <div style={DIALOG} onClick={(e) => e.stopPropagation()}>
        <div id="provisional-owner-title" style={TITLE}>
          You're the provisional owner of <code>{harnessSlug}</code>
        </div>
        <p>
          Because you're the first contributor, you're the harness's{' '}
          <strong>provisional owner</strong>. Your device's pubkey is
          recorded against <code>@{ownerLogin}</code> immediately.
        </p>
        <p style={{ marginTop: 8 }}>
          When you publish to Cupboard, this provisional ownership becomes
          the harness's <strong>formal claim</strong>. If you don't publish,
          another verified maintainer of the same GitHub repo can claim it
          later.
        </p>
        <p style={{ marginTop: 8, color: 'var(--fg-dim)' }}>
          We won't show this again on this machine.
        </p>
        <div style={BUTTON_ROW}>
          <button
            type="button"
            onClick={onClose}
            style={PRIMARY_BUTTON}
            data-testid="provisional-owner-explainer-dismiss"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
