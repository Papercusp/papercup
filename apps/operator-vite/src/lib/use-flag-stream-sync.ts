import { useEffect } from 'react';
import { subscribeToFlagStream } from '@papercusp/flags/client';

/**
 * Keep the shared `@papercusp/flags/client` store LIVE for the app's lifetime.
 *
 * The store is seeded once from `window.__PAPERCUSP_FLAGS__` (the dev vite
 * plugin / host-spa bootstrap) and then frozen — operator-vite never opened the
 * flag stream. So toggling a flag anywhere (e.g. the dev rail FlagsPanel →
 * `/api/flags/set`) updated the server + that panel's own local state, but never
 * the shared store, so `useFlag()` consumers stayed stale until a full reload.
 *
 * This subscribes the shared store to `/api/flags/stream` once. Combined with
 * the now-reactive `useFlag` (useSyncExternalStore), a flag flip re-renders
 * every gated surface immediately. (flag-reactivity 2026-06-18)
 *
 * Call this from the root component (a parent) so its effect runs AFTER all
 * descendant mount effects — in particular after `RootSyncProvider` installs the
 * desktop IPC `EventSource` polyfill — so the stream opens over the right
 * transport. (React fires effects bottom-up: children before parents.)
 */
export function useFlagStreamSync(): void {
  useEffect(() => {
    const sub = subscribeToFlagStream();
    return () => sub.close();
  }, []);
}
