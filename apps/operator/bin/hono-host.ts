/**
 * operator Hono host — `@hono/node-server`.
 *
 * Serves the operator's full Hono API (`_hono/app.ts`, basePath `/api`) plus
 * the page-namespace handlers (`/wiki`, `/drizzle-studio`). Replaces the Next
 * route shim (`app/api/[[...route]]/route.ts`).
 *
 * Run:  tsx apps/operator/bin/hono-host.ts        (cwd: apps/operator)
 * Port: PAPERCUSP_HONO_PORT (default 3070 — the production operator host).
 *
 * This file is a pure entrypoint — it always boots when executed. The
 * side-effect-free request handler lives in `./host-handler.ts`.
 *
 * Final home (Phase H): moves to `apps/operator-vite/server/` once `_hono/`
 * relocates there. See operator-vite-migration-2026-05-20.md (Phase C/H).
 */
import { serve } from '@hono/node-server';
import { runBootstrap } from './host-bootstrap';
import { handler } from './host-handler';
import { workspacePinWarning } from '@papercusp/operator-core/lib/workspace-pin-guard';

// Resilience guard: when an MCP/SSE client disconnects mid-stream, the
// `mcp-handler` dependency's response adapter enqueues onto an already-closed
// ReadableStream controller → `ERR_INVALID_STATE: Controller is already closed`,
// surfacing as an unhandled rejection that (Node ≥15) terminates the WHOLE host —
// so one agent dropping a connection crash-loops :3070 for the entire fleet. That
// client is already gone; the only casualty should be its one request. Swallow
// ONLY this known-benign stream-close class; preserve fail-fast (exit) for
// everything else so real bugs still surface.
function isBenignStreamClose(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  return (
    !!x &&
    (x.code === 'ERR_INVALID_STATE' || /Controller is already closed/i.test(x.message ?? ''))
  );
}
process.on('unhandledRejection', (reason) => {
  if (isBenignStreamClose(reason)) {
    console.warn('[hono-host] ignored benign stream-close (client disconnected mid-MCP/SSE):', (reason as Error)?.message);
    return;
  }
  console.error('[hono-host] fatal unhandledRejection — exiting:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (isBenignStreamClose(err)) {
    console.warn('[hono-host] ignored benign stream-close (uncaught):', err.message);
    return;
  }
  console.error('[hono-host] fatal uncaughtException — exiting:', err);
  process.exit(1);
});

runBootstrap();

// Port/host: `PAPERCUSP_HONO_PORT`/`PAPERCUSP_BIND_HOST` are the explicit
// knobs (dev). The packaged desktop's Tauri main spawns the sidecar with
// the generic `PORT`/`HOSTNAME` it already sets for every sidecar — accept
// those as fallbacks so G4 needs no extra env wiring.
const port = Number(
  process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070,
);
const hostname =
  process.env.PAPERCUSP_BIND_HOST ?? process.env.HOSTNAME ?? '127.0.0.1';

// Export the resolved port so selfUrl() builds correct server-side
// self-fetch origins inside this host (the operator brain's agentmcp
// MCP URL, the <spawn> dispatch). Without it selfUrl() falls back to
// the :3055 dev default — post-Vite-migration :3055 is the frontend
// SPA, not this API host, so self-fetches would hit the wrong server.
process.env.PORT = String(port);

serve({ fetch: handler, port, hostname }, (info) => {
  console.log(`[hono-host] listening on http://${hostname}:${info.port}`);

  // Guardrail: a stray PAPERCUSP_WORKSPACE_ID pin silently rebinds every
  // non-request path on this multi-workspace host. Warn loudly at boot — a bare
  // `# TEMPORARY` comment in .env.local was not enough to stop one surviving.
  // (Logic + rationale in lib/workspace-pin-guard.ts, unit-tested.)
  const pinWarning = workspacePinWarning();
  if (pinWarning) console.warn(pinWarning);
});
