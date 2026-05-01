'use client';

/**
 * Programmatic trigger for the Chatwoot widget.
 *
 * Calls $chatwoot.toggle('open') if the widget is loaded; falls back to a
 * mailto link if not (e.g. NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN unset).
 */

import type { ReactNode } from 'react';

interface Props {
  children?: ReactNode;
  className?: string;
  /** Optional pre-fill message that opens with the widget. */
  message?: string;
}

export function SupportChatButton({ children, className, message }: Props) {
  const onClick = () => {
    if (typeof window === 'undefined') return;
    if (window.$chatwoot) {
      window.$chatwoot.toggle('open');
      // Pre-fill is best-effort; not all Chatwoot SDK versions expose this.
      // Keep the optional ts-cast minimal.
      const cw = window.$chatwoot as unknown as { setUnreadView?: () => void };
      cw.setUnreadView?.();
      if (message) {
        // Chatwoot's SDK doesn't expose a public "set draft" API. Copy the
        // suggested message to clipboard instead so the user pastes it.
        navigator.clipboard?.writeText(message).catch(() => {});
      }
      return;
    }
    // Fallback: open a fresh email if widget isn't configured. Better than
    // a dead button.
    window.location.href = `mailto:support@papercusp.com?subject=Papercusp%20support${message ? '&body=' + encodeURIComponent(message) : ''}`;
  };

  return (
    <button onClick={onClick} className={className} type="button">
      {children ?? 'Start support chat'}
    </button>
  );
}
