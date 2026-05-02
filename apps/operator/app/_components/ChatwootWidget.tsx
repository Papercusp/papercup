'use client';

/**
 * Chatwoot live-chat widget for the in-app operator surface.
 *
 * Mirrors the implementation on papercusp.com but tags conversations
 * with `papercusp:operator` so the support team can tell them apart
 * from public marketing-site visits.
 *
 * Configurable via env (no recompile needed to switch inboxes):
 *   NEXT_PUBLIC_CHATWOOT_BASE_URL       — Chatwoot host
 *   NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN  — operator inbox token (different
 *                                          from public if you want, same if
 *                                          you don't — both is fine)
 *
 * No-ops cleanly when env is unset. Pre-fills user identity if available
 * via the SessionIndicator's auth state.
 */

import { useEffect } from 'react';

declare global {
  interface Window {
    chatwootSettings?: Record<string, unknown>;
    chatwootSDK?: { run: (config: { websiteToken: string; baseUrl: string }) => void };
    $chatwoot?: {
      setUser: (id: string, attrs: Record<string, unknown>) => void;
      setLabel: (label: string) => void;
      setCustomAttributes: (attrs: Record<string, unknown>) => void;
      reset: () => void;
      toggle: (state?: 'open' | 'close') => void;
    };
  }
}

// Defaults from the operator's Chatwoot setup. Override via env at deploy time.
// The Cloudflare-Tunnel base URL ROTATES if the tunnel restarts; production DNS
// will eventually point at chat.papercusp.com — update this default then.
const DEFAULT_BASE_URL = 'https://chat.papercupai.com';
const DEFAULT_TOKEN = 'CT5CTToo11YtPN3CVkhvbFs9'; // papercuspai.com (operator) inbox

export function ChatwootWidget() {
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? DEFAULT_BASE_URL;
    const websiteToken = process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN ?? DEFAULT_TOKEN;
    if (!websiteToken) return;

    window.chatwootSettings = {
      hideMessageBubble: true,
      position: 'right',
      locale: 'en',
      type: 'standard',
      launcherTitle: 'Papercusp Support',
      // Keep the SDK available as a hidden bridge; Support is opened through
      // OracleDock's integrated Support tab, not a separate floating button.
      darkMode: 'dark',
      widgetColor: '#38bdf8',
      widgetStyle: 'flat',
      showUnreadMessagesDialog: false,
      showPopoutButton: false,
    };

    if (window.chatwootSDK) {
      window.chatwootSDK.run({ websiteToken, baseUrl });
      return;
    }

    const script = document.createElement('script');
    script.src = `${baseUrl}/packs/js/sdk.js`;
    script.defer = true;
    script.async = true;
    script.onload = () => {
      window.chatwootSDK?.run({ websiteToken, baseUrl });
      const ready = (cb: () => void) => {
        const tick = () => {
          if (window.$chatwoot) cb();
          else setTimeout(tick, 200);
        };
        tick();
      };
      ready(() => {
        try {
          window.$chatwoot?.setLabel('papercusp:operator');
          // Pull in-app identity from the existing auth status endpoint if available (non-blocking).
          fetch('/api/auth/status')
            .then((r) => (r.ok ? r.json() : null))
            .then((auth) => {
              const me = auth?.signedIn ? auth.user : null;
              if (me?.id) {
                window.$chatwoot?.setUser(String(me.id), {
                  email: me.email ?? undefined,
                  name: me.displayName ?? me.email ?? undefined,
                });
              }
            })
            .catch(() => {
              /* unauthenticated — ignore */
            });
        } catch {
          /* best-effort */
        }
      });
    };
    document.body.appendChild(script);
  }, []);

  return null;
}
