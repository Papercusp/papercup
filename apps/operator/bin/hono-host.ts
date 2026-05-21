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
import { runBootstrap } from '../app/api/_hono/bootstrap';
import { handler } from './host-handler';

runBootstrap();

const port = Number(process.env.PAPERCUSP_HONO_PORT ?? 3070);
const hostname = process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1';

serve({ fetch: handler, port, hostname }, (info) => {
  console.log(`[hono-host] listening on http://${hostname}:${info.port}`);
});
