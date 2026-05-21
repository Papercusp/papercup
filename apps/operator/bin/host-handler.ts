/**
 * Composed request handler for the operator Hono host — side-effect free,
 * so it can be imported by tests and the import-resolution smoke without
 * starting a server or running bootstrap. `hono-host.ts` is the entrypoint
 * that wraps this with `runBootstrap()` + `serve()`.
 *
 * Phase E extension: a top-level Hono app layers the ported `next.config.js`
 * + `proxy.ts` behaviors on top of the inner `_hono/app.ts` API:
 *
 *   compress    — host-level gzip on every response (no-op for the inner
 *                 `_hono`-already-compressed `/api/*`; matters for docs HTML)
 *   apiCors     — broad `/api/*` CORS port from proxy.ts; mounts on the host
 *                 (not inside `_hono/app.ts`) to preserve the Phase 0
 *                 BOUNDARY contract — the existing narrow `tauriApiCors`
 *                 inside `_hono` is left untouched. As-built deviation from
 *                 plan E2.
 *   rustOptIn   — env-gated `?backend=rust` proxy. Default off.
 *   crossApp    — `/api/org/*` etc. → :3061 / :3001 upstream proxies.
 *   docsRoutes  — `/internal/docs/*` loopback gate + slug→html + Accept→md.
 *   pageRoutes  — `/wiki`, `/drizzle-studio`.
 *   app.fetch   — local API fallthrough (`/api/*`).
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { app } from '../app/api/_hono/app';
import { apiCors } from './host-cors';
import { docsRoutes } from './host-docs';
import { pageRoutes } from './page-routes';
import { crossAppRewrites, rustOptIn } from './host-proxies';

const host = new Hono();

// 1. Outermost compression. Skips responses that already carry a
//    Content-Encoding header (so `_hono`'s inner `/api/*` gzip is preserved
//    and not double-encoded).
host.use('*', compress());

// 2. Broad `/api/*` CORS (proxy.ts port). Handles OPTIONS preflight and
//    decorates downstream responses with the standard headers.
host.use('/api/*', apiCors);

// 3. Rust opt-in proxy. Inert unless PAPERCUSP_ENABLE_RUST_REWRITES=1.
//    Must run before the cross-app rewrites and local API so the
//    `?backend=rust` flag wins.
host.use('/api/*', rustOptIn);

// 4. Cross-app upstream proxies (`/api/org/*` → :3061 etc.). These match
//    before the local-API fallthrough below; the URL spaces don't overlap
//    so order is unambiguous.
host.route('/', crossAppRewrites);

// 5. Docs surface (`/internal/docs/*`).
host.route('/', docsRoutes);

// 6. Page-namespace routes (`/wiki`, `/drizzle-studio`).
host.route('/', pageRoutes);

// 7. Local API fallthrough — every remaining `/api/*` request goes to the
//    inner Hono app. Calling `app.fetch(c.req.raw)` (not `c.req`) preserves
//    the original Web `Request` object — `_hono/app.ts` handlers index off
//    `c.req.raw` for things like `request.signal` (abort propagation).
host.all('/api/*', (c) => app.fetch(c.req.raw));

export async function handler(req: Request): Promise<Response> {
  return host.fetch(req);
}
