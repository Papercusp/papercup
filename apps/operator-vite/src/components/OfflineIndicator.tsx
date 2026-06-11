import { useEffect } from 'react';
import { toast } from 'sonner';
import { useSyncConnectivity } from '@papercusp/sync';

/**
 * Surfaces operator connectivity loss as a persistent toast (EI-239).
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
 */
const TOAST_ID = 'sync-offline-indicator';

export default function OfflineIndicator() {
  const { offline } = useSyncConnectivity();

  useEffect(() => {
    if (offline) {
      toast.error('Operator connection lost', {
        id: TOAST_ID,
        description:
          'Live data is paused and actions will not save. Reconnecting automatically — the app resumes by itself once the operator is back.',
        duration: Infinity,
      });
    } else {
      toast.dismiss(TOAST_ID);
    }
  }, [offline]);

  return null;
}
