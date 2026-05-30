'use client';

/**
 * Chatwoot live-chat widget for the papercup demo (papercupai.com).
 *
 * Tags conversations with `papercup:demo` so support agents can tell
 * demo-site visitors apart from papercusp public site and operator UI.
 *
 * Env (production override):
 *   NEXT_PUBLIC_CHATWOOT_BASE_URL       — Chatwoot host
 *   NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN  — papercupai.com inbox token
 */

import { useEffect } from 'react';

declare global {
  interface Window {
    chatwootSettings?: Record<string, unknown>;
    chatwootSDK?: { run: (config: { websiteToken: string; baseUrl: string }) => void };
    $chatwoot?: {
      setUser: (id: string, attrs: Record<string, unknown>) => void;
      setLabel: (label: string) => void;
      reset: () => void;
    };
  }
}

// Defaults from the operator's Chatwoot setup. Override via env at deploy time.
const DEFAULT_BASE_URL = 'https://chat.papercupai.com';
const DEFAULT_TOKEN = 'nQNnZSsKUsVEzeq7VLLUKhgJ';

export function ChatwootWidget() {
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? DEFAULT_BASE_URL;
    const websiteToken = process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN ?? DEFAULT_TOKEN;
    if (!websiteToken) return;

    window.chatwootSettings = {
      hideMessageBubble: false,
      position: 'right',
      locale: 'en',
      type: 'standard',
      launcherTitle: 'Papercup Support',
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
          window.$chatwoot?.setLabel('papercup:demo');
        } catch {
          /* best-effort */
        }
      });
    };
    document.body.appendChild(script);
  }, []);

  return null;
}
