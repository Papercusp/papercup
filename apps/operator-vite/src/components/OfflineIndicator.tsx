import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useSyncConnectivity } from '@papercusp/sync';

/**
 * Surfaces operator connectivity loss as a persistent toast (EI-239) — but
 * only for a SUSTAINED outage, never a brief reconnect blip (EI-3033).
 *
 * Without this, an operator death left the SPA looking healthy-but-empty —
 * panels render zero-counts indistinguishable from a real empty state and
 * every action fails silently. The sync transports already detect sustained
 * network-level failure (`@papercusp/sync`'s connectivity store, fed by the
 * SSE reconnect loop and the REST batch fetcher); this component renders
 * that state. Same idiom as ChunkReloadPrompt: a stable-id sonner toast,
 * auto-dismissed the moment a transport proves the origin reachable again
 * (the SPA soft-recovers on its own — reload is NOT offered, a full
 * document load against a dead origin strands the webview).
 *
 * EI-3033: under heavy fleet load the desktop's SSE/IPC stream drops and
 * re-dials frequently (CPU-starved operator, webview IPC re-dials), flipping
 * `offline` true for a second or two before the next attempt reconnects.
 * Firing the alarming "actions will not save" toast on every such blip is
 * noise that recovers on its own. So we DEBOUNCE the toast on the time axis:
 * it only appears once the outage has persisted past OFFLINE_TOAST_GRACE_MS.
 * A drop that recovers within the grace window never interrupts the user; a
 * genuine sustained outage still surfaces promptly. Recovery cancels a pending
 * alarm and dismisses an already-shown toast immediately. The connectivity
 * store's `offline` boolean stays pure truth — the debounce is a view-layer
 * presentation decision, not a change to what "offline" means.
 */
const TOAST_ID = 'sync-offline-indicator';

/**
 * How long the connection must stay continuously down before we alarm the
 * user. Long enough to ride out a reconnect / IPC re-dial under load
 * (EI-3033), short enough that a genuine outage surfaces promptly.
 */
export const OFFLINE_TOAST_GRACE_MS = 5000;

export default function OfflineIndicator() {
  const { offline } = useSyncConnectivity();
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearGrace = () => {
      if (graceTimer.current !== null) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };

    if (offline) {
      // Debounce: only alarm once the outage outlasts a brief reconnect blip.
      if (graceTimer.current === null) {
        graceTimer.current = setTimeout(() => {
          graceTimer.current = null;
          toast.error('Operator connection lost', {
            id: TOAST_ID,
            description:
              'Live data is paused and actions will not save. Reconnecting automatically — the app resumes by itself once the operator is back.',
            duration: Infinity,
          });
        }, OFFLINE_TOAST_GRACE_MS);
      }
    } else {
      // Recovered (or never down): cancel a pending alarm and dismiss a shown one.
      clearGrace();
      toast.dismiss(TOAST_ID);
    }

    return clearGrace;
  }, [offline]);

  return null;
}
