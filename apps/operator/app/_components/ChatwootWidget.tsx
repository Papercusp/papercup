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
    };
  }
}

export function ChatwootWidget() {
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? 'https://chat.papercusp.com';
    const websiteToken = process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN;
    if (!websiteToken) return;

    window.chatwootSettings = {
      hideMessageBubble: false,
      position: 'right',
      locale: 'en',
      type: 'standard',
      launcherTitle: 'Papercusp Support',
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
          // Pull in-app identity from /api/me if available (non-blocking).
          fetch('/api/me')
            .then((r) => (r.ok ? r.json() : null))
            .then((me) => {
              if (me?.id) {
                window.$chatwoot?.setUser(String(me.id), {
                  email: me.email ?? undefined,
                  name: me.name ?? me.login ?? undefined,
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
