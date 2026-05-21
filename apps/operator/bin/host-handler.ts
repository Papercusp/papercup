/**
 * Composed request handler for the operator Hono host — side-effect free,
 * so it can be imported by tests and the import-resolution smoke without
 * starting a server or running bootstrap. `hono-host.ts` is the entrypoint
 * that wraps this with `runBootstrap()` + `serve()`.
 */
import { app } from '../app/api/_hono/app';
import { pageRoutes } from './page-routes';

/**
 * Page-namespace routes are checked first; every other request falls through
 * to the `/api` Hono app. The URL spaces don't overlap, so this is a flat
 * dispatch — no interleave, no change to the `_hono/app.ts` boundary contract.
 */
export async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (
    pathname === '/wiki' ||
    pathname === '/drizzle-studio' ||
    pathname.startsWith('/drizzle-studio/')
  ) {
    return pageRoutes.fetch(req);
  }
  return app.fetch(req);
}
