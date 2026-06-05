import { useEffect } from 'react';
import { toast } from 'sonner';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';

/**
 * Surfaces a user-controlled reload when a code-split chunk fails to load.
 *
 * Vite fires `vite:preloadError` on `window` whenever a dynamic import (a
 * `React.lazy` chunk, `import('vditor')`, etc.) 404s — which happens when the
 * bundle the running page references gets replaced underneath it:
 *   - dev box: `vite build --watch` rewrites `dist` on every fleet edit;
 *   - production: a redeploy rolls the asset hashes.
 * The loaded page then can't fetch a chunk it needs, so the component that
 * needed it silently fails to mount (e.g. a settings editor that never
 * appears).
 *
 * Rather than that silent break — or an auto-reload that yanks the session
 * mid-task (which is exactly why `lazyWithRetry` is guarded on the desktop;
 * see `bin/desktop-dev-nohmr`) — show a one-time, dismissible toast offering a
 * manual reload. The user decides when to pick up the new build. We do NOT
 * `preventDefault()` the event: the import still rejects (unchanged failure
 * behaviour), we only surface the recovery action.
 */
export default function ChunkReloadPrompt() {
  useEffect(() => {
    let shown = false;
    const onPreloadError = () => {
      if (shown) return;
      shown = true;
      toast('A newer build is available', {
        // Stable id → sonner dedupes, so repeated chunk failures never stack.
        id: 'chunk-reload-prompt',
        description:
          'Some content failed to load because the app was updated underneath it. Reload to get the latest.',
        duration: Infinity,
        // `window.location.reload()` is a no-op on the desktop host (it
        // overrides reload to keep `vite build --watch` from yanking the
        // session); hardReload() uses the host's stashed genuine reload so the
        // button actually picks up the new build.
        action: { label: 'Reload', onClick: () => hardReload() },
      });
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, []);
  return null;
}
