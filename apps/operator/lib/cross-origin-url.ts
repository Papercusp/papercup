/**
 * crossOriginUrl — build an absolute URL to our own server on the *sibling*
 * loopback host (localhost <-> 127.0.0.1, same scheme + port).
 *
 * Why this exists
 * ---------------
 * The harness page keeps ~6 long-lived SSE streams open (zero-harness sync,
 * flags, ui-intents, operator state-snapshot, harness log…). That is the
 * browser's *entire* HTTP/1.1 connection budget — Chromium allows only 6
 * concurrent sockets per origin. On-demand fetches like the commit diff
 * (`/api/harness/:slug/git/show/:sha`) then get zero free sockets and sit
 * in the queue until they time out — the "loading diff… forever" bug.
 *
 * `localhost` and `127.0.0.1` resolve to the same server but are *different
 * origins* for the browser's per-origin socket pool. Fetching the diff from
 * the sibling host gives it a fresh, empty 6-socket pool that the SSE
 * streams never touch. The target route answers with
 * `Access-Control-Allow-Origin: *` so the cross-origin GET is permitted
 * (it is an unauthenticated, loopback-only read — no credentials sent).
 *
 * SSR-safe: returns the path unchanged when `window` is absent or the page
 * is not on a loopback host (nothing to shard against).
 */
export function crossOriginUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const { protocol, hostname, port } = window.location;
  const sibling =
    hostname === 'localhost' ? '127.0.0.1'
    : hostname === '127.0.0.1' ? 'localhost'
    : null;
  if (!sibling) return path;
  return `${protocol}//${sibling}${port ? `:${port}` : ''}${path}`;
}
