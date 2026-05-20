/**
 * Route registration onto the Hono app — in two phases.
 *
 * **Why two phases.** Hono runs every matching handler for a request as
 * a middleware chain, in registration order; the first handler that
 * returns a Response without calling `next()` wins. The composed
 * `_hono/app.ts` mounts sub-apps — `app.route('/harness', harness)`,
 * `app.route('/plugins', plugins)` — and the `plugins` sub-app carries
 * a parametric catch-all (`installPluginApiDispatcher`). If a literal
 * `defineRoute` like `/plugins/enabled` registers *after* that
 * catch-all, the catch-all shadows it and the literal 404s.
 *
 * So registration is split:
 *   - `registerRouteLiterals(app)` — every non-catch-all route. Called
 *     BEFORE the sub-apps mount, so a literal always out-ranks a
 *     sub-app's parametric/catch-all route at the same prefix.
 *   - `registerRouteCatchalls(app)` — the `*` / `:transport` dispatch
 *     routes. Called AFTER the sub-apps, so a sub-app's real route
 *     (e.g. a plugin's own apiRoutes) still gets first refusal before
 *     our projected-tool catch-all.
 *
 * `registerAllRoutes(app)` runs both phases back-to-back — correct for a
 * bare app with no sub-apps (the test harness). The real `_hono/app.ts`
 * calls the two phases separately, around the sub-app mounts.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

import type { Hono } from 'hono';
import { registerRoute } from './define-route';
import { ALL_ROUTES } from './routes';

/**
 * A route is "catch-all" if its path carries a wildcard (`*`) or is the
 * single-segment MCP transport route (`/:transport`) — both must yield
 * precedence to literal routes and sub-app routes.
 */
function isCatchAll(path: string): boolean {
  return path.includes('*') || path === '/:transport';
}

/** Mount the subset of `ALL_ROUTES` matching `wantCatchAll`. */
function registerSubset(app: Hono, wantCatchAll: boolean): void {
  const seen = new Set<string>();
  for (const def of ALL_ROUTES) {
    if (isCatchAll(def.path) !== wantCatchAll) continue;
    const key = `${def.method} ${def.path}`;
    if (seen.has(key)) {
      throw new Error(
        `register: duplicate route "${key}" — two route files claim the same endpoint`,
      );
    }
    seen.add(key);
    registerRoute(app, def);
  }
}

/**
 * Phase 1 — mount every literal (non-catch-all) route. Call this BEFORE
 * `app.route('/harness', …)` / `app.route('/plugins', …)` so literals
 * out-rank the sub-apps.
 */
export function registerRouteLiterals(app: Hono): void {
  registerSubset(app, false);
}

/**
 * Phase 2 — mount the catch-all dispatch routes (`/plugins/*`,
 * `/agent-tools/*`, `/plugin-runtime/.../*`, `/:transport`). Call this
 * AFTER the sub-apps mount.
 */
export function registerRouteCatchalls(app: Hono): void {
  registerSubset(app, true);
}

/**
 * Mount all routes, both phases. Correct for a bare app with no
 * sub-apps (the in-process test harness). The composed `_hono/app.ts`
 * does NOT use this — it calls the two phases separately, around the
 * sub-app mounts.
 */
export function registerAllRoutes(app: Hono): void {
  registerRouteLiterals(app);
  registerRouteCatchalls(app);
}

/** Count of mounted routes — used by the OpenAPI assembler + tests. */
export function registeredRouteCount(): number {
  return ALL_ROUTES.length;
}
