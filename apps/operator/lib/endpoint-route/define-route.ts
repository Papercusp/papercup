/**
 * `defineRoute` — the route projection of the endpoint system.
 *
 * **Phase E6 (endpoint-unification-2026-05-21): `defineRoute` collapsed
 * into `defineTool`.** `defineRoute` is now a re-export of the unified
 * `defineTool` primitive from `@papercusp/agent-mcp`. `defineTool`
 * discriminates structurally — a route-shaped input (`{ method, path,
 * auth, handler }`) yields a `RouteDefinition`; a tool-shaped input
 * yields a `ToolDefinition`. There is one primitive.
 *
 * The name `defineRoute` survives as an alias because it is a useful
 * ergonomic signal at the ~250 callsites — "this is plumbing, not an
 * agent tool" — and because the route TYPES (`RouteDefinition` etc.)
 * are what those files import alongside it. Authors may equally call
 * `defineTool` directly for a route; both resolve to the same function.
 *
 * What stays HOST-side (here): `registerRoute` — the Hono mounting +
 * `mobileCors` middleware. A route is *declared* with the package
 * primitive and *mounted* by the host; the host owns Hono and the
 * `requirePrincipal` auth chain, the package must not.
 *
 * Plan: apps/operator/docs/plans/endpoint-unification-2026-05-21.md
 */

import type { Hono } from 'hono';
import type { ZodTypeAny } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { runRouteStack } from './route-stack';
import { mobileCors } from './cors';

/* ─── The route types — canonical home is now @papercusp/agent-mcp ────── */
export type {
  RouteDefinition,
  RouteContext,
  RouteMethod,
  RouteAuth,
} from '@papercusp/agent-mcp';

/**
 * Declare a route. `defineRoute` IS `defineTool` (Phase E6) — the
 * `defineTool` overload set resolves a route-shaped input to a
 * `RouteDefinition`. Mounting happens via `registerRoute` /
 * `registerAllRoutes`.
 */
export const defineRoute = defineTool;

/**
 * Per-app set of paths that already have `mobileCors` mounted. Keyed on
 * the Hono app instance (each test builds a fresh app) so a module-level
 * Set can't wrongly skip CORS on a second app. Deduped because the
 * agent-tools catch-all is an array of 5 same-path defineRoutes — without
 * this, `app.use` would stack the middleware 5×.
 */
const MOBILE_CORS_PATHS = Symbol.for('papercusp.endpoint-route.mobileCorsPaths');

/**
 * Mount one route definition onto a Hono app. The Hono handler runs the
 * route through the route-stack (`route-stack.ts`) — auth, input
 * validation, timeout, invoke, telemetry.
 *
 * For `mobile: true` routes, the shared `mobileCors` middleware is
 * mounted (once per path) ahead of the handler so the cross-origin
 * phone client + its OPTIONS preflight are handled centrally.
 */
export function registerRoute(app: Hono, def: RouteDefinition<ZodTypeAny | undefined>): void {
  if (def.mobile) {
    const reg = app as unknown as Record<symbol, Set<string> | undefined>;
    let paths = reg[MOBILE_CORS_PATHS];
    if (!paths) {
      paths = new Set<string>();
      reg[MOBILE_CORS_PATHS] = paths;
    }
    if (!paths.has(def.path)) {
      paths.add(def.path);
      app.use(def.path, mobileCors);
    }
  }
  app.on(def.method, def.path, (c) => runRouteStack(def, c));
}
