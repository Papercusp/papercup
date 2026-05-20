/**
 * `registerAllRoutes` — mount every `defineRoute` onto the Hono app.
 *
 * Called once from `app/api/_hono/app.ts`. After this runs, every route
 * in `ALL_ROUTES` is served by the existing `[[...route]]` Next catch-all
 * (which does `handle(app)`), exactly like the `_hono/*` routers. Once
 * the Next-removal agent swaps in `@hono/node-server`, the same `app`
 * serves them with no further change here.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

import type { Hono } from 'hono';
import { registerRoute } from './define-route';
import { ALL_ROUTES } from './routes';

/**
 * Mount all routes. Throws on a duplicate `method + path` — the registry
 * must be collision-free (a duplicate means two route files claim the
 * same endpoint, which would make dispatch order-dependent).
 */
export function registerAllRoutes(app: Hono): void {
  const seen = new Set<string>();
  for (const def of ALL_ROUTES) {
    const key = `${def.method} ${def.path}`;
    if (seen.has(key)) {
      throw new Error(
        `registerAllRoutes: duplicate route "${key}" — two route files claim the same endpoint`,
      );
    }
    seen.add(key);
    registerRoute(app, def);
  }
}

/** Count of mounted routes — used by the OpenAPI assembler + tests. */
export function registeredRouteCount(): number {
  return ALL_ROUTES.length;
}
