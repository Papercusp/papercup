'use client';

/**
 * FlagStreamSubscriber — EI-2425 fix B: wires the live flag-flip SSE stream
 * once at the app root, so every `useFlag` consumer (now reactive via
 * useSyncExternalStore — fix A, `libs/flags/src/client.ts`) re-renders the
 * instant a flag flips, with no reload.
 *
 * Before this, `libs/flags/src/client.ts` shipped `subscribeToFlagStream()`
 * (opens `/api/flags/stream` SSE, and on a `flag_changed` event re-fetches
 * `/api/flags/bootstrap` + pushes the fresh payload into the shared
 * `current` snapshot) but NOTHING in operator-vite ever called it — verified
 * by grep before this fix; the primitive existed, unwired. A flag flip
 * (`flags:set`) was therefore invisible on an already-open desktop until a
 * fresh page load re-seeded `window.__PAPERCUSP_FLAGS__` from the bootstrap
 * endpoint (and even a normal reload could still serve a stale cached shell
 * — see fix C, `apps/operator/bin/host-spa.ts`'s `Cache-Control: no-store`
 * on the index shell).
 *
 * Mounted once at the router root, next to the other Global- and Desktop-
 * prefixed bridge components (DesktopAttentionNotifier, DesktopConsoleLaunchBridge).
 * Renders nothing; opens exactly one resilient EventSource for the whole
 * app (createResilientEventSource auto-reconnects — see @papercusp/sse).
 */
import { useEffect } from 'react';
import { subscribeToFlagStream } from '@papercusp/flags/client';

export default function FlagStreamSubscriber() {
  useEffect(() => {
    const sub = subscribeToFlagStream();
    return () => sub.close();
  }, []);
  return null;
}
