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

  // Guardrail (2026-06-01): PAPERCUSP_WORKSPACE_ID pins activeWorkspaceId() for
  // EVERY non-request path on this host — background work, the spawn envelope, and
  // the harness-list/features tools whenever a request didn't stamp
  // `x-papercusp-workspace`. The :3070 host is inherently MULTI-workspace (it
  // serves every desktop window), so a pin here silently makes all of them resolve
  // to the pinned workspace: a leftover `=default` once made papercusp-workspace
  // surface default's entire harness registry. A bare `# TEMPORARY` comment in
  // .env.local was not enough to stop it surviving — so warn loudly at boot.
  // Legitimate only for a deliberately single-workspace host; otherwise unset it.
  const wsPin = process.env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (wsPin) {
    console.warn(
      `[hono-host] ⚠ PAPERCUSP_WORKSPACE_ID=${wsPin} is set — this PINS workspace ` +
        `resolution to '${wsPin}' for every non-request path on this multi-workspace ` +
        `host. Any window/tool that doesn't carry the x-papercusp-workspace header ` +
        `will see '${wsPin}'s harnesses/features/registry, regardless of the active ` +
        `workspace. Unset it unless this host is intentionally single-workspace.`,
    );
  }
});
