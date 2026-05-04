/**
 * Next.js instrumentation hook — runs once at server startup, before any
 * route handler. Used to boot the pty WebSocket server alongside the
 * Next HTTP server.
 *
 * The pty WS server lives on a separate port (default 3056) rather than
 * sharing the Next server's port. This is the same shape as Wetty,
 * GoTTY, and ttyd: keeping `next dev` / Turbopack untouched is cheaper
 * than replacing the dev server with a custom `server.js` that hosts
 * both. In dev the second port is just `localhost:3056`; in production
 * nginx needs a `location /pty/` block that upgrades to ws://.
 *
 * Idempotent: re-runs (Next dev re-loads instrumentation on some
 * config changes) detect EADDRINUSE and skip.
 */
export async function register(): Promise<void> {
  // Edge / Workers runtime can't open sockets; skip.
  // process.env.NEXT_RUNTIME is "nodejs" in the Node runtime.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Allow opt-out for environments where we'd prefer the legacy SSE+POST
  // path only (e.g. behind a reverse proxy that doesn't pass upgrades).
  if (process.env.PAPERCUSP_PTY_WS === '0') {
    console.log('[pty-ws] PAPERCUSP_PTY_WS=0 — skipping pty WebSocket server');
    return;
  }

  const port = Number.parseInt(process.env.PAPERCUSP_PTY_WS_PORT ?? '3056', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.warn(`[pty-ws] invalid PAPERCUSP_PTY_WS_PORT, skipping`);
    return;
  }

  // Production allow-list. In dev, allowLocalhost catches everything.
  const allowedHosts = (process.env.PAPERCUSP_PTY_WS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const { startPtyWsServer } = await import('./lib/pty-ws');
    startPtyWsServer({
      port,
      allowedHosts,
      allowLocalhost: process.env.NODE_ENV !== 'production' || allowedHosts.length === 0,
    });
  } catch (err) {
    console.error('[pty-ws] failed to start:', err);
  }
}
